begin;

-- Phase 1: separate what arrived physically from what enters usable stock.
alter table public.deliveries
  add column if not exists dispatch_document_type text,
  add column if not exists dispatch_document_number text,
  add column if not exists dispatch_external_id text,
  add column if not exists physical_receipt_at timestamptz,
  add column if not exists ereceipt_status text not null default 'NOT_CONNECTED',
  add column if not exists ereceipt_number text,
  add column if not exists ereceipt_external_id text,
  add column if not exists ereceipt_sent_at timestamptz;

alter table public.delivery_items
  add column if not exists physical_qty integer,
  add column if not exists accepted_qty integer,
  add column if not exists rejected_qty integer;

-- Existing receipts remain exactly as they were: everything previously delivered was accepted.
update public.delivery_items
set physical_qty = delivered_qty,
    accepted_qty = delivered_qty,
    rejected_qty = 0
where physical_qty is null or accepted_qty is null or rejected_qty is null;

alter table public.delivery_items
  alter column physical_qty set not null,
  alter column accepted_qty set not null,
  alter column rejected_qty set not null;

alter table public.delivery_items
  add constraint delivery_items_physical_nonnegative check (physical_qty >= 0),
  add constraint delivery_items_accepted_nonnegative check (accepted_qty >= 0),
  add constraint delivery_items_rejected_nonnegative check (rejected_qty >= 0),
  add constraint delivery_items_split_check check (accepted_qty + rejected_qty = physical_qty);

alter table public.deliveries
  add constraint deliveries_dispatch_type_check
    check (dispatch_document_type is null or dispatch_document_type in ('E_OTPREMNICA','DELIVERY_NOTE','OTHER')),
  add constraint deliveries_ereceipt_status_check
    check (ereceipt_status in ('NOT_CONNECTED','PENDING','SENT','ACCEPTED','PARTIALLY_ACCEPTED','REJECTED','DISPUTED'));

-- Keep delivered_qty during transition. It means accepted into usable stock.
comment on column public.delivery_items.delivered_qty is 'Backward-compatible alias of accepted_qty during Phase 1.';
comment on column public.delivery_items.physical_qty is 'Quantity physically unloaded/count-confirmed.';
comment on column public.delivery_items.accepted_qty is 'Quantity accepted into usable inventory.';
comment on column public.delivery_items.rejected_qty is 'Quantity physically received but rejected from usable inventory.';

create or replace view public.order_fulfillment as
select
  oi.id as order_item_id,
  oi.order_id,
  oi.product_id,
  oi.quantity as ordered_qty,

  -- Postojeće kolone moraju ostati istim redosledom.
  di.delivered_qty,
  di.physical_qty - oi.quantity as variance,
  di.reason,
  d.id as delivery_id,
  d.delivered_at,

  -- Nove kolone smeju samo na kraj postojećeg view-a.
  di.physical_qty,
  di.accepted_qty,
  di.rejected_qty,
  di.reason_code

from public.order_items oi
left join public.delivery_items di
  on di.order_item_id = oi.id
left join public.deliveries d
  on d.id = di.delivery_id;

-- New core signature. Old wrapper is replaced below.
drop function if exists public._record_delivery_core(uuid,text,text,text,jsonb);
create function public._record_delivery_core(
  p_order_id uuid,
  p_carrier text,
  p_received_by text,
  p_note text,
  p_dispatch_document_type text,
  p_dispatch_document_number text,
  p_dispatch_external_id text,
  p_physical_receipt_at timestamptz,
  p_items jsonb
) returns uuid
language plpgsql security definer set search_path='public','pg_temp'
as $$
declare
  v_delivery_id uuid; v_object_id uuid; v_status order_status; v_item jsonb;
  v_oi_id uuid; v_physical int; v_accepted int; v_rejected int; v_ordered int;
  v_reason text; v_code text; v_line_count int; v_order_lines int;
  v_doc_type text := nullif(upper(btrim(coalesce(p_dispatch_document_type,''))), '');
