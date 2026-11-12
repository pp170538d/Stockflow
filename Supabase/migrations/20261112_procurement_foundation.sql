-- Stockflow procurement foundation
-- Company profile, suppliers, atomic order numbering, supplier links,
-- approval snapshots, immutability guards, and upgraded create-order RPC.

-- ---------------------------------------------------------
-- 1) Company profile: one legal entity for this Stockflow instance
-- ---------------------------------------------------------
create table if not exists public.company_profile (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  address text,
  city text,
  postal_code text,
  country text,
  tax_id text,
  registration_number text,
  email text,
  phone text,
  updated_by uuid references public.profiles(id) on delete set null,
  updated_at timestamptz not null default now(),
  singleton boolean not null default true,
  constraint company_profile_singleton check (singleton),
  constraint company_profile_singleton_key unique (singleton),
  constraint company_profile_name_not_blank check (btrim(name) <> '')
);

alter table public.company_profile enable row level security;

-- Authenticated users may read company identity because it appears on business documents.
drop policy if exists "company_profile: authenticated reads" on public.company_profile;
create policy "company_profile: authenticated reads"
on public.company_profile for select to authenticated
using (true);

-- Changes go through RPC only.
revoke insert, update, delete on public.company_profile from anon, authenticated;

-- ---------------------------------------------------------
-- 2) Suppliers
-- ---------------------------------------------------------
create table if not exists public.suppliers (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  address text,
  city text,
  postal_code text,
  country text,
  tax_id text,
  registration_number text,
  order_email text,
  phone text,
  contact_name text,
  active boolean not null default true,
  created_by uuid references public.profiles(id) on delete set null default auth.uid(),
  created_at timestamptz not null default now(),
  updated_by uuid references public.profiles(id) on delete set null,
  updated_at timestamptz not null default now(),
  constraint suppliers_name_not_blank check (btrim(name) <> '')
);

create unique index if not exists suppliers_name_key
  on public.suppliers (lower(btrim(name)));
create index if not exists idx_suppliers_active_name
  on public.suppliers (active, name);

alter table public.suppliers enable row level security;

drop policy if exists "suppliers: authenticated reads" on public.suppliers;
create policy "suppliers: authenticated reads"
on public.suppliers for select to authenticated
using (true);

-- Mutation goes through guarded RPCs to keep admin/demo rules consistent.
revoke insert, update, delete on public.suppliers from anon, authenticated;

-- ---------------------------------------------------------
-- 3) Atomic business order number
--    Separate sequence per calendar year, concurrency-safe.
-- ---------------------------------------------------------
create table if not exists public.order_number_counters (
  year smallint primary key,
  last_value integer not null check (last_value >= 0)
);

revoke all on public.order_number_counters from anon, authenticated;

create or replace function public.next_order_number(p_at timestamptz default now())
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_year int := extract(year from p_at)::int;
  v_number int;
begin
  insert into public.order_number_counters(year, last_value)
  values (v_year, 1)
  on conflict (year) do update
    set last_value = order_number_counters.last_value + 1
  returning last_value into v_number;

  return 'ORD-' || v_year::text || '-' || lpad(v_number::text, 6, '0');
end;
$$;

revoke all on function public.next_order_number(timestamptz) from public, anon, authenticated;

-- ---------------------------------------------------------
-- 4) Extend orders
-- ---------------------------------------------------------
alter table public.orders
  add column if not exists order_number text,
  add column if not exists supplier_id uuid references public.suppliers(id) on delete restrict,
  add column if not exists approved_at timestamptz,
  add column if not exists approved_by uuid references public.profiles(id) on delete set null,
  add column if not exists company_snapshot jsonb,
  add column if not exists supplier_snapshot jsonb,
  add column if not exists delivery_snapshot jsonb,
  add column if not exists prepared_by_snapshot jsonb;

create unique index if not exists orders_order_number_key
  on public.orders(order_number) where order_number is not null;
create index if not exists idx_orders_supplier_created_at
  on public.orders(supplier_id, created_at desc);

