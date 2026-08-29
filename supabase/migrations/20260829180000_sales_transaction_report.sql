create index if not exists transaction_sales_report_idx on public."transaction"(subsidiary_id,transaction_type_id,tran_date,customer_id);
create index if not exists invoice_sales_report_idx on public.invoice(subsidiary_id,customer_id,transaction_id);
create index if not exists credit_note_sales_report_idx on public.credit_note(customer_id,transaction_id,invoice_id);
create index if not exists debit_note_sales_report_idx on public.debit_note(customer_id,transaction_id,invoice_id);

create or replace function public.run_sales_transaction_report(p_filters jsonb default '{}'::jsonb)
returns jsonb language plpgsql stable security definer set search_path=public as $$
declare sid bigint;date_from date;date_to date;customer_key bigint;seller_key bigint;cost_key bigint;currency_mode text;group_mode text;exclude_cancelled boolean;selected_types text[];page_no int;page_size int;result jsonb;
begin
 sid:=nullif(p_filters->'subsidiaryIds'->>0,'')::bigint;date_from:=nullif(p_filters->>'dateFrom','')::date;date_to:=nullif(p_filters->>'dateTo','')::date;
 customer_key:=nullif(p_filters->>'salesCustomerId','')::bigint;seller_key:=nullif(p_filters->>'salesRepresentativeId','')::bigint;cost_key:=nullif(p_filters->>'salesCostCenterId','')::bigint;
 currency_mode:=coalesce(nullif(p_filters->>'salesCurrencyMode',''),'BASE');group_mode:=coalesce(nullif(p_filters->>'salesGroupMode',''),'TRANSACTION');exclude_cancelled:=coalesce((p_filters->>'excludeCancelled')::boolean,true);
 select coalesce(array_agg(value),array['FAC_VEN','NC_VEN','ND_VEN']) into selected_types from jsonb_array_elements_text(coalesce(p_filters->'salesTransactionTypes','["FAC_VEN","NC_VEN","ND_VEN"]'::jsonb));
 page_no:=greatest(coalesce((p_filters->>'page')::int,1),1);page_size:=least(greatest(coalesce((p_filters->>'pageSize')::int,50),10),250);
 if sid is null or not exists(select 1 from user_subsidiaries where user_id=app_user_id() and subsidiary_id=sid) then raise exception 'No tiene acceso a la subsidiaria seleccionada.';end if;
 if date_from is null or date_to is null then raise exception 'El rango de fechas es obligatorio.';end if;
 with documents as(
  select 'FAC_VEN' document_type,i.invoice_id document_id,i.invoice_number document_number,null::text referenced_document,i.customer_id,i.transaction_id,i.subsidiary_id,i.total_amount raw_total from invoice i
  union all select 'NC_VEN',n.cn_id,n.cn_number,i.invoice_number,n.customer_id,n.transaction_id,i.subsidiary_id,n.amount from credit_note n join invoice i using(invoice_id)
  union all select 'ND_VEN',n.dn_id,n.dn_number,i.invoice_number,n.customer_id,n.transaction_id,i.subsidiary_id,n.amount from debit_note n join invoice i using(invoice_id)
 ),base as(
  select d.*,t.tran_date issue_date,t.exchange_rate,c.currency_code,currency_mode,cu.tax_id customer_tax_id,cu.company_name customer_name,concat_ws(' ',e.first_name,e.last_name) seller_name,coalesce(st.code,'CONTABILIZADO') document_status,j.journal_id,
   coalesce((select sum(abs(g.credit_amount-g.debit_amount)) from gl_impact g join chart_accounts a using(account_id) where g.transaction_id=d.transaction_id and a.category='Ingreso'),0) revenue_amount,
   coalesce((select string_agg(distinct cc.code,', ' order by cc.code) from journal_line jl join cost_centers cc using(cost_center_id) where jl.journal_id=j.journal_id),'—') cost_centers
  from documents d join "transaction" t using(transaction_id) join currencies c using(currency_id) join customers cu using(customer_id) left join employees e on e.employee_id=cu.sales_representative_id left join status st using(status_id) left join journal j using(transaction_id)
  where d.subsidiary_id=sid and t.tran_date between date_from and date_to and d.document_type=any(selected_types) and (customer_key is null or d.customer_id=customer_key) and (seller_key is null or cu.sales_representative_id=seller_key) and (not exclude_cancelled or upper(coalesce(st.code,''))<>'ANULADO') and (cost_key is null or exists(select 1 from journal_line jl where jl.journal_id=j.journal_id and jl.cost_center_id=cost_key))
 ),calculated as(
  select *,case when document_type='NC_VEN' then -1 else 1 end sign_value,case when currency_mode='BASE' then exchange_rate else 1 end conversion,
   case when revenue_amount>0 then revenue_amount else raw_total end calculated_base,count(*) over() total_count from base
 ),rows_data as(
  select document_type,document_id,document_number,referenced_document,transaction_id,journal_id,issue_date,customer_tax_id,customer_name,coalesce(seller_name,'—') seller_name,document_status,cost_centers,currency_code,
   0::numeric discount,sign_value*calculated_base*conversion subtotal,sign_value*calculated_base*conversion taxable_base,sign_value*greatest(raw_total-calculated_base,0)*conversion tax,sign_value*raw_total*conversion total,total_count
  from calculated
 ),paged as(select * from rows_data order by issue_date,transaction_id limit page_size offset(page_no-1)*page_size)
 select jsonb_build_object('rows',coalesce((select jsonb_agg(to_jsonb(p)-'total_count' order by issue_date,transaction_id) from paged p),'[]'::jsonb),'total',coalesce((select max(total_count) from rows_data),0),'page',page_no,'pageSize',page_size,
  'summary',jsonb_build_object('invoices',coalesce((select sum(abs(total)) from rows_data where document_type='FAC_VEN'),0),'debitNotes',coalesce((select sum(abs(total)) from rows_data where document_type='ND_VEN'),0),'creditNotes',coalesce((select sum(abs(total)) from rows_data where document_type='NC_VEN'),0),'netSales',coalesce((select sum(total) from rows_data),0),'netBase',coalesce((select sum(taxable_base) from rows_data),0),'groupMode',group_mode)) into result;
 return result;
end$$;

grant execute on function public.run_sales_transaction_report(jsonb) to authenticated;
