-- Read-only account 115004. GL carries both authoritative historical amounts.
-- Never reconstruct foreign amounts from a current exchange rate or allocate
-- an ambiguous journal line by position. Unattributed GL remains in the report.
set local lock_timeout='5s';
set local statement_timeout='60s';

create schema supplier_advances_report_private;
revoke all on schema supplier_advances_report_private from public,anon,authenticated,service_role;

create function supplier_advances_report_private.source_rows(p_sid bigint,p_cutoff date,p_book bigint)
returns table(row_id bigint,posting_date date,transaction_id bigint,book_id bigint,book_name text,
 journal_id bigint,journal_number text,document_number text,note text,
 supplier_id bigint,supplier_code text,supplier_name text,currency_id bigint,currency_code text,
 debit_original numeric,credit_original numeric,debit_local numeric,credit_local numeric,source_type text,quality_reason text)
language sql stable set search_path=pg_catalog,public,pg_temp as $$
with target as materialized(select account_id from public.chart_accounts where account_number='115004'),
scope_gl as materialized(
 select g.* from public.gl_impact g join target a using(account_id)
 where g.subsidiary_id=p_sid and g.posting_date<=p_cutoff and(p_book is null or g.accounting_book_id=p_book)
),journal_identity as materialized(
 select j.transaction_id,count(*)n,min(j.journal_id)journal_id,bool_and(j.subsidiary_id=p_sid)scoped
 from public.journal j where j.transaction_id in(select g.transaction_id from scope_gl g)
 group by j.transaction_id
),linked as materialized(
 select g.*,j.journal_id,j.journal_number,j.journal_date,j.currency_id journal_currency_id,j.exchange_rate,
  j.is_opening_balance,j.reversed_from_journal_id,j.fx_revaluation_run_id,j.memo,
  coalesce(t.currency_id,opening_transaction.currency_id)transaction_currency_id
 from scope_gl g left join public."transaction"t on t.transaction_id=g.transaction_id and t.subsidiary_id=p_sid
 left join journal_identity identity on identity.transaction_id=g.transaction_id and identity.n=1 and identity.scoped
 -- Legacy opening GL may have no transaction FK. Its immutable line/run key
 -- identifies one journal; a non-NULL inconsistent transaction never falls back.
 left join public.opening_balance_lines opening_line on g.transaction_id is null
  and opening_line.id=g.opening_balance_line_id and opening_line.account_id=g.account_id
 left join public.opening_balance_runs opening_run on opening_run.id=opening_line.run_id and opening_run.subsidiary_id=p_sid
 left join public.journal opening_journal on opening_journal.journal_id=opening_run.journal_id and opening_journal.subsidiary_id=p_sid
 left join public."transaction"opening_transaction on opening_transaction.transaction_id=opening_journal.transaction_id and opening_transaction.subsidiary_id=p_sid
 left join public.journal j on j.journal_id=case when g.transaction_id is null then opening_journal.journal_id else identity.journal_id end
  and j.subsidiary_id=p_sid and(t.transaction_id is not null or(g.transaction_id is null and opening_journal.journal_id is not null
   and(opening_journal.transaction_id is null or opening_transaction.transaction_id is not null)))
),journal_books as materialized(
 select distinct l.journal_id,l.transaction_id,l.account_id,l.accounting_book_id
 from linked l where l.journal_id is not null
),full_gl as materialized(
 select g.*,j.journal_id,coalesce(g.original_currency_id,j.currency_id,t.currency_id)resolved_currency_id
 from journal_books b join public.gl_impact g on g.transaction_id=b.transaction_id and g.account_id=b.account_id
  and g.accounting_book_id=b.accounting_book_id and g.subsidiary_id=p_sid
 join public.journal j on j.journal_id=b.journal_id
 join public."transaction"t on t.transaction_id=g.transaction_id and t.subsidiary_id=p_sid
),ordinary_lines as materialized(
 select l.*,j.transaction_id,coalesce(l.original_currency_id,j.currency_id,t.currency_id)resolved_currency_id,
  round(l.debit*j.exchange_rate,6)expected_debit,round(l.credit*j.exchange_rate,6)expected_credit
 from public.journal_line l join public.journal j using(journal_id)
 join public."transaction"t on t.transaction_id=j.transaction_id and t.subsidiary_id=p_sid
 join target a using(account_id)
 where j.subsidiary_id=p_sid and j.is_opening_balance is not true
  and j.exchange_rate>0 and j.exchange_rate::text not in('NaN','Infinity','-Infinity')
  and(l.debit>0 or l.credit>0) and j.journal_id in(select b.journal_id from journal_books b)
),ordinary_expected as(
 select l.journal_id,jsonb_agg(jsonb_build_array(l.resolved_currency_id,l.expected_debit,l.expected_credit,l.debit,l.credit)
  order by l.resolved_currency_id,l.expected_debit,l.expected_credit,l.debit,l.credit)signature
 from ordinary_lines l group by l.journal_id
),ordinary_actual as(
 select g.journal_id,g.accounting_book_id,jsonb_agg(jsonb_build_array(g.resolved_currency_id,g.debit_amount,g.credit_amount,g.debit_fx,g.credit_fx)
  order by g.resolved_currency_id,g.debit_amount,g.credit_amount,g.debit_fx,g.credit_fx)signature
 from full_gl g group by g.journal_id,g.accounting_book_id
),ordinary_proof as(
 select a.journal_id,a.accounting_book_id from ordinary_actual a join ordinary_expected e using(journal_id)
 where a.signature=e.signature
),ordinary_components as materialized(
 select l.journal_id,l.account_id,l.resolved_currency_id,l.expected_debit,l.expected_credit,l.debit,l.credit,
  count(*)candidate_count,count(distinct l.supplier_id)supplier_count,min(l.supplier_id)supplier_id,
  bool_and(l.supplier_id is not null and l.customer_id is null and l.employee_id is null
   and l.financial_creditor_id is null and l.related_company_id is null and l.tax_agency_id is null and l.other_name_id is null)sole_entity,
  case when count(*)=1 then min(l.note)end note
 from ordinary_lines l group by l.journal_id,l.account_id,l.resolved_currency_id,l.expected_debit,l.expected_credit,l.debit,l.credit
),ordinary_candidates as(
 select g.gl_impact_id,c.candidate_count,c.supplier_count,c.supplier_id,c.sole_entity,c.note
 from linked g join ordinary_proof proof on proof.journal_id=g.journal_id and proof.accounting_book_id=g.accounting_book_id
 join ordinary_components c on c.journal_id=g.journal_id and c.account_id=g.account_id
  and c.resolved_currency_id=coalesce(g.original_currency_id,g.journal_currency_id,g.transaction_currency_id)
  and c.expected_debit=g.debit_amount and c.expected_credit=g.credit_amount and c.debit=g.debit_fx and c.credit=g.credit_fx
),opening_candidates as(
 select g.gl_impact_id,count(*)candidate_count,min(l.supplier_id)supplier_id,
  bool_and(l.supplier_id is not null and l.customer_id is null and l.employee_id is null
   and l.financial_creditor_id is null and l.related_company_id is null and l.tax_agency_id is null and l.other_name_id is null)sole_entity,
  min(coalesce(l.original_currency_id,o.currency_id))currency_id,min(o.document_number)document_number,min(l.note)note
 from linked g join public.journal_line l on l.journal_id=g.journal_id and l.account_id=g.account_id
  and l.opening_balance_line_id=g.opening_balance_line_id
 join public.opening_balance_lines o on o.id=g.opening_balance_line_id and o.account_id=g.account_id
 join public.opening_balance_runs r on r.id=o.run_id and r.subsidiary_id=p_sid
  and(r.journal_id=g.journal_id or r.journal_id=g.reversed_from_journal_id)
 where g.opening_balance_line_id is not null and l.debit=g.debit_amount and l.credit=g.credit_amount
  and g.debit_fx=case when l.debit>0 then o.foreign_amount else 0 end
  and g.credit_fx=case when l.credit>0 then o.foreign_amount else 0 end
  and(g.original_currency_id is null or g.original_currency_id=coalesce(l.original_currency_id,o.currency_id))
 group by g.gl_impact_id
),payment_sources as(
 select p.payment_id,p.journal_id,p.transaction_id,p.supplier_id,p.currency_id,p.payment_number,
  sum(a.amount)native_amount,bool_and(s.supplier_id=p.supplier_id and sj.subsidiary_id=p_sid
   and coalesce(s.original_currency_id,sj.currency_id)=p.currency_id)valid_sources
 from public.supplier_payment p join public."transaction"t on t.transaction_id=p.transaction_id and t.subsidiary_id=p_sid
 join public.supplier_advance_application a using(payment_id)
 join public.journal_line s on s.journal_line_id=a.source_journal_line_id
 join target account on account.account_id=s.account_id
 join public.journal sj on sj.journal_id=s.journal_id
 where p.journal_id in(select b.journal_id from journal_books b)
 group by p.payment_id,p.journal_id,p.transaction_id,p.supplier_id,p.currency_id,p.payment_number
),payment_lines as(
 select p.payment_id,sum(l.credit_fx)local_amount,bool_and(l.supplier_id=p.supplier_id and l.debit=0
  and l.customer_id is null and l.employee_id is null and l.financial_creditor_id is null
  and l.related_company_id is null and l.tax_agency_id is null and l.other_name_id is null
  and l.note='Aplicación de anticipo de proveedor')valid_lines
 from payment_sources p join public.journal_line l on l.journal_id=p.journal_id
 join target account on account.account_id=l.account_id group by p.payment_id
),payment_gl as(
 select g.journal_id,g.accounting_book_id,sum(g.credit_fx)native_amount,sum(g.credit_amount)local_amount,
  bool_and(g.debit_amount=0 and g.debit_fx=0)credit_only,
  count(distinct g.resolved_currency_id)currency_count,min(g.resolved_currency_id)currency_id
 from full_gl g group by g.journal_id,g.accounting_book_id
),payment_proof_candidates as(
 select p.journal_id,p.transaction_id,p.supplier_id,p.currency_id,p.payment_number,g.accounting_book_id
 from payment_sources p join payment_lines l using(payment_id)join payment_gl g using(journal_id)
 where p.valid_sources and l.valid_lines and g.credit_only and g.currency_count=1 and g.currency_id=p.currency_id
  and g.native_amount=p.native_amount and g.local_amount=l.local_amount
),payment_proof as(
 select journal_id,transaction_id,accounting_book_id,min(supplier_id)supplier_id,min(currency_id)currency_id,min(payment_number)payment_number
 from payment_proof_candidates group by journal_id,transaction_id,accounting_book_id having count(*)=1
),attributed as(
 select g.*,case when o.candidate_count=1 and o.sole_entity then o.supplier_id
  when p.supplier_id is not null then p.supplier_id
  when c.supplier_count=1 and c.sole_entity then c.supplier_id end resolved_supplier_id,
  coalesce(g.original_currency_id,case when o.candidate_count=1 then o.currency_id end,p.currency_id,
   case when g.journal_id is not null and g.is_opening_balance is not true then coalesce(g.journal_currency_id,g.transaction_currency_id)end)resolved_currency_id,
  coalesce(case when o.candidate_count=1 then nullif(o.document_number,'')end,p.payment_number,g.journal_number)resolved_document,
  case when o.candidate_count=1 then o.note when c.candidate_count=1 then c.note end resolved_note
 from linked g left join opening_candidates o using(gl_impact_id)left join ordinary_candidates c using(gl_impact_id)
 left join payment_proof p on p.journal_id=g.journal_id and p.transaction_id=g.transaction_id and p.accounting_book_id=g.accounting_book_id
)
select g.gl_impact_id,g.posting_date,g.transaction_id,g.accounting_book_id,b.book_name,
 g.journal_id,g.journal_number,g.resolved_document,g.resolved_note,
 s.supplier_id,s.supplier_number,s.company_name,c.currency_id,c.currency_code,
 g.debit_fx,g.credit_fx,g.debit_amount,g.credit_amount,
 case when g.journal_id is null then'UNKNOWN'when g.reversed_from_journal_id is not null then'REVERSAL'
  when g.fx_revaluation_run_id is not null then'REVALUATION'when g.is_opening_balance then'OPENING'
  when g.journal_id in(select p.journal_id from payment_proof p)then'PAYMENT_APPLICATION'else'JOURNAL'end,
 case when s.supplier_id is null and c.currency_id is null then'No se pudo identificar el proveedor ni la moneda de origen.'
  when s.supplier_id is null then'No se pudo atribuir el movimiento a un único proveedor.'
  when c.currency_id is null then'No se pudo identificar la moneda de origen.'end
