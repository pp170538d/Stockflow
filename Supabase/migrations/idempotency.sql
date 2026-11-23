-- =====================================================================
-- Stockflow · Idempotency
--  * Može da se pokrene više puta (safe re-run).
--  * Postojeće funkcije se NE prepisuju: preimenuju se u _<ime>_core,
--    a javna funkcija sa istim imenom postaje tanak wrapper sa ključem.
--  * p_idempotency_key je opcion (default null) -> stari frontend radi
--    i dalje, pa redosled deploy-a nije bitan.
-- =====================================================================

begin;

-- ---------------------------------------------------------------------
-- 1. Tabela ključeva
-- ---------------------------------------------------------------------
create table if not exists public.idempotency_keys (
  key          uuid primary key,
  user_id      uuid not null,
  operation    text not null,
  request_hash text not null,
  result       jsonb,
  created_at   timestamptz not null default now()
);

create index if not exists idempotency_keys_created_at_idx
  on public.idempotency_keys (created_at);

alter table public.idempotency_keys enable row level security;
revoke all on public.idempotency_keys from public, anon, authenticated;

-- ---------------------------------------------------------------------
-- 2. Helperi
-- ---------------------------------------------------------------------
-- NULL  -> prvi poziv, nastavi sa radom
-- jsonb -> već urađeno, vrati sačuvani rezultat
create or replace function public._idem_begin(p_key uuid, p_operation text, p_payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_row  public.idempotency_keys;
  v_hash text := md5(coalesce(p_payload, 'null'::jsonb)::text);
begin
  if p_key is null then
    return null;                       -- bez ključa = staro ponašanje
  end if;
  if auth.uid() is null then
    raise exception 'Not signed in' using errcode = '42501';
  end if;

  -- povremeno čišćenje (≈1% poziva), ključevi žive 7 dana
  if random() < 0.01 then
    delete from public.idempotency_keys where created_at < now() - interval '7 days';
  end if;

  -- Ako isti ključ upravo obrađuje druga transakcija, ovaj insert ČEKA
  -- dok se ona ne završi (commit -> konflikt, rollback -> prolazi).
  insert into public.idempotency_keys (key, user_id, operation, request_hash)
  values (p_key, auth.uid(), p_operation, v_hash)
  on conflict (key) do nothing;

  if found then
    return null;
  end if;

  select * into v_row from public.idempotency_keys where key = p_key;

  if v_row.user_id is distinct from auth.uid() or v_row.operation <> p_operation then
    raise exception 'Idempotency key reused for a different operation' using errcode = '22023';
  end if;
  if v_row.request_hash <> v_hash then
    raise exception 'Idempotency key reused with different data' using errcode = '22023';
  end if;

  return coalesce(v_row.result, '{}'::jsonb);
end;
$$;

create or replace function public._idem_finish(p_key uuid, p_result jsonb)
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
begin
  if p_key is not null then
    update public.idempotency_keys set result = p_result where key = p_key;
  end if;
  return p_result;
end;
$$;

revoke execute on function public._idem_begin(uuid, text, jsonb) from public, anon, authenticated;
revoke execute on function public._idem_finish(uuid, jsonb)     from public, anon, authenticated;

-- ---------------------------------------------------------------------
-- 3. Preimenovanje postojećih funkcija u _core (samo prvi put)
-- ---------------------------------------------------------------------
-- Stari 3-arg wrapper pravi "more than one function" konflikt -> brišemo ga.
drop function if exists public.create_order_with_items(uuid, text, jsonb);

do $$
declare
  r record;
begin
  for r in
    select * from (values
      ('record_transfer',         'uuid, uuid, text, jsonb'),
      ('record_stock_count',      'uuid, text, text, jsonb'),
      ('create_order_with_items', 'uuid, text, jsonb, uuid'),
      ('record_delivery',         'uuid, text, text, text, jsonb'),
      ('approve_request',         'uuid, jsonb'),
      ('review_order',            'uuid, uuid, text, jsonb, boolean'),
      ('resolve_delivery_lines',  'uuid[], text, text'),
      ('save_supplier',           'uuid, jsonb')
    ) v(fn, args)
  loop
    if to_regprocedure(format('public._%s_core(%s)', r.fn, r.args)) is null then
      execute format('alter function public.%I(%s) rename to %I', r.fn, r.args, '_' || r.fn || '_core');
    end if;
    -- core više ne sme da se zove direktno iz klijenta
    execute format('revoke execute on function public.%I(%s) from public, anon, authenticated',
                   '_' || r.fn || '_core', r.args);
  end loop;
end $$;

-- ---------------------------------------------------------------------
-- 4. Wrapperi (isto ime, isti parametri + p_idempotency_key)
--    Rezultat se čuva kao {"result": <povratna vrednost>}
-- ---------------------------------------------------------------------

-- record_transfer -> text
create or replace function public.record_transfer(
  p_from_object_id uuid, p_to_object_id uuid, p_reason text, p_items jsonb,
  p_idempotency_key uuid default null)
returns text
language plpgsql security definer set search_path to 'public', 'pg_temp'
as $$
declare v_prev jsonb; v_res text;
begin
  v_prev := _idem_begin(p_idempotency_key, 'record_transfer', jsonb_build_object(
    'from', p_from_object_id, 'to', p_to_object_id, 'reason', p_reason, 'items', p_items));
  if v_prev is not null then return v_prev->>'result'; end if;

  v_res := _record_transfer_core(p_from_object_id, p_to_object_id, p_reason, p_items);
  perform _idem_finish(p_idempotency_key, jsonb_build_object('result', v_res));
  return v_res;
end $$;

-- record_stock_count -> uuid
-- (import_opening_balance ga zove sa 4 argumenta -> ključ null -> radi kao pre)
create or replace function public.record_stock_count(
  p_object_id uuid, p_counted_by text, p_note text, p_items jsonb,
  p_idempotency_key uuid default null)
returns uuid
language plpgsql security definer set search_path to 'public', 'pg_temp'
as $$
declare v_prev jsonb; v_res uuid;
begin
  v_prev := _idem_begin(p_idempotency_key, 'record_stock_count', jsonb_build_object(
    'object', p_object_id, 'counted_by', p_counted_by, 'note', p_note, 'items', p_items));
  if v_prev is not null then return (v_prev->>'result')::uuid; end if;

  v_res := _record_stock_count_core(p_object_id, p_counted_by, p_note, p_items);
  perform _idem_finish(p_idempotency_key, jsonb_build_object('result', v_res));
  return v_res;
end $$;

-- create_order_with_items -> uuid
create or replace function public.create_order_with_items(
  p_object_id uuid, p_comment text, p_items jsonb, p_supplier_id uuid default null,
  p_idempotency_key uuid default null)
returns uuid
language plpgsql security definer set search_path to 'public', 'pg_temp'
as $$
declare v_prev jsonb; v_res uuid;
begin
  v_prev := _idem_begin(p_idempotency_key, 'create_order_with_items', jsonb_build_object(
    'object', p_object_id, 'comment', p_comment, 'items', p_items, 'supplier', p_supplier_id));
  if v_prev is not null then return (v_prev->>'result')::uuid; end if;

  v_res := _create_order_with_items_core(p_object_id, p_comment, p_items, p_supplier_id);
  perform _idem_finish(p_idempotency_key, jsonb_build_object('result', v_res));
  return v_res;
end $$;

-- record_delivery -> uuid
create or replace function public.record_delivery(
  p_order_id uuid, p_carrier text, p_received_by text, p_note text, p_items jsonb,
  p_idempotency_key uuid default null)
returns uuid
language plpgsql security definer set search_path to 'public', 'pg_temp'
as $$
declare v_prev jsonb; v_res uuid;
begin
  v_prev := _idem_begin(p_idempotency_key, 'record_delivery', jsonb_build_object(
    'order', p_order_id, 'carrier', p_carrier, 'received_by', p_received_by,
    'note', p_note, 'items', p_items));
  if v_prev is not null then return (v_prev->>'result')::uuid; end if;

  v_res := _record_delivery_core(p_order_id, p_carrier, p_received_by, p_note, p_items);
  perform _idem_finish(p_idempotency_key, jsonb_build_object('result', v_res));
  return v_res;
end $$;

-- approve_request -> jsonb
create or replace function public.approve_request(
  p_order_id uuid, p_lines jsonb,
  p_idempotency_key uuid default null)
returns jsonb
language plpgsql security definer set search_path to 'public', 'pg_temp'
as $$
declare v_prev jsonb; v_res jsonb;
begin
  v_prev := _idem_begin(p_idempotency_key, 'approve_request', jsonb_build_object(
    'order', p_order_id, 'lines', p_lines));
  if v_prev is not null then return v_prev->'result'; end if;

  v_res := _approve_request_core(p_order_id, p_lines);
  perform _idem_finish(p_idempotency_key, jsonb_build_object('result', v_res));
  return v_res;
end $$;

-- review_order -> jsonb
create or replace function public.review_order(
  p_order_id uuid, p_supplier_id uuid, p_comment text, p_lines jsonb, p_approve boolean default false,
  p_idempotency_key uuid default null)
returns jsonb
language plpgsql security definer set search_path to 'public', 'pg_temp'
as $$
declare v_prev jsonb; v_res jsonb;
begin
  v_prev := _idem_begin(p_idempotency_key, 'review_order', jsonb_build_object(
    'order', p_order_id, 'supplier', p_supplier_id, 'comment', p_comment,
    'lines', p_lines, 'approve', p_approve));
  if v_prev is not null then return v_prev->'result'; end if;

  v_res := _review_order_core(p_order_id, p_supplier_id, p_comment, p_lines, p_approve);
  perform _idem_finish(p_idempotency_key, jsonb_build_object('result', v_res));
  return v_res;
end $$;

-- resolve_delivery_lines -> jsonb
create or replace function public.resolve_delivery_lines(
  p_line_ids uuid[], p_resolution text, p_note text default null,
  p_idempotency_key uuid default null)
returns jsonb
language plpgsql security definer set search_path to 'public', 'pg_temp'
as $$
declare v_prev jsonb; v_res jsonb;
begin
  v_prev := _idem_begin(p_idempotency_key, 'resolve_delivery_lines', jsonb_build_object(
    'lines', to_jsonb(p_line_ids), 'resolution', p_resolution, 'note', p_note));
  if v_prev is not null then return v_prev->'result'; end if;

  v_res := _resolve_delivery_lines_core(p_line_ids, p_resolution, p_note);
  perform _idem_finish(p_idempotency_key, jsonb_build_object('result', v_res));
  return v_res;
end $$;

-- save_supplier -> uuid
create or replace function public.save_supplier(
  p_id uuid, p_data jsonb,
  p_idempotency_key uuid default null)
returns uuid
language plpgsql security definer set search_path to 'public', 'pg_temp'
as $$
declare v_prev jsonb; v_res uuid;
begin
  v_prev := _idem_begin(p_idempotency_key, 'save_supplier', jsonb_build_object(
    'id', p_id, 'data', p_data));
  if v_prev is not null then return (v_prev->>'result')::uuid; end if;

  v_res := _save_supplier_core(p_id, p_data);
  perform _idem_finish(p_idempotency_key, jsonb_build_object('result', v_res));
  return v_res;
end $$;

-- ---------------------------------------------------------------------
-- 5. Nove RPC: prodaja i ručni movement (do sada direktan insert)
--    Unutar security definer funkcije guard_stock_movement preskače
--    "direct API" proveru, zato su te provere ponovljene ovde.
-- ---------------------------------------------------------------------
create or replace function public.record_sale(
  p_object_id uuid, p_lines jsonb, p_note text default null,
  p_idempotency_key uuid default null)
returns jsonb
language plpgsql security definer set search_path to 'public', 'pg_temp'
as $$
declare
  v_prev  jsonb;
  v_ref   text;
  v_count int;
  v_bad   text;
  v_res   jsonb;
begin
  if auth.uid() is null then
    raise exception 'Not signed in' using errcode = '42501';
  end if;
  if p_object_id is null then
    raise exception 'Store is required.' using errcode = '22023';
  end if;

  v_prev := _idem_begin(p_idempotency_key, 'record_sale', jsonb_build_object(
    'object', p_object_id, 'lines', p_lines, 'note', p_note));
  if v_prev is not null then return v_prev->'result'; end if;

  -- isto što je ranije radio RLS (demo sandbox) + guard (assert_object_access)
  if is_demo() and p_object_id is distinct from demo_object_id() then
    raise exception 'DEMO_READONLY' using errcode = '42501';
  end if;
  perform assert_object_access(p_object_id);
  perform set_config('stockflow.allow_negative', 'off', true);

  if p_lines is null or jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) = 0 then
    raise exception 'Add at least one product.' using errcode = '22023';
  end if;
  if exists (
    select 1 from jsonb_array_elements(p_lines) x
    where coalesce(x->>'product_id', '') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
       or coalesce(x->>'qty', '') !~ '^[0-9]{1,7}$'
       or (x->>'qty')::int <= 0
  ) then
    raise exception 'Every line needs a product and a quantity above zero.' using errcode = '22023';
  end if;

  drop table if exists pg_temp._sale;
  create temp table _sale on commit drop as
  select (x->>'product_id')::uuid as product_id, sum((x->>'qty')::int)::int as qty
  from jsonb_array_elements(p_lines) x
  group by 1;

  select string_agg(s.product_id::text, ', ') into v_bad
  from _sale s left join products p on p.id = s.product_id
  where p.id is null;
  if v_bad is not null then
    raise exception 'Product not found: %.', v_bad using errcode = '22023';
  end if;

  v_ref := 'sale:' || coalesce(p_idempotency_key, gen_random_uuid())::text;

  -- unit_price/unit_cost/currency popunjava guard_stock_movement iz proizvoda
  insert into stock_movements (object_id, product_id, event, quantity, reference, note, created_by)
  select p_object_id, s.product_id, 'SALE', -s.qty, v_ref,
         nullif(btrim(coalesce(p_note, '')), ''), auth.uid()
  from _sale s
  order by s.product_id;                       -- isti redosled zaključavanja
  get diagnostics v_count = row_count;

  v_res := jsonb_build_object('reference', v_ref, 'lines', v_count);
  perform _idem_finish(p_idempotency_key, jsonb_build_object('result', v_res));
  return v_res;
