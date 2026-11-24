create function public.supplier_invoice_catalog_options() returns jsonb
language plpgsql stable security definer set search_path=pg_catalog,public,pg_temp as $$
declare sid bigint:=entity_master_private.identity();access jsonb;result jsonb;
begin
 access:=public.supplier_invoice_access();
 if not coalesce((access->>'canView')::boolean,false) then raise exception using errcode='42501',message='No tiene permiso para consultar facturas de proveedores.';end if;
 with invoices as materialized(select supplier_id,transaction_id,po_id,payment_term_id from public.supplier_invoice where subsidiary_id=sid)
 select jsonb_build_object(
 'entities/suppliers',coalesce((select jsonb_agg(jsonb_build_object('supplier_id',s.supplier_id,'company_name',s.company_name) order by s.company_name,s.supplier_id) from public.suppliers s where exists(select 1 from invoices i where i.supplier_id=s.supplier_id)),'[]'::jsonb),
 'organization/subsidiaries',coalesce((select jsonb_agg(jsonb_build_object('subsidiary_id',s.subsidiary_id,'name',s.name)) from public.subsidiaries s where s.subsidiary_id=sid),'[]'::jsonb),
 'transaction-engine/transactions',coalesce((select jsonb_agg(jsonb_build_object('transaction_id',t.transaction_id,'tran_number',t.tran_number)) from public."transaction" t where t.subsidiary_id=sid and exists(select 1 from invoices i where i.transaction_id=t.transaction_id)),'[]'::jsonb),
 'purchasing/orders',coalesce((select jsonb_agg(jsonb_build_object('po_id',p.po_id,'po_number',p.po_number)) from public.purchase_order p where p.subsidiary_id=sid and exists(select 1 from invoices i where i.po_id=p.po_id)),'[]'::jsonb),
 'configuration/payment-terms',coalesce((select jsonb_agg(jsonb_build_object('term_id',p.term_id,'term_name',p.term_name)) from public.payment_terms p where exists(select 1 from invoices i where i.payment_term_id=p.term_id)),'[]'::jsonb)
 ) into result;
 return result;
end $$;
revoke all on function public.supplier_invoice_catalog_options() from public,anon,authenticated,service_role;
grant execute on function public.supplier_invoice_catalog_options() to authenticated;
notify pgrst,'reload schema';
