


SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;


COMMENT ON SCHEMA "public" IS 'standard public schema';



CREATE EXTENSION IF NOT EXISTS "pg_stat_statements" WITH SCHEMA "extensions";






CREATE EXTENSION IF NOT EXISTS "pgcrypto" WITH SCHEMA "extensions";






CREATE EXTENSION IF NOT EXISTS "supabase_vault" WITH SCHEMA "vault";






CREATE EXTENSION IF NOT EXISTS "uuid-ossp" WITH SCHEMA "extensions";






CREATE TYPE "public"."movement_event" AS ENUM (
    'DELIVERY',
    'SALE',
    'STOCK_COUNT',
    'ADJUSTMENT',
    'TRANSFER',
    'RETURN',
    'WRITE_OFF'
);


ALTER TYPE "public"."movement_event" OWNER TO "postgres";


CREATE TYPE "public"."order_status" AS ENUM (
    'PENDING',
    'APPROVED',
    'DELIVERED',
    'REJECTED'
);


ALTER TYPE "public"."order_status" OWNER TO "postgres";


CREATE TYPE "public"."user_role" AS ENUM (
    'ADMIN',
    'SELLER'
);


ALTER TYPE "public"."user_role" OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."apply_stock_movement"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare
  v_current int;
  v_result  int;
begin
  -- Make sure the row exists so it can be locked (rolled back if we raise)
  insert into public.inventory (object_id, product_id, quantity, updated_at)
  values (new.object_id, new.product_id, 0, now())
  on conflict (object_id, product_id) do nothing;

  -- Row lock: concurrent movements on the same product serialize here
  select quantity into v_current
  from public.inventory
  where object_id = new.object_id and product_id = new.product_id
  for update;

  v_result := v_current + new.quantity;

  if v_result < 0 then
    -- message kept identical: the frontend matches on 'Insufficient stock'
    raise exception
      'Insufficient stock: % on hand, % of % would result in %.',
      v_current, new.quantity, new.event, v_result;
  end if;

  update public.inventory
  set quantity = v_result, updated_at = now()
  where object_id = new.object_id and product_id = new.product_id;

  return new;
end;
$$;


ALTER FUNCTION "public"."apply_stock_movement"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."assert_object_access"("p_object_id" "uuid") RETURNS "void"
    LANGUAGE "plpgsql" STABLE
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
begin
  if auth.uid() is null then
    return;
  end if;

  if p_object_id is null then
    raise exception 'Store is required.';
  end if;

  if public.is_demo() then
    if p_object_id is distinct from public.demo_object_id() then
      raise exception using errcode = '42501',
        message = 'The demo account can only work in the Demo Store.';
    end if;
    return;
  end if;

  if public.is_admin() then
    return;
  end if;

  if p_object_id is distinct from public.auth_object_id() then
    raise exception using errcode = '42501',
      message = 'You can only work with your own store.';
  end if;
end;
$$;


