begin;

-- Rejected goods are physically at the receiving location but are NOT saleable inventory.
-- Keep custody separate from stock_movements so runway/on-hand never counts rejected goods.
create table if not exists public.held_stock (
  id uuid primary key default gen_random_uuid(),
  object_id uuid not null references public.objects(id),
  product_id uuid not null references public.products(id),
  delivery_id uuid not null references public.deliveries(id),
  delivery_item_id uuid not null references public.delivery_items(id),
  source_reason text,
  quantity integer not null check (quantity > 0),
  remaining_qty integer not null check (remaining_qty >= 0 and remaining_qty <= quantity),
  status text not null default 'HELD' check (status in ('HELD','PARTIALLY_DISPOSED','CLOSED')),
  created_at timestamptz not null default now(),
  created_by uuid default auth.uid(),
  closed_at timestamptz,
  unique(delivery_item_id)
);

create table if not exists public.held_stock_dispositions (
  id uuid primary key default gen_random_uuid(),
  held_stock_id uuid not null references public.held_stock(id),
  quantity integer not null check (quantity > 0),
  disposition_type text not null check (disposition_type in ('RETURN_IMMEDIATE','RETURN_LATER','DISPOSED')),
  -- Generic external dispatch reference. For Serbia RETURN_IMMEDIATE is the special same-vehicle case
  -- and normally has no new dispatch document; it is stated in the receipt acknowledgement/e-Prijemnica.
  dispatch_provider text,
  dispatch_document_number text,
  dispatch_external_id text,
  note text,
  disposed_by uuid not null default auth.uid(),
  disposed_at timestamptz not null default now()
);

alter table public.held_stock enable row level security;
alter table public.held_stock_dispositions enable row level security;
create policy held_stock_read on public.held_stock for select to authenticated using (true);
create policy held_stock_dispositions_read on public.held_stock_dispositions for select to authenticated using (true);
revoke insert,update,delete on public.held_stock from anon,authenticated;
revoke insert,update,delete on public.held_stock_dispositions from anon,authenticated;

-- Automatically put every future rejected quantity in physical custody.
create or replace function public.capture_rejected_to_held_stock()
returns trigger language plpgsql security definer set search_path='public','pg_temp' as $$
declare v_object uuid;
begin
  if new.rejected_qty is null or new.rejected_qty <= 0 then return new; end if;
  select object_id into v_object from deliveries where id=new.delivery_id;
  insert into held_stock(object_id,product_id,delivery_id,delivery_item_id,source_reason,quantity,remaining_qty,created_by)
  values(v_object,new.product_id,new.delivery_id,new.id,new.reason_code,new.rejected_qty,new.rejected_qty,auth.uid())
  on conflict(delivery_item_id) do nothing;
  return new;
end $$;
drop trigger if exists capture_rejected_hold on public.delivery_items;
create trigger capture_rejected_hold after insert on public.delivery_items
for each row execute function public.capture_rejected_to_held_stock();

-- Safe backfill: only unresolved historic rejected rows may still physically be on site.
insert into public.held_stock(object_id,product_id,delivery_id,delivery_item_id,source_reason,quantity,remaining_qty,created_by)
select d.object_id,di.product_id,d.id,di.id,di.reason_code,di.rejected_qty,di.rejected_qty,di.resolved_by
from delivery_items di join deliveries d on d.id=di.delivery_id
where di.rejected_qty>0 and coalesce(di.resolution_status,'open')='open'
on conflict(delivery_item_id) do nothing;

create or replace function public.held_stock_for_line(p_delivery_item_id uuid)
returns jsonb language sql stable set search_path='public' as $$
select to_jsonb(x) from (
  select h.id,h.quantity,h.remaining_qty,h.status,h.source_reason,h.created_at,
         coalesce((select jsonb_agg(jsonb_build_object(
           'id',hd.id,'quantity',hd.quantity,'type',hd.disposition_type,'provider',hd.dispatch_provider,
           'document_number',hd.dispatch_document_number,'external_id',hd.dispatch_external_id,
           'note',hd.note,'disposed_at',hd.disposed_at) order by hd.disposed_at desc)
           from held_stock_dispositions hd where hd.held_stock_id=h.id),'[]'::jsonb) dispositions
  from held_stock h where h.delivery_item_id=p_delivery_item_id
) x;
$$;
grant execute on function public.held_stock_for_line(uuid) to authenticated,service_role;

create or replace function public.dispose_held_stock(
  p_held_stock_id uuid,
  p_quantity integer,
  p_disposition_type text,
  p_dispatch_provider text default null,
  p_dispatch_document_number text default null,
  p_dispatch_external_id text default null,
  p_note text default null,
  p_idempotency_key uuid default null
) returns jsonb
language plpgsql security definer set search_path='public','pg_temp' as $$
declare
  v_prev jsonb; h held_stock%rowtype; v_type text:=upper(btrim(coalesce(p_disposition_type,'')));
  v_profile text:=app_compliance_profile(); v_disp_id uuid; v_result jsonb; v_remaining int;
