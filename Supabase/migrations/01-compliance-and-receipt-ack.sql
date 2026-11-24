-- =====================================================================
-- Stockflow · Phase 1+2
--  1. Compliance profile (NONE | SERBIA) on the company profile.
--     Receiving logic stays universal; the profile only decides labels,
--     allowed document types and (later) deadlines and connectors.
--  2. Dispatch document types: DELIVERY_NOTE, ASN, OTHER everywhere;
--     E_OTPREMNICA only for the SERBIA profile.
--  3. Receipt acknowledgement (e-Prijemnica in Serbia) as an external
--     reference on the GRN, stored in the provider-neutral
--     external_documents table. Nothing is sent to any government system.
--  All in one transaction: if anything fails, nothing changes.
-- =====================================================================
begin;

-- ---------------------------------------------------------------------
-- 1. Compliance profile
-- ---------------------------------------------------------------------
alter table public.company_profile
  add column if not exists compliance_profile text not null default 'NONE';

alter table public.company_profile drop constraint if exists company_profile_compliance_check;
alter table public.company_profile add constraint company_profile_compliance_check
  check (compliance_profile in ('NONE', 'SERBIA'));

-- Existing Serbian company keeps working exactly as today.
update public.company_profile
set compliance_profile = 'SERBIA'
where compliance_profile = 'NONE'
  and (country ilike 'serbia%' or country ilike 'srbija%' or upper(btrim(country)) in ('RS', 'SRB'));

create or replace function public.app_compliance_profile()
returns text
language sql stable security definer set search_path = 'public', 'pg_temp'
as $$
  select coalesce((select compliance_profile from company_profile where singleton limit 1), 'NONE');
$$;
grant execute on function public.app_compliance_profile() to authenticated, service_role;

create or replace function public.save_company_profile(p_data jsonb)
returns uuid
language plpgsql security definer set search_path = 'public', 'pg_temp'
as $$
declare
  v_id      uuid;
  v_name    text := nullif(btrim(p_data->>'name'), '');
  v_profile text := nullif(upper(btrim(coalesce(p_data->>'compliance_profile', ''))), '');
begin
  if not is_admin() then
    raise exception 'Only admin can edit the company profile' using errcode = '42501';
  end if;
  if is_demo() then
    raise exception 'Demo account is read-only' using errcode = '42501';
  end if;
  if v_name is null then
    raise exception 'Company name is required' using errcode = '22023';
  end if;
  if v_profile is not null and v_profile not in ('NONE', 'SERBIA') then
    raise exception 'Invalid compliance profile %', v_profile using errcode = '22023';
  end if;

  insert into public.company_profile(
    name, address, city, postal_code, country, tax_id, registration_number,
    email, phone, compliance_profile, updated_by, updated_at, singleton
  ) values (
    v_name,
    nullif(btrim(p_data->>'address'), ''),
    nullif(btrim(p_data->>'city'), ''),
    nullif(btrim(p_data->>'postal_code'), ''),
    nullif(btrim(p_data->>'country'), ''),
    nullif(btrim(p_data->>'tax_id'), ''),
    nullif(btrim(p_data->>'registration_number'), ''),
    nullif(btrim(p_data->>'email'), ''),
    nullif(btrim(p_data->>'phone'), ''),
    coalesce(v_profile, 'NONE'),
    auth.uid(), now(), true
  )
  on conflict (singleton) do update set
    name                = excluded.name,
    address             = excluded.address,
    city                = excluded.city,
    postal_code         = excluded.postal_code,
    country             = excluded.country,
    tax_id              = excluded.tax_id,
    registration_number = excluded.registration_number,
    email               = excluded.email,
    phone               = excluded.phone,
    -- older clients that do not send the field keep the current profile
    compliance_profile  = coalesce(v_profile, company_profile.compliance_profile),
    updated_by          = auth.uid(),
    updated_at          = now()
  returning id into v_id;

  return v_id;
end;
$$;

-- ---------------------------------------------------------------------
-- 2. Dispatch document types
-- ---------------------------------------------------------------------
alter table public.deliveries drop constraint if exists deliveries_dispatch_type_check;
alter table public.deliveries add constraint deliveries_dispatch_type_check
  check (dispatch_document_type is null
         or dispatch_document_type in ('E_OTPREMNICA', 'DELIVERY_NOTE', 'ASN', 'OTHER'));

create or replace function pg_temp.swap(src text, a text, b text)
returns text language plpgsql as $$
begin
  if position(a in src) = 0 then
    raise exception 'Not found: %', a;
  end if;
  return replace(src, a, b);
end $$;