-- Backfill existing orders deterministically. These numbers identify old records
-- from now on; the exact historical creation sequence is preserved by created_at/id.
do $$
declare
  r record;
  v_year int;
  v_n int := 0;
  v_prev_year int := -1;
begin
  for r in
    select id, extract(year from created_at)::int as yr
    from public.orders
    where order_number is null
    order by extract(year from created_at)::int, created_at, id
  loop
    v_year := r.yr;
    if v_year <> v_prev_year then
      v_n := 0;
      v_prev_year := v_year;
    end if;
    v_n := v_n + 1;
    update public.orders
       set order_number = 'ORD-' || v_year::text || '-' || lpad(v_n::text, 6, '0')
     where id = r.id;
  end loop;
end $$;

-- Seed counters so new numbers continue after the backfill.
insert into public.order_number_counters(year, last_value)
select extract(year from created_at)::int, count(*)::int
from public.orders
group by 1
on conflict (year) do update
set last_value = greatest(order_number_counters.last_value, excluded.last_value);

alter table public.orders alter column order_number set not null;

-- ---------------------------------------------------------
-- 5) Master-data mutation RPCs
-- ---------------------------------------------------------
create or replace function public.save_company_profile(p_data jsonb)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_id uuid;
  v_name text := nullif(btrim(p_data->>'name'), '');
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

  insert into public.company_profile(
    name, address, city, postal_code, country, tax_id, registration_number,
    email, phone, updated_by, updated_at, singleton
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
    auth.uid(), now(), true
  )
  on conflict (singleton) do update set
    name = excluded.name,
    address = excluded.address,
    city = excluded.city,
    postal_code = excluded.postal_code,
    country = excluded.country,
    tax_id = excluded.tax_id,
    registration_number = excluded.registration_number,
    email = excluded.email,
    phone = excluded.phone,
    updated_by = auth.uid(),
    updated_at = now()
  returning id into v_id;

  return v_id;
end;
$$;

revoke all on function public.save_company_profile(jsonb) from public, anon;
grant execute on function public.save_company_profile(jsonb) to authenticated;

create or replace function public.save_supplier(p_id uuid, p_data jsonb)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_id uuid;
  v_name text := nullif(btrim(p_data->>'name'), '');
  v_active boolean := coalesce((p_data->>'active')::boolean, true);
begin
  if not is_admin() then
    raise exception 'Only admin can manage suppliers' using errcode = '42501';
  end if;
  if is_demo() then
    raise exception 'Demo account is read-only' using errcode = '42501';
  end if;
  if v_name is null then
    raise exception 'Supplier name is required' using errcode = '22023';
  end if;

  if p_id is null then
    insert into public.suppliers(
      name, address, city, postal_code, country, tax_id, registration_number,
      order_email, phone, contact_name, active, created_by, updated_by
    ) values (
      v_name,
      nullif(btrim(p_data->>'address'), ''), nullif(btrim(p_data->>'city'), ''),
      nullif(btrim(p_data->>'postal_code'), ''), nullif(btrim(p_data->>'country'), ''),
      nullif(btrim(p_data->>'tax_id'), ''), nullif(btrim(p_data->>'registration_number'), ''),
      nullif(btrim(p_data->>'order_email'), ''), nullif(btrim(p_data->>'phone'), ''),
      nullif(btrim(p_data->>'contact_name'), ''), v_active, auth.uid(), auth.uid()
    ) returning id into v_id;
  else
    update public.suppliers set
      name = v_name,
      address = nullif(btrim(p_data->>'address'), ''),
      city = nullif(btrim(p_data->>'city'), ''),
      postal_code = nullif(btrim(p_data->>'postal_code'), ''),
      country = nullif(btrim(p_data->>'country'), ''),
      tax_id = nullif(btrim(p_data->>'tax_id'), ''),
      registration_number = nullif(btrim(p_data->>'registration_number'), ''),
      order_email = nullif(btrim(p_data->>'order_email'), ''),
      phone = nullif(btrim(p_data->>'phone'), ''),
      contact_name = nullif(btrim(p_data->>'contact_name'), ''),
      active = v_active,
      updated_by = auth.uid(),
      updated_at = now()
    where id = p_id
    returning id into v_id;

    if v_id is null then
      raise exception 'Supplier not found' using errcode = 'P0002';
    end if;
  end if;

  return v_id;
