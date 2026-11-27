create or replace function public.orders_work_queue(
  p_object_id uuid default null,
  p_search text default null,
  p_offset integer default 0,
  p_limit integer default 10
)
returns table(order_id uuid, priority integer, work_type text, total_count bigint)
language sql stable security invoker set search_path='public'
as $function$
with visible as (
  select o.id,o.status,o.created_at,
    case
      when o.status='PENDING' then 1
      when o.status='DELIVERED' and (
        exists(select 1 from deliveries d join delivery_items di on di.delivery_id=d.id where d.order_id=o.id and di.resolution_status='open')
        or exists(select 1 from deliveries d join held_stock h on h.delivery_id=d.id where d.order_id=o.id and h.remaining_qty>0)
      ) then 2
      when o.status='APPROVED' then 3
      else 99
    end priority,
    case
      when o.status='PENDING' then 'NEEDS_REVIEW'
      when o.status='DELIVERED' then 'NEEDS_RESOLUTION'
      when o.status='APPROVED' then 'AWAITING_RECEIPT'
    end work_type
  from orders o
  where (p_object_id is null or o.object_id=p_object_id)
    and (nullif(btrim(coalesce(p_search,'')),'') is null
      or o.order_number ilike '%'||replace(replace(replace(btrim(p_search),'%',''),'_',''),',','')||'%'
      or coalesce(o.comment,'') ilike '%'||replace(replace(replace(btrim(p_search),'%',''),'_',''),',','')||'%')
), queue as (select * from visible where priority<99), counted as (select q.*,count(*) over() total_count from queue q)
select id,priority,work_type,total_count from counted
order by priority,created_at asc,id
offset greatest(coalesce(p_offset,0),0) limit greatest(least(coalesce(p_limit,10),100),1);
$function$;

create or replace function public.orders_workload_summary(p_object_id uuid default null)
returns jsonb language sql stable security invoker set search_path='public'
as $function$
with visible as (select * from orders o where p_object_id is null or o.object_id=p_object_id),
resolution as (
 select count(distinct v.id)::int n from visible v where v.status='DELIVERED' and (
  exists(select 1 from deliveries d join delivery_items di on di.delivery_id=d.id where d.order_id=v.id and di.resolution_status='open')
  or exists(select 1 from deliveries d join held_stock h on h.delivery_id=d.id where d.order_id=v.id and h.remaining_qty>0)
 )
)
select jsonb_build_object(
 'needs_review',(select count(*) from visible where status='PENDING'),
 'awaiting_receipt',(select count(*) from visible where status='APPROVED'),
 'needs_resolution',(select n from resolution),
 'received_this_month',(select count(*) from visible where status='DELIVERED' and exists(select 1 from deliveries d where d.order_id=visible.id and d.delivered_at>=date_trunc('month',now())))
);
$function$;
revoke all on function public.orders_work_queue(uuid,text,integer,integer) from public,anon;
revoke all on function public.orders_workload_summary(uuid) from public,anon;
grant execute on function public.orders_work_queue(uuid,text,integer,integer) to authenticated;
grant execute on function public.orders_workload_summary(uuid) to authenticated;
notify pgrst,'reload schema';