ALTER FUNCTION "public"."assert_object_access"("p_object_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."auth_object_id"() RETURNS "uuid"
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  select object_id from public.profiles where id = auth.uid();
$$;


ALTER FUNCTION "public"."auth_object_id"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."auth_role"() RETURNS "public"."user_role"
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  select role from public.profiles where id = auth.uid();
$$;


ALTER FUNCTION "public"."auth_role"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."create_order_with_items"("p_object_id" "uuid", "p_comment" "text", "p_items" "jsonb") RETURNS "uuid"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare
  v_order_id uuid;
  v_item     jsonb;
  v_qty      int;
begin
  -- Guard: must have at least one line
  if p_items is null or jsonb_array_length(p_items) = 0 then
    raise exception 'An order must contain at least one item.';
  end if;

  -- 1. Insert the header (created_by is forced to the authenticated user)
  insert into public.orders (object_id, comment, created_by, status)
  values (p_object_id, p_comment, auth.uid(), 'PENDING')
  returning id into v_order_id;

  -- 2. Insert each line, validating as we go
  for v_item in select * from jsonb_array_elements(p_items)
  loop
    v_qty := (v_item->>'quantity')::int;

    if v_qty is null or v_qty <= 0 then
      raise exception 'Quantity must be a positive number.';
    end if;

    insert into public.order_items (order_id, product_id, quantity)
    values (
      v_order_id,
      (v_item->>'product_id')::uuid,
      v_qty
    );
  end loop;

  return v_order_id;
end;
$$;


ALTER FUNCTION "public"."create_order_with_items"("p_object_id" "uuid", "p_comment" "text", "p_items" "jsonb") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."dashboard_summary"("p_object_id" "uuid" DEFAULT NULL::"uuid", "p_days" integer DEFAULT 30) RETURNS "jsonb"
    LANGUAGE "plpgsql" STABLE
    SET "search_path" TO 'public'
    AS $$
declare
  v_since    timestamptz := date_trunc('day', now()) - make_interval(days => p_days - 1);
  v_week     timestamptz := now() - interval '7 days';
  v_prevweek timestamptz := now() - interval '14 days';
  v_result   jsonb;
begin
  with
  inv as (
    select i.object_id, i.product_id, i.quantity
    from inventory i
    where p_object_id is null or i.object_id = p_object_id
  ),
  sales as (
    select m.object_id, m.product_id, sum(abs(m.quantity))::numeric as sold
    from stock_movements m
    where m.event = 'SALE'
      and m.created_at >= v_since
      and (p_object_id is null or m.object_id = p_object_id)
    group by 1, 2
  ),
  runway as (
    select
      inv.object_id, inv.product_id, inv.quantity as on_hand,
      coalesce(s.sold, 0) / p_days as daily_rate,
      case when coalesce(s.sold, 0) > 0
           then round(inv.quantity / (s.sold / p_days), 1) end as days_left
    from inv
    left join sales s using (object_id, product_id)
  ),
  runway_ranked as (
    select r.*,
      case
        when r.on_hand <= 0      then 'out'
        when r.days_left is null then 'idle'
        when r.days_left <= 7    then 'critical'
        when r.days_left <= 14   then 'warning'
        else 'healthy'
      end as urgency
    from runway r
  ),
  mv as (
    select m.*
    from stock_movements m
    where m.created_at >= v_since
      and (p_object_id is null or m.object_id = p_object_id)
  ),
  days as (
    select generate_series(v_since, date_trunc('day', now()), interval '1 day') as d
  ),
  daily as (
    select
      date_trunc('day', created_at) as d,
      sum(quantity) filter (where quantity > 0)      as units_in,
      sum(abs(quantity)) filter (where quantity < 0) as units_out,
      sum(quantity)                                  as net,
      count(*) filter (where event = 'DELIVERY')     as n_delivery,
      count(*) filter (where event = 'SALE')         as n_sale,
      count(*) filter (where event = 'STOCK_COUNT')  as n_count,
      count(*) filter (where event not in ('DELIVERY','SALE','STOCK_COUNT')) as n_other
    from mv
    group by 1
  ),
  totals as (
    select coalesce(sum(quantity), 0) as on_hand from inv
  ),
  flow as (
    select
      days.d,
      coalesce(daily.units_in, 0)   as units_in,
      coalesce(daily.units_out, 0)  as units_out,
      coalesce(daily.net, 0)        as net,
      coalesce(daily.n_delivery, 0) as n_delivery,
      coalesce(daily.n_sale, 0)     as n_sale,
      coalesce(daily.n_count, 0)    as n_count,
      coalesce(daily.n_other, 0)    as n_other
    from days left join daily using (d)
  ),
  flow_bal as (
    select f.*,
      (select on_hand from totals)
        - coalesce(sum(f.net) over (order by f.d desc
            rows between unbounded preceding and 1 preceding), 0) as closing
    from flow f
  ),
  variances as (
    select f.order_id, f.product_id, f.ordered_qty, f.delivered_qty,
           f.variance, f.reason, f.delivered_at, o.object_id
    from order_fulfillment f
    join orders o on o.id = f.order_id
    where f.variance is not null and f.variance <> 0
      and f.delivered_at >= v_week
      and (p_object_id is null or o.object_id = p_object_id)
  ),
  ord as (
    select o.id, o.status, o.created_at, o.object_id
    from orders o
    where p_object_id is null or o.object_id = p_object_id
  )
  select jsonb_build_object(
    'generated_at', now(),
    'days', p_days,

    'totals', jsonb_build_object(
      'on_hand',     (select on_hand from totals),
      'products',    (select count(distinct product_id) from inv),
      'stores',      (select count(distinct object_id) from inv),
      'pending',     (select count(*) from ord where status = 'PENDING'),
      'approved',    (select count(*) from ord where status = 'APPROVED'),
      'orders_week', (select count(*) from ord where created_at >= v_week),
      'orders_prev', (select count(*) from ord where created_at >= v_prevweek and created_at < v_week),
      'sold_week',   (select coalesce(sum(abs(quantity)), 0) from stock_movements
                       where event = 'SALE' and created_at >= v_week
                         and (p_object_id is null or object_id = p_object_id)),
      'sold_prev',   (select coalesce(sum(abs(quantity)), 0) from stock_movements
                       where event = 'SALE' and created_at >= v_prevweek and created_at < v_week
                         and (p_object_id is null or object_id = p_object_id))
    ),

    'running_out', coalesce((
      select jsonb_agg(x order by x.rank, x.days_left nulls last)
      from (
        select r.object_id, r.product_id, r.on_hand,
               round(r.daily_rate, 2) as daily_rate, r.days_left, r.urgency,
               p.name, p.sku, ob.name as store,
               case r.urgency when 'out' then 0 when 'critical' then 1 else 2 end as rank
        from runway_ranked r
        join products p on p.id = r.product_id
        join objects ob on ob.id = r.object_id
        where r.urgency in ('out', 'critical', 'warning')
        limit 8
      ) x
    ), '[]'::jsonb),

    'variances', jsonb_build_object(
      'net_week', (select coalesce(sum(variance), 0) from variances),
      'lines', coalesce((
        select jsonb_agg(v order by v.delivered_at desc)
        from (
          select va.order_id, va.ordered_qty, va.delivered_qty, va.variance,
                 va.reason, va.delivered_at, p.name, ob.name as store
          from variances va
          join products p on p.id = va.product_id
          join objects ob on ob.id = va.object_id
          limit 5
        ) v
      ), '[]'::jsonb),
      'count_net_week', (select coalesce(sum(quantity), 0) from stock_movements
                          where event = 'STOCK_COUNT' and created_at >= v_week
                            and (p_object_id is null or object_id = p_object_id))
    ),

    -- NEW: per-day event counts for the chart dots
    'flow', coalesce((
      select jsonb_agg(jsonb_build_object(
        'day', to_char(d, 'YYYY-MM-DD'),
        'in', units_in, 'out', units_out, 'closing', closing,
        'events', jsonb_build_object(
          'delivery', n_delivery, 'sale', n_sale, 'count', n_count, 'other', n_other)
      ) order by d)
      from flow_bal
    ), '[]'::jsonb),

    -- NEW: oldest pending orders first, with their lines (RLS-scoped)
    'pending_orders', coalesce((
      select jsonb_agg(po order by po.created_at)
      from (
        select o.id, o.created_at, ob.name as store,
               (select coalesce(sum(oi.quantity), 0) from order_items oi where oi.order_id = o.id) as units,
               (select coalesce(jsonb_agg(jsonb_build_object('name', p.name, 'qty', oi.quantity)
                                          order by oi.quantity desc), '[]'::jsonb)
                  from order_items oi join products p on p.id = oi.product_id
                 where oi.order_id = o.id) as lines
        from ord o
        join objects ob on ob.id = o.object_id
        where o.status = 'PENDING'
        order by o.created_at
        limit 5
      ) po
    ), '[]'::jsonb),

    'stores', coalesce((
      select jsonb_agg(s order by s.rank, s.name)
      from (
        select ob.id, ob.name,
               sum(r.on_hand) as on_hand,
               count(*) filter (where r.urgency in ('out', 'critical')) as critical,
               count(*) filter (where r.urgency = 'warning')            as warning,
               min(case r.urgency when 'out' then 0 when 'critical' then 1
                                  when 'warning' then 2 else 3 end)     as rank
        from runway_ranked r
        join objects ob on ob.id = r.object_id
        group by ob.id, ob.name
      ) s
    ), '[]'::jsonb),

    'ledger', coalesce((
      select jsonb_agg(l order by l.created_at desc)
      from (
        select m.id, m.event, m.quantity, m.reference, m.created_at,
               p.name, ob.name as store
        from stock_movements m
        join products p on p.id = m.product_id
        join objects ob on ob.id = m.object_id
        where p_object_id is null or m.object_id = p_object_id
        order by m.created_at desc
        limit 12
      ) l
    ), '[]'::jsonb)
  )
  into v_result;

  return v_result;
end;
$$;


ALTER FUNCTION "public"."dashboard_summary"("p_object_id" "uuid", "p_days" integer) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."demo_object_id"() RETURNS "uuid"
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
    SELECT id FROM objects WHERE name = 'Demo Store' LIMIT 1;
$$;


ALTER FUNCTION "public"."demo_object_id"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."guard_order"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
begin
  if tg_op = 'INSERT' then
    perform public.assert_object_access(new.object_id);
    new.status := 'PENDING';
    if auth.uid() is not null then
      new.created_by := auth.uid();
    end if;
    return new;
  end if;

  -- UPDATE
  perform public.assert_object_access(old.object_id);

  if new.object_id  is distinct from old.object_id
  or new.created_by is distinct from old.created_by
  or new.created_at is distinct from old.created_at then
    raise exception using errcode = '42501',
      message = 'Order store, author and creation time cannot be changed.';
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
  end if;

  return new;
end;
$$;


ALTER FUNCTION "public"."guard_order"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."guard_order_item"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare
  v_order_id uuid := coalesce(new.order_id, old.order_id);
  v_status   order_status;
  v_object   uuid;
begin
  select status, object_id into v_status, v_object
  from public.orders where id = v_order_id
  for share;

  perform public.assert_object_access(v_object);

  if v_status is distinct from 'PENDING' then
    raise exception 'Order lines can only be changed while the order is PENDING.';
  end if;

  if tg_op <> 'DELETE' and (new.quantity is null or new.quantity <= 0) then
    raise exception 'Quantity must be a positive number.';
  end if;

  return coalesce(new, old);
end;
$$;


ALTER FUNCTION "public"."guard_order_item"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."guard_rpc_only"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
begin
  if public.is_direct_api_call() then
    raise exception using errcode = '42501',
      message = format('%s can only be written through its RPC.', tg_table_name);
  end if;

  if tg_op = 'INSERT' and tg_table_name in ('deliveries', 'stock_counts') then
    perform public.assert_object_access(new.object_id);
    if auth.uid() is not null then
      new.recorded_by := auth.uid();
    end if;
  end if;

  return coalesce(new, old);
end;
$$;


ALTER FUNCTION "public"."guard_rpc_only"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."guard_stock_movement"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
begin
  if new.quantity is null or new.quantity = 0 then
    raise exception 'Movement quantity cannot be zero.';
  end if;

  -- Sign rules (SALE is stored negative, DELIVERY positive, ...)
  if new.event in ('SALE', 'WRITE_OFF') and new.quantity > 0 then
    raise exception '% must be a negative quantity.', new.event;
  end if;
  if new.event in ('DELIVERY', 'RETURN') and new.quantity < 0 then
    raise exception '% must be a positive quantity.', new.event;
  end if;

  -- Store scope (also covers RPCs running as definer)
  perform public.assert_object_access(new.object_id);

  if public.is_direct_api_call() then
    -- These events only exist as the result of a workflow
    if new.event in ('DELIVERY', 'STOCK_COUNT', 'TRANSFER') then
      raise exception using errcode = '42501',
        message = format('%s can only be recorded through its workflow.', new.event);
    end if;
    -- The client may not forge the timestamp
    new.created_at := now();
  end if;

  -- Never trust created_by from the client
  if auth.uid() is not null then
    new.created_by := auth.uid();
  end if;

  return new;
end;
$$;


ALTER FUNCTION "public"."guard_stock_movement"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."handle_new_user"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
begin
  insert into public.profiles (id, email, full_name, role)
  values (
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data->>'full_name', new.email),
    'SELLER'
  );
  return new;
end;
$$;


ALTER FUNCTION "public"."handle_new_user"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."is_admin"() RETURNS boolean
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  select coalesce(public.auth_role() = 'ADMIN', false);
$$;