end;
$$;

revoke all on function public.save_supplier(uuid, jsonb) from public, anon;
grant execute on function public.save_supplier(uuid, jsonb) to authenticated;

-- ---------------------------------------------------------
-- 6) Upgrade guard_order
--    - number is assigned only by DB
--    - supplier may change only while PENDING
--    - approval requires company profile + active supplier
--    - snapshots are generated once on APPROVAL
-- ---------------------------------------------------------
create or replace function public.guard_order()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_supplier public.suppliers%rowtype;
  v_company public.company_profile%rowtype;
  v_object public.objects%rowtype;
  v_profile public.profiles%rowtype;
begin
  if tg_op = 'INSERT' then
    perform public.assert_object_access(new.object_id);
    new.status := 'PENDING';
    if auth.uid() is not null then
      new.created_by := auth.uid();
    end if;
    if new.order_number is null then
      new.order_number := public.next_order_number(coalesce(new.created_at, now()));
    end if;
    return new;
  end if;

  -- UPDATE
  perform public.assert_object_access(old.object_id);

  if new.object_id is distinct from old.object_id
  or new.created_by is distinct from old.created_by
  or new.created_at is distinct from old.created_at
  or new.order_number is distinct from old.order_number then
    raise exception using errcode = '42501',
      message = 'Order store, author, creation time and order number cannot be changed.';
  end if;

  if old.status <> 'PENDING' and new.supplier_id is distinct from old.supplier_id then
    raise exception 'Supplier can only be changed while the order is PENDING.';
  end if;

  -- Snapshot/document fields are system controlled and immutable after being set.
  if old.company_snapshot is not null and new.company_snapshot is distinct from old.company_snapshot
  or old.supplier_snapshot is not null and new.supplier_snapshot is distinct from old.supplier_snapshot
  or old.delivery_snapshot is not null and new.delivery_snapshot is distinct from old.delivery_snapshot
  or old.prepared_by_snapshot is not null and new.prepared_by_snapshot is distinct from old.prepared_by_snapshot
  or old.approved_at is not null and new.approved_at is distinct from old.approved_at
  or old.approved_by is not null and new.approved_by is distinct from old.approved_by then
    raise exception 'Approved order document data cannot be changed.';
  end if;

  if new.status is distinct from old.status then
    if old.status = 'DELIVERED' then
      raise exception 'A delivered order cannot change status.';
    end if;

    if new.status = 'DELIVERED' then
      if public.is_direct_api_call() then
        raise exception using errcode = '42501',
          message = 'Use Record delivery to mark an order as delivered.';
      end if;
      if old.status <> 'APPROVED' then
        raise exception 'Only an APPROVED order can be delivered.';
      end if;

    elsif not (
         (old.status = 'PENDING'  and new.status in ('APPROVED', 'REJECTED'))
      or (old.status = 'APPROVED' and new.status = 'PENDING')
      or (old.status = 'REJECTED' and new.status = 'PENDING')
    ) then
      raise exception 'Invalid status change: % -> %.', old.status, new.status;
    end if;

    if public.is_direct_api_call()
       and not (public.is_admin() or public.is_demo()) then
      raise exception using errcode = '42501',
        message = 'Only an admin can change order status.';
    end if;

    -- Document is issued the first time the order is approved.
    if old.status = 'PENDING' and new.status = 'APPROVED' and old.approved_at is null then
      if new.supplier_id is null then
        raise exception 'Select a supplier before approving the order.';
      end if;

      select * into v_supplier from public.suppliers where id = new.supplier_id;
      if v_supplier.id is null then
        raise exception 'Supplier not found.';
      end if;
      if not v_supplier.active then
        raise exception 'Inactive supplier cannot be used for a new purchase order.';
      end if;

      select * into v_company from public.company_profile where singleton = true;
      if v_company.id is null then
        raise exception 'Complete Settings > Company profile before approving purchase orders.';
      end if;

      select * into v_object from public.objects where id = new.object_id;
      select * into v_profile from public.profiles where id = new.created_by;

      new.approved_at := now();
      new.approved_by := auth.uid();
      new.company_snapshot := jsonb_build_object(
        'name', v_company.name, 'address', v_company.address, 'city', v_company.city,
        'postal_code', v_company.postal_code, 'country', v_company.country,
        'tax_id', v_company.tax_id, 'registration_number', v_company.registration_number,
        'email', v_company.email, 'phone', v_company.phone
      );
      new.supplier_snapshot := jsonb_build_object(
        'id', v_supplier.id, 'name', v_supplier.name, 'address', v_supplier.address,
        'city', v_supplier.city, 'postal_code', v_supplier.postal_code,
        'country', v_supplier.country, 'tax_id', v_supplier.tax_id,
        'registration_number', v_supplier.registration_number,
        'order_email', v_supplier.order_email, 'phone', v_supplier.phone,
        'contact_name', v_supplier.contact_name
      );
      new.delivery_snapshot := jsonb_build_object(
        'id', v_object.id, 'name', v_object.name, 'address', v_object.address, 'city', v_object.city
      );
      new.prepared_by_snapshot := jsonb_build_object(
        'id', v_profile.id, 'full_name', v_profile.full_name, 'email', v_profile.email
      );
    end if;
  end if;

  return new;
