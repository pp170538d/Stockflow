begin;

-- A promised replacement is fulfilled through a normal APPROVED PO + normal receiving/GRN.
alter table public.supplier_claims
  add column if not exists replacement_order_id uuid references public.orders(id),
  add column if not exists replacement_received_qty integer,
  add column if not exists replacement_received_at timestamptz;

-- Existing status constraint from claims foundation did not include replacement received.
alter table public.supplier_claims drop constraint if exists supplier_claims_status_check;
alter table public.supplier_claims add constraint supplier_claims_status_check check (status in (
  'AWAITING_SUPPLIER','REPLACEMENT_PROMISED','REPLACEMENT_RECEIVED',
  'CREDIT_ACCEPTED','CLAIM_REJECTED','RESOLVED_OTHER'
));

-- Replace supplier response RPC: REPLACEMENT_PROMISED creates one approved replacement order.
create or replace function public.respond_supplier_claim(
  p_claim_id uuid,
  p_outcome text,
  p_supplier_reference text default null,
  p_response text default null,
  p_expected_replacement_at date default null,
  p_idempotency_key uuid default null
) returns jsonb
language plpgsql security definer set search_path='public','pg_temp' as $$
declare
  v_prev jsonb; r record; v_out text:=upper(btrim(coalesce(p_outcome,'')));
  v_result jsonb; v_replacement_order_id uuid; v_replacement_order_no text;
begin
  if auth.uid() is null then raise exception 'Not signed in' using errcode='42501'; end if;
  if not is_admin() then raise exception 'Only admins can record supplier responses' using errcode='42501'; end if;
  if is_demo() then raise exception 'Demo account is read-only' using errcode='42501'; end if;
  if v_out not in ('REPLACEMENT_PROMISED','CREDIT_ACCEPTED','CLAIM_REJECTED','RESOLVED_OTHER') then
    raise exception 'Invalid claim outcome %',v_out using errcode='22023';
  end if;

  v_prev:=_idem_begin(p_idempotency_key,'respond_supplier_claim',jsonb_build_object(
    'claim',p_claim_id,'outcome',v_out,'reference',p_supplier_reference,'response',p_response,
    'replacement_at',p_expected_replacement_at));
  if v_prev is not null then return v_prev->'result'; end if;

  select sc.*,d.object_id,di.order_item_id,oi.unit_cost,o.id original_order_id
  into r
  from supplier_claims sc
  join deliveries d on d.id=sc.delivery_id
  join delivery_items di on di.id=sc.delivery_item_id
  join order_items oi on oi.id=di.order_item_id
  join orders o on o.id=sc.order_id
  where sc.id=p_claim_id for update of sc;
  if r.id is null then raise exception 'Claim not found' using errcode='P0002'; end if;
  perform assert_object_access(r.object_id);
  if r.status not in ('AWAITING_SUPPLIER','REPLACEMENT_PROMISED') then raise exception 'Claim is already closed'; end if;

  if v_out='REPLACEMENT_PROMISED' then
    v_replacement_order_id:=r.replacement_order_id;
    if v_replacement_order_id is null then
      -- guard_order forces INSERT to PENDING and assigns normal order number/author.
      insert into orders(object_id,supplier_id,comment,created_by,parent_order_id)
      values(r.object_id,r.supplier_id,
        format('Replacement for %s · original %s',r.claim_number,(select order_number from orders where id=r.original_order_id)),
        auth.uid(),r.original_order_id)
      returning id into v_replacement_order_id;

      insert into order_items(order_id,product_id,quantity,unit_cost,requested_qty)
      values(v_replacement_order_id,r.product_id,r.claimed_qty,r.unit_cost,r.claimed_qty);

      -- Normal PENDING -> APPROVED transition invokes guard_order snapshots/approval audit.
      update orders set status='APPROVED' where id=v_replacement_order_id;
      update supplier_claims set replacement_order_id=v_replacement_order_id where id=p_claim_id;
    end if;
    select order_number into v_replacement_order_no from orders where id=v_replacement_order_id;

    update supplier_claims set
      status='REPLACEMENT_PROMISED',supplier_reference=nullif(btrim(p_supplier_reference),''),
      supplier_response=nullif(btrim(p_response),''),expected_replacement_at=p_expected_replacement_at,
      responded_by=auth.uid(),responded_at=now(),resolved_at=null,updated_at=now()
    where id=p_claim_id;
  else
    -- A final non-replacement commercial outcome closes the original receipt exception.
    -- Do not silently switch away from a replacement that has already been received.
    if r.replacement_order_id is not null and exists(select 1 from orders where id=r.replacement_order_id and status='DELIVERED') then
      raise exception 'Replacement has already been received; claim outcome can no longer be changed.';
    end if;
    update supplier_claims set status=v_out,supplier_reference=nullif(btrim(p_supplier_reference),''),
      supplier_response=nullif(btrim(p_response),''),expected_replacement_at=null,
      responded_by=auth.uid(),responded_at=now(),resolved_at=now(),updated_at=now()
    where id=p_claim_id;
    update delivery_items set resolution_status='resolved',resolution='CLAIM',
      resolution_note=coalesce(nullif(btrim(p_response),''),v_out),resolved_by=auth.uid(),resolved_at=now()
    where id=r.delivery_item_id;
  end if;

  v_result:=jsonb_build_object('id',p_claim_id,'claim_number',r.claim_number,'status',v_out,
    'replacement_order_id',v_replacement_order_id,'replacement_order_number',v_replacement_order_no);
  perform _idem_finish(p_idempotency_key,jsonb_build_object('result',v_result));
  return v_result;
