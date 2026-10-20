-- =====================================================================
-- Stockflow guard tests v4  (supabase/tests/guards_tests.sql)
-- Paste the whole file into Supabase SQL Editor and click Run.
-- Supabase warning about "destructive operations / RLS" on _guard_results
--   -> choose "Run without RLS" (it is a TEMP table, session-only).
--
-- 100% SAFE: everything (temporary seller->store assignment, all test
-- writes, role switch) runs inside ONE sub-transaction that is ALWAYS
-- rolled back at the end. Only the result list survives.
--
-- Works even if your SELLER has no store: the seller is temporarily
-- assigned to a store that has stock, just for the duration of the test.
-- =====================================================================

drop table if exists _guard_results;
create temp table _guard_results (
  nr      int,
  test    text,
  status  text,
  detail  text
);

do $$
declare
  v_seller uuid;
  v_own    uuid;
  v_other  uuid;
  v_prod   uuid;
  v_before int;
  v_after  int;
  v_note   text := null;
  r        text[] := '{}';   -- rows as "nr|test|status|detail"

  c_accepted constant text := '__accepted_rolled_back__';
  c_rollback constant text := '__test_rollback__';
  c_end      constant text := '__end_of_tests__';
begin
  -- ===================================================================
  -- Outer sub-transaction: EVERYTHING inside is rolled back at the end
  -- ===================================================================
  begin
    -- ---------------- pick a store with stock + a product -------------
    select i.object_id, i.product_id, i.quantity
      into v_own, v_prod, v_before
    from public.inventory i
    where i.quantity > 0
    order by i.quantity desc
    limit 1;

    if v_own is null then
      raise exception 'No store has any stock. Record a delivery first.';
    end if;

    -- ---------------- pick a seller --------------------------------
    -- prefer a seller already assigned to that store
    select id into v_seller
    from public.profiles
    where role = 'SELLER' and object_id = v_own
    limit 1;

    if v_seller is null then
      select id into v_seller
      from public.profiles
      where role = 'SELLER'
      limit 1;

      if v_seller is null then
        raise exception 'No SELLER user exists. Create one in the app first.';
      end if;

      -- temporary assignment, rolled back at the end
      update public.profiles set object_id = v_own where id = v_seller;
      v_note := 'Seller was TEMPORARILY assigned to store ' || v_own || ' (rolled back).';
    end if;

    select id into v_other from public.objects where id <> v_own limit 1;

    -- ---------------- impersonate the seller (like PostgREST) --------
    perform set_config('request.jwt.claims',
      json_build_object('sub', v_seller, 'role', 'authenticated')::text, true);
    set local role authenticated;

    -- 1. Fake DELIVERY from the browser
    begin
      insert into public.stock_movements (object_id, product_id, event, quantity)
      values (v_own, v_prod, 'DELIVERY', 1000);
      raise exception '%', c_accepted;
    exception when others then
      if sqlerrm = c_accepted then
        r := array_append(r, ('1|Seller fakes a DELIVERY|FAIL|was accepted (rolled back)')::text);
      else
        r := array_append(r, (('1|Seller fakes a DELIVERY|OK|' || sqlerrm))::text);
      end if;
    end;

    -- 2. Sale in someone else's store
    if v_other is null then
      r := array_append(r, ('2|Sale in another store|SKIP|only one store exists')::text);
    else
      begin
        insert into public.stock_movements (object_id, product_id, event, quantity)
        values (v_other, v_prod, 'SALE', -1);
        raise exception '%', c_accepted;
      exception when others then
        if sqlerrm = c_accepted then
          r := array_append(r, ('2|Sale in another store|FAIL|was accepted (rolled back)')::text);
        else
          r := array_append(r, (('2|Sale in another store|OK|' || sqlerrm))::text);
        end if;
      end;
    end if;

    -- 3. Oversell
    begin
      insert into public.stock_movements (object_id, product_id, event, quantity)
      values (v_own, v_prod, 'SALE', -(v_before + 1));
      raise exception '%', c_accepted;
    exception when others then
      if sqlerrm = c_accepted then
        r := array_append(r, ('3|Oversell|FAIL|was accepted (rolled back)')::text);
      else
        r := array_append(r, (('3|Oversell|OK|' || sqlerrm))::text);
      end if;
    end;

    -- 4. Direct inventory edit
    begin
      update public.inventory set quantity = 9999
      where object_id = v_own and product_id = v_prod;
      if found then
        raise exception '%', c_accepted;
      end if;
      r := array_append(r, ('4|Direct inventory edit|OK|no row visible/changed (RLS)')::text);
    exception when others then
      if sqlerrm = c_accepted then
        r := array_append(r, ('4|Direct inventory edit|FAIL|was accepted (rolled back)')::text);
      else
        r := array_append(r, (('4|Direct inventory edit|OK|' || sqlerrm))::text);
      end if;
    end;

    -- 5. Delete from the ledger
    begin
      delete from public.stock_movements where object_id = v_own;
      if found then
        raise exception '%', c_accepted;
      end if;
      r := array_append(r, ('5|Delete from ledger|OK|no row visible/deleted (RLS)')::text);
    exception when others then
      if sqlerrm = c_accepted then
        r := array_append(r, ('5|Delete from ledger|FAIL|rows were deletable (rolled back)')::text);
      else
        r := array_append(r, (('5|Delete from ledger|OK|' || sqlerrm))::text);
      end if;
    end;

    -- 6. Stock count for another store via RPC
    if v_other is null then
      r := array_append(r, ('6|Stock count in another store|SKIP|only one store exists')::text);
    else
      begin
        perform public.record_stock_count(
          p_object_id  => v_other,
          p_items      => jsonb_build_array(jsonb_build_object(
                            'product_id', v_prod, 'counted_qty', 0, 'reason', 'test')),
          p_counted_by => 'test',
          p_note       => null);
        raise exception '%', c_accepted;
      exception
        when undefined_function then
          r := array_append(r, (('6|Stock count in another store|SKIP|RPC signature differs: ' || sqlerrm))::text);
        when others then
          if sqlerrm = c_accepted then
            r := array_append(r, ('6|Stock count in another store|FAIL|was accepted (rolled back)')::text);
          else
            r := array_append(r, (('6|Stock count in another store|OK|' || sqlerrm))::text);
          end if;
      end;
    end if;

    -- 7. A normal sale of 1 must still work
    begin
      insert into public.stock_movements (object_id, product_id, event, quantity, note)
      values (v_own, v_prod, 'SALE', -1, 'guard test');

      select quantity into v_after
      from public.inventory
      where object_id = v_own and product_id = v_prod;

      raise exception '%', c_rollback;
    exception when others then
      if sqlerrm = c_rollback then
        if v_after = v_before - 1 then
          r := array_append(r, (format('7|Normal sale still works|OK|balance %s -> %s (rolled back)', v_before, v_after))::text);
        else
          r := array_append(r, (format('7|Normal sale still works|FAIL|expected %s, got %s', v_before - 1, v_after))::text);
        end if;
      else
        r := array_append(r, (('7|Normal sale still works|FAIL|' || sqlerrm))::text);
      end if;
    end;

    -- roll back EVERYTHING above (assignment, role, jwt, writes)
    raise exception '%', c_end;

  exception when others then
    if sqlerrm <> c_end then
      raise;   -- real setup error -> show it
    end if;
  end;

  -- ===================================================================
  -- Back as postgres, nothing changed in the DB. Store results.
  -- ===================================================================
  if v_note is not null then
    r := array_append(r, (('0|Setup|INFO|' || v_note))::text);
  end if;

  insert into _guard_results (nr, test, status, detail)
  select split_part(x, '|', 1)::int,
         split_part(x, '|', 2),
         split_part(x, '|', 3),
         substr(x, length(split_part(x, '|', 1)) + length(split_part(x, '|', 2))
                   + length(split_part(x, '|', 3)) + 4)
  from unnest(r) as x;
end $$;

select nr, test, status, detail from _guard_results order by nr;
