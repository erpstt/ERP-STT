-- Pending advances are sources minus verified registered applications, never a
-- provider-level net ledger balance. No financial writer or historical row changes.
set local lock_timeout='5s';
set local statement_timeout='60s';
do $guard$
declare signature text;expected text;actual text;
begin
 for signature,expected in select *from(values
  ('public.run_supplier_advances_report(jsonb)','09eab6d0397148d48689827ef69c5b97'),
  ('supplier_advances_report_private.source_rows(bigint,date,bigint)','aade0c05e0133eba30e588876cc52cd0'),
  ('supplier_payment_private.advance_values(bigint,bigint)','e311b20496a08e524f8f3eee50e1b898'))v loop
  select md5(prosrc)into actual from pg_proc where oid=to_regprocedure(signature);
  if actual is distinct from expected then raise exception 'Unexpected supplier advance report dependency: %',signature;end if;
 end loop;
end$guard$;

create function supplier_advances_report_private.grant_sources(p_sid bigint,p_book bigint)returns jsonb
language sql stable set search_path=pg_catalog,public,pg_temp as $$
with target as(select account_id from public.chart_accounts where account_number='115004'),
ledger as materialized(select g.*from public.gl_impact g join target a using(account_id)where g.subsidiary_id=p_sid and g.accounting_book_id=p_book),
journal_identity as(
 select j.transaction_id,count(*)n,min(j.journal_id)journal_id,bool_and(j.subsidiary_id=p_sid)scoped
 from public.journal j where j.transaction_id in(select transaction_id from ledger)group by j.transaction_id
),linked as materialized(
 select g.*,j.journal_id,j.journal_number,j.journal_date,j.currency_id journal_currency_id,j.exchange_rate,j.status,j.is_opening_balance,j.reversed_from_journal_id,
  coalesce(t.currency_id,opening_t.currency_id)transaction_currency_id
 from ledger g left join public."transaction"t on t.transaction_id=g.transaction_id and t.subsidiary_id=p_sid
 left join journal_identity identity on identity.transaction_id=g.transaction_id and identity.n=1 and identity.scoped
 left join public.opening_balance_lines opening_line on g.transaction_id is null and opening_line.id=g.opening_balance_line_id and opening_line.account_id=g.account_id
 left join public.opening_balance_runs opening_run on opening_run.id=opening_line.run_id and opening_run.subsidiary_id=p_sid
 left join public.journal opening_j on opening_j.journal_id=opening_run.journal_id and opening_j.subsidiary_id=p_sid
 left join public."transaction"opening_t on opening_t.transaction_id=opening_j.transaction_id and opening_t.subsidiary_id=p_sid
 left join public.journal j on j.journal_id=case when g.transaction_id is null then opening_j.journal_id else identity.journal_id end
  and j.subsidiary_id=p_sid and(t.transaction_id is not null or(g.transaction_id is null and opening_j.journal_id is not null and(opening_j.transaction_id is null or opening_t.transaction_id is not null)))
),buckets as materialized(select distinct journal_id,transaction_id,account_id from linked where journal_id is not null),
ordinary_lines as materialized(
 select l.*,j.journal_date,j.journal_number,j.transaction_id,j.currency_id journal_currency_id,j.exchange_rate,j.status,
  coalesce(l.original_currency_id,j.currency_id,t.currency_id)currency_id,
  round(l.debit*j.exchange_rate,6)debit_local,round(l.credit*j.exchange_rate,6)credit_local
 from public.journal_line l join public.journal j using(journal_id)
 join public."transaction"t on t.transaction_id=j.transaction_id and t.subsidiary_id=p_sid join target a using(account_id)
 where j.subsidiary_id=p_sid and j.is_opening_balance is not true and j.reversed_from_journal_id is null and l.opening_balance_line_id is null
  and j.exchange_rate>0 and j.exchange_rate::text not in('NaN','Infinity','-Infinity')and(l.debit>0 or l.credit>0)
  and j.journal_id in(select journal_id from buckets)
),ordinary_expected as(
 select journal_id,account_id,jsonb_agg(jsonb_build_array(journal_date,currency_id,debit_local,credit_local,debit,credit)
  order by journal_date,currency_id,debit_local,credit_local,debit,credit)signature from ordinary_lines group by journal_id,account_id
),ordinary_actual as(
 select g.journal_id,g.account_id,jsonb_agg(jsonb_build_array(g.posting_date,coalesce(g.original_currency_id,g.journal_currency_id,g.transaction_currency_id),g.debit_amount,g.credit_amount,g.debit_fx,g.credit_fx)
  order by g.posting_date,coalesce(g.original_currency_id,g.journal_currency_id,g.transaction_currency_id),g.debit_amount,g.credit_amount,g.debit_fx,g.credit_fx)signature
 from linked g where g.journal_id is not null group by g.journal_id,g.account_id
),ordinary_proof as materialized(select a.journal_id,a.account_id from ordinary_actual a join ordinary_expected e using(journal_id,account_id)where a.signature=e.signature),
opening_counts as(select opening_balance_line_id,posting_date,count(*)n from linked where opening_balance_line_id is not null and reversed_from_journal_id is null group by opening_balance_line_id,posting_date),
opening_candidates as materialized(
 select l.journal_line_id,count(*)n,min(g.gl_impact_id)gl_id,min(g.journal_id)journal_id,min(g.journal_number)journal_number,min(g.journal_date)journal_date,
  min(g.transaction_id)transaction_id,min(g.account_id)account_id,min(g.status)status,min(l.supplier_id)supplier_id,
  min(coalesce(g.original_currency_id,l.original_currency_id,o.currency_id))currency_id,min(o.document_number)document_number,min(l.note)note,
  min(g.debit_fx-g.credit_fx)advance_original,min(g.debit_amount-g.credit_amount)advance_local,
  min(coalesce(l.historical_exchange_rate,o.historical_rate))rate
 from linked g join public.journal_line l on l.journal_id=g.journal_id and l.account_id=g.account_id and l.opening_balance_line_id=g.opening_balance_line_id
 join public.opening_balance_lines o on o.id=g.opening_balance_line_id and o.account_id=g.account_id
 join public.opening_balance_runs r on r.id=o.run_id and r.subsidiary_id=p_sid and r.journal_id=g.journal_id and r.status in('POSTED','REVERSED')
 join opening_counts c on c.opening_balance_line_id=g.opening_balance_line_id and c.posting_date=g.posting_date and c.n=1
 where g.reversed_from_journal_id is null and g.posting_date=g.journal_date and l.debit=g.debit_amount and l.credit=g.credit_amount
  and g.debit_fx=case when l.debit>0 then o.foreign_amount else 0 end and g.credit_fx=case when l.credit>0 then o.foreign_amount else 0 end
  and(g.original_currency_id is null or g.original_currency_id=coalesce(l.original_currency_id,o.currency_id))
  and g.debit_fx-g.credit_fx>0
 group by l.journal_line_id
),opening_unverified as(
 select l.journal_line_id,j.journal_id,j.journal_number,j.journal_date,j.transaction_id,l.account_id,l.supplier_id,
  coalesce(l.original_currency_id,o.currency_id)currency_id,coalesce(o.document_number,j.journal_number)document_number,l.note,
  o.foreign_amount advance_original,null::numeric advance_local,coalesce(l.historical_exchange_rate,o.historical_rate)rate,j.status
 from(select distinct journal_id,account_id from buckets)b join public.journal j on j.journal_id=b.journal_id and j.subsidiary_id=p_sid
 join public.journal_line l on l.journal_id=j.journal_id and l.account_id=b.account_id
 left join public.opening_balance_lines o on o.id=l.opening_balance_line_id and o.account_id=l.account_id
  and exists(select 1 from public.opening_balance_runs r where r.id=o.run_id and r.subsidiary_id=p_sid and r.journal_id=j.journal_id)
 where l.opening_balance_line_id is not null and j.reversed_from_journal_id is null and l.debit-l.credit>0
  and not exists(select 1 from opening_candidates known where known.journal_line_id=l.journal_line_id and known.n=1)
),sources_base as materialized(
 select l.journal_line_id source_line_id,l.journal_id,l.journal_number,l.journal_date,l.transaction_id,l.account_id,l.supplier_id,l.currency_id,
  l.journal_number document_number,l.note,l.debit-l.credit advance_original,l.debit_local-l.credit_local advance_local,
  l.exchange_rate rate,(l.historical_exchange_rate is null or l.historical_exchange_rate=l.exchange_rate)
   and round((l.debit-l.credit)*l.exchange_rate,6)=l.debit_local-l.credit_local rate_valid,
  l.status,p.journal_id is not null proven
 from ordinary_lines l left join ordinary_proof p using(journal_id,account_id)where l.debit-l.credit>0
 union all
 select o.journal_line_id,o.journal_id,o.journal_number,o.journal_date,o.transaction_id,o.account_id,o.supplier_id,o.currency_id,
  coalesce(o.document_number,o.journal_number),o.note,o.advance_original,o.advance_local,o.rate,
  o.rate>0 and o.rate::text not in('NaN','Infinity','-Infinity')and round(o.advance_original*o.rate,6)=o.advance_local,o.status,o.n=1
 from opening_candidates o
 union all
 select o.journal_line_id,o.journal_id,o.journal_number,o.journal_date,o.transaction_id,o.account_id,o.supplier_id,o.currency_id,
  o.document_number,o.note,o.advance_original,o.advance_local,o.rate,false,o.status,false from opening_unverified o
),source_journals as materialized(select distinct journal_id,transaction_id,account_id from sources_base),
source_signatures as(
 select s.journal_id,s.account_id,jsonb_agg(jsonb_build_array(coalesce(g.original_currency_id,j.currency_id),g.debit_amount,g.credit_amount,g.debit_fx,g.credit_fx)
  order by coalesce(g.original_currency_id,j.currency_id),g.debit_amount,g.credit_amount,g.debit_fx,g.credit_fx)signature
 from source_journals s join public.journal j on j.journal_id=s.journal_id
 join ledger g on(g.transaction_id=s.transaction_id or(g.transaction_id is null and g.opening_balance_line_id in(select l.opening_balance_line_id from public.journal_line l where l.journal_id=s.journal_id)))and g.account_id=s.account_id
 group by s.journal_id,s.account_id
),reversal_candidates as(
 select s.journal_id original_journal_id,s.account_id,r.journal_id,r.journal_date,
  bool_and(g.posting_date=r.journal_date)dates_valid,
  jsonb_agg(jsonb_build_array(coalesce(g.original_currency_id,r.currency_id),g.credit_amount,g.debit_amount,g.credit_fx,g.debit_fx)
   order by coalesce(g.original_currency_id,r.currency_id),g.credit_amount,g.debit_amount,g.credit_fx,g.debit_fx)signature,
  array_agg(g.gl_impact_id)filter(where g.credit_fx-g.debit_fx>0)gl_ids
 from source_journals s join public.journal r on r.reversed_from_journal_id=s.journal_id and r.subsidiary_id=p_sid
 join public."transaction"t on t.transaction_id=r.transaction_id and t.subsidiary_id=p_sid
 join ledger g on g.transaction_id=r.transaction_id and g.account_id=s.account_id
 group by s.journal_id,s.account_id,r.journal_id,r.journal_date
),reversal_status as(
 select s.journal_id,s.account_id,count(r.journal_id)reversal_count,
  count(r.journal_id)filter(where r.dates_valid and r.signature=s.signature)valid_count,
  min(r.journal_date)filter(where r.dates_valid and r.signature=s.signature)reversed_date
 from source_signatures s left join reversal_candidates r on r.original_journal_id=s.journal_id and r.account_id=s.account_id group by s.journal_id,s.account_id
),sources as(
 select 'JL:'||s.source_line_id||':BOOK:'||p_book source_key,s.source_line_id,s.journal_id,s.journal_number,s.journal_date date,s.transaction_id,s.account_id,p_book book_id,
  supplier.supplier_id,supplier.supplier_number supplier_code,supplier.company_name supplier_name,c.currency_id,c.currency_code,s.document_number,s.note,
  s.advance_original,s.advance_local,s.rate,s.rate_valid,s.proven,s.status,
  coalesce(r.reversal_count,0)reversal_count,coalesce(r.valid_count,0)valid_reversal_count,r.reversed_date
 from sources_base s left join public.suppliers supplier on supplier.supplier_id=s.supplier_id left join public.currencies c on c.currency_id=s.currency_id
 left join reversal_status r on r.journal_id=s.journal_id and r.account_id=s.account_id
),recognized_source_gl as(
 select g.gl_impact_id from linked g join ordinary_proof p using(journal_id,account_id)where g.debit_fx-g.credit_fx>0
 union select o.gl_id from opening_candidates o where o.n=1
),recognized_reversal_gl as(
 select distinct unnest(r.gl_ids)gl_impact_id from reversal_candidates r join reversal_status s on s.journal_id=r.original_journal_id and s.account_id=r.account_id
 where s.reversal_count=1 and s.valid_count=1 and r.dates_valid and r.signature=(select signature from source_signatures x where x.journal_id=r.original_journal_id and x.account_id=r.account_id)
)
select jsonb_build_object('sources',(select coalesce(jsonb_agg(to_jsonb(s)order by source_line_id),'[]')from sources s),
 'recognizedSourceGlIds',(select coalesce(jsonb_agg(gl_impact_id order by gl_impact_id),'[]')from recognized_source_gl),
 'recognizedReversalGlIds',(select coalesce(jsonb_agg(gl_impact_id order by gl_impact_id),'[]')from recognized_reversal_gl))
