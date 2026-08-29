create table if not exists public.customer_payment_application(
 application_id bigint generated always as identity primary key,
 payment_id bigint not null references public.customer_payment(payment_id) on delete cascade,
 invoice_id bigint not null references public.invoice(invoice_id) on delete cascade,
 amount numeric(24,6) not null check(amount>0),application_date date not null,
 unique(payment_id,invoice_id)
);
create table if not exists public.supplier_payment_application(
 application_id bigint generated always as identity primary key,
 payment_id bigint not null references public.supplier_payment(payment_id) on delete cascade,
 invoice_id bigint not null references public.supplier_invoice(invoice_id) on delete cascade,
 amount numeric(24,6) not null check(amount>0),application_date date not null,
 unique(payment_id,invoice_id)
);
create index if not exists invoice_ar_aging_idx on public.invoice(subsidiary_id,customer_id,due_date,transaction_id);
create index if not exists supplier_invoice_ap_aging_idx on public.supplier_invoice(subsidiary_id,supplier_id,due_date,transaction_id);
create index if not exists customer_application_cutoff_idx on public.customer_payment_application(invoice_id,application_date);
create index if not exists supplier_application_cutoff_idx on public.supplier_payment_application(invoice_id,application_date);
alter table public.suppliers add column if not exists supplier_category text;
create index if not exists suppliers_category_idx on public.suppliers(supplier_category) where supplier_category is not null;
create index if not exists supplier_payment_aging_idx on public.supplier_payment(supplier_id,payment_date,transaction_id);
alter table public.customer_payment_application enable row level security;alter table public.supplier_payment_application enable row level security;
drop policy if exists aging_application_access on public.customer_payment_application;
create policy aging_application_access on public.customer_payment_application for all to authenticated
using(exists(select 1 from customer_payment p join "transaction" t using(transaction_id) join user_subsidiaries u on u.subsidiary_id=t.subsidiary_id where p.payment_id=customer_payment_application.payment_id and u.user_id=app_user_id()))
with check(exists(select 1 from customer_payment p join "transaction" t using(transaction_id) join user_subsidiaries u on u.subsidiary_id=t.subsidiary_id where p.payment_id=customer_payment_application.payment_id and u.user_id=app_user_id()));
drop policy if exists aging_application_access on public.supplier_payment_application;
create policy aging_application_access on public.supplier_payment_application for all to authenticated
using(exists(select 1 from supplier_payment p join "transaction" t using(transaction_id) join user_subsidiaries u on u.subsidiary_id=t.subsidiary_id where p.payment_id=supplier_payment_application.payment_id and u.user_id=app_user_id()))
with check(exists(select 1 from supplier_payment p join "transaction" t using(transaction_id) join user_subsidiaries u on u.subsidiary_id=t.subsidiary_id where p.payment_id=supplier_payment_application.payment_id and u.user_id=app_user_id()));

create or replace function public.aging_report_options() returns jsonb language sql stable security definer set search_path=public as $$
with allowed as(select subsidiary_id from user_subsidiaries where user_id=app_user_id())
select jsonb_build_object(
 'customers',coalesce((select jsonb_agg(jsonb_build_object('id',c.customer_id,'name',c.company_name,'subsidiaryId',es.subsidiary_id) order by c.company_name) from customers c join entity_subsidiaries es using(customer_id) join allowed a using(subsidiary_id)),'[]'::jsonb),
 'suppliers',coalesce((select jsonb_agg(jsonb_build_object('id',s.supplier_id,'name',s.company_name,'category',s.supplier_category,'subsidiaryId',es.subsidiary_id) order by s.company_name) from suppliers s join entity_subsidiaries es using(supplier_id) join allowed a using(subsidiary_id)),'[]'::jsonb),
 'supplierCategories',coalesce((select jsonb_agg(category order by category) from(select distinct supplier_category category from suppliers where supplier_category is not null and trim(supplier_category)<>'') x),'[]'::jsonb),
 'salesRepresentatives',coalesce((select jsonb_agg(jsonb_build_object('id',e.employee_id,'name',concat_ws(' ',e.first_name,e.last_name),'subsidiaryId',e.subsidiary_id) order by e.first_name,e.last_name) from employees e join allowed a using(subsidiary_id) where e.is_active and e.is_sales_representative),'[]'::jsonb)
)$$;

