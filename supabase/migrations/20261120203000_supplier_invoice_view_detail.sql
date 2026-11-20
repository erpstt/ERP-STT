-- A document read uses invoice authority and only references of that document.
create function public.supplier_invoice_view_detail(p_invoice_id bigint) returns jsonb
language plpgsql stable security definer set search_path=pg_catalog,public,pg_temp as $$
declare sid bigint;invoice public.supplier_invoice;result jsonb;access jsonb;can_supports boolean;
begin
 sid:=asset_posting_private.access('purchasing:supplier-invoices','view');
 if p_invoice_id is null or p_invoice_id<=0 or p_invoice_id>9007199254740991 then raise exception using errcode='22023',message='Identificador de factura inválido.';end if;
 select * into invoice from public.supplier_invoice where invoice_id=p_invoice_id and subsidiary_id=sid;
 if not found then raise exception using errcode='42501',message='Factura no disponible en la empresa activa.';end if;
 access:=public.supplier_invoice_access();can_supports:=asset_posting_private.allowed('accounting:journal-supports','view');
 with selected_lines as materialized(select l.* from public.supplier_invoice_line l where l.invoice_id=invoice.invoice_id),
 selected_withholdings as materialized(select w.* from public.supplier_invoice_withholding w where w.invoice_id=invoice.invoice_id),
 selected_impacts as materialized(select g.* from public.gl_impact g where g.transaction_id=invoice.transaction_id and g.subsidiary_id=sid)
 select jsonb_build_object(
 'context',jsonb_build_object('subsidiaryId',sid,'invoiceId',invoice.invoice_id),
 'access',jsonb_build_object('canEdit',coalesce((access->>'canEdit')::boolean,false),'canViewSupports',can_supports),
 'invoices',jsonb_build_array(supplier_invoice_form_private.project(to_jsonb(invoice),array['invoice_id','invoice_number','invoice_type','transaction_id','supplier_id','payment_term_id','location_id','subsidiary_id','currency_id','invoice_date','due_date','exchange_rate','memo','journal_id','subtotal_amount','tax_total','total_amount','withholding_total','payable_amount'])),
 'invoiceLines',coalesce((select jsonb_agg(supplier_invoice_form_private.project(to_jsonb(l),array['line_id','invoice_id','account_id','quantity','unit_price','amount','tax_code_id','tax_rate','tax_amount','gross_amount','note','department_id','cost_center_id','class_id']) order by l.line_id)from selected_lines l),'[]'),
 'withholdings',coalesce((select jsonb_agg(supplier_invoice_form_private.project(to_jsonb(w),array['invoice_withholding_id','invoice_id','tax_code_id','calculation_base','base_amount','rate_percentage','withholding_amount','application_moment','recognized_at_invoice']) order by w.invoice_withholding_id)from selected_withholdings w),'[]'),
 'impacts',coalesce((select jsonb_agg(supplier_invoice_form_private.project(to_jsonb(g),array['gl_impact_id','transaction_id','account_id','debit_amount','credit_amount','posting_date']) order by g.gl_impact_id)from selected_impacts g),'[]'),
 'accounts',coalesce((select jsonb_agg(jsonb_build_object('account_id',a.account_id,'account_number',a.account_number,'account_name',a.account_name)order by a.account_id)from public.chart_accounts a where a.account_id in(select account_id from selected_lines union select account_id from selected_impacts)),'[]'),
 'suppliers',coalesce((select jsonb_agg(jsonb_build_object('supplier_id',s.supplier_id,'company_name',s.company_name))from public.suppliers s where s.supplier_id=invoice.supplier_id),'[]'),
 'terms',coalesce((select jsonb_agg(jsonb_build_object('term_id',t.term_id,'term_name',t.term_name))from public.payment_terms t where t.term_id=invoice.payment_term_id),'[]'),
 'currencies',coalesce((select jsonb_agg(jsonb_build_object('currency_id',c.currency_id,'currency_code',c.currency_code,'name',c.name))from public.currencies c where c.currency_id=invoice.currency_id),'[]'),
 'departments',coalesce((select jsonb_agg(jsonb_build_object('department_id',d.department_id,'name',d.name))from public.departments d where d.department_id in(select department_id from selected_lines)),'[]'),
 'costs',coalesce((select jsonb_agg(jsonb_build_object('cost_center_id',c.cost_center_id,'name',c.name))from public.cost_centers c where c.cost_center_id in(select cost_center_id from selected_lines)),'[]'),
 'classes',coalesce((select jsonb_agg(jsonb_build_object('class_id',c.class_id,'name',c.name))from public.classes c where c.class_id in(select class_id from selected_lines)),'[]'),
 'taxes',coalesce((select jsonb_agg(jsonb_build_object('tax_code_id',t.tax_code_id,'code_name',t.code_name))from public.tax_codes t where t.tax_code_id in(select tax_code_id from selected_lines union select tax_code_id from selected_withholdings)),'[]'),
 'subsidiaries',coalesce((select jsonb_agg(jsonb_build_object('subsidiary_id',s.subsidiary_id,'name',s.name))from public.subsidiaries s where s.subsidiary_id=sid),'[]'),
 'locations',coalesce((select jsonb_agg(jsonb_build_object('location_id',l.location_id,'name',l.name))from public.locations l where l.location_id=invoice.location_id),'[]')
 )into result;
 if can_supports then result:=result||jsonb_build_object('supports',coalesce((select jsonb_agg(to_jsonb(s)order by s.support_id)from public.journal_support s join public.journal j on j.journal_id=s.journal_id and j.subsidiary_id=sid where s.journal_id=invoice.journal_id),'[]'));else result:=result||jsonb_build_object('supports','[]'::jsonb);end if;
 return result;
end$$;
revoke all on function public.supplier_invoice_view_detail(bigint) from public,anon,authenticated,service_role;
grant execute on function public.supplier_invoice_view_detail(bigint) to authenticated;
notify pgrst,'reload schema';
