create index if not exists supplier_invoice_purchase_report_idx on public.supplier_invoice(subsidiary_id,supplier_id,transaction_id);
create index if not exists supplier_credit_note_purchase_report_idx on public.supplier_credit_note(supplier_id,transaction_id,invoice_id);
create index if not exists supplier_debit_note_purchase_report_idx on public.supplier_debit_note(supplier_id,transaction_id,invoice_id);

create or replace function public.run_purchase_transaction_report(p_filters jsonb default '{}'::jsonb)
returns jsonb language plpgsql stable security definer set search_path=public as $$
declare sid bigint;date_from date;date_to date;supplier_key bigint;cost_key bigint;supplier_category_filter text;currency_mode text;group_mode text;exclude_cancelled boolean;selected_types text[];page_no int;page_size int;result jsonb;
begin
 sid:=nullif(p_filters->'subsidiaryIds'->>0,'')::bigint;date_from:=nullif(p_filters->>'dateFrom','')::date;date_to:=nullif(p_filters->>'dateTo','')::date;
 supplier_key:=nullif(p_filters->>'purchaseSupplierId','')::bigint;cost_key:=nullif(p_filters->>'purchaseCostCenterId','')::bigint;supplier_category_filter:=nullif(p_filters->>'purchaseCategory','');currency_mode:=coalesce(nullif(p_filters->>'purchaseCurrencyMode',''),'BASE');group_mode:=coalesce(nullif(p_filters->>'purchaseGroupMode',''),'TRANSACTION');exclude_cancelled:=coalesce((p_filters->>'excludePurchaseCancelled')::boolean,true);
 select coalesce(array_agg(value),array['FAC_PRO','NC_PRO','ND_PRO']) into selected_types from jsonb_array_elements_text(coalesce(p_filters->'purchaseTransactionTypes','["FAC_PRO","NC_PRO","ND_PRO"]'::jsonb));
 page_no:=greatest(coalesce((p_filters->>'page')::int,1),1);page_size:=least(greatest(coalesce((p_filters->>'pageSize')::int,50),10),250);
 if sid is null or not exists(select 1 from user_subsidiaries where user_id=app_user_id() and subsidiary_id=sid) then raise exception 'No tiene acceso a la subsidiaria seleccionada.';end if;
 if date_from is null or date_to is null then raise exception 'El rango de fechas es obligatorio.';end if;
 with documents as(
  select 'FAC_PRO' document_type,i.invoice_id document_id,i.invoice_number document_number,null::text referenced_document,i.supplier_id,i.transaction_id,i.subsidiary_id,i.total_amount raw_total from supplier_invoice i
  union all select 'NC_PRO',n.cn_id,n.cn_number,i.invoice_number,n.supplier_id,n.transaction_id,i.subsidiary_id,n.amount from supplier_credit_note n join supplier_invoice i using(invoice_id)
  union all select 'ND_PRO',n.dn_id,n.dn_number,i.invoice_number,n.supplier_id,n.transaction_id,i.subsidiary_id,n.amount from supplier_debit_note n join supplier_invoice i using(invoice_id)
 ),base as(
  select d.*,t.tran_date issue_date,t.exchange_rate,c.currency_code,sp.tax_id supplier_tax_id,sp.company_name supplier_name,sp.supplier_category,coalesce(st.code,'CONTABILIZADO') document_status,j.journal_id,
   coalesce((select sum(abs(g.debit_amount-g.credit_amount)) from gl_impact g join chart_accounts a using(account_id) where g.transaction_id=d.transaction_id and a.category in('Costo','Gasto')),0) expense_amount,
   coalesce((select string_agg(distinct cc.code,', ' order by cc.code) from journal_line jl join cost_centers cc using(cost_center_id) where jl.journal_id=j.journal_id),'—') cost_centers
  from documents d join "transaction" t using(transaction_id) join currencies c using(currency_id) join suppliers sp using(supplier_id) left join status st using(status_id) left join journal j using(transaction_id)
  where d.subsidiary_id=sid and t.tran_date between date_from and date_to and d.document_type=any(selected_types) and (supplier_key is null or d.supplier_id=supplier_key) and (supplier_category_filter is null or sp.supplier_category=supplier_category_filter) and (not exclude_cancelled or upper(coalesce(st.code,''))<>'ANULADO') and (cost_key is null or exists(select 1 from journal_line jl where jl.journal_id=j.journal_id and jl.cost_center_id=cost_key))
 ),calculated as(
  select *,case when document_type='NC_PRO' then -1 else 1 end sign_value,case when currency_mode='BASE' then exchange_rate else 1 end conversion,case when expense_amount>0 then expense_amount else raw_total end calculated_base,count(*) over() total_count from base
 ),rows_data as(
  select document_type,document_id,document_number,referenced_document,transaction_id,journal_id,issue_date,supplier_tax_id,supplier_name,coalesce(supplier_category,'—') supplier_category,document_status,cost_centers,currency_code,0::numeric discount,
   sign_value*calculated_base*conversion subtotal,sign_value*calculated_base*conversion taxable_base,sign_value*greatest(raw_total-calculated_base,0)*conversion tax,sign_value*raw_total*conversion total,total_count from calculated
 ),paged as(select * from rows_data order by issue_date,transaction_id limit page_size offset(page_no-1)*page_size)
 select jsonb_build_object('rows',coalesce((select jsonb_agg(to_jsonb(p)-'total_count' order by issue_date,transaction_id) from paged p),'[]'::jsonb),'total',coalesce((select max(total_count) from rows_data),0),'page',page_no,'pageSize',page_size,
 'summary',jsonb_build_object('invoices',coalesce((select sum(abs(total)) from rows_data where document_type='FAC_PRO'),0),'debitNotes',coalesce((select sum(abs(total)) from rows_data where document_type='ND_PRO'),0),'creditNotes',coalesce((select sum(abs(total)) from rows_data where document_type='NC_PRO'),0),'netPurchases',coalesce((select sum(total) from rows_data),0),'netBase',coalesce((select sum(taxable_base) from rows_data),0),'groupMode',group_mode)) into result;
 return result;
end$$;

grant execute on function public.run_purchase_transaction_report(jsonb) to authenticated;
