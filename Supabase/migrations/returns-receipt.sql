-- =====================================================================
-- Stockflow · Povraćaj samo uz fiskalni račun i stvarnu cenu
--  * RETURN bez cene se odbija svuda (ručno, import, direktno)
--  * Ručni RETURN: obavezan broj računa + cena po kojoj je zaista prodato
--  * Ne može se vratiti više nego što je prodato po toj ceni (90 dana)
--  * Isti račun ne može dvaput za isti proizvod
--  Sve u jednoj transakciji: ako bilo šta padne, ništa se ne menja.
-- =====================================================================

begin;

-- ---------------------------------------------------------------------
-- 1. Broj fiskalnog računa na povraćaju
-- ---------------------------------------------------------------------
alter table public.stock_movements add column if not exists receipt_no text;

-- isti račun + isti proizvod + ista prodavnica = samo jedan povraćaj
create unique index if not exists stock_movements_return_receipt_uq
  on public.stock_movements (object_id, product_id, receipt_no)
  where event = 'RETURN' and receipt_no is not null;

-- ---------------------------------------------------------------------
-- 2. Cene po kojima se proizvod prodavao (za izbor u formi)
-- ---------------------------------------------------------------------
create or replace function public.return_price_options(p_object_id uuid, p_product_id uuid)
returns table (
  unit_price   numeric,
  sold         int,
  returned     int,
  available    int,
  last_sold_at timestamptz,
  currency     text
)
language sql
stable
security invoker                       -- RLS: prodavac vidi samo svoju prodavnicu
set search_path to 'public', 'pg_temp'
as $$
  with s as (
    select m.unit_price as price,
           sum(-m.quantity) filter (where m.event = 'SALE')::int               as sold,
           coalesce(sum(m.quantity) filter (where m.event = 'RETURN'), 0)::int as returned,
           max(m.occurred_at) filter (where m.event = 'SALE')                  as last_sold_at
    from stock_movements m
    where m.object_id = p_object_id
      and m.product_id = p_product_id
      and m.event in ('SALE', 'RETURN')
      and m.unit_price is not null
      and m.occurred_at >= now() - interval '90 days'
    group by m.unit_price
  )
  select s.price, s.sold, s.returned, greatest(s.sold - s.returned, 0),
         s.last_sold_at, app_currency()
  from s
  where s.sold > 0
  order by s.last_sold_at desc;
$$;

-- ---------------------------------------------------------------------
-- 3. record_movement sa cenom i računom (stara verzija se briše)
-- ---------------------------------------------------------------------
drop function if exists public.record_movement(uuid, uuid, text, integer, text, uuid);

create or replace function public.record_movement(
  p_object_id       uuid,
  p_product_id      uuid,
  p_event           text,
  p_quantity        int,
  p_note            text    default null,
  p_unit_price      numeric default null,
  p_receipt_no      text    default null,
  p_idempotency_key uuid    default null)
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_prev     jsonb;
  v_event    text := upper(btrim(coalesce(p_event, '')));
  v_receipt  text;
  v_price    numeric;
  v_cost     numeric;
  v_sold     int;
  v_returned int;
  v_prices   text;
  v_used     timestamptz;
  v_id       uuid;
  v_res      jsonb;