begin
  if auth.uid() is null then raise exception 'Not signed in' using errcode='42501'; end if;
  if p_items is null or jsonb_array_length(p_items)=0 then
    raise exception 'A delivery must record every line of the order.';
  end if;
  if v_doc_type is not null and v_doc_type not in ('E_OTPREMNICA','DELIVERY_NOTE','OTHER') then
    raise exception 'Invalid dispatch document type %.', v_doc_type using errcode='22023';
  end if;
  if nullif(btrim(coalesce(p_dispatch_document_number,'')),'') is not null and v_doc_type is null then
    raise exception 'Pick the dispatch document type.' using errcode='22023';
  end if;

  select object_id,status into v_object_id,v_status from orders where id=p_order_id for update;
  if v_object_id is null then raise exception 'Order % not found.',p_order_id; end if;
  perform assert_object_access(v_object_id);
  if v_status <> 'APPROVED' then raise exception 'Order must be APPROVED to record delivery (current: %).',v_status; end if;
  if exists(select 1 from deliveries where order_id=p_order_id) then raise exception 'This order has already been delivered.'; end if;

  select count(*) into v_order_lines from order_items where order_id=p_order_id;
  select count(distinct (x->>'order_item_id')::uuid) into v_line_count from jsonb_array_elements(p_items) x;
  if v_line_count <> v_order_lines then raise exception 'Delivery must account for all % order lines (got %).',v_order_lines,v_line_count; end if;

  insert into deliveries(order_id,object_id,carrier,received_by,recorded_by,note,
    dispatch_document_type,dispatch_document_number,dispatch_external_id,physical_receipt_at,
    ereceipt_status)
  values(p_order_id,v_object_id,nullif(btrim(p_carrier),''),nullif(btrim(p_received_by),''),auth.uid(),nullif(btrim(p_note),''),
    v_doc_type,nullif(btrim(p_dispatch_document_number),''),nullif(btrim(p_dispatch_external_id),''),
    coalesce(p_physical_receipt_at,now()),'NOT_CONNECTED')
  returning id into v_delivery_id;

  for v_item in select * from jsonb_array_elements(p_items) loop
    v_oi_id := (v_item->>'order_item_id')::uuid;
    v_physical := (v_item->>'physical_qty')::int;
    v_accepted := (v_item->>'accepted_qty')::int;
    v_reason := nullif(btrim(coalesce(v_item->>'reason','')),'');
    v_code := nullif(upper(btrim(coalesce(v_item->>'reason_code',''))),'');
    if v_physical is null or v_physical < 0 or v_accepted is null or v_accepted < 0 or v_accepted > v_physical then
      raise exception 'Physical and accepted quantities are invalid for line %.',v_oi_id using errcode='22023';
    end if;
    v_rejected := v_physical-v_accepted;
    select quantity into v_ordered from order_items where id=v_oi_id and order_id=p_order_id;
    if v_ordered is null then raise exception 'Order item % does not belong to order %.',v_oi_id,p_order_id; end if;

    if v_physical=v_ordered and v_rejected=0 then
      v_code:=null; v_reason:=null;
    else
      if v_code is null then
        v_code := case when v_rejected>0 then 'DAMAGED'
                       when v_physical<v_ordered then 'SUPPLIER_SHORT'
                       when v_physical>v_ordered then 'SUPPLIER_OVER' end;
      end if;
      if v_code not in ('SUPPLIER_SHORT','SUPPLIER_OVER','DAMAGED','WRONG_ITEM','OTHER') then
        raise exception 'Invalid delivery reason %.',v_code using errcode='22023';
      end if;
      v_reason:=coalesce(v_reason,reason_label(v_code));
    end if;

    insert into delivery_items(delivery_id,order_item_id,product_id,delivered_qty,physical_qty,accepted_qty,rejected_qty,reason,reason_code,resolution_status)
    select v_delivery_id,oi.id,oi.product_id,v_accepted,v_physical,v_accepted,v_rejected,v_reason,v_code,
           case when v_physical<>v_ordered or v_rejected>0 then 'open' else null end
    from order_items oi where oi.id=v_oi_id;

    if v_accepted>0 then
      insert into stock_movements(object_id,product_id,event,quantity,reference,note,created_by)
      select v_object_id,oi.product_id,'DELIVERY',v_accepted,'delivery:'||v_delivery_id,
             coalesce(v_reason,nullif(btrim(p_note),''),'Delivery'),auth.uid()
      from order_items oi where oi.id=v_oi_id;
    end if;
  end loop;
  update orders set status='DELIVERED' where id=p_order_id;
  return v_delivery_id;