begin
  if auth.uid() is null then raise exception 'Not signed in' using errcode='42501'; end if;
  if not is_admin() then raise exception 'Only admins can dispose held goods' using errcode='42501'; end if;
  if is_demo() then raise exception 'Demo account is read-only' using errcode='42501'; end if;
  if p_quantity is null or p_quantity<=0 then raise exception 'Quantity must be positive' using errcode='22023'; end if;
  if v_type not in ('RETURN_IMMEDIATE','RETURN_LATER','DISPOSED') then raise exception 'Invalid disposition %',v_type using errcode='22023'; end if;

  v_prev:=_idem_begin(p_idempotency_key,'dispose_held_stock',jsonb_build_object(
    'held',p_held_stock_id,'qty',p_quantity,'type',v_type,'provider',p_dispatch_provider,
    'document',p_dispatch_document_number,'external_id',p_dispatch_external_id,'note',p_note));
  if v_prev is not null then return v_prev->'result'; end if;

  select * into h from held_stock where id=p_held_stock_id for update;
  if h.id is null then raise exception 'Held stock not found' using errcode='P0002'; end if;
  perform assert_object_access(h.object_id);
  if p_quantity>h.remaining_qty then raise exception 'Only % unit(s) remain held',h.remaining_qty using errcode='22023'; end if;

  if v_type='RETURN_IMMEDIATE' and v_profile='SERBIA' then
    -- Same-vehicle return is documented in the receipt acknowledgement rather than by a new dispatch reference.
    if not exists(select 1 from external_documents x where x.entity_type='DELIVERY' and x.entity_id=h.delivery_id and x.document_type='RECEIPT') then
      raise exception 'Record the e-Prijemnica reference before confirming a same-vehicle return.' using errcode='22023';
    end if;
  end if;

  if v_type='RETURN_LATER' and nullif(btrim(coalesce(p_dispatch_document_number,'')),'') is null then
    raise exception 'A later return requires a dispatch document reference.' using errcode='22023';
  end if;
  if v_type='DISPOSED' and nullif(btrim(coalesce(p_note,'')),'') is null then
    raise exception 'A disposal reason/note is required.' using errcode='22023';
  end if;

  insert into held_stock_dispositions(held_stock_id,quantity,disposition_type,dispatch_provider,
    dispatch_document_number,dispatch_external_id,note,disposed_by)
  values(h.id,p_quantity,v_type,nullif(upper(btrim(coalesce(p_dispatch_provider,''))),''),
    nullif(btrim(coalesce(p_dispatch_document_number,'')),''),nullif(btrim(coalesce(p_dispatch_external_id,'')),''),
    nullif(btrim(coalesce(p_note,'')),''),auth.uid()) returning id into v_disp_id;

  -- The outbound reference belongs to this disposition and stays in held_stock_dispositions.
  -- This deliberately avoids overwriting/merging multiple later returns on the same GRN.
  -- A future connector can sync every disposition independently to SEO/Teron/SAP/etc.

  v_remaining:=h.remaining_qty-p_quantity;
  update held_stock set remaining_qty=v_remaining,
    status=case when v_remaining=0 then 'CLOSED' else 'PARTIALLY_DISPOSED' end,
    closed_at=case when v_remaining=0 then now() else null end
  where id=h.id;

  v_result:=jsonb_build_object('id',v_disp_id,'remaining_qty',v_remaining,'status',case when v_remaining=0 then 'CLOSED' else 'PARTIALLY_DISPOSED' end);
  perform _idem_finish(p_idempotency_key,jsonb_build_object('result',v_result));
  return v_result;
end $$;
revoke execute on function public.dispose_held_stock(uuid,integer,text,text,text,text,text,uuid) from public,anon;
grant execute on function public.dispose_held_stock(uuid,integer,text,text,text,text,text,uuid) to authenticated,service_role;

-- Read model for a future operations/held-stock page.
create or replace view public.held_stock_overview as
select h.id,h.object_id,o.name object_name,h.product_id,p.sku,p.name product_name,h.delivery_id,d.delivery_number,
       h.delivery_item_id,h.source_reason,h.quantity,h.remaining_qty,h.status,h.created_at
from held_stock h join objects o on o.id=h.object_id join products p on p.id=h.product_id join deliveries d on d.id=h.delivery_id;
grant select on public.held_stock_overview to authenticated,service_role;

commit;
notify pgrst,'reload schema';

select status,count(*) as lines,sum(remaining_qty) as units from held_stock group by status order by status;