begin
  if auth.uid() is null then
    raise exception 'Not signed in' using errcode = '42501';
  end if;

  if v_event = 'RETURN' then
    v_receipt := nullif(upper(regexp_replace(coalesce(p_receipt_no, ''), '\s+', '', 'g')), '');
    v_price   := p_unit_price;
  end if;

  v_prev := _idem_begin(p_idempotency_key, 'record_movement', jsonb_build_object(
    'object', p_object_id, 'product', p_product_id, 'event', v_event,
    'quantity', p_quantity, 'note', p_note, 'price', v_price, 'receipt', v_receipt));
  if v_prev is not null then return v_prev->'result'; end if;

  if is_demo() and p_object_id is distinct from demo_object_id() then
    raise exception 'DEMO_READONLY' using errcode = '42501';
  end if;
  perform assert_object_access(p_object_id);
  perform set_config('stockflow.allow_negative', 'off', true);

  if v_event not in ('SALE', 'RETURN', 'ADJUSTMENT', 'WRITE_OFF') then
    raise exception '% can only be recorded through its workflow.', v_event using errcode = '42501';
  end if;
  if v_event = 'ADJUSTMENT' and not is_admin() then
    raise exception 'Only admins can record adjustments. Use a stock count instead.'
      using errcode = '42501';
  end if;
  if p_quantity is null or p_quantity = 0 then
    raise exception 'Quantity cannot be zero.' using errcode = '22023';
  end if;

  -- ---------- povraćaj ----------
  if v_event = 'RETURN' then
    if v_receipt is null then
      raise exception 'Enter the fiscal receipt number.' using errcode = '22023';
    end if;
    if v_price is null then
      raise exception 'Enter the price from the fiscal receipt.' using errcode = '22023';
    end if;

    -- dva istovremena povraćaja istog proizvoda čekaju jedan drugog
    perform pg_advisory_xact_lock(hashtext('stockflow:return:' || p_object_id::text || ':' || p_product_id::text));

    select m.occurred_at into v_used
    from stock_movements m
    where m.object_id = p_object_id and m.product_id = p_product_id
      and m.event = 'RETURN' and m.receipt_no = v_receipt
    limit 1;
    if found then
      raise exception 'Receipt % was already used to return this product on %.',
        v_receipt, to_char(v_used at time zone app_timezone(), 'DD.MM.YYYY HH24:MI')
        using errcode = '23505';
    end if;

    select coalesce(sum(-m.quantity) filter (where m.event = 'SALE'), 0)::int,
           coalesce(sum(m.quantity)  filter (where m.event = 'RETURN'), 0)::int
      into v_sold, v_returned
    from stock_movements m
    where m.object_id = p_object_id and m.product_id = p_product_id
      and m.event in ('SALE', 'RETURN')
      and m.unit_price = v_price
      and m.occurred_at >= now() - interval '90 days';

    if v_sold = 0 then
      select string_agg(distinct to_char(m.unit_price, 'FM999999990.00'), ', ')
        into v_prices
      from stock_movements m
      where m.object_id = p_object_id and m.product_id = p_product_id
        and m.event = 'SALE' and m.unit_price is not null
        and m.occurred_at >= now() - interval '90 days';
      raise exception 'This product was not sold at % in the last 90 days. Prices sold: %.',
        to_char(v_price, 'FM999999990.00'), coalesce(v_prices, 'none')
        using errcode = '22023';
    end if;

    if p_quantity > v_sold - v_returned then
      raise exception 'Only % unit(s) sold at % can still be returned.',
        greatest(v_sold - v_returned, 0), to_char(v_price, 'FM999999990.00')
        using errcode = '22023';
    end if;

    -- nabavna cena iz iste prodaje -> margin se poništi tačno
    select m.unit_cost into v_cost
    from stock_movements m
    where m.object_id = p_object_id and m.product_id = p_product_id
      and m.event = 'SALE' and m.unit_price = v_price
      and m.occurred_at >= now() - interval '90 days'
    order by m.occurred_at desc
    limit 1;
  end if;

  insert into stock_movements
    (object_id, product_id, event, quantity, reference, note, created_by,
     unit_price, unit_cost, receipt_no)
  values
    (p_object_id, p_product_id, v_event::movement_event, p_quantity, 'manual',
     nullif(btrim(coalesce(p_note, '')), ''), auth.uid(),
     v_price, v_cost, v_receipt)
  returning id into v_id;

  v_res := jsonb_build_object('id', v_id);
  perform _idem_finish(p_idempotency_key, jsonb_build_object('result', v_res));
  return v_res;
end $$;

-- ---------------------------------------------------------------------
-- 4. Guard i import: RETURN bez cene se odbija, nema više procene
-- ---------------------------------------------------------------------
create or replace function pg_temp.swap(src text, a text, b text)
returns text language plpgsql as $$
begin
  if position(a in src) = 0 then
    raise exception 'Nije pronađeno: %', a;
  end if;
  return replace(src, a, b);
end $$;

do $$
declare
  n   text;
  pat text := 'new\.unit_price := coalesce\(\s*new\.unit_price,\s*case when new\.event = ''RETURN''.*d\.sell_price\);';
begin
  -- guard: ukloni "cena poslednje prodaje" i zahtevaj cenu za RETURN
  n := pg_get_functiondef('public.guard_stock_movement()'::regprocedure);
  if n !~ pat then
    raise exception 'guard_stock_movement: nije pronađen očekivani kod, ništa nije menjano';
  end if;
  n := regexp_replace(n, pat,
'if new.event = ''RETURN'' and new.unit_price is null then
      raise exception ''A return needs the price from the fiscal receipt.'' using errcode = ''22023'';
    end if;
    new.unit_price := coalesce(new.unit_price, d.sell_price);');
  execute n;

  -- import_sales: povraćaj iz fajla mora imati cenu
  n := pg_get_functiondef('public.import_sales(jsonb, text, text, boolean)'::regprocedure);
  n := pg_temp.swap(n,
    'from _si where price_txt is not null and price is null',
    'from _si where price_txt is not null and price is null
    union all
    select row_no, ''unit_price'', ''A return needs the price from the fiscal receipt''
      from _si where qty < 0 and price_txt is null');
  execute n;
end $$;

-- ---------------------------------------------------------------------
-- 5. Prava
-- ---------------------------------------------------------------------
revoke execute on function public.record_movement(uuid, uuid, text, integer, text, numeric, text, uuid) from public, anon;
grant  execute on function public.record_movement(uuid, uuid, text, integer, text, numeric, text, uuid) to authenticated, service_role;
revoke execute on function public.return_price_options(uuid, uuid) from public, anon;
grant  execute on function public.return_price_options(uuid, uuid) to authenticated, service_role;

commit;

notify pgrst, 'reload schema';