end $$;

drop function if exists public.record_delivery(uuid,text,text,text,jsonb,uuid);
create function public.record_delivery(
  p_order_id uuid,p_carrier text,p_received_by text,p_note text,
  p_dispatch_document_type text,p_dispatch_document_number text,p_dispatch_external_id text,
  p_physical_receipt_at timestamptz,p_items jsonb,p_idempotency_key uuid default null
) returns uuid
language plpgsql security definer set search_path='public','pg_temp'
as $$
declare v_prev jsonb; v_res uuid;
begin
  v_prev:=_idem_begin(p_idempotency_key,'record_delivery',jsonb_build_object(
    'order',p_order_id,'carrier',p_carrier,'received_by',p_received_by,'note',p_note,
    'dispatch_type',p_dispatch_document_type,'dispatch_number',p_dispatch_document_number,
    'dispatch_external_id',p_dispatch_external_id,'physical_receipt_at',p_physical_receipt_at,'items',p_items));
  if v_prev is not null then return (v_prev->>'result')::uuid; end if;
  v_res:=_record_delivery_core(p_order_id,p_carrier,p_received_by,p_note,p_dispatch_document_type,
    p_dispatch_document_number,p_dispatch_external_id,p_physical_receipt_at,p_items);
  perform _idem_finish(p_idempotency_key,jsonb_build_object('result',v_res));
  return v_res;
end $$;

revoke execute on function public.record_delivery(uuid,text,text,text,text,text,text,timestamptz,jsonb,uuid) from public,anon;
grant execute on function public.record_delivery(uuid,text,text,text,text,text,text,timestamptz,jsonb,uuid) to authenticated,service_role;

create or replace function public.goods_receipt(p_delivery_id uuid) returns jsonb
language sql stable set search_path='public' as $$
select jsonb_build_object(
 'currency',app_currency(),
 'delivery',jsonb_build_object('id',d.id,'delivery_number',d.delivery_number,'delivered_at',d.delivered_at,
   'received_by',d.received_by,'carrier',d.carrier,'note',d.note,
   'dispatch_document_type',d.dispatch_document_type,'dispatch_document_number',d.dispatch_document_number,
   'dispatch_external_id',d.dispatch_external_id,'physical_receipt_at',d.physical_receipt_at,
   'ereceipt_status',d.ereceipt_status,'ereceipt_number',d.ereceipt_number,
   'ereceipt_external_id',d.ereceipt_external_id,'ereceipt_sent_at',d.ereceipt_sent_at),
 'order',jsonb_build_object('id',o.id,'order_number',o.order_number,'status',o.status,'comment',o.comment,
   'approved_at',o.approved_at,'company',o.company_snapshot,'supplier',o.supplier_snapshot,'deliver_to',o.delivery_snapshot),
 'object_name',ob.name,
 'lines',coalesce((select jsonb_agg(l order by l.open desc,l.product_name) from (
   select di.id line_id,oi.id order_item_id,oi.product_id,p.sku,p.name product_name,oi.quantity ordered_qty,
     di.physical_qty,di.accepted_qty,di.rejected_qty,
     di.accepted_qty received_qty,di.physical_qty-oi.quantity variance,
     oi.quantity-coalesce(di.physical_qty,0) shortage_qty,
     coalesce(oi.unit_cost,p.cost_price) unit_cost,
     round(oi.quantity*coalesce(oi.unit_cost,p.cost_price),2) ordered_value,
     round(di.accepted_qty*coalesce(oi.unit_cost,p.cost_price),2) received_value,
     round((di.physical_qty-oi.quantity)*coalesce(oi.unit_cost,p.cost_price),2) variance_value,
     di.reason_code,di.reason,di.resolution_status,di.resolution,di.resolution_note,di.resolved_at,
     bo.order_number backorder_number,(di.resolution_status='open') open
   from order_items oi join products p on p.id=oi.product_id
   left join delivery_items di on di.order_item_id=oi.id and di.delivery_id=d.id
   left join orders bo on bo.id=di.backorder_id where oi.order_id=d.order_id) l),'[]'::jsonb))