end $$;

create or replace function public.record_movement(
  p_object_id uuid, p_product_id uuid, p_event text, p_quantity int, p_note text default null,
  p_idempotency_key uuid default null)
returns jsonb
language plpgsql security definer set search_path to 'public', 'pg_temp'
as $$
declare
  v_prev  jsonb;
  v_event text := upper(btrim(coalesce(p_event, '')));
  v_id    uuid;
  v_res   jsonb;
begin
  if auth.uid() is null then
    raise exception 'Not signed in' using errcode = '42501';
  end if;

  v_prev := _idem_begin(p_idempotency_key, 'record_movement', jsonb_build_object(
    'object', p_object_id, 'product', p_product_id, 'event', v_event,
    'quantity', p_quantity, 'note', p_note));
  if v_prev is not null then return v_prev->'result'; end if;

  if is_demo() and p_object_id is distinct from demo_object_id() then
    raise exception 'DEMO_READONLY' using errcode = '42501';
  end if;
  perform assert_object_access(p_object_id);
  perform set_config('stockflow.allow_negative', 'off', true);

  -- iste provere kao guard_stock_movement za direktne pozive
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

  insert into stock_movements (object_id, product_id, event, quantity, reference, note, created_by)
  values (p_object_id, p_product_id, v_event::movement_event, p_quantity, 'manual',
          nullif(btrim(coalesce(p_note, '')), ''), auth.uid())
  returning id into v_id;

  v_res := jsonb_build_object('id', v_id);
  perform _idem_finish(p_idempotency_key, jsonb_build_object('result', v_res));
  return v_res;
end $$;

-- ---------------------------------------------------------------------
-- 6. Prava
-- ---------------------------------------------------------------------
do $$
declare s text;
begin
  foreach s in array array[
    'record_transfer(uuid, uuid, text, jsonb, uuid)',
    'record_stock_count(uuid, text, text, jsonb, uuid)',
    'create_order_with_items(uuid, text, jsonb, uuid, uuid)',
    'record_delivery(uuid, text, text, text, jsonb, uuid)',
    'approve_request(uuid, jsonb, uuid)',
    'review_order(uuid, uuid, text, jsonb, boolean, uuid)',
    'resolve_delivery_lines(uuid[], text, text, uuid)',
    'save_supplier(uuid, jsonb, uuid)',
    'record_sale(uuid, jsonb, text, uuid)',
    'record_movement(uuid, uuid, text, integer, text, uuid)'
  ] loop
    execute format('revoke execute on function public.%s from public, anon', s);
    execute format('grant execute on function public.%s to authenticated, service_role', s);
  end loop;
end $$;

commit;

-- PostgREST mora da vidi nove potpise
notify pgrst, 'reload schema';