from attributed g left join public.suppliers s on s.supplier_id=g.resolved_supplier_id
left join public.currencies c on c.currency_id=g.resolved_currency_id
left join public.accounting_books b on b.accounting_book_id=g.accounting_book_id and b.subsidiary_id=p_sid
$$;

create function public.run_supplier_advances_report(p_filters jsonb default'{}')returns jsonb
language plpgsql stable security definer set search_path=pg_catalog,public,pg_temp as $$
declare sid bigint;uid bigint;cutoff date;book bigint;supplier bigint;currency bigint;
 only_nonzero boolean:=true;page_no integer:=1;page_size integer:=50;key text;value text;
 account_count bigint;account_info jsonb;local_currency jsonb;control_balance numeric;result jsonb;
begin
 perform report_template_private.enter('reports:accounting-reports','view');
 uid:=public.app_user_id();sid:=public.active_subsidiary_id();
 if uid is null or sid is null or not exists(select 1 from public.users u join public.user_subsidiaries us using(user_id)
  where u.user_id=uid and u.is_active and us.subsidiary_id=sid)then
  raise exception using errcode='42501',message='La empresa activa no está autorizada.';
 end if;
 if p_filters is null or jsonb_typeof(p_filters)<>'object' or exists(select 1 from jsonb_object_keys(p_filters)k
  where k not in('subsidiaryIds','dateTo','bookId','supplierId','currencyId','onlyNonzero','page','pageSize'))then
  raise exception using errcode='22023',message='Los filtros del reporte no son válidos.';
 end if;
 if jsonb_typeof(p_filters->'subsidiaryIds')is distinct from'array'or jsonb_array_length(p_filters->'subsidiaryIds')<>1
  or coalesce(p_filters#>>'{subsidiaryIds,0}','')!~'^[1-9][0-9]{0,18}$'then
  raise exception using errcode='22023',message='Seleccione una sola empresa.';
 end if;
 begin
  if(p_filters#>>'{subsidiaryIds,0}')::bigint<>sid then raise exception using errcode='42501',message='La empresa solicitada no coincide con la empresa activa.';end if;
  if coalesce(p_filters->>'dateTo','')!~'^[0-9]{4}-[0-9]{2}-[0-9]{2}$'then raise exception using errcode='22023',message='La fecha de corte no es válida.';end if;
  cutoff:=(p_filters->>'dateTo')::date;
  foreach key in array array['bookId','supplierId','currencyId']loop
   value:=p_filters->>key;
   if value is not null and(value!~'^[1-9][0-9]{0,18}$')then raise exception using errcode='22023',message='El identificador de un filtro no es válido.';end if;
   case key when'bookId'then book:=value::bigint;when'supplierId'then supplier:=value::bigint;else currency:=value::bigint;end case;
  end loop;
  if p_filters?'onlyNonzero'then
   if jsonb_typeof(p_filters->'onlyNonzero')<>'boolean'then raise exception using errcode='22023',message='El filtro de saldos no es válido.';end if;
   only_nonzero:=(p_filters->>'onlyNonzero')::boolean;
  end if;
  foreach key in array array['page','pageSize']loop
   if p_filters?key then
    value:=p_filters->>key;
    if value is null or value!~'^[1-9][0-9]{0,9}$'then raise exception using errcode='22023',message='La paginación no es válida.';end if;
    if key='page'then page_no:=value::integer;else page_size:=value::integer;end if;
   end if;
  end loop;
 exception when numeric_value_out_of_range or invalid_datetime_format or datetime_field_overflow then
  raise exception using errcode='22023',message='Los filtros del reporte no son válidos.';
 end;
 if page_size>250 then raise exception using errcode='22023',message='El tamaño de página no es válido.';end if;
 if book is not null and not exists(select 1 from public.accounting_books b where b.accounting_book_id=book and b.subsidiary_id=sid)then
  raise exception using errcode='42501',message='El libro no pertenece a la empresa activa.';
 end if;
 select count(*),jsonb_build_object('id',min(account_id),'number','115004','name',min(account_name))into account_count,account_info
 from public.chart_accounts where account_number='115004';
 if account_count>1 then raise exception using errcode='55000',message='La cuenta 115004 no tiene una identificación única.';end if;
 select jsonb_build_object('id',c.currency_id,'code',c.currency_code)into local_currency
 from public.subsidiaries s left join public.currencies c on c.currency_id=s.currency_id where s.subsidiary_id=sid;
 -- Independent control: never reuse attributed rows as their own reconciliation
 -- oracle. This also detects a future accidental omission or fan-out in joins.
 select coalesce(sum(g.debit_amount-g.credit_amount),0)into control_balance
 from public.gl_impact g join public.chart_accounts a using(account_id)
 where a.account_number='115004'and g.subsidiary_id=sid and g.posting_date<=cutoff
  and(book is null or g.accounting_book_id=book);
 with all_rows as materialized(select *from supplier_advances_report_private.source_rows(sid,cutoff,book)),
 grouped as materialized(
  select supplier_id,currency_id,sum(debit_original-credit_original)original_balance,sum(debit_local-credit_local)local_balance,
   count(*)movement_count from all_rows group by supplier_id,currency_id
 ),selected as materialized(
  select r.* from all_rows r join grouped g on g.supplier_id is not distinct from r.supplier_id and g.currency_id is not distinct from r.currency_id
  where(supplier is null or r.supplier_id=supplier)and(currency is null or r.currency_id=currency)
   and(not only_nonzero or r.supplier_id is null or r.currency_id is null or g.original_balance<>0 or g.local_balance<>0)
 ),running as(
  select r.*,case when currency_id is not null then sum(debit_original-credit_original)over w end running_original,
   sum(debit_local-credit_local)over w running_local from selected r
  window w as(partition by supplier_id,currency_id order by posting_date,row_id rows unbounded preceding)
 ),paged as(select *from running order by posting_date,row_id limit page_size offset((page_no::bigint-1)*page_size)),
 currency_totals as(
  select currency_id,min(currency_code)currency_code,count(*)movement_count,
   case when currency_id is not null then sum(debit_original)end debit_original,
   case when currency_id is not null then sum(credit_original)end credit_original,
   case when currency_id is not null then sum(debit_original-credit_original)end balance_original,
   sum(debit_local)debit_local,sum(credit_local)credit_local,sum(debit_local-credit_local)balance_local
  from selected group by currency_id
 ),supplier_totals as(
  select supplier_id,min(supplier_code)supplier_code,min(supplier_name)supplier_name,currency_id,min(currency_code)currency_code,count(*)movement_count,
   case when currency_id is not null then sum(debit_original)end debit_original,
   case when currency_id is not null then sum(credit_original)end credit_original,
   case when currency_id is not null then sum(debit_original-credit_original)end balance_original,
   sum(debit_local)debit_local,sum(credit_local)credit_local,sum(debit_local-credit_local)balance_local
  from selected group by supplier_id,currency_id
 )
 select jsonb_build_object('context',jsonb_build_object('subsidiaryId',sid,'dateTo',cutoff,'bookId',book,'supplierId',supplier,'currencyId',currency,'onlyNonzero',only_nonzero),
  'account',account_info,'localCurrency',local_currency,'total',(select count(*)from selected),'page',page_no,'pageSize',page_size,
  'dataFingerprint',(select md5(coalesce(jsonb_agg(to_jsonb(r)order by r.row_id),'[]')::text)from running r),
  'rows',(select coalesce(jsonb_agg(jsonb_build_object('rowId',row_id,'date',posting_date,'transactionId',transaction_id,'bookId',book_id,'bookName',book_name,
   'journalId',journal_id,'journalNumber',journal_number,'documentNumber',document_number,'note',note,'supplierId',supplier_id,'supplierCode',supplier_code,'supplierName',supplier_name,
   'currencyId',currency_id,'currencyCode',currency_code,'debitOriginal',debit_original,'creditOriginal',credit_original,'debitLocal',debit_local,'creditLocal',credit_local,
   'runningBalanceOriginal',running_original,'runningBalanceLocal',running_local,'sourceType',source_type,'qualityReason',quality_reason)order by posting_date,row_id),'[]')from paged),
  'currencyTotals',(select coalesce(jsonb_agg(jsonb_build_object('currencyId',currency_id,'currencyCode',currency_code,'movementCount',movement_count,
   'debitOriginal',debit_original,'creditOriginal',credit_original,'balanceOriginal',balance_original,'debitLocal',debit_local,'creditLocal',credit_local,'balanceLocal',balance_local)order by currency_code nulls last),'[]')from currency_totals),
  'supplierTotals',(select coalesce(jsonb_agg(jsonb_build_object('supplierId',supplier_id,'supplierCode',supplier_code,'supplierName',supplier_name,'currencyId',currency_id,'currencyCode',currency_code,'movementCount',movement_count,
   'debitOriginal',debit_original,'creditOriginal',credit_original,'balanceOriginal',balance_original,'debitLocal',debit_local,'creditLocal',credit_local,'balanceLocal',balance_local)order by currency_code nulls last,supplier_name nulls last,supplier_id),'[]')from supplier_totals),
  'summary',jsonb_build_object('controlBalanceLocal',control_balance,
   'reportedBalanceLocal',(select coalesce(sum(debit_local-credit_local),0)from selected),
   'attributedBalanceLocal',(select coalesce(sum(debit_local-credit_local),0)from selected where supplier_id is not null),
   'unattributedBalanceLocal',(select coalesce(sum(debit_local-credit_local),0)from selected where supplier_id is null),
   'differenceLocal',case when supplier is null and currency is null then(select coalesce(sum(debit_local-credit_local),0)from selected)-control_balance end,
   'reconciliationAvailable',supplier is null and currency is null,'reconciliationReason',case when supplier is not null or currency is not null then'FILTERED_SELECTION'end,
   'unknownSupplierRows',(select count(*)from selected where supplier_id is null),'unknownCurrencyRows',(select count(*)from selected where currency_id is null)))into result;
 return result;
end$$;

revoke all on function supplier_advances_report_private.source_rows(bigint,date,bigint)from public,anon,authenticated,service_role;
revoke all on function public.run_supplier_advances_report(jsonb)from public,anon,authenticated,service_role;
grant execute on function public.run_supplier_advances_report(jsonb)to authenticated;
notify pgrst,'reload schema';
