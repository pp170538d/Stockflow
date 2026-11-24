begin;

-- Generic external document links: SEO Serbia today, Teron/SAP/BC/other provider tomorrow.
create table if not exists public.external_documents (
  id uuid primary key default gen_random_uuid(),
  entity_type text not null check (entity_type in ('DELIVERY','ORDER','CLAIM','TRANSFER')),
  entity_id uuid not null,
  document_type text not null check (document_type in ('DISPATCH','RECEIPT','DELIVERY_NOTE','OTHER')),
  provider text not null default 'MANUAL',
  external_id text,
  document_number text,
  status text,
  issued_at timestamptz,
  sent_at timestamptz,
  synced_at timestamptz,
  metadata jsonb not null default '{}'::jsonb,
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(entity_type, entity_id, document_type, provider)
);

alter table public.external_documents enable row level security;
create policy external_documents_read on public.external_documents for select to authenticated using (true);
-- Writes are through SECURITY DEFINER RPCs only.
revoke insert,update,delete on public.external_documents from anon,authenticated;

-- Supplier claim = commercial/operational process, independent of SEO/e-Prijemnica.
create table if not exists public.supplier_claims (
  id uuid primary key default gen_random_uuid(),
  claim_number text not null unique,
  delivery_id uuid not null references public.deliveries(id),
  delivery_item_id uuid not null references public.delivery_items(id),
  order_id uuid not null references public.orders(id),
  supplier_id uuid references public.suppliers(id),
  product_id uuid not null references public.products(id),
  claimed_qty int not null check (claimed_qty > 0),
  issue_code text not null,
  description text not null check (btrim(description) <> ''),
  status text not null default 'AWAITING_SUPPLIER' check (status in (
    'AWAITING_SUPPLIER','REPLACEMENT_PROMISED','CREDIT_ACCEPTED','CLAIM_REJECTED','RESOLVED_OTHER'
  )),
  supplier_reference text,
  supplier_response text,
  expected_replacement_at date,
  created_by uuid not null default auth.uid(),
  created_at timestamptz not null default now(),
  responded_by uuid,
  responded_at timestamptz,
  resolved_at timestamptz,
  updated_at timestamptz not null default now()
);

create unique index if not exists supplier_claims_one_active_per_line
on public.supplier_claims(delivery_item_id)
where status in ('AWAITING_SUPPLIER','REPLACEMENT_PROMISED');

alter table public.supplier_claims enable row level security;
create policy supplier_claims_read on public.supplier_claims for select to authenticated using (true);
revoke insert,update,delete on public.supplier_claims from anon,authenticated;

create sequence if not exists public.supplier_claim_seq start 1;

create or replace function public.create_supplier_claim(
  p_delivery_item_id uuid,
  p_description text,
  p_idempotency_key uuid default null
) returns jsonb
language plpgsql security definer set search_path='public','pg_temp' as $$
declare
  v_prev jsonb; v_claim_id uuid; v_claim_no text; r record; v_qty int; v_result jsonb;
begin
  if auth.uid() is null then raise exception 'Not signed in' using errcode='42501'; end if;
  if not is_admin() then raise exception 'Only admins can create supplier claims' using errcode='42501'; end if;
  if is_demo() then raise exception 'Demo account is read-only' using errcode='42501'; end if;
  if nullif(btrim(coalesce(p_description,'')),'') is null then raise exception 'Claim description is required' using errcode='22023'; end if;

  v_prev:=_idem_begin(p_idempotency_key,'create_supplier_claim',jsonb_build_object('line',p_delivery_item_id,'description',p_description));
  if v_prev is not null then return v_prev->'result'; end if;

  select di.id line_id,di.product_id,di.reason_code,di.physical_qty,di.accepted_qty,di.rejected_qty,
         di.resolution_status,d.id delivery_id,d.object_id,o.id order_id,o.supplier_id
  into r from delivery_items di join deliveries d on d.id=di.delivery_id join orders o on o.id=d.order_id
  where di.id=p_delivery_item_id for update of di;
  if r.line_id is null then raise exception 'Delivery exception not found' using errcode='P0002'; end if;
  perform assert_object_access(r.object_id);
  if coalesce(r.resolution_status,'open') <> 'open' then raise exception 'This exception is already resolved'; end if;
  if exists(select 1 from supplier_claims where delivery_item_id=r.line_id and status in ('AWAITING_SUPPLIER','REPLACEMENT_PROMISED')) then
    raise exception 'This exception already has an active supplier claim';
  end if;
  v_qty:=case when r.rejected_qty>0 then r.rejected_qty
              when r.physical_qty is not null and r.physical_qty<>0 then abs(r.physical_qty-(select quantity from order_items where id=(select order_item_id from delivery_items where id=r.line_id)))
              else 1 end;
  v_qty:=greatest(v_qty,1);
  v_claim_no:='CLM-'||to_char(current_date,'YYYY')||'-'||lpad(nextval('supplier_claim_seq')::text,6,'0');
  insert into supplier_claims(claim_number,delivery_id,delivery_item_id,order_id,supplier_id,product_id,claimed_qty,issue_code,description)
  values(v_claim_no,r.delivery_id,r.line_id,r.order_id,r.supplier_id,r.product_id,v_qty,coalesce(r.reason_code,'OTHER'),btrim(p_description)) returning id into v_claim_id;

  -- IMPORTANT: the delivery exception stays OPEN. Claim creation is not resolution.
  v_result:=jsonb_build_object('id',v_claim_id,'claim_number',v_claim_no,'status','AWAITING_SUPPLIER');
  perform _idem_finish(p_idempotency_key,jsonb_build_object('result',v_result));
  return v_result;