ALTER FUNCTION "public"."is_admin"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."is_demo"() RETURNS boolean
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
    SELECT COALESCE(
        (SELECT email = 'demo@stockflow.com' FROM profiles WHERE id = auth.uid()),
        false);
$$;


ALTER FUNCTION "public"."is_demo"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."is_direct_api_call"() RETURNS boolean
    LANGUAGE "sql" STABLE
    AS $$
  select current_user in ('authenticated', 'anon');
$$;


ALTER FUNCTION "public"."is_direct_api_call"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."protect_inventory"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
begin
  if public.is_direct_api_call() then
    raise exception using errcode = '42501',
      message = 'Inventory is derived from the ledger and cannot be edited directly.';
  end if;
  return coalesce(new, old);
end;
$$;


ALTER FUNCTION "public"."protect_inventory"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."protect_ledger"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
begin
  if public.is_direct_api_call() then
    raise exception using errcode = '42501',
      message = 'The ledger is append-only. Record a correcting ADJUSTMENT instead.';
  end if;
  return coalesce(new, old);
end;
$$;


ALTER FUNCTION "public"."protect_ledger"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."record_delivery"("p_order_id" "uuid", "p_carrier" "text", "p_received_by" "text", "p_note" "text", "p_items" "jsonb") RETURNS "uuid"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare
  v_delivery_id uuid;
  v_object_id   uuid;
  v_status      order_status;
  v_item        jsonb;
  v_oi_id       uuid;
  v_delivered   int;
  v_ordered     int;
  v_reason      text;
  v_line_count  int;
  v_order_lines int;
begin
  if p_items is null or jsonb_array_length(p_items) = 0 then
    raise exception 'A delivery must record every line of the order.';
  end if;

  select object_id, status into v_object_id, v_status
  from public.orders where id = p_order_id for update;

  if v_object_id is null then
    raise exception 'Order % not found.', p_order_id;
  end if;
  if v_status <> 'APPROVED' then
    raise exception 'Order must be APPROVED to record delivery (current: %).', v_status;
  end if;
  if exists (select 1 from public.deliveries where order_id = p_order_id) then
    raise exception 'This order has already been delivered.';
  end if;

  select count(*) into v_order_lines from public.order_items where order_id = p_order_id;
  select count(distinct (x->>'order_item_id')::uuid) into v_line_count
  from jsonb_array_elements(p_items) x;
  if v_line_count <> v_order_lines then
    raise exception 'Delivery must account for all % order lines (got %).', v_order_lines, v_line_count;
  end if;

  insert into public.deliveries (order_id, object_id, carrier, received_by, recorded_by, note)
  values (p_order_id, v_object_id, coalesce(p_carrier, 'NELT'), p_received_by, auth.uid(), p_note)
  returning id into v_delivery_id;

  for v_item in select * from jsonb_array_elements(p_items)
  loop
    v_oi_id     := (v_item->>'order_item_id')::uuid;
    v_delivered := (v_item->>'delivered_qty')::int;
    v_reason    := nullif(trim(coalesce(v_item->>'reason', '')), '');

    if v_delivered is null or v_delivered < 0 then
      raise exception 'Delivered quantity must be zero or a positive number.';
    end if;

    select quantity into v_ordered
    from public.order_items where id = v_oi_id and order_id = p_order_id;
    if v_ordered is null then
      raise exception 'Order item % does not belong to order %.', v_oi_id, p_order_id;
    end if;
    if v_delivered <> v_ordered and v_reason is null then
      raise exception 'A reason is required for line % (ordered %, delivered %).',
        v_oi_id, v_ordered, v_delivered;
    end if;

    insert into public.delivery_items (delivery_id, order_item_id, product_id, delivered_qty, reason)
    select v_delivery_id, oi.id, oi.product_id, v_delivered, v_reason
    from public.order_items oi where oi.id = v_oi_id;

    if v_delivered > 0 then
      insert into public.stock_movements
        (object_id, product_id, event, quantity, reference, note, created_by)
      select
        v_object_id, oi.product_id, 'DELIVERY', v_delivered,
        'delivery:' || v_delivery_id, coalesce(v_reason, p_note, 'Delivery'), auth.uid()
      from public.order_items oi where oi.id = v_oi_id;
    end if;
  end loop;

  update public.orders set status = 'DELIVERED' where id = p_order_id;
  return v_delivery_id;
end;
$$;


ALTER FUNCTION "public"."record_delivery"("p_order_id" "uuid", "p_carrier" "text", "p_received_by" "text", "p_note" "text", "p_items" "jsonb") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."record_stock_count"("p_object_id" "uuid", "p_counted_by" "text", "p_note" "text", "p_items" "jsonb") RETURNS "uuid"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare
  v_count_id  uuid;
  v_item      jsonb;
  v_product   uuid;
  v_counted   int;
  v_expected  int;
  v_variance  int;
  v_reason    text;
begin
  if p_items is null or jsonb_array_length(p_items) = 0 then
    raise exception 'A stock count must include at least one product.';
  end if;

  if p_object_id is null then
    raise exception 'Object is required for a stock count.';
  end if;

  -- Header
  insert into public.stock_counts (object_id, counted_by, recorded_by, note)
  values (p_object_id, p_counted_by, auth.uid(), p_note)
  returning id into v_count_id;

  -- Lines
  for v_item in select * from jsonb_array_elements(p_items)
  loop
    v_product := (v_item->>'product_id')::uuid;
    v_counted := (v_item->>'counted_qty')::int;
    v_reason  := nullif(trim(coalesce(v_item->>'reason', '')), '');

    if v_counted is null or v_counted < 0 then
      raise exception 'Counted quantity must be zero or a positive number.';
    end if;

    -- Re-read the CURRENT expected balance server-side, locking the row so a
    -- concurrent movement can't slip in between read and correction.
    select quantity into v_expected
    from public.inventory
    where object_id = p_object_id and product_id = v_product
    for update;

    v_expected := coalesce(v_expected, 0);   -- product never stocked here yet → expected 0
    v_variance := v_counted - v_expected;

    -- Reason required whenever reality differs from the system belief
    if v_variance <> 0 and v_reason is null then
      raise exception 'A reason is required for product % (expected %, counted %).',
        v_product, v_expected, v_counted;
    end if;

    -- Persist the counted line (with the server-computed expected & variance)
    insert into public.stock_count_items
      (count_id, product_id, expected_qty, counted_qty, variance, reason)
    values (v_count_id, v_product, v_expected, v_counted, v_variance, v_reason);

    -- Only a non-zero variance needs a correcting ledger event.
    -- STOCK_COUNT is exempt from the oversell guard — reality wins.
    if v_variance <> 0 then
      insert into public.stock_movements
        (object_id, product_id, event, quantity, reference, note, created_by)
      values (
        p_object_id, v_product, 'STOCK_COUNT', v_variance,
        'count:' || v_count_id,
        coalesce(v_reason, 'Stock count correction'),
        auth.uid()
      );
    end if;
  end loop;

  return v_count_id;
end;
$$;


ALTER FUNCTION "public"."record_stock_count"("p_object_id" "uuid", "p_counted_by" "text", "p_note" "text", "p_items" "jsonb") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."sales_feed_summary"("p_object_id" "uuid" DEFAULT NULL::"uuid", "p_from" timestamp with time zone DEFAULT NULL::timestamp with time zone, "p_search" "text" DEFAULT NULL::"text") RETURNS TABLE("total_units" bigint, "sale_events" bigint, "products_sold" bigint)
    LANGUAGE "sql" STABLE
    SET "search_path" TO 'public'
    AS $$
  select
    coalesce(sum(sf.units), 0)::bigint as total_units,
    count(*)::bigint as sale_events,
    count(distinct sf.product_id)::bigint as products_sold
  from public.sales_feed sf
  where
    (p_object_id is null or sf.object_id = p_object_id)
    and (p_from is null or sf.created_at >= p_from)
    and (
      nullif(trim(coalesce(p_search, '')), '') is null
      or sf.product_name ilike '%' || p_search || '%'
      or sf.sku ilike '%' || p_search || '%'
      or sf.object_name ilike '%' || p_search || '%'
      or coalesce(sf.note, '') ilike '%' || p_search || '%'
    );
$$;


