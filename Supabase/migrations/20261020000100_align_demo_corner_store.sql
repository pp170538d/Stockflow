-- =====================================================================
-- Align demo account with Corner Store
--
-- Context:
-- - Demo account is identified by email: demo@stockflow.com
-- - Demo store is currently named: Corner Store
-- - Previously, demo_object_id() searched for "Demo Store"
-- =====================================================================

begin;

-- ---------------------------------------------------------------------
-- 1. Validate required data before changing anything
-- ---------------------------------------------------------------------
do $$
declare
  v_store_count int;
  v_demo_count  int;
begin
  select count(*)
  into v_store_count
  from public.objects
  where name = 'Corner Store';

  if v_store_count <> 1 then
    raise exception
      'Expected exactly one Corner Store, found %.',
      v_store_count;
  end if;

  select count(*)
  into v_demo_count
  from public.profiles
  where lower(email) = 'demo@stockflow.com';

  if v_demo_count <> 1 then
    raise exception
      'Expected exactly one demo@stockflow.com profile, found %.',
      v_demo_count;
  end if;
end;
$$;

-- ---------------------------------------------------------------------
-- 2. Return Corner Store as the allowed demo store
-- ---------------------------------------------------------------------
create or replace function public.demo_object_id()
returns uuid
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select id
  from public.objects
  where name = 'Corner Store'
  limit 1;
$$;

-- ---------------------------------------------------------------------
-- 3. Assign the demo profile to Corner Store
-- ---------------------------------------------------------------------
update public.profiles
set object_id = public.demo_object_id()
where lower(email) = 'demo@stockflow.com';

-- ---------------------------------------------------------------------
-- 4. Validate that profile and demo_object_id() are aligned
-- ---------------------------------------------------------------------
do $$
declare
  v_assigned_object_id uuid;
  v_demo_object_id     uuid;
begin
  select object_id
  into v_assigned_object_id
  from public.profiles
  where lower(email) = 'demo@stockflow.com';

  v_demo_object_id := public.demo_object_id();

  if v_demo_object_id is null then
    raise exception 'demo_object_id() returned NULL.';
  end if;

  if v_assigned_object_id is distinct from v_demo_object_id then
    raise exception
      'Demo profile was not correctly assigned to Corner Store.';
  end if;
end;
$$;

commit;