do $$
declare n text;
begin
  n := pg_get_functiondef(
         'public._record_delivery_core(uuid,text,text,text,text,text,text,timestamptz,jsonb)'::regprocedure);
  n := pg_temp.swap(n,
    $a$v_doc_type not in ('E_OTPREMNICA','DELIVERY_NOTE','OTHER') then$a$,
    $b$v_doc_type not in ('E_OTPREMNICA','DELIVERY_NOTE','ASN','OTHER') then$b$);
  n := pg_temp.swap(n,
    $a$if nullif(btrim(coalesce(p_dispatch_document_number,'')),'') is not null and v_doc_type is null then$a$,
    $b$if v_doc_type = 'E_OTPREMNICA' and app_compliance_profile() <> 'SERBIA' then
    raise exception 'e-Otpremnica is only available with the Serbia compliance profile.' using errcode='22023';
  end if;
  if nullif(btrim(coalesce(p_dispatch_document_number,'')),'') is not null and v_doc_type is null then$b$);
  execute n;
end $$;

-- ---------------------------------------------------------------------
-- 3. Receipt acknowledgement as an external document reference
-- ---------------------------------------------------------------------
create or replace function public.receipt_ack_outcome(p_delivery_id uuid)
returns text
language sql stable set search_path = 'public' as $$
  select case
    when coalesce(sum(di.accepted_qty), 0) = 0 then 'REJECTED_IN_FULL'
    when bool_and(di.rejected_qty = 0 and di.physical_qty = oi.quantity) then 'ACCEPTED_IN_FULL'
    else 'ACCEPTED_WITH_DEVIATIONS'
  end
  from delivery_items di
  join order_items oi on oi.id = di.order_item_id
  where di.delivery_id = p_delivery_id;
$$;
grant execute on function public.receipt_ack_outcome(uuid) to authenticated, service_role;

create or replace function public.set_receipt_acknowledgement(
  p_delivery_id     uuid,
  p_document_number text,
  p_status          text,
  p_provider        text        default 'MANUAL',
  p_external_id     text        default null,
  p_sent_at         timestamptz default null,
  p_note            text        default null,
  p_idempotency_key uuid        default null
) returns jsonb
language plpgsql security definer set search_path = 'public', 'pg_temp'
as $$
declare
  v_prev     jsonb;
  v_object   uuid;
  v_number   text := nullif(btrim(coalesce(p_document_number, '')), '');
  v_status   text := upper(btrim(coalesce(p_status, '')));
  v_provider text := coalesce(nullif(upper(btrim(coalesce(p_provider, ''))), ''), 'MANUAL');
  v_outcome  text;
  v_id       uuid;
  v_result   jsonb;
begin
  if auth.uid() is null then raise exception 'Not signed in' using errcode = '42501'; end if;
  if is_demo() then raise exception 'Demo account is read-only' using errcode = '42501'; end if;
  if v_number is null then raise exception 'Document number is required' using errcode = '22023'; end if;
  if v_status not in ('SENT', 'SUPPLIER_AGREED', 'SUPPLIER_DISPUTED') then
    raise exception 'Invalid receipt acknowledgement status %', v_status using errcode = '22023';
  end if;
  if v_provider not in ('MANUAL', 'SEO_SERBIA', 'TERON', 'SAP', 'BUSINESS_CENTRAL', 'OTHER') then
    raise exception 'Invalid source system %', v_provider using errcode = '22023';
  end if;

  v_prev := _idem_begin(p_idempotency_key, 'set_receipt_acknowledgement', jsonb_build_object(
    'delivery', p_delivery_id, 'number', v_number, 'status', v_status, 'provider', v_provider,
    'external_id', p_external_id, 'sent_at', p_sent_at, 'note', p_note));
  if v_prev is not null then return v_prev->'result'; end if;

  select object_id into v_object from deliveries where id = p_delivery_id for update;
  if v_object is null then raise exception 'Goods receipt not found' using errcode = 'P0002'; end if;
  perform assert_object_access(v_object);

  v_outcome := receipt_ack_outcome(p_delivery_id);

  -- One receipt acknowledgement per GRN, whatever system it came from.
  select id into v_id from external_documents
  where entity_type = 'DELIVERY' and entity_id = p_delivery_id and document_type = 'RECEIPT'
  order by created_at limit 1
  for update;

  if v_id is null then
    insert into external_documents(entity_type, entity_id, document_type, provider, external_id,
                                   document_number, status, sent_at, metadata, created_by)
    values ('DELIVERY', p_delivery_id, 'RECEIPT', v_provider, nullif(btrim(p_external_id), ''),
            v_number, v_status, coalesce(p_sent_at, now()),
            jsonb_build_object('outcome', v_outcome, 'note', nullif(btrim(coalesce(p_note, '')), '')),
            auth.uid())
    returning id into v_id;
  else
    update external_documents set
      provider        = v_provider,
      external_id     = nullif(btrim(p_external_id), ''),
      document_number = v_number,
      status          = v_status,
      sent_at         = coalesce(p_sent_at, sent_at, now()),
      metadata        = metadata || jsonb_build_object('outcome', v_outcome,
                          'note', nullif(btrim(coalesce(p_note, '')), '')),
      updated_at      = now()
    where id = v_id;
  end if;

  v_result := jsonb_build_object('id', v_id, 'status', v_status, 'outcome', v_outcome);
  perform _idem_finish(p_idempotency_key, jsonb_build_object('result', v_result));
  return v_result;