ALTER FUNCTION "public"."sales_feed_summary"("p_object_id" "uuid", "p_from" timestamp with time zone, "p_search" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."stock_level_history"("p_object_id" "uuid", "p_product_id" "uuid", "p_from" timestamp with time zone DEFAULT NULL::timestamp with time zone, "p_to" timestamp with time zone DEFAULT NULL::timestamp with time zone) RETURNS TABLE("movement_id" "uuid", "occurred_at" timestamp with time zone, "event" "text", "change_quantity" integer, "balance" bigint, "note" "text", "reference" "text", "is_opening" boolean)
    LANGUAGE "sql" STABLE
    SET "search_path" TO 'public'
    AS $$
  with visible_all as (
    select
      sm.id,
      sm.created_at,
      sm.event::text as event,
      sm.quantity::integer as change_quantity,
      sm.note,
      sm.reference
    from public.stock_movements sm
    where sm.object_id = p_object_id
      and sm.product_id = p_product_id
      and (p_to is null or sm.created_at <= p_to)
  ),
  bounds as (
    select
      coalesce(
        p_from,
        (select min(v.created_at) from visible_all v),
        now()
      ) as range_start
  ),
  opening as (
    select
      coalesce(sum(v.change_quantity), 0)::bigint as opening_balance
    from visible_all v
    cross join bounds b
    where v.created_at < b.range_start
  ),
  in_range as (
    select v.*
    from visible_all v
    cross join bounds b
    where v.created_at >= b.range_start
  ),
  movement_points as (
    select
      r.id as movement_id,
      r.created_at as occurred_at,
      r.event,
      r.change_quantity,
      (
        o.opening_balance
        + sum(r.change_quantity) over (
            order by r.created_at, r.id
            rows between unbounded preceding and current row
          )
      )::bigint as balance,
      r.note,
      r.reference,
      false as is_opening,
      1 as point_order
    from in_range r
    cross join opening o
  ),
  opening_point as (
    select
      null::uuid as movement_id,
      b.range_start as occurred_at,
      'OPENING'::text as event,
      0::integer as change_quantity,
      o.opening_balance as balance,
      null::text as note,
      null::text as reference,
      true as is_opening,
      0 as point_order
    from bounds b
    cross join opening o
  )
  select
    p.movement_id,
    p.occurred_at,
    p.event,
    p.change_quantity,
    p.balance,
    p.note,
    p.reference,
    p.is_opening
  from (
    select * from opening_point
    union all
    select * from movement_points
  ) p
  order by p.occurred_at, p.point_order, p.movement_id nulls first;
$$;


ALTER FUNCTION "public"."stock_level_history"("p_object_id" "uuid", "p_product_id" "uuid", "p_from" timestamp with time zone, "p_to" timestamp with time zone) OWNER TO "postgres";

SET default_tablespace = '';

SET default_table_access_method = "heap";


CREATE TABLE IF NOT EXISTS "public"."deliveries" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "order_id" "uuid" NOT NULL,
    "object_id" "uuid" NOT NULL,
    "carrier" "text" DEFAULT 'NELT'::"text",
    "received_by" "text",
    "recorded_by" "uuid",
    "note" "text",
    "delivered_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."deliveries" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."delivery_items" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "delivery_id" "uuid" NOT NULL,
    "order_item_id" "uuid" NOT NULL,
    "product_id" "uuid" NOT NULL,
    "delivered_qty" integer NOT NULL,
    "reason" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "delivery_items_delivered_qty_check" CHECK (("delivered_qty" >= 0))
);


ALTER TABLE "public"."delivery_items" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."inventory" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "object_id" "uuid" NOT NULL,
    "product_id" "uuid" NOT NULL,
    "quantity" integer DEFAULT 0 NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."inventory" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."object_products" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "object_id" "uuid" NOT NULL,
    "product_id" "uuid" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."object_products" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."objects" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "name" "text" NOT NULL,
    "address" "text",
    "city" "text",
    "active" boolean DEFAULT true NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."objects" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."order_items" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "order_id" "uuid" NOT NULL,
    "product_id" "uuid" NOT NULL,
    "quantity" integer NOT NULL,
    CONSTRAINT "order_items_quantity_check" CHECK (("quantity" > 0))
);


ALTER TABLE "public"."order_items" OWNER TO "postgres";


CREATE OR REPLACE VIEW "public"."order_fulfillment" WITH ("security_invoker"='true') AS
 SELECT "oi"."id" AS "order_item_id",
    "oi"."order_id",
    "oi"."product_id",
    "oi"."quantity" AS "ordered_qty",
    "di"."delivered_qty",
    ("di"."delivered_qty" - "oi"."quantity") AS "variance",
    "di"."reason",
    "d"."id" AS "delivery_id",
    "d"."delivered_at"
   FROM (("public"."order_items" "oi"
     LEFT JOIN "public"."delivery_items" "di" ON (("di"."order_item_id" = "oi"."id")))
     LEFT JOIN "public"."deliveries" "d" ON (("d"."id" = "di"."delivery_id")));


ALTER VIEW "public"."order_fulfillment" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."orders" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "object_id" "uuid" NOT NULL,
    "status" "public"."order_status" DEFAULT 'PENDING'::"public"."order_status" NOT NULL,
    "comment" "text",
    "created_by" "uuid" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."orders" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."products" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "sku" "text" NOT NULL,
    "name" "text" NOT NULL,
    "category" "text",
    "active" boolean DEFAULT true NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."products" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."profiles" (
    "id" "uuid" NOT NULL,
    "email" "text",
    "full_name" "text",
    "role" "public"."user_role" DEFAULT 'SELLER'::"public"."user_role" NOT NULL,
    "object_id" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."profiles" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."stock_movements" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "object_id" "uuid" NOT NULL,
    "product_id" "uuid" NOT NULL,
    "quantity" integer NOT NULL,
    "reference" "text",
    "note" "text",
    "created_by" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "event" "public"."movement_event" NOT NULL,
    CONSTRAINT "stock_movements_quantity_check" CHECK (("quantity" <> 0))
);


ALTER TABLE "public"."stock_movements" OWNER TO "postgres";


CREATE OR REPLACE VIEW "public"."sales_feed" WITH ("security_invoker"='true') AS
 SELECT "sm"."id",
    "sm"."object_id",
    "o"."name" AS "object_name",
    "sm"."product_id",
    "p"."name" AS "product_name",
    "p"."sku",
    "abs"("sm"."quantity") AS "units",
    "sm"."note",
    "sm"."created_by",
    "sm"."created_at"
   FROM (("public"."stock_movements" "sm"
     JOIN "public"."products" "p" ON (("p"."id" = "sm"."product_id")))
     JOIN "public"."objects" "o" ON (("o"."id" = "sm"."object_id")))
  WHERE ("sm"."event" = 'SALE'::"public"."movement_event");


ALTER VIEW "public"."sales_feed" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."stock_count_items" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "count_id" "uuid" NOT NULL,
    "product_id" "uuid" NOT NULL,
    "expected_qty" integer NOT NULL,
    "counted_qty" integer NOT NULL,
    "variance" integer NOT NULL,
    "reason" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "stock_count_items_counted_qty_check" CHECK (("counted_qty" >= 0))
);


ALTER TABLE "public"."stock_count_items" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."stock_counts" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "object_id" "uuid" NOT NULL,
    "note" "text",
    "counted_by" "text",
    "recorded_by" "uuid",
    "counted_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."stock_counts" OWNER TO "postgres";


CREATE OR REPLACE VIEW "public"."stock_count_summary" WITH ("security_invoker"='true') AS
 SELECT "sc"."id" AS "count_id",
    "sc"."object_id",
    "sc"."counted_by",
    "sc"."recorded_by",
    "sc"."counted_at",
    "count"("sci"."id") AS "lines",
    "count"("sci"."id") FILTER (WHERE ("sci"."variance" <> 0)) AS "discrepancies",
    "count"("sci"."id") FILTER (WHERE ("sci"."variance" < 0)) AS "products_short",
    "count"("sci"."id") FILTER (WHERE ("sci"."variance" > 0)) AS "products_over",
    COALESCE("sum"(
        CASE
            WHEN ("sci"."variance" < 0) THEN (- "sci"."variance")
            ELSE 0
        END), (0)::bigint) AS "units_short",
    COALESCE("sum"(
        CASE
            WHEN ("sci"."variance" > 0) THEN "sci"."variance"
            ELSE 0
        END), (0)::bigint) AS "units_over"
   FROM ("public"."stock_counts" "sc"
     LEFT JOIN "public"."stock_count_items" "sci" ON (("sci"."count_id" = "sc"."id")))
  GROUP BY "sc"."id", "sc"."object_id", "sc"."counted_by", "sc"."recorded_by", "sc"."counted_at";


