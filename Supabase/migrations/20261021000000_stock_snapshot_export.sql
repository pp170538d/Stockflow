create or replace function public.stock_snapshot()
returns table (
  store         text,
  sku           text,
  product       text,
  quantity      int,
  last_movement timestamptz
)
language sql stable security invoker
set search_path = public, pg_temp
as $$
  select o.name, p.sku, p.name,
         coalesce(i.quantity, 0),
         i.updated_at
  from public.objects o
  cross join public.products p
  left join public.inventory i
         on i.object_id = o.id and i.product_id = p.id
  order by o.name, p.name;
$$;

revoke execute on function public.stock_snapshot() from public, anon;
grant  execute on function public.stock_snapshot() to authenticated;