end;
$$;
revoke execute on function public.set_receipt_acknowledgement(uuid,text,text,text,text,timestamptz,text,uuid) from public, anon;
grant  execute on function public.set_receipt_acknowledgement(uuid,text,text,text,text,timestamptz,text,uuid) to authenticated, service_role;

-- GRN payload: + compliance_profile, + receipt_ack, + suggested outcome
create or replace function public.goods_receipt(p_delivery_id uuid)
returns jsonb
language sql stable set search_path = 'public'
as $$
select jsonb_build_object(
  'currency', app_currency(),
  'compliance_profile', app_compliance_profile(),
  'receipt_outcome', receipt_ack_outcome(d.id),
  'receipt_ack', (
    select jsonb_build_object(
      'id', x.id, 'provider', x.provider, 'document_number', x.document_number,
      'external_id', x.external_id, 'status', x.status, 'sent_at', x.sent_at,
      'outcome', x.metadata->>'outcome', 'note', x.metadata->>'note', 'updated_at', x.updated_at)
    from external_documents x
    where x.entity_type = 'DELIVERY' and x.entity_id = d.id and x.document_type = 'RECEIPT'
    order by x.created_at limit 1),
  'delivery', jsonb_build_object(
    'id', d.id, 'delivery_number', d.delivery_number, 'delivered_at', d.delivered_at,
    'received_by', d.received_by, 'carrier', d.carrier, 'note', d.note,
    'dispatch_document_type', d.dispatch_document_type,
    'dispatch_document_number', d.dispatch_document_number,
    'dispatch_external_id', d.dispatch_external_id,
    'physical_receipt_at', d.physical_receipt_at,
    'ereceipt_status', d.ereceipt_status, 'ereceipt_number', d.ereceipt_number,
    'ereceipt_external_id', d.ereceipt_external_id, 'ereceipt_sent_at', d.ereceipt_sent_at),
  'order', jsonb_build_object(
    'id', o.id, 'order_number', o.order_number, 'status', o.status, 'comment', o.comment,
    'approved_at', o.approved_at, 'company', o.company_snapshot,
    'supplier', o.supplier_snapshot, 'deliver_to', o.delivery_snapshot),
  'object_name', ob.name,
  'lines', coalesce((
    select jsonb_agg(l order by l.open desc, l.product_name) from (
      select di.id line_id, oi.id order_item_id, oi.product_id, p.sku, p.name product_name,
             oi.quantity ordered_qty,
             di.physical_qty, di.accepted_qty, di.rejected_qty,
             di.accepted_qty received_qty, di.physical_qty - oi.quantity variance,
             oi.quantity - coalesce(di.physical_qty, 0) shortage_qty,
             coalesce(oi.unit_cost, p.cost_price) unit_cost,
             round(oi.quantity * coalesce(oi.unit_cost, p.cost_price), 2) ordered_value,
             round(di.accepted_qty * coalesce(oi.unit_cost, p.cost_price), 2) received_value,
             round((di.physical_qty - oi.quantity) * coalesce(oi.unit_cost, p.cost_price), 2) variance_value,
             di.reason_code, di.reason, di.resolution_status, di.resolution, di.resolution_note,
             di.resolved_at, bo.order_number backorder_number, (di.resolution_status = 'open') open
      from order_items oi
      join products p on p.id = oi.product_id
      left join delivery_items di on di.order_item_id = oi.id and di.delivery_id = d.id
      left join orders bo on bo.id = di.backorder_id
      where oi.order_id = d.order_id) l), '[]'::jsonb))
from deliveries d
join orders o   on o.id = d.order_id
join objects ob on ob.id = d.object_id
where d.id = p_delivery_id;
$$;

commit;
notify pgrst, 'reload schema';

-- Check: profile, and that GRN payload has the new keys
select app_compliance_profile() as profile,
       (select goods_receipt(id) ? 'receipt_ack' from deliveries order by created_at desc limit 1) as grn_has_receipt_ack;