ALTER VIEW "public"."stock_count_summary" OWNER TO "postgres";


ALTER TABLE ONLY "public"."deliveries"
    ADD CONSTRAINT "deliveries_order_id_key" UNIQUE ("order_id");



ALTER TABLE ONLY "public"."deliveries"
    ADD CONSTRAINT "deliveries_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."delivery_items"
    ADD CONSTRAINT "delivery_items_delivery_id_order_item_id_key" UNIQUE ("delivery_id", "order_item_id");



ALTER TABLE ONLY "public"."delivery_items"
    ADD CONSTRAINT "delivery_items_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."inventory"
    ADD CONSTRAINT "inventory_object_id_product_id_key" UNIQUE ("object_id", "product_id");



ALTER TABLE ONLY "public"."inventory"
    ADD CONSTRAINT "inventory_pkey" PRIMARY KEY ("id");



ALTER TABLE "public"."inventory"
    ADD CONSTRAINT "inventory_quantity_nonneg" CHECK (("quantity" >= 0)) NOT VALID;



ALTER TABLE ONLY "public"."object_products"
    ADD CONSTRAINT "object_products_object_id_product_id_key" UNIQUE ("object_id", "product_id");



ALTER TABLE ONLY "public"."object_products"
    ADD CONSTRAINT "object_products_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."objects"
    ADD CONSTRAINT "objects_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."order_items"
    ADD CONSTRAINT "order_items_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."orders"
    ADD CONSTRAINT "orders_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."products"
    ADD CONSTRAINT "products_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."products"
    ADD CONSTRAINT "products_sku_key" UNIQUE ("sku");



ALTER TABLE ONLY "public"."profiles"
    ADD CONSTRAINT "profiles_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."stock_count_items"
    ADD CONSTRAINT "stock_count_items_count_id_product_id_key" UNIQUE ("count_id", "product_id");



ALTER TABLE ONLY "public"."stock_count_items"
    ADD CONSTRAINT "stock_count_items_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."stock_counts"
    ADD CONSTRAINT "stock_counts_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."stock_movements"
    ADD CONSTRAINT "stock_movements_pkey" PRIMARY KEY ("id");



CREATE INDEX "idx_deliveries_order" ON "public"."deliveries" USING "btree" ("order_id");



CREATE INDEX "idx_delivery_items_delivery" ON "public"."delivery_items" USING "btree" ("delivery_id");



CREATE INDEX "idx_delivery_items_orderitem" ON "public"."delivery_items" USING "btree" ("order_item_id");



CREATE INDEX "idx_inventory_object" ON "public"."inventory" USING "btree" ("object_id");



CREATE INDEX "idx_inventory_product" ON "public"."inventory" USING "btree" ("product_id");



CREATE INDEX "idx_movements_created_at" ON "public"."stock_movements" USING "btree" ("created_at" DESC);



CREATE INDEX "idx_movements_object" ON "public"."stock_movements" USING "btree" ("object_id");



CREATE INDEX "idx_movements_product" ON "public"."stock_movements" USING "btree" ("product_id");



CREATE INDEX "idx_object_products_object" ON "public"."object_products" USING "btree" ("object_id");



CREATE INDEX "idx_object_products_product" ON "public"."object_products" USING "btree" ("product_id");



CREATE INDEX "idx_order_items_order_id" ON "public"."order_items" USING "btree" ("order_id");



CREATE INDEX "idx_order_items_product_id" ON "public"."order_items" USING "btree" ("product_id");



CREATE INDEX "idx_orders_created_by" ON "public"."orders" USING "btree" ("created_by");



CREATE INDEX "idx_orders_object_created_at" ON "public"."orders" USING "btree" ("object_id", "created_at" DESC);



CREATE INDEX "idx_orders_object_id" ON "public"."orders" USING "btree" ("object_id");



CREATE INDEX "idx_orders_status_created_at" ON "public"."orders" USING "btree" ("status", "created_at" DESC);



CREATE INDEX "idx_profiles_object_id" ON "public"."profiles" USING "btree" ("object_id");



CREATE INDEX "idx_stock_count_items_count" ON "public"."stock_count_items" USING "btree" ("count_id");



CREATE INDEX "idx_stock_count_items_product" ON "public"."stock_count_items" USING "btree" ("product_id");



CREATE INDEX "idx_stock_counts_object" ON "public"."stock_counts" USING "btree" ("object_id");



CREATE INDEX "idx_stock_movements_event_created_at" ON "public"."stock_movements" USING "btree" ("event", "created_at" DESC);



CREATE INDEX "idx_stock_movements_object_event_created_at" ON "public"."stock_movements" USING "btree" ("object_id", "event", "created_at" DESC);



CREATE INDEX "idx_stock_movements_object_product_created_at" ON "public"."stock_movements" USING "btree" ("object_id", "product_id", "created_at" DESC);



CREATE OR REPLACE TRIGGER "guard_order" BEFORE INSERT OR UPDATE ON "public"."orders" FOR EACH ROW EXECUTE FUNCTION "public"."guard_order"();



CREATE OR REPLACE TRIGGER "guard_order_item" BEFORE INSERT OR DELETE OR UPDATE ON "public"."order_items" FOR EACH ROW EXECUTE FUNCTION "public"."guard_order_item"();



CREATE OR REPLACE TRIGGER "guard_rpc_only" BEFORE INSERT OR DELETE OR UPDATE ON "public"."deliveries" FOR EACH ROW EXECUTE FUNCTION "public"."guard_rpc_only"();



CREATE OR REPLACE TRIGGER "guard_rpc_only" BEFORE INSERT OR DELETE OR UPDATE ON "public"."delivery_items" FOR EACH ROW EXECUTE FUNCTION "public"."guard_rpc_only"();



CREATE OR REPLACE TRIGGER "guard_rpc_only" BEFORE INSERT OR DELETE OR UPDATE ON "public"."stock_count_items" FOR EACH ROW EXECUTE FUNCTION "public"."guard_rpc_only"();



CREATE OR REPLACE TRIGGER "guard_rpc_only" BEFORE INSERT OR DELETE OR UPDATE ON "public"."stock_counts" FOR EACH ROW EXECUTE FUNCTION "public"."guard_rpc_only"();



CREATE OR REPLACE TRIGGER "guard_stock_movement" BEFORE INSERT ON "public"."stock_movements" FOR EACH ROW EXECUTE FUNCTION "public"."guard_stock_movement"();



CREATE OR REPLACE TRIGGER "on_stock_movement_created" AFTER INSERT ON "public"."stock_movements" FOR EACH ROW EXECUTE FUNCTION "public"."apply_stock_movement"();



CREATE OR REPLACE TRIGGER "protect_inventory" BEFORE INSERT OR DELETE OR UPDATE ON "public"."inventory" FOR EACH ROW EXECUTE FUNCTION "public"."protect_inventory"();



CREATE OR REPLACE TRIGGER "protect_ledger" BEFORE DELETE OR UPDATE ON "public"."stock_movements" FOR EACH ROW EXECUTE FUNCTION "public"."protect_ledger"();



ALTER TABLE ONLY "public"."deliveries"
    ADD CONSTRAINT "deliveries_object_id_fkey" FOREIGN KEY ("object_id") REFERENCES "public"."objects"("id");



ALTER TABLE ONLY "public"."deliveries"
    ADD CONSTRAINT "deliveries_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."deliveries"
    ADD CONSTRAINT "deliveries_recorded_by_fkey" FOREIGN KEY ("recorded_by") REFERENCES "public"."profiles"("id");



ALTER TABLE ONLY "public"."delivery_items"
    ADD CONSTRAINT "delivery_items_delivery_id_fkey" FOREIGN KEY ("delivery_id") REFERENCES "public"."deliveries"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."delivery_items"
    ADD CONSTRAINT "delivery_items_order_item_id_fkey" FOREIGN KEY ("order_item_id") REFERENCES "public"."order_items"("id");



ALTER TABLE ONLY "public"."delivery_items"
    ADD CONSTRAINT "delivery_items_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id");