create or replace function public.run_aging_report(p_kind text,p_filters jsonb default '{}'::jsonb)
returns jsonb language plpgsql stable security definer set search_path=public as $$
declare sid bigint;cutoff date;filter_entity_id bigint;sales_id bigint;filter_cost_id bigint;filter_book_id bigint;filter_supplier_category text;only_pending boolean;currency_mode text;page_no int;page_size int;result jsonb;control_balance numeric;subledger numeric;advances numeric:=0;
begin
 sid:=nullif(p_filters->'subsidiaryIds'->>0,'')::bigint;cutoff:=nullif(p_filters->>'dateTo','')::date;filter_entity_id:=nullif(p_filters->>'agingEntityId','')::bigint;sales_id:=nullif(p_filters->>'salesRepresentativeId','')::bigint;filter_cost_id:=nullif(p_filters->>'costCenterId','')::bigint;filter_book_id:=nullif(p_filters->>'bookId','')::bigint;filter_supplier_category:=nullif(p_filters->>'supplierCategory','');only_pending:=coalesce((p_filters->>'onlyPending')::boolean,true);currency_mode:=coalesce(nullif(p_filters->>'agingCurrencyMode',''),'LOCAL');page_no:=greatest(coalesce((p_filters->>'page')::int,1),1);page_size:=least(greatest(coalesce((p_filters->>'pageSize')::int,50),10),250);
 if sid is null or not exists(select 1 from user_subsidiaries where user_id=app_user_id() and subsidiary_id=sid) then raise exception 'No tiene acceso a la subsidiaria seleccionada.';end if;if cutoff is null then raise exception 'La fecha de corte es obligatoria.';end if;
 if p_kind='AR' then
  with docs as(
   select i.invoice_id document_id,c.customer_id entity_id,c.customer_number entity_code,c.tax_id identification,c.company_name entity_name,concat_ws(' ',rep.first_name,rep.last_name) manager,t.tran_number document_number,t.tran_date issue_date,i.due_date,
    case when currency_mode='ORIGINAL' then i.total_amount else i.total_amount*t.exchange_rate end original_amount,
    case when currency_mode='ORIGINAL' then coalesce(app.applied,0)+coalesce(cred.amount,0) else (coalesce(app.applied,0)+coalesce(cred.amount,0))*t.exchange_rate end applied_amount,
    case when currency_mode='ORIGINAL' then greatest(i.total_amount-coalesce(app.applied,0)-coalesce(cred.amount,0)+coalesce(deb.amount,0),0) else greatest(i.total_amount-coalesce(app.applied,0)-coalesce(cred.amount,0)+coalesce(deb.amount,0),0)*t.exchange_rate end pending,
    greatest(cutoff-i.due_date,0) overdue_days,case when cutoff<=i.due_date then 'CURRENT' when cutoff-i.due_date<=30 then '1_30' when cutoff-i.due_date<=60 then '31_60' when cutoff-i.due_date<=90 then '61_90' when cutoff-i.due_date<=120 then '91_120' else 'OVER_120' end bucket,j.journal_id,
    coalesce((select sum(greatest(p.amount_received-coalesce((select sum(pa.amount) from customer_payment_application pa where pa.payment_id=p.payment_id and pa.application_date<=cutoff),0),0)*(case when currency_mode='ORIGINAL' then 1 else pt.exchange_rate end)) from customer_payment p join "transaction" pt using(transaction_id) where p.customer_id=c.customer_id and pt.subsidiary_id=sid and pt.tran_date<=cutoff),0) entity_advances,
    coalesce((select jsonb_agg(jsonb_build_object('date',a.application_date,'reference',p.payment_number,'amount',a.amount) order by a.application_date) from customer_payment_application a join customer_payment p using(payment_id) where a.invoice_id=i.invoice_id and a.application_date<=cutoff),'[]'::jsonb) applications
   from invoice i join "transaction" t on t.transaction_id=i.transaction_id join customers c on c.customer_id=i.customer_id left join employees rep on rep.employee_id=c.sales_representative_id left join journal j on j.transaction_id=i.transaction_id
   left join lateral(select sum(a.amount) applied from customer_payment_application a where a.invoice_id=i.invoice_id and a.application_date<=cutoff) app on true
   left join lateral(select sum(n.amount) amount from credit_note n join "transaction" nt using(transaction_id) where n.invoice_id=i.invoice_id and nt.tran_date<=cutoff) cred on true
   left join lateral(select sum(n.amount) amount from debit_note n join "transaction" nt using(transaction_id) where n.invoice_id=i.invoice_id and nt.tran_date<=cutoff) deb on true
   where i.subsidiary_id=sid and t.tran_date<=cutoff and (filter_entity_id is null or c.customer_id=filter_entity_id) and (sales_id is null or c.sales_representative_id=sales_id)
  ),filtered as(select *,count(*) over() total_count,sum(pending) over() subledger_total from docs where not only_pending or pending>.005),paged as(select * from filtered order by entity_name,due_date,document_number limit page_size offset(page_no-1)*page_size)
  select jsonb_build_object('rows',coalesce(jsonb_agg(to_jsonb(paged)-'total_count'-'subledger_total'),'[]'::jsonb),'total',coalesce(max(total_count),0),'subledgerTotal',coalesce(max(subledger_total),0),'page',page_no,'pageSize',page_size) into result from paged;
  select coalesce(sum(case when coalesce(a.nature,ag.nature)='Acreedora' then g.credit_amount-g.debit_amount else g.debit_amount-g.credit_amount end),0) into control_balance from gl_impact g join chart_accounts a using(account_id) join account_group ag on ag.group_id=a.account_group_id where g.subsidiary_id=sid and g.posting_date<=cutoff and (lower(a.account_name) like '%cuenta%por cobrar%' or lower(a.account_name) like '%clientes por cobrar%');
  subledger:=coalesce((result->>'subledgerTotal')::numeric,0);
  select coalesce(sum(greatest(p.amount_received-coalesce(a.applied,0),0)*(case when currency_mode='ORIGINAL' then 1 else t.exchange_rate end)),0) into advances from customer_payment p join "transaction" t using(transaction_id) left join lateral(select sum(x.amount) applied from customer_payment_application x where x.payment_id=p.payment_id and x.application_date<=cutoff) a on true where t.subsidiary_id=sid and t.tran_date<=cutoff and (filter_entity_id is null or p.customer_id=filter_entity_id);
 elsif p_kind='AP' then
  with docs as(
   select i.invoice_id document_id,s.supplier_id entity_id,s.supplier_number entity_code,s.tax_id identification,s.company_name entity_name,s.supplier_category entity_category,null::text manager,i.invoice_number external_document_number,t.tran_number document_number,t.tran_date issue_date,i.due_date,
    case when currency_mode='ORIGINAL' then i.total_amount else i.total_amount*t.exchange_rate end original_amount,
    case when currency_mode='ORIGINAL' then coalesce(app.applied,0)+coalesce(cred.amount,0) else (coalesce(app.applied,0)+coalesce(cred.amount,0))*t.exchange_rate end applied_amount,
    case when currency_mode='ORIGINAL' then greatest(i.total_amount-coalesce(app.applied,0)-coalesce(cred.amount,0)+coalesce(deb.amount,0),0) else greatest(i.total_amount-coalesce(app.applied,0)-coalesce(cred.amount,0)+coalesce(deb.amount,0),0)*t.exchange_rate end pending,
    greatest(cutoff-i.due_date,0) overdue_days,case when cutoff<=i.due_date then 'CURRENT' when cutoff-i.due_date<=30 then '1_30' when cutoff-i.due_date<=60 then '31_60' when cutoff-i.due_date<=90 then '61_90' when cutoff-i.due_date<=120 then '91_120' else 'OVER_120' end bucket,j.journal_id,
    coalesce((select sum(greatest(p.amount_paid-coalesce((select sum(pa.amount) from supplier_payment_application pa where pa.payment_id=p.payment_id and pa.application_date<=cutoff),0),0)*(case when currency_mode='ORIGINAL' then 1 else pt.exchange_rate end)) from supplier_payment p join "transaction" pt using(transaction_id) where p.supplier_id=s.supplier_id and pt.subsidiary_id=sid and pt.tran_date<=cutoff),0) entity_advances,
    coalesce((select jsonb_agg(jsonb_build_object('date',history_date,'reference',reference,'type',history_type,'amount',amount) order by history_date) from(select a.application_date history_date,p.payment_number reference,'Pago aplicado' history_type,a.amount from supplier_payment_application a join supplier_payment p using(payment_id) where a.invoice_id=i.invoice_id and a.application_date<=cutoff union all select nt.tran_date,n.cn_number,'Nota de crédito',n.amount from supplier_credit_note n join "transaction" nt using(transaction_id) where n.invoice_id=i.invoice_id and nt.tran_date<=cutoff) history),'[]'::jsonb) applications
   from supplier_invoice i join "transaction" t on t.transaction_id=i.transaction_id join suppliers s on s.supplier_id=i.supplier_id left join journal j on j.transaction_id=i.transaction_id
   left join lateral(select sum(a.amount) applied from supplier_payment_application a where a.invoice_id=i.invoice_id and a.application_date<=cutoff) app on true
   left join lateral(select sum(n.amount) amount from supplier_credit_note n join "transaction" nt using(transaction_id) where n.invoice_id=i.invoice_id and nt.tran_date<=cutoff) cred on true
   left join lateral(select sum(n.amount) amount from supplier_debit_note n join "transaction" nt using(transaction_id) where n.invoice_id=i.invoice_id and nt.tran_date<=cutoff) deb on true
   where i.subsidiary_id=sid and t.tran_date<=cutoff and (filter_entity_id is null or s.supplier_id=filter_entity_id) and (filter_supplier_category is null or s.supplier_category=filter_supplier_category) and (filter_cost_id is null or exists(select 1 from journal_line jl where jl.journal_id=j.journal_id and jl.cost_center_id=filter_cost_id)) and (filter_book_id is null or exists(select 1 from gl_impact gi where gi.transaction_id=i.transaction_id and gi.accounting_book_id=filter_book_id))
  ),filtered as(select *,count(*) over() total_count,sum(pending) over() subledger_total from docs where not only_pending or pending>.005),paged as(select * from filtered order by entity_name,due_date,document_number limit page_size offset(page_no-1)*page_size)
  select jsonb_build_object('rows',coalesce(jsonb_agg(to_jsonb(paged)-'total_count'-'subledger_total'),'[]'::jsonb),'total',coalesce(max(total_count),0),'subledgerTotal',coalesce(max(subledger_total),0),'page',page_no,'pageSize',page_size) into result from paged;
  select coalesce(sum(case when coalesce(a.nature,ag.nature)='Acreedora' then g.credit_amount-g.debit_amount else g.debit_amount-g.credit_amount end),0) into control_balance from gl_impact g join chart_accounts a using(account_id) join account_group ag on ag.group_id=a.account_group_id where g.subsidiary_id=sid and g.posting_date<=cutoff and (filter_book_id is null or g.accounting_book_id=filter_book_id) and (lower(a.account_name) like '%cuenta%por pagar%' or lower(a.account_name) like '%proveedores por pagar%');
  subledger:=coalesce((result->>'subledgerTotal')::numeric,0);
  select coalesce(sum(greatest(p.amount_paid-coalesce(a.applied,0),0)*(case when currency_mode='ORIGINAL' then 1 else t.exchange_rate end)),0) into advances from supplier_payment p join "transaction" t using(transaction_id) left join lateral(select sum(x.amount) applied from supplier_payment_application x where x.payment_id=p.payment_id and x.application_date<=cutoff) a on true where t.subsidiary_id=sid and t.tran_date<=cutoff and (filter_entity_id is null or p.supplier_id=filter_entity_id);
 else raise exception 'Tipo de auxiliar no válido.';end if;
 result:=coalesce(result,jsonb_build_object('rows','[]'::jsonb,'total',0,'page',page_no,'pageSize',page_size));return (result-'subledgerTotal')||jsonb_build_object('summary',jsonb_build_object('subledger',subledger,'advances',advances,'netBalance',subledger-advances,'controlBalance',control_balance,'difference',(subledger-advances)-control_balance));
end$$;
grant select,insert,update,delete on public.customer_payment_application,public.supplier_payment_application to authenticated;
grant usage,select on sequence public.customer_payment_application_application_id_seq,public.supplier_payment_application_application_id_seq to authenticated;
grant execute on function public.aging_report_options(),public.run_aging_report(text,jsonb) to authenticated;