end $$;

-- Once the replacement order is physically received through the normal Receive goods workflow,
-- close the original supplier claim only if enough replacement units were ACCEPTED into stock.
create or replace function public.finish_claim_from_replacement_order()
returns trigger language plpgsql security definer set search_path='public','pg_temp' as $$
declare r record; v_accepted int;
begin
  if tg_op<>'UPDATE' or old.status is not distinct from new.status or new.status<>'DELIVERED' then return new; end if;
  for r in select * from supplier_claims where replacement_order_id=new.id and status='REPLACEMENT_PROMISED' for update loop
    select coalesce(sum(di.accepted_qty),0)::int into v_accepted
    from deliveries d join delivery_items di on di.delivery_id=d.id
    where d.order_id=new.id and di.product_id=r.product_id;

    update supplier_claims set replacement_received_qty=v_accepted,replacement_received_at=now(),
      status=case when v_accepted>=r.claimed_qty then 'REPLACEMENT_RECEIVED' else status end,
      resolved_at=case when v_accepted>=r.claimed_qty then now() else resolved_at end,updated_at=now()
    where id=r.id;

    if v_accepted>=r.claimed_qty then
      update delivery_items set resolution_status='resolved',resolution='CLAIM',
        resolution_note=format('Replacement received via %s',new.order_number),resolved_by=auth.uid(),resolved_at=now()
      where id=r.delivery_item_id;
    end if;
  end loop;
  return new;
end $$;

drop trigger if exists finish_claim_replacement on public.orders;
create trigger finish_claim_replacement after update of status on public.orders
for each row execute function public.finish_claim_from_replacement_order();

create or replace function public.supplier_claim_for_line(p_delivery_item_id uuid)
returns jsonb language sql stable set search_path='public' as $$
select to_jsonb(x) from (
 select sc.id,sc.claim_number,sc.claimed_qty,sc.issue_code,sc.description,sc.status,
 sc.supplier_reference,sc.supplier_response,sc.expected_replacement_at,sc.created_at,sc.responded_at,sc.resolved_at,
 sc.replacement_order_id,ro.order_number replacement_order_number,ro.status replacement_order_status,
 sc.replacement_received_qty,sc.replacement_received_at,s.name supplier_name,p.name product_name
 from supplier_claims sc left join suppliers s on s.id=sc.supplier_id join products p on p.id=sc.product_id
 left join orders ro on ro.id=sc.replacement_order_id
 where sc.delivery_item_id=p_delivery_item_id order by sc.created_at desc limit 1
)x;
$$;

-- Remove the shortcut receiving function if the previous experiment installed it.
drop function if exists public.receive_claim_replacement(uuid,integer,integer,text,uuid);

commit;
notify pgrst,'reload schema';