ALTER TABLE ONLY "public"."inventory"
    ADD CONSTRAINT "inventory_object_id_fkey" FOREIGN KEY ("object_id") REFERENCES "public"."objects"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."inventory"
    ADD CONSTRAINT "inventory_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."object_products"
    ADD CONSTRAINT "object_products_object_id_fkey" FOREIGN KEY ("object_id") REFERENCES "public"."objects"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."object_products"
    ADD CONSTRAINT "object_products_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."order_items"
    ADD CONSTRAINT "order_items_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."order_items"
    ADD CONSTRAINT "order_items_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE RESTRICT;



ALTER TABLE ONLY "public"."orders"
    ADD CONSTRAINT "orders_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "public"."profiles"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."orders"
    ADD CONSTRAINT "orders_object_id_fkey" FOREIGN KEY ("object_id") REFERENCES "public"."objects"("id") ON DELETE RESTRICT;



ALTER TABLE ONLY "public"."profiles"
    ADD CONSTRAINT "profiles_id_fkey" FOREIGN KEY ("id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."profiles"
    ADD CONSTRAINT "profiles_object_id_fkey" FOREIGN KEY ("object_id") REFERENCES "public"."objects"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."stock_count_items"
    ADD CONSTRAINT "stock_count_items_count_id_fkey" FOREIGN KEY ("count_id") REFERENCES "public"."stock_counts"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."stock_count_items"
    ADD CONSTRAINT "stock_count_items_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id");



ALTER TABLE ONLY "public"."stock_counts"
    ADD CONSTRAINT "stock_counts_object_id_fkey" FOREIGN KEY ("object_id") REFERENCES "public"."objects"("id");



ALTER TABLE ONLY "public"."stock_counts"
    ADD CONSTRAINT "stock_counts_recorded_by_fkey" FOREIGN KEY ("recorded_by") REFERENCES "public"."profiles"("id");



ALTER TABLE ONLY "public"."stock_movements"
    ADD CONSTRAINT "stock_movements_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "public"."profiles"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."stock_movements"
    ADD CONSTRAINT "stock_movements_object_id_fkey" FOREIGN KEY ("object_id") REFERENCES "public"."objects"("id") ON DELETE RESTRICT;



ALTER TABLE ONLY "public"."stock_movements"
    ADD CONSTRAINT "stock_movements_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE RESTRICT;



ALTER TABLE "public"."deliveries" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "deliveries_insert" ON "public"."deliveries" FOR INSERT WITH CHECK (("public"."is_admin"() OR ("object_id" = "public"."auth_object_id"())));



CREATE POLICY "deliveries_select" ON "public"."deliveries" FOR SELECT USING (("public"."is_admin"() OR ("object_id" = "public"."auth_object_id"())));



ALTER TABLE "public"."delivery_items" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "delivery_items_insert" ON "public"."delivery_items" FOR INSERT WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."deliveries" "d"
  WHERE (("d"."id" = "delivery_items"."delivery_id") AND ("public"."is_admin"() OR ("d"."object_id" = "public"."auth_object_id"()))))));



CREATE POLICY "delivery_items_select" ON "public"."delivery_items" FOR SELECT USING ((EXISTS ( SELECT 1
   FROM "public"."deliveries" "d"
  WHERE (("d"."id" = "delivery_items"."delivery_id") AND ("public"."is_admin"() OR ("d"."object_id" = "public"."auth_object_id"()))))));



CREATE POLICY "demo_no_del_count_items" ON "public"."stock_count_items" AS RESTRICTIVE FOR DELETE TO "authenticated" USING ((NOT "public"."is_demo"()));



CREATE POLICY "demo_no_del_counts" ON "public"."stock_counts" AS RESTRICTIVE FOR DELETE TO "authenticated" USING ((NOT "public"."is_demo"()));



CREATE POLICY "demo_no_del_deliveries" ON "public"."deliveries" AS RESTRICTIVE FOR DELETE TO "authenticated" USING ((NOT "public"."is_demo"()));



CREATE POLICY "demo_no_del_delivery_items" ON "public"."delivery_items" AS RESTRICTIVE FOR DELETE TO "authenticated" USING ((NOT "public"."is_demo"()));



CREATE POLICY "demo_no_del_inventory" ON "public"."inventory" AS RESTRICTIVE FOR DELETE TO "authenticated" USING ((NOT "public"."is_demo"()));



CREATE POLICY "demo_no_del_movements" ON "public"."stock_movements" AS RESTRICTIVE FOR DELETE TO "authenticated" USING ((NOT "public"."is_demo"()));



CREATE POLICY "demo_no_del_order_items" ON "public"."order_items" AS RESTRICTIVE FOR DELETE TO "authenticated" USING ((NOT "public"."is_demo"()));



CREATE POLICY "demo_no_del_orders" ON "public"."orders" AS RESTRICTIVE FOR DELETE TO "authenticated" USING ((NOT "public"."is_demo"()));



CREATE POLICY "demo_no_upd_movements" ON "public"."stock_movements" AS RESTRICTIVE FOR UPDATE TO "authenticated" USING ((NOT "public"."is_demo"())) WITH CHECK ((NOT "public"."is_demo"()));



CREATE POLICY "demo_no_write_inventory_ins" ON "public"."inventory" AS RESTRICTIVE FOR INSERT TO "authenticated" WITH CHECK (((NOT "public"."is_demo"()) OR ("object_id" = "public"."demo_object_id"())));



CREATE POLICY "demo_no_write_inventory_upd" ON "public"."inventory" AS RESTRICTIVE FOR UPDATE TO "authenticated" USING (((NOT "public"."is_demo"()) OR ("object_id" = "public"."demo_object_id"()))) WITH CHECK (((NOT "public"."is_demo"()) OR ("object_id" = "public"."demo_object_id"())));



CREATE POLICY "demo_ro_objects_del" ON "public"."objects" AS RESTRICTIVE FOR DELETE TO "authenticated" USING ((NOT "public"."is_demo"()));



CREATE POLICY "demo_ro_objects_ins" ON "public"."objects" AS RESTRICTIVE FOR INSERT TO "authenticated" WITH CHECK ((NOT "public"."is_demo"()));



CREATE POLICY "demo_ro_objects_upd" ON "public"."objects" AS RESTRICTIVE FOR UPDATE TO "authenticated" USING ((NOT "public"."is_demo"())) WITH CHECK ((NOT "public"."is_demo"()));



CREATE POLICY "demo_ro_objprod_del" ON "public"."object_products" AS RESTRICTIVE FOR DELETE TO "authenticated" USING ((NOT "public"."is_demo"()));



CREATE POLICY "demo_ro_objprod_ins" ON "public"."object_products" AS RESTRICTIVE FOR INSERT TO "authenticated" WITH CHECK ((NOT "public"."is_demo"()));



CREATE POLICY "demo_ro_products_del" ON "public"."products" AS RESTRICTIVE FOR DELETE TO "authenticated" USING ((NOT "public"."is_demo"()));



CREATE POLICY "demo_ro_products_ins" ON "public"."products" AS RESTRICTIVE FOR INSERT TO "authenticated" WITH CHECK ((NOT "public"."is_demo"()));



CREATE POLICY "demo_ro_products_upd" ON "public"."products" AS RESTRICTIVE FOR UPDATE TO "authenticated" USING ((NOT "public"."is_demo"())) WITH CHECK ((NOT "public"."is_demo"()));



CREATE POLICY "demo_ro_profiles_del" ON "public"."profiles" AS RESTRICTIVE FOR DELETE TO "authenticated" USING ((NOT "public"."is_demo"()));



CREATE POLICY "demo_ro_profiles_ins" ON "public"."profiles" AS RESTRICTIVE FOR INSERT TO "authenticated" WITH CHECK ((NOT "public"."is_demo"()));



CREATE POLICY "demo_ro_profiles_upd" ON "public"."profiles" AS RESTRICTIVE FOR UPDATE TO "authenticated" USING ((NOT "public"."is_demo"())) WITH CHECK ((NOT "public"."is_demo"()));



CREATE POLICY "demo_sandbox_count_items_ins" ON "public"."stock_count_items" AS RESTRICTIVE FOR INSERT TO "authenticated" WITH CHECK (((NOT "public"."is_demo"()) OR (EXISTS ( SELECT 1
   FROM "public"."stock_counts" "sc"
  WHERE (("sc"."id" = "stock_count_items"."count_id") AND ("sc"."object_id" = "public"."demo_object_id"()))))));