end $$;

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
  v_prev jsonb; r record; v_out text:=upper(btrim(coalesce(p_outcome,''))); v_status text; v_result jsonb;
begin
  if auth.uid() is null then raise exception 'Not signed in' using errcode='42501'; end if;
  if not is_admin() then raise exception 'Only admins can record supplier responses' using errcode='42501'; end if;
  if is_demo() then raise exception 'Demo account is read-only' using errcode='42501'; end if;
  if v_out not in ('REPLACEMENT_PROMISED','CREDIT_ACCEPTED','CLAIM_REJECTED','RESOLVED_OTHER') then raise exception 'Invalid claim outcome %',v_out using errcode='22023'; end if;
  v_prev:=_idem_begin(p_idempotency_key,'respond_supplier_claim',jsonb_build_object('claim',p_claim_id,'outcome',v_out,'reference',p_supplier_reference,'response',p_response,'replacement_at',p_expected_replacement_at));
  if v_prev is not null then return v_prev->'result'; end if;

  select sc.*,d.object_id into r from supplier_claims sc join deliveries d on d.id=sc.delivery_id where sc.id=p_claim_id for update of sc;
  if r.id is null then raise exception 'Claim not found' using errcode='P0002'; end if;
  perform assert_object_access(r.object_id);
  if r.status not in ('AWAITING_SUPPLIER','REPLACEMENT_PROMISED') then raise exception 'Claim is already closed'; end if;
  v_status:=v_out;
  update supplier_claims set status=v_status,supplier_reference=nullif(btrim(p_supplier_reference),''),supplier_response=nullif(btrim(p_response),''),expected_replacement_at=case when v_out='REPLACEMENT_PROMISED' then p_expected_replacement_at end,responded_by=auth.uid(),responded_at=now(),resolved_at=case when v_out='REPLACEMENT_PROMISED' then null else now() end,updated_at=now() where id=p_claim_id;

  -- Replacement promised remains an open operational exception until replacement is physically received.
  if v_out <> 'REPLACEMENT_PROMISED' then
    update delivery_items set resolution_status='resolved',resolution='CLAIM',resolution_note=coalesce(nullif(btrim(p_response),''),v_out),resolved_by=auth.uid(),resolved_at=now() where id=r.delivery_item_id;
  end if;
  v_result:=jsonb_build_object('id',p_claim_id,'claim_number',r.claim_number,'status',v_status);
  perform _idem_finish(p_idempotency_key,jsonb_build_object('result',v_result));
  return v_result;
end $$;

create or replace function public.supplier_claim_for_line(p_delivery_item_id uuid)
returns jsonb language sql stable security invoker set search_path='public' as $$
select to_jsonb(x) from (
  select sc.id,sc.claim_number,sc.claimed_qty,sc.issue_code,sc.description,sc.status,
         sc.supplier_reference,sc.supplier_response,sc.expected_replacement_at,
         sc.created_at,sc.responded_at,sc.resolved_at,s.name supplier_name,p.name product_name
  from supplier_claims sc left join suppliers s on s.id=sc.supplier_id join products p on p.id=sc.product_id
  where sc.delivery_item_id=p_delivery_item_id order by sc.created_at desc limit 1
) x;
$$;

revoke execute on function public.create_supplier_claim(uuid,text,uuid) from public,anon;
grant execute on function public.create_supplier_claim(uuid,text,uuid) to authenticated,service_role;
revoke execute on function public.respond_supplier_claim(uuid,text,text,text,date,uuid) from public,anon;
grant execute on function public.respond_supplier_claim(uuid,text,text,text,date,uuid) to authenticated,service_role;
grant execute on function public.supplier_claim_for_line(uuid) to authenticated,service_role;

commit;
notify pgrst,'reload schema';
