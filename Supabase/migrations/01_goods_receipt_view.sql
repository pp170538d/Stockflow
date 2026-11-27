create or replace function public.goods_receipt(p_delivery_id uuid)
returns jsonb
language sql
stable
set search_path to 'public'
as $function$
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
    where x.entity_type='DELIVERY' and x.entity_id=d.id and x.document_type='RECEIPT'
    order by x.created_at limit 1
  ),
  'delivery', jsonb_build_object(
    'id',d.id,'delivery_number',d.delivery_number,'delivered_at',d.delivered_at,
    'received_by',d.received_by,'carrier',d.carrier,'note',d.note,
    'dispatch_document_type',d.dispatch_document_type,
    'dispatch_document_number',d.dispatch_document_number,
    'dispatch_external_id',d.dispatch_external_id,
    'physical_receipt_at',d.physical_receipt_at,
    'ereceipt_status',d.ereceipt_status,'ereceipt_number',d.ereceipt_number,
    'ereceipt_external_id',d.ereceipt_external_id,'ereceipt_sent_at',d.ereceipt_sent_at),
  'order', jsonb_build_object(
    'id',o.id,'order_number',o.order_number,'status',o.status,'comment',o.comment,
    'approved_at',o.approved_at,'company',o.company_snapshot,
    'supplier',o.supplier_snapshot,'deliver_to',o.delivery_snapshot),
  'object_name',ob.name,
  'lines',coalesce((
    select jsonb_agg(l order by l.is_open desc,l.product_name) from (
      select di.id line_id,oi.id order_item_id,oi.product_id,p.sku,p.name product_name,
        oi.quantity ordered_qty,di.physical_qty,di.accepted_qty,di.rejected_qty,
        di.held_qty,di.immediate_return_qty,di.short_qty,di.over_qty,
        di.quality_rejected_qty,di.variance_reason_code,di.rejection_reason_code,
        di.accepted_qty received_qty,di.physical_qty-oi.quantity variance,
        oi.quantity-coalesce(di.physical_qty,0) shortage_qty,
        coalesce(oi.unit_cost,p.cost_price) unit_cost,
        round(oi.quantity*coalesce(oi.unit_cost,p.cost_price),2) ordered_value,
        round(di.accepted_qty*coalesce(oi.unit_cost,p.cost_price),2) received_value,
        round((di.physical_qty-oi.quantity)*coalesce(oi.unit_cost,p.cost_price),2) variance_value,
        di.reason_code,di.reason,di.resolution_status,di.resolution,di.resolution_note,
        di.resolved_at,bo.order_number backorder_number,(di.resolution_status='open') is_open
      from order_items oi join products p on p.id=oi.product_id
      left join delivery_items di on di.order_item_id=oi.id and di.delivery_id=d.id
      left join orders bo on bo.id=di.backorder_id
      where oi.order_id=d.order_id
    ) l
  ),'[]'::jsonb)
)
from deliveries d join orders o on o.id=d.order_id join objects ob on ob.id=d.object_id
where d.id=p_delivery_id;
$function$;