CREATE POLICY "demo_sandbox_counts_ins" ON "public"."stock_counts" AS RESTRICTIVE FOR INSERT TO "authenticated" WITH CHECK (((NOT "public"."is_demo"()) OR ("object_id" = "public"."demo_object_id"())));



CREATE POLICY "demo_sandbox_deliveries_ins" ON "public"."deliveries" AS RESTRICTIVE FOR INSERT TO "authenticated" WITH CHECK (((NOT "public"."is_demo"()) OR ("object_id" = "public"."demo_object_id"())));



CREATE POLICY "demo_sandbox_delivery_items_ins" ON "public"."delivery_items" AS RESTRICTIVE FOR INSERT TO "authenticated" WITH CHECK (((NOT "public"."is_demo"()) OR (EXISTS ( SELECT 1
   FROM "public"."deliveries" "d"
  WHERE (("d"."id" = "delivery_items"."delivery_id") AND ("d"."object_id" = "public"."demo_object_id"()))))));



CREATE POLICY "demo_sandbox_movements_ins" ON "public"."stock_movements" AS RESTRICTIVE FOR INSERT TO "authenticated" WITH CHECK (((NOT "public"."is_demo"()) OR ("object_id" = "public"."demo_object_id"())));



CREATE POLICY "demo_sandbox_order_items_ins" ON "public"."order_items" AS RESTRICTIVE FOR INSERT TO "authenticated" WITH CHECK (((NOT "public"."is_demo"()) OR (EXISTS ( SELECT 1
   FROM "public"."orders" "o"
  WHERE (("o"."id" = "order_items"."order_id") AND ("o"."object_id" = "public"."demo_object_id"()))))));



CREATE POLICY "demo_sandbox_orders_ins" ON "public"."orders" AS RESTRICTIVE FOR INSERT TO "authenticated" WITH CHECK (((NOT "public"."is_demo"()) OR ("object_id" = "public"."demo_object_id"())));



CREATE POLICY "demo_sandbox_orders_upd" ON "public"."orders" AS RESTRICTIVE FOR UPDATE TO "authenticated" USING (((NOT "public"."is_demo"()) OR ("object_id" = "public"."demo_object_id"()))) WITH CHECK (((NOT "public"."is_demo"()) OR ("object_id" = "public"."demo_object_id"())));



ALTER TABLE "public"."inventory" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "inventory: admin reads all" ON "public"."inventory" FOR SELECT USING ("public"."is_admin"());



CREATE POLICY "inventory: seller reads own object" ON "public"."inventory" FOR SELECT USING (("object_id" = "public"."auth_object_id"()));



CREATE POLICY "movements: admin full access" ON "public"."stock_movements" USING ("public"."is_admin"()) WITH CHECK ("public"."is_admin"());



CREATE POLICY "movements: seller inserts own object" ON "public"."stock_movements" FOR INSERT WITH CHECK ((("object_id" = "public"."auth_object_id"()) AND ("created_by" = "auth"."uid"())));



CREATE POLICY "movements: seller reads own object" ON "public"."stock_movements" FOR SELECT USING (("object_id" = "public"."auth_object_id"()));



ALTER TABLE "public"."object_products" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "object_products: admin full access" ON "public"."object_products" USING ("public"."is_admin"()) WITH CHECK ("public"."is_admin"());



CREATE POLICY "object_products: seller reads own object assignments" ON "public"."object_products" FOR SELECT USING (("object_id" = "public"."auth_object_id"()));



ALTER TABLE "public"."objects" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "objects: admin full access" ON "public"."objects" USING ("public"."is_admin"()) WITH CHECK ("public"."is_admin"());



CREATE POLICY "objects: seller reads own object" ON "public"."objects" FOR SELECT USING (("id" = "public"."auth_object_id"()));



ALTER TABLE "public"."order_items" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "order_items: admin inserts any" ON "public"."order_items" FOR INSERT WITH CHECK ("public"."is_admin"());



CREATE POLICY "order_items: read if parent order visible" ON "public"."order_items" FOR SELECT USING ((EXISTS ( SELECT 1
   FROM "public"."orders" "o"
  WHERE (("o"."id" = "order_items"."order_id") AND (("o"."created_by" = "auth"."uid"()) OR "public"."is_admin"())))));



CREATE POLICY "order_items: seller inserts into own pending order" ON "public"."order_items" FOR INSERT WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."orders" "o"
  WHERE (("o"."id" = "order_items"."order_id") AND ("o"."created_by" = "auth"."uid"()) AND ("o"."status" = 'PENDING'::"public"."order_status")))));



ALTER TABLE "public"."orders" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "orders: admin creates any" ON "public"."orders" FOR INSERT WITH CHECK ("public"."is_admin"());



CREATE POLICY "orders: admin reads all" ON "public"."orders" FOR SELECT USING ("public"."is_admin"());



CREATE POLICY "orders: admin updates status" ON "public"."orders" FOR UPDATE USING ("public"."is_admin"()) WITH CHECK ("public"."is_admin"());



CREATE POLICY "orders: seller creates for own object" ON "public"."orders" FOR INSERT WITH CHECK ((("created_by" = "auth"."uid"()) AND ("object_id" = "public"."auth_object_id"())));



CREATE POLICY "orders: seller reads own" ON "public"."orders" FOR SELECT USING (("created_by" = "auth"."uid"()));



ALTER TABLE "public"."products" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "products: admin full access" ON "public"."products" USING ("public"."is_admin"()) WITH CHECK ("public"."is_admin"());



CREATE POLICY "products: seller reads active" ON "public"."products" FOR SELECT USING (("active" = true));



ALTER TABLE "public"."profiles" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "profiles: admin manages all" ON "public"."profiles" USING ("public"."is_admin"()) WITH CHECK ("public"."is_admin"());



CREATE POLICY "profiles: read own" ON "public"."profiles" FOR SELECT USING ((("id" = "auth"."uid"()) OR "public"."is_admin"()));



ALTER TABLE "public"."stock_count_items" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "stock_count_items_insert" ON "public"."stock_count_items" FOR INSERT WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."stock_counts" "sc"
  WHERE (("sc"."id" = "stock_count_items"."count_id") AND ("public"."is_admin"() OR ("sc"."object_id" = "public"."auth_object_id"()))))));



CREATE POLICY "stock_count_items_select" ON "public"."stock_count_items" FOR SELECT USING ((EXISTS ( SELECT 1
   FROM "public"."stock_counts" "sc"
  WHERE (("sc"."id" = "stock_count_items"."count_id") AND ("public"."is_admin"() OR ("sc"."object_id" = "public"."auth_object_id"()))))));



ALTER TABLE "public"."stock_counts" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "stock_counts_insert" ON "public"."stock_counts" FOR INSERT WITH CHECK (("public"."is_admin"() OR ("object_id" = "public"."auth_object_id"())));



CREATE POLICY "stock_counts_select" ON "public"."stock_counts" FOR SELECT USING (("public"."is_admin"() OR ("object_id" = "public"."auth_object_id"())));



ALTER TABLE "public"."stock_movements" ENABLE ROW LEVEL SECURITY;




ALTER PUBLICATION "supabase_realtime" OWNER TO "postgres";






ALTER PUBLICATION "supabase_realtime" ADD TABLE ONLY "public"."orders";



ALTER PUBLICATION "supabase_realtime" ADD TABLE ONLY "public"."stock_movements";



GRANT USAGE ON SCHEMA "public" TO "postgres";
GRANT USAGE ON SCHEMA "public" TO "anon";
GRANT USAGE ON SCHEMA "public" TO "authenticated";
GRANT USAGE ON SCHEMA "public" TO "service_role";






















































































































































GRANT ALL ON FUNCTION "public"."apply_stock_movement"() TO "anon";
GRANT ALL ON FUNCTION "public"."apply_stock_movement"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."apply_stock_movement"() TO "service_role";