from deliveries d join orders o on o.id=d.order_id join objects ob on ob.id=d.object_id
where d.id=p_delivery_id;
$$;

-- Exceptions now include quantity differences OR quality rejection.
drop function if exists public.delivery_exceptions(text,uuid,uuid);
create function public.delivery_exceptions(p_status text default 'open',p_object_id uuid default null,p_delivery_id uuid default null)
returns table(line_id uuid,delivery_id uuid,delivery_number text,delivered_at timestamptz,received_by text,
 order_id uuid,order_number text,supplier_name text,object_id uuid,object_name text,product_id uuid,sku text,product_name text,
 ordered_qty integer,delivered_qty integer,variance integer,reason_code text,reason text,variance_value numeric,
 resolution_status text,resolution text,resolution_note text,resolved_at timestamptz,backorder_id uuid,backorder_number text)
language sql stable set search_path='public' as $$
select di.id,d.id,d.delivery_number,d.delivered_at,d.received_by,o.id,o.order_number,o.supplier_snapshot->>'name',
 d.object_id,ob.name,di.product_id,p.sku,p.name,oi.quantity,di.accepted_qty,di.physical_qty-oi.quantity,
 di.reason_code,di.reason,
 case when coalesce(oi.unit_cost,p.cost_price) is not null then round((abs(di.physical_qty-oi.quantity)+di.rejected_qty)*coalesce(oi.unit_cost,p.cost_price),2) end,
 di.resolution_status,di.resolution,di.resolution_note,di.resolved_at,di.backorder_id,bo.order_number
from delivery_items di join order_items oi on oi.id=di.order_item_id join deliveries d on d.id=di.delivery_id
join orders o on o.id=d.order_id join objects ob on ob.id=d.object_id join products p on p.id=di.product_id
left join orders bo on bo.id=di.backorder_id
where (di.physical_qty<>oi.quantity or di.rejected_qty>0)
 and (p_status is null or di.resolution_status=p_status)
 and (p_object_id is null or d.object_id=p_object_id) and (p_delivery_id is null or d.id=p_delivery_id)
order by d.delivered_at desc,p.name;
$$;


-- Resolution rules updated for separate quantity and quality exceptions.
create or replace function public._resolve_delivery_lines_core(p_line_ids uuid[],p_resolution text,p_note text default null)
returns jsonb language plpgsql security definer set search_path='public','pg_temp' as $$
declare
 v_res text:=upper(btrim(coalesce(p_resolution,''))); v_note text:=nullif(btrim(coalesce(p_note,'')),'');
 v_ids uuid[]; v_found int; v_receipts int; v_delivery_id uuid; v_grn text; v_object_id uuid;
 v_order_id uuid; v_order_no text; v_supplier_id uuid; v_backorder_id uuid; v_backorder_no text; v_mov uuid; r record;