$$;

create or replace function public.run_supplier_advances_report(p_filters jsonb default'{}')returns jsonb
language plpgsql stable security definer set search_path=pg_catalog,public,pg_temp as $$
declare sid bigint;uid bigint;cutoff date;requested_book bigint;effective_book bigint;book_info jsonb;primary_count bigint;
 supplier bigint;currency bigint;page_no integer:=1;page_size integer:=50;key text;filter_value text;
 account_count bigint;account_info jsonb;local_currency jsonb;snapshot jsonb;paged jsonb;
begin
 perform report_template_private.enter('reports:accounting-reports','view');
 uid:=public.app_user_id();sid:=public.active_subsidiary_id();
 if uid is null or sid is null or not exists(select 1 from public.users u join public.user_subsidiaries s using(user_id)where u.user_id=uid and u.is_active and s.subsidiary_id=sid)then
  raise exception using errcode='42501',message='La empresa activa no está autorizada.';
 end if;
 if p_filters is null or jsonb_typeof(p_filters)<>'object'or exists(select 1 from jsonb_object_keys(p_filters)k where k not in('subsidiaryIds','dateTo','bookId','supplierId','currencyId','onlyNonzero','page','pageSize'))then
  raise exception using errcode='22023',message='Los filtros del reporte no son válidos.';
 end if;
 if jsonb_typeof(p_filters->'subsidiaryIds')is distinct from'array'or jsonb_array_length(p_filters->'subsidiaryIds')<>1 or coalesce(p_filters#>>'{subsidiaryIds,0}','')!~'^[1-9][0-9]{0,18}$'then
  raise exception using errcode='22023',message='Seleccione una sola empresa.';
 end if;
 begin
  if(p_filters#>>'{subsidiaryIds,0}')::bigint<>sid then raise exception using errcode='42501',message='La empresa solicitada no coincide con la empresa activa.';end if;
  if coalesce(p_filters->>'dateTo','')!~'^[0-9]{4}-[0-9]{2}-[0-9]{2}$'then raise exception using errcode='22023',message='La fecha de corte no es válida.';end if;
  cutoff:=(p_filters->>'dateTo')::date;
  foreach key in array array['bookId','supplierId','currencyId']loop
   filter_value:=p_filters->>key;
   if filter_value is not null and filter_value!~'^[1-9][0-9]{0,18}$'then raise exception using errcode='22023',message='El identificador de un filtro no es válido.';end if;
   case key when'bookId'then requested_book:=filter_value::bigint;when'supplierId'then supplier:=filter_value::bigint;else currency:=filter_value::bigint;end case;
  end loop;
  if p_filters?'onlyNonzero'and jsonb_typeof(p_filters->'onlyNonzero')<>'boolean'then raise exception using errcode='22023',message='El filtro de saldos no es válido.';end if;
  foreach key in array array['page','pageSize']loop
   if p_filters?key then filter_value:=p_filters->>key;
    if filter_value is null or filter_value!~'^[1-9][0-9]{0,9}$'then raise exception using errcode='22023',message='La paginación no es válida.';end if;
    if key='page'then page_no:=filter_value::integer;else page_size:=filter_value::integer;end if;
   end if;
  end loop;
 exception when numeric_value_out_of_range or invalid_datetime_format or datetime_field_overflow then
  raise exception using errcode='22023',message='Los filtros del reporte no son válidos.';
 end;
 if page_size>250 then raise exception using errcode='22023',message='El tamaño de página no es válido.';end if;
 if requested_book is null then
  select count(*)into primary_count from public.accounting_books where subsidiary_id=sid and is_primary;
  if primary_count<>1 then raise exception using errcode='22023',message='Seleccione un libro contable; la empresa no tiene un único libro principal.';end if;
  select accounting_book_id,jsonb_build_object('id',accounting_book_id,'name',book_name,'isPrimary',is_primary)into effective_book,book_info
  from public.accounting_books where subsidiary_id=sid and is_primary;
 else
  select accounting_book_id,jsonb_build_object('id',accounting_book_id,'name',book_name,'isPrimary',is_primary)into effective_book,book_info
  from public.accounting_books where accounting_book_id=requested_book and subsidiary_id=sid;
  if effective_book is null then raise exception using errcode='42501',message='El libro no pertenece a la empresa activa.';end if;
 end if;
 select count(*),jsonb_build_object('id',min(account_id),'number','115004','name',min(account_name))into account_count,account_info from public.chart_accounts where account_number='115004';
 if account_count>1 then raise exception using errcode='55000',message='La cuenta 115004 no tiene una identificación única.';end if;
 select jsonb_build_object('id',c.currency_id,'code',c.currency_code)into local_currency from public.subsidiaries s left join public.currencies c on c.currency_id=s.currency_id where s.subsidiary_id=sid;
 snapshot:=supplier_advances_report_private.pending_sources(sid,cutoff,effective_book,supplier,currency);
 select coalesce(jsonb_agg(r.value order by r.position),'[]')into paged from jsonb_array_elements(snapshot->'rows')with ordinality r(value,position)
 where r.position>((page_no::bigint-1)*page_size)and r.position<=page_no::bigint*page_size;
 return jsonb_build_object('reportMode','UNAPPLIED_ADVANCES','context',jsonb_build_object('subsidiaryId',sid,'dateTo',cutoff,'bookId',requested_book,'supplierId',supplier,'currencyId',currency,'onlyNonzero',true),
  'book',book_info,'effectiveBookId',effective_book,'account',account_info,'localCurrency',local_currency,'rows',paged,'total',snapshot->'total','page',page_no,'pageSize',page_size,
  'dataFingerprint',snapshot->'dataFingerprint','filterOptions',snapshot->'filterOptions','currencyTotals',snapshot->'currencyTotals','supplierTotals',snapshot->'supplierTotals','exceptions',snapshot->'exceptions','summary',snapshot->'summary');
end$$;

create function supplier_advances_report_private.pending_sources(p_sid bigint,p_cutoff date,p_book bigint,p_supplier bigint,p_currency bigint)returns jsonb
language sql stable set search_path=pg_catalog,public,pg_temp as $$
with target as(select account_id from public.chart_accounts where account_number='115004'),
grant_snapshot as materialized(select supplier_advances_report_private.grant_sources(p_sid,p_book)value),
sources as materialized(
 select *from jsonb_to_recordset((select value->'sources'from grant_snapshot))as s(
  source_key text,source_line_id bigint,journal_id bigint,journal_number text,date date,transaction_id bigint,account_id bigint,book_id bigint,
  supplier_id bigint,supplier_code text,supplier_name text,currency_id bigint,currency_code text,document_number text,note text,
  advance_original numeric,advance_local numeric,rate numeric,rate_valid boolean,proven boolean,status text,reversal_count bigint,valid_reversal_count bigint,reversed_date date)
),ledger as materialized(select g.*from public.gl_impact g join target t using(account_id)where g.subsidiary_id=p_sid and g.accounting_book_id=p_book),
application_rows as materialized(
 select a.application_id,a.source_journal_line_id,a.payment_id,a.amount,p.payment_date,p.transaction_id payment_transaction_id,p.journal_id payment_journal_id,
  p.supplier_id payment_supplier_id,p.currency_id payment_currency_id,l.account_id,
  s.source_key,s.advance_original,s.advance_local,s.rate,s.rate_valid,s.proven,s.currency_id source_currency_id,s.supplier_id source_supplier_id,
  coalesce(p.payment_id is not null and t.subsidiary_id=p_sid and j.subsidiary_id=p_sid and j.transaction_id=p.transaction_id
   and p.payment_date=j.journal_date and p.status='APROBADO'and j.status='CONTABILIZADO'
   and p.currency_id=j.currency_id and p.currency_id=t.currency_id
   and not exists(select 1 from public.journal r where r.reversed_from_journal_id=p.journal_id)
   and not exists(select 1 from public.supplier_payment other where other.transaction_id=p.transaction_id and other.payment_id<>p.payment_id),false)header_valid,
  coalesce(s.proven and s.rate_valid and s.supplier_id=p.supplier_id and s.currency_id=p.currency_id
   and a.amount>0 and a.amount::text not in('NaN','Infinity','-Infinity'),false)source_valid,
  p.payment_date is null or p.payment_date<=p_cutoff or exists(select 1 from ledger g where g.transaction_id=p.transaction_id and g.posting_date<=p_cutoff)seen_at_cutoff
 from public.supplier_advance_application a join public.journal_line l on l.journal_line_id=a.source_journal_line_id
 join target t_account on t_account.account_id=l.account_id
 left join public.supplier_payment p using(payment_id)left join public."transaction"t on t.transaction_id=p.transaction_id
 left join public.journal j on j.journal_id=p.journal_id
 left join sources s on s.source_line_id=a.source_journal_line_id
 where a.source_journal_line_id in(select source_line_id from sources)
),ordered_applications as materialized(
 select a.*,coalesce(sum(amount)over(partition by source_journal_line_id order by payment_transaction_id,application_id rows between unbounded preceding and 1 preceding),0)prior_native
 from application_rows a
),allocated as materialized(
 select a.*,case when source_valid then
  (case when prior_native+amount=advance_original then advance_local else round((prior_native+amount)*rate,6)end)-round(prior_native*rate,6)end local_amount,
  coalesce(source_valid and prior_native>=0 and prior_native+amount<=advance_original,false)within_source
 from ordered_applications a
),invoice_proof as(
 select p.payment_id,count(i.application_id)>0 and bool_and(coalesce(inv.invoice_id is not null and inv.subsidiary_id=p_sid
  and inv.supplier_id=p.supplier_id and inv.currency_id=p.currency_id and i.amount>0 and i.amount::text not in('NaN','Infinity','-Infinity')
  and ij.subsidiary_id=p_sid and it.subsidiary_id=p_sid and ij.status='CONTABILIZADO'and ij.journal_date<=p.payment_date
  and not exists(select 1 from public.journal reversed where reversed.reversed_from_journal_id=ij.journal_id)
  and((not coalesce(inv.is_opening_balance,false)and inv.transaction_id=ij.transaction_id and ij.currency_id=inv.currency_id and it.currency_id=inv.currency_id)
   or(coalesce(inv.is_opening_balance,false)and ij.is_opening_balance and(inv.transaction_id is null or inv.transaction_id=ij.transaction_id)
    and exists(select 1 from public.opening_balance_lines line join public.opening_balance_runs run on run.id=line.run_id
     where line.id=inv.opening_balance_line_id and run.id=inv.opening_run_id and run.subsidiary_id=p_sid and run.journal_id=ij.journal_id and run.status in('POSTED','REVERSED')
      and line.source_type='AP'and line.account_id=inv.payable_account_id and line.currency_id=inv.currency_id)))
  and exists(select 1 from public.gl_impact invoice_gl where invoice_gl.transaction_id=ij.transaction_id and invoice_gl.subsidiary_id=p_sid
   and invoice_gl.accounting_book_id=p_book and invoice_gl.posting_date<=p.payment_date
   and invoice_gl.account_id=inv.payable_account_id and invoice_gl.credit_fx>0
   and(not coalesce(inv.is_opening_balance,false)or invoice_gl.opening_balance_line_id=inv.opening_balance_line_id)),false))
  and sum(i.amount)>=(select coalesce(sum(a.amount),0)from public.supplier_advance_application a where a.payment_id=p.payment_id)valid
 from public.supplier_payment p left join public.supplier_payment_application i using(payment_id)
 left join public.supplier_invoice inv on inv.invoice_id=i.invoice_id
 left join public.journal ij on ij.journal_id=inv.journal_id
 left join public."transaction"it on it.transaction_id=ij.transaction_id
 where p.payment_id in(select payment_id from allocated)group by p.payment_id,p.supplier_id,p.currency_id
),expected_payments as(
 select payment_id,account_id,min(payment_transaction_id)transaction_id,min(payment_journal_id)journal_id,min(payment_date)payment_date,min(payment_currency_id)currency_id,
  sum(amount)native_amount,sum(local_amount)local_amount,bool_and(header_valid and source_valid and within_source and local_amount is not null)valid
 from allocated group by payment_id,account_id
),actual_payments as(
 select p.payment_id,p.account_id,count(g.gl_impact_id)gl_count,sum(g.credit_fx)native_amount,sum(g.credit_amount)local_amount,
  bool_and(coalesce(g.debit_amount=0 and g.debit_fx=0 and g.credit_fx is not null and g.credit_amount is not null
   and g.posting_date=p.payment_date and coalesce(g.original_currency_id,p.currency_id)=p.currency_id
   and g.credit_fx::text not in('NaN','Infinity','-Infinity')and g.credit_amount::text not in('NaN','Infinity','-Infinity'),false))valid
 from expected_payments p left join ledger g on g.transaction_id=p.transaction_id and g.account_id=p.account_id group by p.payment_id,p.account_id
),payment_proof as materialized(
 select p.payment_id,p.account_id,p.transaction_id,p.payment_date,
  coalesce(p.valid and i.valid and a.valid and a.gl_count>0 and a.native_amount=p.native_amount and a.local_amount=p.local_amount,false)valid
 from expected_payments p join actual_payments a using(payment_id,account_id)left join invoice_proof i using(payment_id)
),source_applications as materialized(
 select a.source_journal_line_id,count(*)filter(where a.seen_at_cutoff)seen_count,
  coalesce(sum(a.amount)filter(where p.valid and a.payment_date<=p_cutoff),0)applied_original,
  coalesce(sum(a.local_amount)filter(where p.valid and a.payment_date<=p_cutoff),0)applied_local,
  count(*)filter(where a.seen_at_cutoff and not p.valid)invalid_count,
  count(*)filter(where a.seen_at_cutoff and a.prior_native+a.amount>a.advance_original)overapplied_count,
  count(*)filter(where a.seen_at_cutoff and not a.rate_valid)local_unverified_count
 from allocated a join payment_proof p using(payment_id,account_id)group by a.source_journal_line_id
),classified as materialized(
 select s.*,coalesce(a.applied_original,0)applied_original,coalesce(a.applied_local,0)applied_local,
  s.advance_original-coalesce(a.applied_original,0)pending_original,s.advance_local-coalesce(a.applied_local,0)pending_local,
  case when not s.proven then'SOURCE_UNVERIFIED'
   when s.supplier_id is null then'UNKNOWN_SUPPLIER'when s.currency_id is null then'UNKNOWN_CURRENCY'
   when s.reversal_count>0 and(s.reversal_count<>1 or s.valid_reversal_count<>1)then'SOURCE_REVERSAL_UNVERIFIED'
   when s.status not in('CONTABILIZADO','ANULADO')or(s.status='ANULADO'and s.valid_reversal_count<>1)then'SOURCE_STATE_UNVERIFIED'
   when coalesce(a.overapplied_count,0)>0 then'SOURCE_OVERAPPLIED'
   when coalesce(a.local_unverified_count,0)>0 then'LOCAL_HISTORY_UNVERIFIED'
   when coalesce(a.invalid_count,0)>0 then'APPLICATION_HISTORY_UNVERIFIED'
   when coalesce(a.applied_original,0)>s.advance_original then'SOURCE_OVERAPPLIED'
   when s.reversed_date<=p_cutoff and coalesce(a.applied_original,0)>0 then'REVERSED_APPLIED_SOURCE'end reason
 from sources s left join source_applications a on a.source_journal_line_id=s.source_line_id
 where s.date<=p_cutoff
),pending_all as materialized(
 select *from classified s where s.reason is null and s.pending_original>0 and(s.reversed_date is null or s.reversed_date>p_cutoff)
),pending as materialized(
 select *from pending_all s where(p_supplier is null or s.supplier_id=p_supplier)and(p_currency is null or s.currency_id=p_currency)
),bad_sources as materialized(
 select s.*,case s.reason when'SOURCE_UNVERIFIED'then'El origen no coincide con su mayor histórico.'
  when'UNKNOWN_SUPPLIER'then'No se identificó el proveedor del adelanto.'when'UNKNOWN_CURRENCY'then'No se identificó la moneda del adelanto.'
  when'SOURCE_REVERSAL_UNVERIFIED'then'La reversión de la fuente no pudo verificarse.'when'SOURCE_STATE_UNVERIFIED'then'El estado del origen no tiene evidencia contable suficiente.'
  when'LOCAL_HISTORY_UNVERIFIED'then'La valoración histórica de las aplicaciones no pudo verificarse.'
  when'APPLICATION_HISTORY_UNVERIFIED'then'Las aplicaciones registradas no coinciden con sus documentos y mayor.'
  when'SOURCE_OVERAPPLIED'then'Las aplicaciones exceden el importe original.'else'La fuente aplicada tiene una reversión que requiere revisión.'end label,
  row_number()over(order by s.reason,s.source_key)sample_number
 from classified s where s.reason is not null and(p_supplier is null or s.supplier_id=p_supplier)and(p_currency is null or s.currency_id=p_currency)
),exceptions as(
 select reason,min(label)label,count(*)count,
  coalesce(jsonb_agg(jsonb_build_object('sourceKey',source_key,'sourceLineId',source_line_id,'journalId',journal_id,'journalNumber',journal_number,'documentNumber',document_number)
   order by source_key)filter(where sample_number<=25),'[]')examples
 from bad_sources group by reason
),recognized_gl as materialized(
 select value::text::bigint gl_id from jsonb_array_elements((select value->'recognizedSourceGlIds'from grant_snapshot))
 union select value::text::bigint from jsonb_array_elements((select value->'recognizedReversalGlIds'from grant_snapshot))
 union select g.gl_impact_id from ledger g join payment_proof p on p.transaction_id=g.transaction_id and p.account_id=g.account_id and p.valid
),unlinked as materialized(
 select g.*from ledger g where g.posting_date<=p_cutoff and not exists(select 1 from recognized_gl r where r.gl_id=g.gl_impact_id)
),rows_json as materialized(
 select s.source_key,s.date,s.supplier_name,s.currency_code,jsonb_build_object('rowId',s.source_key,'sourceKey',s.source_key,'sourceLineId',s.source_line_id,
  'date',s.date,'journalId',s.journal_id,'journalNumber',s.journal_number,'documentNumber',s.document_number,'note',s.note,
  'bookId',p_book,'bookName',(select book_name from public.accounting_books where accounting_book_id=p_book and subsidiary_id=p_sid),
  'supplierId',s.supplier_id,'supplierCode',s.supplier_code,'supplierName',s.supplier_name,'currencyId',s.currency_id,'currencyCode',s.currency_code,
  'advanceOriginal',s.advance_original,'advanceLocal',s.advance_local,'appliedOriginal',s.applied_original,'appliedLocal',s.applied_local,'pendingOriginal',s.pending_original,'pendingLocal',s.pending_local,
  'qualityReason',case when exists(select 1 from unlinked)then'UNLINKED_LEDGER_ACTIVITY'end)value from pending s
),currency_totals as(
 select currency_id,max(currency_code)currency_code,count(*)source_count,sum(advance_original)advance_original,sum(advance_local)advance_local,
  sum(applied_original)applied_original,sum(applied_local)applied_local,sum(pending_original)pending_original,sum(pending_local)pending_local
 from pending group by currency_id
),supplier_totals as(
 select supplier_id,max(supplier_code)supplier_code,max(supplier_name)supplier_name,currency_id,max(currency_code)currency_code,count(*)source_count,
  sum(advance_original)advance_original,sum(advance_local)advance_local,sum(applied_original)applied_original,sum(applied_local)applied_local,sum(pending_original)pending_original,sum(pending_local)pending_local
 from pending group by supplier_id,currency_id
)
select jsonb_build_object('rows',(select coalesce(jsonb_agg(value order by date,source_key),'[]')from rows_json),'total',(select count(*)from pending),
 'dataFingerprint',md5(jsonb_build_object('pending',(select coalesce(jsonb_agg(value order by source_key),'[]')from rows_json),
  'exceptions',(select coalesce(jsonb_agg(to_jsonb(b)-'sample_number'order by source_key),'[]')from bad_sources b),
  'unlinked',(select coalesce(jsonb_agg(to_jsonb(u)order by gl_impact_id),'[]')from unlinked u))::text),
 'filterOptions',jsonb_build_object('suppliers',(select coalesce(jsonb_agg(jsonb_build_object('id',supplier_id,'code',supplier_code,'name',supplier_name)order by supplier_name,supplier_id),'[]')from(select distinct supplier_id,supplier_code,supplier_name from pending_all)s)),
 'currencyTotals',(select coalesce(jsonb_agg(jsonb_build_object('currencyId',currency_id,'currencyCode',currency_code,'sourceCount',source_count,
  'advanceOriginal',advance_original,'advanceLocal',advance_local,'appliedOriginal',applied_original,'appliedLocal',applied_local,'pendingOriginal',pending_original,'pendingLocal',pending_local)order by currency_code),'[]')from currency_totals),
 'supplierTotals',(select coalesce(jsonb_agg(jsonb_build_object('supplierId',supplier_id,'supplierCode',supplier_code,'supplierName',supplier_name,'currencyId',currency_id,'currencyCode',currency_code,'sourceCount',source_count,
  'advanceOriginal',advance_original,'advanceLocal',advance_local,'appliedOriginal',applied_original,'appliedLocal',applied_local,'pendingOriginal',pending_original,'pendingLocal',pending_local)order by currency_code,supplier_name,supplier_id),'[]')from supplier_totals),
 'exceptions',(select coalesce(jsonb_agg(to_jsonb(e)order by reason),'[]')from exceptions e),
 'summary',jsonb_build_object('pendingLocal',(select coalesce(sum(pending_local),0)from pending),'unresolvedSourceCount',(select count(*)from bad_sources),
  'unlinkedMovementCount',(select count(*)from unlinked),'unlinkedMovementLocal',(select coalesce(sum(credit_amount-debit_amount),0)from unlinked),
  'controlBalanceLocal',(select coalesce(sum(debit_amount-credit_amount),0)from ledger where posting_date<=p_cutoff),
  'reconciliationAvailable',false,'reconciliationReason','UNAPPLIED_SOURCE_REPORT','differenceLocal',null))
$$;

revoke all on function supplier_advances_report_private.grant_sources(bigint,bigint)from public,anon,authenticated,service_role;
revoke all on function supplier_advances_report_private.pending_sources(bigint,date,bigint,bigint,bigint)from public,anon,authenticated,service_role;
notify pgrst,'reload schema';
