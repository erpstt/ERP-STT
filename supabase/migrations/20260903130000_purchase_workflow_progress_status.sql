create or replace function purchase_document_report(p_filters jsonb) returns jsonb
language sql stable security definer set search_path=public as $$
select jsonb_build_object('rows',coalesce(jsonb_agg(jsonb_build_object(
 'id',d.document_id,'number',d.document_number,'date',d.document_date,'type',d.document_type,
 'supplier',s.company_name,'currency',c.currency_code,'total',d.total_amount,'status',d.status,
 'source',src.document_number,
 'hasNextDocument',case
   when d.document_type='REQUISITION' then exists(select 1 from purchase_document n where n.source_document_id=d.document_id and n.document_type='QUOTE')
   when d.document_type='QUOTE' then exists(select 1 from purchase_document n where n.source_document_id=d.document_id and n.document_type='ORDER')
   else false end,
 'invoiced',case when d.document_type='RECEIPT' then exists(select 1 from supplier_invoice si where si.purchase_receipt_document_id=d.document_id) else false end,
 'invoiceNumber',case when d.document_type='RECEIPT' then(select si.invoice_number from supplier_invoice si where si.purchase_receipt_document_id=d.document_id limit 1)end,
 'fullyReceived',case when d.document_type='ORDER' then not exists(
   select 1 from purchase_document_line ol where ol.document_id=d.document_id
   and coalesce((select sum(rl.quantity) from purchase_document rd join purchase_document_line rl on rl.document_id=rd.document_id where rd.document_type='RECEIPT' and rd.source_document_id=d.document_id and rl.line_number=ol.line_number),0)<ol.quantity
 ) else false end
) order by d.document_date desc,d.document_id desc),'[]'))
from purchase_document d left join suppliers s on s.supplier_id=d.supplier_id join currencies c on c.currency_id=d.currency_id left join purchase_document src on src.document_id=d.source_document_id
where d.subsidiary_id=active_subsidiary_id() and d.document_type=p_filters->>'type' and d.document_date between(p_filters->>'from')::date and(p_filters->>'to')::date
$$;
grant execute on function purchase_document_report(jsonb) to authenticated;
notify pgrst,'reload schema';