GRANT ALL ON FUNCTION "public"."assert_object_access"("p_object_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."assert_object_access"("p_object_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."assert_object_access"("p_object_id" "uuid") TO "service_role";



GRANT ALL ON FUNCTION "public"."auth_object_id"() TO "anon";
GRANT ALL ON FUNCTION "public"."auth_object_id"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."auth_object_id"() TO "service_role";



GRANT ALL ON FUNCTION "public"."auth_role"() TO "anon";
GRANT ALL ON FUNCTION "public"."auth_role"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."auth_role"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."create_order_with_items"("p_object_id" "uuid", "p_comment" "text", "p_items" "jsonb") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."create_order_with_items"("p_object_id" "uuid", "p_comment" "text", "p_items" "jsonb") TO "authenticated";
GRANT ALL ON FUNCTION "public"."create_order_with_items"("p_object_id" "uuid", "p_comment" "text", "p_items" "jsonb") TO "service_role";



REVOKE ALL ON FUNCTION "public"."dashboard_summary"("p_object_id" "uuid", "p_days" integer) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."dashboard_summary"("p_object_id" "uuid", "p_days" integer) TO "authenticated";
GRANT ALL ON FUNCTION "public"."dashboard_summary"("p_object_id" "uuid", "p_days" integer) TO "service_role";



REVOKE ALL ON FUNCTION "public"."demo_object_id"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."demo_object_id"() TO "anon";
GRANT ALL ON FUNCTION "public"."demo_object_id"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."demo_object_id"() TO "service_role";



GRANT ALL ON FUNCTION "public"."guard_order"() TO "anon";
GRANT ALL ON FUNCTION "public"."guard_order"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."guard_order"() TO "service_role";



GRANT ALL ON FUNCTION "public"."guard_order_item"() TO "anon";
GRANT ALL ON FUNCTION "public"."guard_order_item"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."guard_order_item"() TO "service_role";



GRANT ALL ON FUNCTION "public"."guard_rpc_only"() TO "anon";
GRANT ALL ON FUNCTION "public"."guard_rpc_only"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."guard_rpc_only"() TO "service_role";



GRANT ALL ON FUNCTION "public"."guard_stock_movement"() TO "anon";
GRANT ALL ON FUNCTION "public"."guard_stock_movement"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."guard_stock_movement"() TO "service_role";



GRANT ALL ON FUNCTION "public"."handle_new_user"() TO "anon";
GRANT ALL ON FUNCTION "public"."handle_new_user"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."handle_new_user"() TO "service_role";



GRANT ALL ON FUNCTION "public"."is_admin"() TO "anon";
GRANT ALL ON FUNCTION "public"."is_admin"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."is_admin"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."is_demo"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."is_demo"() TO "anon";
GRANT ALL ON FUNCTION "public"."is_demo"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."is_demo"() TO "service_role";



GRANT ALL ON FUNCTION "public"."is_direct_api_call"() TO "anon";
GRANT ALL ON FUNCTION "public"."is_direct_api_call"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."is_direct_api_call"() TO "service_role";



GRANT ALL ON FUNCTION "public"."protect_inventory"() TO "anon";
GRANT ALL ON FUNCTION "public"."protect_inventory"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."protect_inventory"() TO "service_role";



GRANT ALL ON FUNCTION "public"."protect_ledger"() TO "anon";
GRANT ALL ON FUNCTION "public"."protect_ledger"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."protect_ledger"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."record_delivery"("p_order_id" "uuid", "p_carrier" "text", "p_received_by" "text", "p_note" "text", "p_items" "jsonb") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."record_delivery"("p_order_id" "uuid", "p_carrier" "text", "p_received_by" "text", "p_note" "text", "p_items" "jsonb") TO "authenticated";
GRANT ALL ON FUNCTION "public"."record_delivery"("p_order_id" "uuid", "p_carrier" "text", "p_received_by" "text", "p_note" "text", "p_items" "jsonb") TO "service_role";



REVOKE ALL ON FUNCTION "public"."record_stock_count"("p_object_id" "uuid", "p_counted_by" "text", "p_note" "text", "p_items" "jsonb") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."record_stock_count"("p_object_id" "uuid", "p_counted_by" "text", "p_note" "text", "p_items" "jsonb") TO "authenticated";
GRANT ALL ON FUNCTION "public"."record_stock_count"("p_object_id" "uuid", "p_counted_by" "text", "p_note" "text", "p_items" "jsonb") TO "service_role";



REVOKE ALL ON FUNCTION "public"."sales_feed_summary"("p_object_id" "uuid", "p_from" timestamp with time zone, "p_search" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."sales_feed_summary"("p_object_id" "uuid", "p_from" timestamp with time zone, "p_search" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."sales_feed_summary"("p_object_id" "uuid", "p_from" timestamp with time zone, "p_search" "text") TO "service_role";



REVOKE ALL ON FUNCTION "public"."stock_level_history"("p_object_id" "uuid", "p_product_id" "uuid", "p_from" timestamp with time zone, "p_to" timestamp with time zone) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."stock_level_history"("p_object_id" "uuid", "p_product_id" "uuid", "p_from" timestamp with time zone, "p_to" timestamp with time zone) TO "authenticated";
GRANT ALL ON FUNCTION "public"."stock_level_history"("p_object_id" "uuid", "p_product_id" "uuid", "p_from" timestamp with time zone, "p_to" timestamp with time zone) TO "service_role";


















GRANT ALL ON TABLE "public"."deliveries" TO "anon";
GRANT ALL ON TABLE "public"."deliveries" TO "authenticated";
GRANT ALL ON TABLE "public"."deliveries" TO "service_role";



GRANT ALL ON TABLE "public"."delivery_items" TO "anon";
GRANT ALL ON TABLE "public"."delivery_items" TO "authenticated";
GRANT ALL ON TABLE "public"."delivery_items" TO "service_role";



GRANT ALL ON TABLE "public"."inventory" TO "anon";
GRANT ALL ON TABLE "public"."inventory" TO "authenticated";
GRANT ALL ON TABLE "public"."inventory" TO "service_role";



GRANT ALL ON TABLE "public"."object_products" TO "anon";
GRANT ALL ON TABLE "public"."object_products" TO "authenticated";
GRANT ALL ON TABLE "public"."object_products" TO "service_role";



GRANT ALL ON TABLE "public"."objects" TO "anon";
GRANT ALL ON TABLE "public"."objects" TO "authenticated";
GRANT ALL ON TABLE "public"."objects" TO "service_role";



GRANT ALL ON TABLE "public"."order_items" TO "anon";
GRANT ALL ON TABLE "public"."order_items" TO "authenticated";
GRANT ALL ON TABLE "public"."order_items" TO "service_role";



GRANT ALL ON TABLE "public"."order_fulfillment" TO "anon";
GRANT ALL ON TABLE "public"."order_fulfillment" TO "authenticated";
GRANT ALL ON TABLE "public"."order_fulfillment" TO "service_role";



GRANT ALL ON TABLE "public"."orders" TO "anon";
GRANT ALL ON TABLE "public"."orders" TO "authenticated";
GRANT ALL ON TABLE "public"."orders" TO "service_role";



GRANT ALL ON TABLE "public"."products" TO "anon";
GRANT ALL ON TABLE "public"."products" TO "authenticated";
GRANT ALL ON TABLE "public"."products" TO "service_role";



GRANT ALL ON TABLE "public"."profiles" TO "anon";
GRANT ALL ON TABLE "public"."profiles" TO "authenticated";
GRANT ALL ON TABLE "public"."profiles" TO "service_role";



GRANT ALL ON TABLE "public"."stock_movements" TO "anon";
GRANT ALL ON TABLE "public"."stock_movements" TO "authenticated";
GRANT ALL ON TABLE "public"."stock_movements" TO "service_role";



GRANT ALL ON TABLE "public"."sales_feed" TO "anon";
GRANT ALL ON TABLE "public"."sales_feed" TO "authenticated";
GRANT ALL ON TABLE "public"."sales_feed" TO "service_role";



GRANT ALL ON TABLE "public"."stock_count_items" TO "anon";
GRANT ALL ON TABLE "public"."stock_count_items" TO "authenticated";
GRANT ALL ON TABLE "public"."stock_count_items" TO "service_role";



GRANT ALL ON TABLE "public"."stock_counts" TO "anon";
GRANT ALL ON TABLE "public"."stock_counts" TO "authenticated";
GRANT ALL ON TABLE "public"."stock_counts" TO "service_role";



GRANT ALL ON TABLE "public"."stock_count_summary" TO "anon";
GRANT ALL ON TABLE "public"."stock_count_summary" TO "authenticated";
GRANT ALL ON TABLE "public"."stock_count_summary" TO "service_role";









ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "service_role";






ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "service_role";






ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "service_role";