begin
 if auth.uid() is null then raise exception 'Not signed in' using errcode='42501'; end if;
 if not is_admin() then raise exception 'Only admins can resolve delivery differences' using errcode='42501'; end if;
 if is_demo() then raise exception 'Demo account is read-only' using errcode='42501'; end if;
 select array_agg(distinct x) into v_ids from unnest(p_line_ids)x where x is not null;
 if v_ids is null then raise exception 'Select at least one line.' using errcode='22023'; end if;
 if v_res not in ('BACKORDER','CLOSE_SHORT','CLAIM','ACCEPT','RETURN_TO_SUPPLIER') then raise exception 'Unknown resolution %.',v_res; end if;
 if v_res='CLAIM' and v_note is null then raise exception 'Add a note for the claim (claim number, agreement…).'; end if;
 perform 1 from delivery_items where id=any(v_ids) for update;
 create temp table _res_lines on commit drop as
 select di.id,di.product_id,di.physical_qty,di.accepted_qty,di.rejected_qty,di.resolution_status,
   oi.quantity ordered_qty,oi.unit_cost,
   greatest(oi.quantity-di.physical_qty,0) short_qty,
   greatest(di.physical_qty-oi.quantity,0) over_qty,
   d.id delivery_id,d.delivery_number,d.object_id,o.id order_id,o.order_number,o.supplier_id
 from delivery_items di join order_items oi on oi.id=di.order_item_id join deliveries d on d.id=di.delivery_id
 join orders o on o.id=d.order_id where di.id=any(v_ids);
 select count(*),count(distinct delivery_id) into v_found,v_receipts from _res_lines;
 if v_found<>cardinality(v_ids) then raise exception 'Some lines were not found.'; end if;
 if v_receipts<>1 then raise exception 'Resolve lines from one receipt at a time.'; end if;
 if exists(select 1 from _res_lines where short_qty=0 and over_qty=0 and rejected_qty=0) then raise exception 'A selected line has no exception.'; end if;
 if exists(select 1 from _res_lines where coalesce(resolution_status,'open')<>'open') then raise exception 'A selected difference is already resolved.'; end if;
 if v_res in ('BACKORDER','CLOSE_SHORT') and exists(select 1 from _res_lines where short_qty=0) then raise exception 'Backorder and close short only apply to short lines.'; end if;
 if v_res='ACCEPT' and exists(select 1 from _res_lines where over_qty=0 or rejected_qty>0) then raise exception 'Accept extra only applies to usable over-delivery already accepted into stock.'; end if;
 if v_res='RETURN_TO_SUPPLIER' and exists(select 1 from _res_lines where over_qty=0 and rejected_qty=0) then raise exception 'Return only applies to over-delivered or rejected units.'; end if;
 select delivery_id,delivery_number,object_id,order_id,order_number,supplier_id into v_delivery_id,v_grn,v_object_id,v_order_id,v_order_no,v_supplier_id from _res_lines limit 1;
 if v_res='BACKORDER' then
   insert into orders(object_id,status,comment,created_by,supplier_id,parent_order_id)
   values(v_object_id,'PENDING',format('Backorder for %s · %s',v_order_no,v_grn),auth.uid(),v_supplier_id,v_order_id)
   returning id into v_backorder_id;
   insert into order_items(order_id,product_id,quantity,unit_cost)
   select v_backorder_id,product_id,sum(short_qty)::int,max(unit_cost) from _res_lines group by product_id;
   update orders set status='APPROVED' where id=v_backorder_id;
   select order_number into v_backorder_no from orders where id=v_backorder_id;
 end if;
 for r in select * from _res_lines loop
   v_mov:=null;
   -- Rejected units never entered usable stock. Only accepted excess must be removed.
   if v_res='RETURN_TO_SUPPLIER' and r.over_qty>0 and r.accepted_qty>r.ordered_qty then
     insert into stock_movements(object_id,product_id,event,quantity,reference,note,created_by)
     values(r.object_id,r.product_id,'SUPPLIER_RETURN',-least(r.over_qty,r.accepted_qty-r.ordered_qty),
       'grn:'||r.delivery_id,coalesce(v_note,'Returned accepted excess · '||r.delivery_number),auth.uid()) returning id into v_mov;
   end if;
   update delivery_items set resolution_status='resolved',resolution=v_res,resolution_note=v_note,resolved_by=auth.uid(),resolved_at=now(),backorder_id=v_backorder_id,return_movement_id=v_mov where id=r.id;
 end loop;
 return jsonb_build_object('resolved',v_found,'resolution',v_res,'backorder_id',v_backorder_id,'backorder_number',v_backorder_no);
end $$;

commit;
notify pgrst,'reload schema';
