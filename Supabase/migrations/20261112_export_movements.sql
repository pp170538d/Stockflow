-- =========================================================
-- Export: movements (ledger) and sales for a period
-- Admin: all locations or one. Seller: only own location.
-- =========================================================
create or replace function public.export_movements(
  p_from      timestamptz,
  p_to        timestamptz,
  p_object_id uuid   default null,
  p_events    text[] default null   -- null = all events
)
returns table (
  created_at  timestamptz,
  location    text,
  sku         text,
  product     text,
  event       text,
  quantity    int,
  reference   text,
  note        text,
  user_name   text
)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_object uuid := p_object_id;
begin
  if auth.uid() is null then
    raise exception 'Not signed in' using errcode = '42501';
  end if;

  if p_from is null or p_to is null or p_to <= p_from then
    raise exception 'Invalid period' using errcode = '22023';
  end if;
  if p_to - p_from > interval '366 days' then
    raise exception 'Max period is one year' using errcode = '22023';
  end if;

  -- Seller: always own location, whatever was sent
  if not is_admin() then
    v_object := auth_object_id();
    if v_object is null then
      raise exception 'No location assigned to this user' using errcode = '42501';
    end if;
  end if;

  return query
  select
    m.created_at,
    o.name,
    p.sku,
    p.name,
    m.event::text,
    m.quantity,
    m.reference,
    m.note,
    coalesce(nullif(pr.full_name, ''), pr.email)
  from stock_movements m
  join objects  o  on o.id = m.object_id
  join products p  on p.id = m.product_id
  left join profiles pr on pr.id = m.created_by
  where m.created_at >= p_from
    and m.created_at <  p_to
    and (v_object is null or m.object_id = v_object)
    and (p_events is null or m.event::text = any (p_events))
  order by m.created_at, m.id;
end;
$$;

revoke all on function public.export_movements(timestamptz, timestamptz, uuid, text[]) from public, anon;
grant execute on function public.export_movements(timestamptz, timestamptz, uuid, text[]) to authenticated;

-- Speeds up period exports
create index if not exists idx_stock_movements_created
  on public.stock_movements (created_at);
