-- =====================================================================
-- Stockflow · PDV (VAT) u prodaji
--  * sell_price = konačna cena SA PDV-om (ono što kupac plaća)
--  * cost_price = nabavna cena BEZ PDV-a
--  * Prihod i margin se računaju BEZ PDV-a (PDV nije tvoj novac)
--  Sve u jednoj transakciji: ako bilo šta padne, ništa se ne menja.
-- =====================================================================

begin;

-- ---------------------------------------------------------------------
-- 1. Stopa PDV-a na proizvodu (podrazumevano 20%)
-- ---------------------------------------------------------------------
alter table public.products
  add column if not exists vat_rate numeric(5,2) not null default 20
  check (vat_rate in (0, 10, 20));

-- ---------------------------------------------------------------------
-- 2. Stopa i neto cena na svakoj prodaji / povraćaju (snapshot)
-- ---------------------------------------------------------------------
alter table public.stock_movements
  add column if not exists vat_rate numeric(5,2);

-- dosadašnje prodaje i povraćaji su bili po 20%
update public.stock_movements
set vat_rate = 20
where event in ('SALE', 'RETURN') and unit_price is not null and vat_rate is null;

alter table public.stock_movements
  add column if not exists unit_price_net numeric
  generated always as (
    case when unit_price is null then null
         else round(unit_price / (1 + coalesce(vat_rate, 0) / 100), 4) end
  ) stored;

-- ---------------------------------------------------------------------
-- 3. Izmene postojećih funkcija (samo tačno određeni redovi)
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
  n    text;
  opts text[];
begin
  -- guard: svaka prodaja/povraćaj pamti stopu PDV-a proizvoda u tom trenutku
  n := pg_get_functiondef('public.guard_stock_movement()'::regprocedure);
  if position('new.vat_rate' in n) = 0 then
    n := pg_temp.swap(n,
      'new.unit_cost := coalesce(new.unit_cost, d.cost_price);',
      'new.unit_cost := coalesce(new.unit_cost, d.cost_price);
  new.vat_rate := case when new.event in (''SALE'', ''RETURN'')
                       then coalesce(new.vat_rate,
                                     (select p.vat_rate from public.products p where p.id = new.product_id),
                                     20)
                  end;');
    execute n;
  end if;

  -- inventory_turnover: prihod i margin bez PDV-a
  n := pg_get_functiondef('public.inventory_turnover(integer, uuid)'::regprocedure);
  if position('unit_price_net' in n) = 0 then
    n := pg_temp.swap(n, 'm.unit_price, m.unit_cost, m.occurred_at',
                         'm.unit_price, m.unit_price_net, m.unit_cost, m.occurred_at');
    n := pg_temp.swap(n, 'sum(-quantity*unit_price) as revenue',
                         'sum(-quantity*unit_price_net) as revenue');
    n := pg_temp.swap(n, 'sum(-quantity*(unit_price-unit_cost)) as margin',
                         'sum(-quantity*(unit_price_net-unit_cost)) as margin');
    execute n;
  end if;

  -- sales_feed: prihod i margin bez PDV-a + nove kolone na kraju
  select reloptions into opts from pg_class where oid = 'public.sales_feed'::regclass;

  create or replace view public.sales_feed as
  select sm.id,
         sm.object_id,
         o.name  as object_name,
         sm.product_id,
         p.name  as product_name,
         p.sku,
         abs(sm.quantity) as units,
         sm.note,
         sm.created_by,
         sm.created_at,
         sm.occurred_at,
         sm.unit_price,
         sm.unit_cost,
         sm.currency,
         abs(sm.quantity)::numeric * sm.unit_price_net                   as revenue,
         abs(sm.quantity)::numeric * sm.unit_cost                        as cost,
         abs(sm.quantity)::numeric * (sm.unit_price_net - sm.unit_cost)  as margin,
         sm.import_batch_id,
         sm.vat_rate,
         sm.unit_price_net,
         abs(sm.quantity)::numeric * sm.unit_price                       as gross
  from stock_movements sm
  join products p on p.id = sm.product_id
  join objects  o on o.id = sm.object_id
  where sm.event = 'SALE'::movement_event;

  if opts is not null then
    execute format('alter view public.sales_feed set (%s)', array_to_string(opts, ', '));
  end if;
end $$;

commit;

notify pgrst, 'reload schema';

-- provera
select
  (select count(*) from stock_movements where event in ('SALE','RETURN') and unit_price is not null and vat_rate is null) as bez_stope,
  (select round(sum(revenue), 2) from inventory_turnover(30, null)) as prihod_30d_bez_pdv,
  (select round(sum(margin), 2)  from inventory_turnover(30, null)) as margin_30d;