end;
$$;

-- ---------------------------------------------------------
-- 7) Upgrade create_order_with_items
-- Supplier is now part of creation; old existing orders remain valid.
-- ---------------------------------------------------------
create or replace function public.create_order_with_items(
  p_object_id uuid,
  p_comment text,
  p_items jsonb,
  p_supplier_id uuid default null
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_order_id uuid;
  v_item jsonb;
  v_qty int;
begin
  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'An order must contain at least one item.';
  end if;

  perform public.assert_object_access(p_object_id);

  if p_supplier_id is not null and not exists (
    select 1 from public.suppliers where id = p_supplier_id and active
  ) then
    raise exception 'Supplier does not exist or is inactive.';
  end if;

  insert into public.orders (object_id, supplier_id, comment, created_by, status)
  values (p_object_id, p_supplier_id, nullif(btrim(p_comment), ''), auth.uid(), 'PENDING')
  returning id into v_order_id;

  for v_item in select * from jsonb_array_elements(p_items)
  loop
    v_qty := (v_item->>'quantity')::int;
    if v_qty is null or v_qty <= 0 then
      raise exception 'Quantity must be a positive number.';
    end if;

    insert into public.order_items(order_id, product_id, quantity)
    values (v_order_id, (v_item->>'product_id')::uuid, v_qty);
  end loop;

  return v_order_id;
end;
$$;

-- Keep compatibility with existing Angular call while we migrate the UI.
create or replace function public.create_order_with_items(
  p_object_id uuid,
  p_comment text,
  p_items jsonb
)
returns uuid
language sql
security definer
set search_path = public, pg_temp
as $$
  select public.create_order_with_items(p_object_id, p_comment, p_items, null::uuid);
$$;

revoke all on function public.create_order_with_items(uuid, text, jsonb, uuid) from public, anon;
grant execute on function public.create_order_with_items(uuid, text, jsonb, uuid) to authenticated;
revoke all on function public.create_order_with_items(uuid, text, jsonb) from public, anon;
grant execute on function public.create_order_with_items(uuid, text, jsonb) to authenticated;

-- ---------------------------------------------------------
-- 8) Safety checks / indexes
-- ---------------------------------------------------------
create unique index if not exists order_items_order_product_key
  on public.order_items(order_id, product_id);
