CREATE OR REPLACE FUNCTION public.run_classified_receivables_report(p_filters jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
declare result jsonb; enriched jsonb;
begin
 perform report_template_private.enter('reports:accounting-reports','view');
 result:=public.run_aging_report('AR',p_filters);
 select coalesce(jsonb_agg(item.value||jsonb_build_object(
   'discounted',coalesce(mark.discounted,false),
   'discount_updated_at',mark.updated_at,
   'discount_subsidiary_id',invoice.subsidiary_id,
   'financial_creditor_id',mark.financial_creditor_id,'financial_creditor_name',creditor.name,
   'operation_number',mark.operation_number,'operation_due_date',mark.operation_due_date,
   'intercompany',case when account.account_id is not null then account.account_number='113002' else coalesce(customer.is_intercompany,false) end
 ) order by item.ordinality),'[]'::jsonb) into enriched
 from jsonb_array_elements(coalesce(result->'rows','[]'::jsonb)) with ordinality item(value,ordinality)
 join public.invoice invoice on invoice.invoice_id=(item.value->>'document_id')::bigint
 join public.customers customer on customer.customer_id=invoice.customer_id
 left join public.chart_accounts account on account.account_id=invoice.receivable_account_id
 left join report_delivery_private.receivable_discount_marks mark using(invoice_id)
 left join public.financial_creditors creditor on creditor.financial_creditor_id=mark.financial_creditor_id
 where exists(select 1 from public.user_subsidiaries access where access.user_id=public.app_user_id() and access.subsidiary_id=invoice.subsidiary_id);
 return result||jsonb_build_object('rows',enriched,'financialCreditors',(
 select coalesce(jsonb_agg(jsonb_build_object('id',c.financial_creditor_id,'name',c.name,'subsidiaryId',a.subsidiary_id) order by c.name,c.financial_creditor_id),'[]'::jsonb)
 from public.financial_creditors c join public.financial_creditor_subsidiaries a using(financial_creditor_id)
 where not coalesce(c.is_inactive,false) and exists(select 1 from public.user_subsidiaries u where u.user_id=public.app_user_id() and u.subsidiary_id=a.subsidiary_id)
 ));
end $function$
;

