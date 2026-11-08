-- Read-only group 223 ledger rollforward. Exact whole-bucket proofs permit a
-- JL projection without pretending that an individual GL row identifies a JL.
-- Unproved GL is retained, never allocated by position, proportion or current FX.
set local lock_timeout='5s';
set local statement_timeout='60s';
create schema accrued_payroll_report_private;
revoke all on schema accrued_payroll_report_private from public,anon,authenticated,service_role;

create function accrued_payroll_report_private.source_rows(p_sid bigint,p_cutoff date,p_book bigint)
returns table(source_key text,posting_date date,account_id bigint,account_number text,account_name text,
 currency_id bigint,currency_code text,department_id bigint,department_name text,cost_center_id bigint,cost_center_code text,cost_center_name text,
 book_id bigint,book_name text,journal_id bigint,journal_number text,document_number text,note text,
 debit_original numeric,credit_original numeric,debit_local numeric,credit_local numeric,movement_type text,quality_reason text)
language sql stable set search_path=pg_catalog,public,pg_temp as $$
with recursive groups as(
 select g.group_id from public.account_group g where g.group_code='223'
 union select g.group_id from public.account_group g join groups p on g.parent_id=p.group_id
),accounts as materialized(select a.*from public.chart_accounts a where a.account_group_id in(select group_id from groups)),
scope_gl as materialized(select g.*from public.gl_impact g join accounts a using(account_id)
 where g.subsidiary_id=p_sid and g.posting_date<=p_cutoff and(p_book is null or g.accounting_book_id=p_book)),
journal_identity as materialized(
 select j.transaction_id,count(*)n,min(j.journal_id)journal_id,bool_and(j.subsidiary_id=p_sid)scoped
 from public.journal j where j.transaction_id in(select transaction_id from scope_gl)group by j.transaction_id
),linked as materialized(
 select g.*,j.journal_id,j.journal_number,j.journal_date,j.journal_type,j.currency_id journal_currency_id,j.exchange_rate,j.is_opening_balance,j.reversed_from_journal_id,
  coalesce(t.currency_id,opening_t.currency_id)transaction_currency_id
 from scope_gl g left join public."transaction"t on t.transaction_id=g.transaction_id and t.subsidiary_id=p_sid
 left join journal_identity identity on identity.transaction_id=g.transaction_id and identity.n=1 and identity.scoped
 left join public.opening_balance_lines opening_line on g.transaction_id is null and opening_line.id=g.opening_balance_line_id and opening_line.account_id=g.account_id
 left join public.opening_balance_runs opening_run on opening_run.id=opening_line.run_id and opening_run.subsidiary_id=p_sid
 left join public.journal opening_j on opening_j.journal_id=opening_run.journal_id and opening_j.subsidiary_id=p_sid
 left join public."transaction"opening_t on opening_t.transaction_id=opening_j.transaction_id and opening_t.subsidiary_id=p_sid
 left join public.journal j on j.journal_id=case when g.transaction_id is null then opening_j.journal_id else identity.journal_id end
  and j.subsidiary_id=p_sid and(t.transaction_id is not null or(g.transaction_id is null and opening_j.journal_id is not null and(opening_j.transaction_id is null or opening_t.transaction_id is not null)))
),journal_accounts_books as materialized(
 select distinct l.journal_id,l.transaction_id,l.account_id,l.accounting_book_id from linked l where l.journal_id is not null
),ordinary_lines as materialized(
 select l.*,j.journal_date,j.currency_id journal_currency_id,j.transaction_id,
  coalesce(l.original_currency_id,j.currency_id,t.currency_id)resolved_currency_id,
  round(l.debit*j.exchange_rate,6)expected_debit,round(l.credit*j.exchange_rate,6)expected_credit
 from public.journal_line l join public.journal j using(journal_id)
 join public."transaction"t on t.transaction_id=j.transaction_id and t.subsidiary_id=p_sid
 join accounts a using(account_id)
 where j.subsidiary_id=p_sid and j.is_opening_balance is not true and l.opening_balance_line_id is null
  and j.exchange_rate>0 and j.exchange_rate::text not in('NaN','Infinity','-Infinity')
  and(l.debit>0 or l.credit>0)and j.journal_id in(select journal_id from journal_accounts_books)
),ordinary_expected as(
 select l.journal_id,l.account_id,jsonb_agg(jsonb_build_array(l.journal_date,l.resolved_currency_id,l.expected_debit,l.expected_credit,l.debit,l.credit)
  order by l.journal_date,l.resolved_currency_id,l.expected_debit,l.expected_credit,l.debit,l.credit)signature
 from ordinary_lines l group by l.journal_id,l.account_id
),ordinary_actual as(
 select b.journal_id,b.account_id,b.accounting_book_id,jsonb_agg(jsonb_build_array(g.posting_date,coalesce(g.original_currency_id,j.currency_id,t.currency_id),g.debit_amount,g.credit_amount,g.debit_fx,g.credit_fx)
  order by g.posting_date,coalesce(g.original_currency_id,j.currency_id,t.currency_id),g.debit_amount,g.credit_amount,g.debit_fx,g.credit_fx)signature
 from journal_accounts_books b join public.gl_impact g on g.transaction_id=b.transaction_id and g.account_id=b.account_id
  and g.accounting_book_id is not distinct from b.accounting_book_id and g.subsidiary_id=p_sid
 join public.journal j on j.journal_id=b.journal_id and j.subsidiary_id=p_sid
 join public."transaction"t on t.transaction_id=j.transaction_id and t.subsidiary_id=p_sid
 group by b.journal_id,b.account_id,b.accounting_book_id
),ordinary_proof as materialized(
 select a.journal_id,a.account_id,a.accounting_book_id from ordinary_actual a join ordinary_expected e using(journal_id,account_id)
 join public.accounting_books book on book.accounting_book_id=a.accounting_book_id and book.subsidiary_id=p_sid
 where a.signature=e.signature
),opening_counts as(
 select opening_balance_line_id,accounting_book_id,posting_date,count(*)n from scope_gl where opening_balance_line_id is not null
 group by opening_balance_line_id,accounting_book_id,posting_date
),opening_candidates as materialized(
 select g.gl_impact_id,min(l.journal_line_id)journal_line_id,count(*)n,min(l.department_id)department_id,min(l.cost_center_id)cost_center_id,
  min(coalesce(g.original_currency_id,l.original_currency_id,o.currency_id))currency_id,min(o.document_number)document_number,min(l.note)note
 from linked g join public.journal_line l on l.journal_id=g.journal_id and l.account_id=g.account_id and l.opening_balance_line_id=g.opening_balance_line_id
 join public.opening_balance_lines o on o.id=g.opening_balance_line_id and o.account_id=g.account_id
 join public.opening_balance_runs r on r.id=o.run_id and r.subsidiary_id=p_sid and r.status in('POSTED','REVERSED')and(r.journal_id=g.journal_id or r.journal_id=g.reversed_from_journal_id)
 join opening_counts count_key on count_key.opening_balance_line_id=g.opening_balance_line_id and count_key.accounting_book_id is not distinct from g.accounting_book_id and count_key.posting_date=g.posting_date and count_key.n=1
 join public.accounting_books book on book.accounting_book_id=g.accounting_book_id and book.subsidiary_id=p_sid
 where g.posting_date=g.journal_date and l.debit=g.debit_amount and l.credit=g.credit_amount
  and g.debit_fx=case when l.debit>0 then o.foreign_amount else 0 end and g.credit_fx=case when l.credit>0 then o.foreign_amount else 0 end
  and(g.original_currency_id is null or g.original_currency_id=coalesce(l.original_currency_id,o.currency_id))
 group by g.gl_impact_id
),projected as materialized(
 select 'JL:'||l.journal_line_id||':BOOK:'||coalesce(p.accounting_book_id::text,'NULL')source_key,l.journal_date posting_date,l.account_id,
  l.resolved_currency_id currency_id,l.department_id,l.cost_center_id,p.accounting_book_id book_id,l.journal_id,
  null::text document_number,l.note,l.debit debit_original,l.credit credit_original,l.expected_debit debit_local,l.expected_credit credit_local,true proven
 from ordinary_proof p join ordinary_lines l on l.journal_id=p.journal_id and l.account_id=p.account_id where l.journal_date<=p_cutoff
 union all
 select 'JL:'||o.journal_line_id||':BOOK:'||coalesce(g.accounting_book_id::text,'NULL'),g.posting_date,g.account_id,
  o.currency_id,o.department_id,o.cost_center_id,g.accounting_book_id,g.journal_id,o.document_number,o.note,g.debit_fx,g.credit_fx,g.debit_amount,g.credit_amount,true
 from linked g join opening_candidates o using(gl_impact_id)where o.n=1
 union all
 select 'GL:'||g.gl_impact_id,g.posting_date,g.account_id,g.original_currency_id,null::bigint,null::bigint,g.accounting_book_id,g.journal_id,
  null::text,null::text,g.debit_fx,g.credit_fx,g.debit_amount,g.credit_amount,false
 from linked g where not exists(select 1 from ordinary_proof p where p.journal_id=g.journal_id and p.account_id=g.account_id and p.accounting_book_id is not distinct from g.accounting_book_id)
  and not exists(select 1 from opening_candidates o where o.gl_impact_id=g.gl_impact_id and o.n=1)
),bank_documents as(
 select b.journal_id,b.transaction_id,count(*)n,min(b.check_number)document_number,
  bool_and(b.payment_type in('CHEQUE','TRANSFERENCIA')and b.subsidiary_id=p_sid and bank.subsidiary_id=p_sid
   and b.currency_id=j.currency_id and bank.currency_id=b.currency_id)valid
 from public.bank_check b join public.journal j on j.journal_id=b.journal_id and j.transaction_id=b.transaction_id and j.subsidiary_id=p_sid
 join public.bank_account bank on bank.bank_account_id=b.bank_account_id
 where b.journal_id in(select p.journal_id from projected p)group by b.journal_id,b.transaction_id
)
select p.source_key,p.posting_date,p.account_id,a.account_number,a.account_name,c.currency_id,c.currency_code,
 d.department_id,d.name,cc.cost_center_id,cc.code,cc.name,p.book_id,book.book_name,p.journal_id,j.journal_number,
 coalesce(p.document_number,case when b.n=1 and b.valid then b.document_number end,j.journal_number),p.note,
 p.debit_original,p.credit_original,p.debit_local,p.credit_local,
 case when b.n=1 and b.valid then'payment'when j.journal_type='Asiento de Nóminas'and b.n is null then'payroll'else'other'end,
 case when not p.proven then'No fue posible probar las dimensiones del movimiento.'
  when c.currency_id is null then'No fue posible identificar la moneda de origen.'
  when p.department_id is not null and d.department_id is null then'El departamento no pertenece a la empresa.'
  when p.cost_center_id is not null and cc.cost_center_id is null then'El centro de costos no pertenece a la empresa.'end
from projected p join accounts a using(account_id)
left join public.journal j on j.journal_id=p.journal_id and j.subsidiary_id=p_sid
left join bank_documents b on b.journal_id=j.journal_id and b.transaction_id=j.transaction_id
left join public.currencies c on c.currency_id=p.currency_id
left join public.departments d on d.department_id=p.department_id and(d.subsidiary_id=p_sid or exists(select 1 from public.department_subsidiaries s where s.department_id=d.department_id and s.subsidiary_id=p_sid))
left join public.cost_centers cc on cc.cost_center_id=p.cost_center_id and cc.subsidiary_id=p_sid
left join public.accounting_books book on book.accounting_book_id=p.book_id and book.subsidiary_id=p_sid
$$;

create function public.run_accrued_payroll_payables_report(p_filters jsonb default'{}')returns jsonb
language plpgsql stable security definer set search_path=pg_catalog,public,pg_temp as $$
declare sid bigint;uid bigint;from_date date;to_date date;book bigint;account bigint;currency bigint;department bigint;cost bigint;
 only_nonzero boolean:=true;page_no integer:=1;page_size integer:=50;key text;filter_value text;group_count bigint;group_info jsonb;local_currency jsonb;result jsonb;
begin
 perform report_template_private.enter('reports:accounting-reports','view');
 uid:=public.app_user_id();sid:=public.active_subsidiary_id();
 if uid is null or sid is null or not exists(select 1 from public.users u join public.user_subsidiaries s using(user_id)where u.user_id=uid and u.is_active and s.subsidiary_id=sid)then
  raise exception using errcode='42501',message='La empresa activa no está autorizada.';
 end if;
 if p_filters is null or jsonb_typeof(p_filters)<>'object'or exists(select 1 from jsonb_object_keys(p_filters)k where k not in('subsidiaryIds','dateFrom','dateTo','bookId','accountId','currencyId','departmentId','costCenterId','onlyNonzero','page','pageSize'))then
  raise exception using errcode='22023',message='Los filtros del reporte no son válidos.';
 end if;
 if jsonb_typeof(p_filters->'subsidiaryIds')is distinct from'array'or jsonb_array_length(p_filters->'subsidiaryIds')<>1 or coalesce(p_filters#>>'{subsidiaryIds,0}','')!~'^[1-9][0-9]{0,18}$'then
  raise exception using errcode='22023',message='Seleccione una sola empresa.';
 end if;
 begin
  if(p_filters#>>'{subsidiaryIds,0}')::bigint<>sid then raise exception using errcode='42501',message='La empresa solicitada no coincide con la empresa activa.';end if;
  if coalesce(p_filters->>'dateFrom','')!~'^[0-9]{4}-[0-9]{2}-[0-9]{2}$'or coalesce(p_filters->>'dateTo','')!~'^[0-9]{4}-[0-9]{2}-[0-9]{2}$'then
   raise exception using errcode='22023',message='El período no es válido.';
  end if;
  from_date:=(p_filters->>'dateFrom')::date;to_date:=(p_filters->>'dateTo')::date;
  if from_date>to_date then raise exception using errcode='22023',message='La fecha inicial no puede superar la final.';end if;
  foreach key in array array['bookId','accountId','currencyId','departmentId','costCenterId']loop
   filter_value:=p_filters->>key;
   if filter_value is not null and filter_value!~'^[1-9][0-9]{0,18}$'then raise exception using errcode='22023',message='El identificador de un filtro no es válido.';end if;
   case key when'bookId'then book:=filter_value::bigint;when'accountId'then account:=filter_value::bigint;when'currencyId'then currency:=filter_value::bigint;when'departmentId'then department:=filter_value::bigint;else cost:=filter_value::bigint;end case;
  end loop;
  if p_filters?'onlyNonzero'then
   if jsonb_typeof(p_filters->'onlyNonzero')<>'boolean'then raise exception using errcode='22023',message='El filtro de actividad no es válido.';end if;
   only_nonzero:=(p_filters->>'onlyNonzero')::boolean;
  end if;
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
 if book is not null and not exists(select 1 from public.accounting_books b where b.accounting_book_id=book and b.subsidiary_id=sid)then raise exception using errcode='42501',message='El libro no pertenece a la empresa activa.';end if;
 select count(*),jsonb_build_object('id',min(group_id),'code','223','name',min(group_name))into group_count,group_info from public.account_group where group_code='223';
 if group_count>1 then raise exception using errcode='55000',message='El grupo 223 no tiene una identificación única.';end if;
 if account is not null and not exists(with recursive groups as(select group_id from public.account_group where group_code='223'union select g.group_id from public.account_group g join groups p on g.parent_id=p.group_id)select 1 from public.chart_accounts a where a.account_id=account and a.account_group_id in(select group_id from groups))then
  raise exception using errcode='22023',message='La cuenta no pertenece al grupo 223.';
 end if;
 select jsonb_build_object('id',c.currency_id,'code',c.currency_code)into local_currency from public.subsidiaries s left join public.currencies c on c.currency_id=s.currency_id where s.subsidiary_id=sid;
 with recursive groups as(select group_id from public.account_group where group_code='223'union select g.group_id from public.account_group g join groups p on g.parent_id=p.group_id),
 eligible_accounts as materialized(select a.*from public.chart_accounts a where a.account_group_id in(select group_id from groups)),
 control as materialized(
  select coalesce(sum(g.credit_amount-g.debit_amount)filter(where g.posting_date<from_date),0)opening,
   coalesce(sum(g.debit_amount)filter(where g.posting_date>=from_date),0)debit,
   coalesce(sum(g.credit_amount)filter(where g.posting_date>=from_date),0)credit,
   coalesce(sum(g.credit_amount-g.debit_amount),0)closing
  from public.gl_impact g join eligible_accounts a using(account_id)
  where g.subsidiary_id=sid and g.posting_date<=to_date and(book is null or g.accounting_book_id=book)
 ),all_source as materialized(select *from accrued_payroll_report_private.source_rows(sid,to_date,book)),
 selected as materialized(
  select r.*from all_source r where(account is null or r.account_id=account)and(currency is null or r.currency_id=currency)
   and(department is null or r.department_id=department)and(cost is null or r.cost_center_id=cost)
 ),leaf_state as materialized(
  select account_id,max(account_number)account_number,max(account_name)account_name,currency_id,max(currency_code)currency_code,
   department_id,max(department_name)department_name,cost_center_id,max(cost_center_code)cost_center_code,max(cost_center_name)cost_center_name,
   bool_and(currency_id is not null and debit_original is not null and credit_original is not null)native_complete,
   bool_or(quality_reason is not null or currency_id is null)has_quality,
   count(*)filter(where posting_date<from_date)previous_count,count(*)filter(where posting_date>=from_date)movement_count,
   count(*)filter(where posting_date<from_date and(quality_reason is not null or currency_id is null))unattributed_opening,
   count(*)filter(where posting_date>=from_date and(quality_reason is not null or currency_id is null))unattributed_movements,
   coalesce(sum(credit_original-debit_original)filter(where posting_date<from_date),0)opening_original,
   coalesce(sum(credit_local-debit_local)filter(where posting_date<from_date),0)opening_local,
   coalesce(sum(credit_original-debit_original)filter(where posting_date>=from_date and movement_type='payroll'),0)payroll_original,
   coalesce(sum(credit_local-debit_local)filter(where posting_date>=from_date and movement_type='payroll'),0)payroll_local,
   coalesce(sum(debit_original-credit_original)filter(where posting_date>=from_date and movement_type='payment'),0)payment_original,
   coalesce(sum(debit_local-credit_local)filter(where posting_date>=from_date and movement_type='payment'),0)payment_local,
   coalesce(sum(credit_original-debit_original)filter(where posting_date>=from_date and movement_type='other'),0)other_original,
   coalesce(sum(credit_local-debit_local)filter(where posting_date>=from_date and movement_type='other'),0)other_local,
   coalesce(sum(debit_original)filter(where posting_date>=from_date),0)debit_original,coalesce(sum(credit_original)filter(where posting_date>=from_date),0)credit_original,
   coalesce(sum(debit_local)filter(where posting_date>=from_date),0)debit_local,coalesce(sum(credit_local)filter(where posting_date>=from_date),0)credit_local,
   coalesce(sum(credit_original-debit_original),0)closing_original,coalesce(sum(credit_local-debit_local),0)closing_local
  from selected group by account_id,currency_id,department_id,cost_center_id
 ),active_leaves as materialized(
  select s.*,case when previous_count>0 and(not only_nonzero or opening_original<>0 or opening_local<>0 or unattributed_opening>0 or not native_complete)then 1 else 0 end virtual_count
  from leaf_state s where not only_nonzero or movement_count>0 or opening_original<>0 or opening_local<>0 or closing_original<>0 or closing_local<>0 or has_quality
 ),period_rows as(
  select r.*,case when l.native_complete then l.opening_original+sum(r.credit_original-r.debit_original)over w end running_original,
   l.opening_local+sum(r.credit_local-r.debit_local)over w running_local
  from selected r join active_leaves l on l.account_id=r.account_id and l.currency_id is not distinct from r.currency_id
   and l.department_id is not distinct from r.department_id and l.cost_center_id is not distinct from r.cost_center_id
  where r.posting_date>=from_date
  window w as(partition by r.account_id,r.currency_id,r.department_id,r.cost_center_id order by r.posting_date,r.source_key rows unbounded preceding)
 ),display_rows as materialized(
  select r.source_key,'movement'::text row_kind,r.posting_date,r.account_id,r.account_number,r.account_name,r.currency_id,r.currency_code,r.department_id,r.department_name,r.cost_center_id,r.cost_center_code,r.cost_center_name,
   r.book_id,r.book_name,r.journal_id,r.journal_number,r.document_number,r.note,r.movement_type,r.quality_reason,
   r.debit_original,r.credit_original,r.debit_local,r.credit_local,0::numeric opening_original,0::numeric opening_local,
   case when r.movement_type='payroll'then r.credit_original-r.debit_original else 0 end payroll_original,
   case when r.movement_type='payroll'then r.credit_local-r.debit_local else 0 end payroll_local,
   case when r.movement_type='payment'then r.debit_original-r.credit_original else 0 end payment_original,
   case when r.movement_type='payment'then r.debit_local-r.credit_local else 0 end payment_local,
   case when r.movement_type='other'then r.credit_original-r.debit_original else 0 end other_original,
   case when r.movement_type='other'then r.credit_local-r.debit_local else 0 end other_local,
   r.running_original closing_original,r.running_local closing_local,r.running_original,r.running_local
  from period_rows r
  union all
  select 'opening:'||jsonb_build_array(l.account_id,l.currency_id,l.department_id,l.cost_center_id)::text,'opening',from_date,
   l.account_id,l.account_number,l.account_name,l.currency_id,l.currency_code,l.department_id,l.department_name,l.cost_center_id,l.cost_center_code,l.cost_center_name,
   book,(select b.book_name from public.accounting_books b where b.accounting_book_id=book and b.subsidiary_id=sid),null::bigint,null::text,null::text,'Saldo anterior al período',null::text,
   case when l.unattributed_opening>0 or not l.native_complete then'Incluye movimientos anteriores no identificados.'end,
   0,0,0,0,case when l.native_complete then l.opening_original end,l.opening_local,0,0,0,0,0,0,
   case when l.native_complete then l.opening_original end,l.opening_local,case when l.native_complete then l.opening_original end,l.opening_local
  from active_leaves l where l.virtual_count=1
 ),paged as(
  select *from display_rows order by account_number,currency_code nulls last,department_name nulls last,department_id nulls last,cost_center_code nulls last,cost_center_id nulls last,
   posting_date,case row_kind when'opening'then 0 else 1 end,source_key limit page_size offset((page_no::bigint-1)*page_size)
 ),rollup as(
  select case grouping(l.currency_id,l.department_id,l.cost_center_id)when 7 then'account'when 3 then'currency'when 1 then'department'else'leaf'end level,
   l.account_id,max(l.account_number)account_number,max(l.account_name)account_name,l.currency_id,
   case when grouping(l.currency_id)=0 then max(l.currency_code)end currency_code,l.department_id,
   case when grouping(l.department_id)=0 then max(l.department_name)end department_name,l.cost_center_id,
   case when grouping(l.cost_center_id)=0 then max(l.cost_center_code)end cost_center_code,
   case when grouping(l.cost_center_id)=0 then max(l.cost_center_name)end cost_center_name,
   sum(l.movement_count)movement_count,sum(l.movement_count+l.virtual_count)total_rows,
   case when count(distinct l.currency_id)=1 and bool_and(l.native_complete)then sum(l.opening_original)end opening_original,sum(l.opening_local)opening_local,
   case when count(distinct l.currency_id)=1 and bool_and(l.native_complete)then sum(l.payroll_original)end payroll_original,sum(l.payroll_local)payroll_local,
   case when count(distinct l.currency_id)=1 and bool_and(l.native_complete)then sum(l.payment_original)end payment_original,sum(l.payment_local)payment_local,
   case when count(distinct l.currency_id)=1 and bool_and(l.native_complete)then sum(l.other_original)end other_original,sum(l.other_local)other_local,
   case when count(distinct l.currency_id)=1 and bool_and(l.native_complete)then sum(l.debit_original)end debit_original,
   case when count(distinct l.currency_id)=1 and bool_and(l.native_complete)then sum(l.credit_original)end credit_original,
   sum(l.debit_local)debit_local,sum(l.credit_local)credit_local,
   case when count(distinct l.currency_id)=1 and bool_and(l.native_complete)then sum(l.closing_original)end closing_original,sum(l.closing_local)closing_local,
   case when bool_or(l.has_quality)then'Incluye movimientos no identificados.'end quality_reason
  from active_leaves l group by grouping sets((l.account_id),(l.account_id,l.currency_id),(l.account_id,l.currency_id,l.department_id),(l.account_id,l.currency_id,l.department_id,l.cost_center_id))
 ),totals_json as materialized(
  select r.level,r.account_number,r.currency_code,r.department_name,r.cost_center_code,jsonb_build_object(
   'accountId',r.account_id,'accountNumber',r.account_number,'accountName',r.account_name,'currencyId',r.currency_id,'currencyCode',r.currency_code,
   'departmentId',r.department_id,'departmentName',r.department_name,'costCenterId',r.cost_center_id,'costCenterCode',r.cost_center_code,'costCenterName',r.cost_center_name,
   'movementCount',r.movement_count,'totalRows',r.total_rows,'openingOriginal',r.opening_original,'openingLocal',r.opening_local,
   'payrollOriginal',r.payroll_original,'payrollLocal',r.payroll_local,'paymentOriginal',r.payment_original,'paymentLocal',r.payment_local,
   'otherOriginal',r.other_original,'otherLocal',r.other_local,'debitOriginal',r.debit_original,'creditOriginal',r.credit_original,'debitLocal',r.debit_local,'creditLocal',r.credit_local,
   'closingOriginal',r.closing_original,'closingLocal',r.closing_local,'qualityReason',r.quality_reason)value from rollup r
 )
 select jsonb_build_object('context',jsonb_build_object('subsidiaryId',sid,'dateFrom',from_date,'dateTo',to_date,'bookId',book,'accountId',account,'currencyId',currency,'departmentId',department,'costCenterId',cost,'onlyNonzero',only_nonzero),
  'group',group_info,'localCurrency',local_currency,
  'filterOptions',jsonb_build_object(
   'accounts',(select coalesce(jsonb_agg(jsonb_build_object('id',a.account_id,'number',a.account_number,'name',a.account_name)order by a.account_number),'[]')from eligible_accounts a where exists(select 1 from public.account_subsidiaries s where s.account_id=a.account_id and s.subsidiary_id=sid)or a.account_id in(select account_id from all_source)),
   'currencies',(select coalesce(jsonb_agg(jsonb_build_object('id',c.currency_id,'code',c.currency_code)order by c.currency_code),'[]')from public.currencies c where exists(select 1 from public.subsidiary_currencies s where s.currency_id=c.currency_id and s.subsidiary_id=sid)or c.currency_id in(select currency_id from all_source)),
   'departments',(select coalesce(jsonb_agg(jsonb_build_object('id',d.department_id,'name',d.name)order by d.name,d.department_id),'[]')from public.departments d where d.subsidiary_id=sid or exists(select 1 from public.department_subsidiaries s where s.department_id=d.department_id and s.subsidiary_id=sid)),
   'costCenters',(select coalesce(jsonb_agg(jsonb_build_object('id',c.cost_center_id,'code',c.code,'name',c.name)order by c.code,c.cost_center_id),'[]')from public.cost_centers c where c.subsidiary_id=sid)),
  'totalRows',(select count(*)from display_rows),'movementCount',(select coalesce(sum(movement_count),0)from active_leaves),'page',page_no,'pageSize',page_size,
  'dataFingerprint',(select md5(coalesce(jsonb_agg(to_jsonb(r)order by source_key),'[]')::text)from display_rows r),
  'rows',(select coalesce(jsonb_agg(jsonb_build_object('rowId',source_key,'sourceKey',source_key,'rowKind',row_kind,'date',posting_date,
   'accountId',account_id,'accountNumber',account_number,'accountName',account_name,'currencyId',currency_id,'currencyCode',currency_code,
   'departmentId',department_id,'departmentName',department_name,'costCenterId',cost_center_id,'costCenterCode',cost_center_code,'costCenterName',cost_center_name,
   'bookId',book_id,'bookName',book_name,'journalId',journal_id,'journalNumber',journal_number,'documentNumber',document_number,'note',note,'movementType',movement_type,'qualityReason',quality_reason,
   'debitOriginal',debit_original,'creditOriginal',credit_original,'debitLocal',debit_local,'creditLocal',credit_local,
   'openingOriginal',opening_original,'openingLocal',opening_local,'payrollOriginal',payroll_original,'payrollLocal',payroll_local,'paymentOriginal',payment_original,'paymentLocal',payment_local,
   'otherOriginal',other_original,'otherLocal',other_local,'closingOriginal',closing_original,'closingLocal',closing_local,'runningBalanceOriginal',running_original,'runningBalanceLocal',running_local)
   order by account_number,currency_code nulls last,department_name nulls last,department_id nulls last,cost_center_code nulls last,cost_center_id nulls last,posting_date,case row_kind when'opening'then 0 else 1 end,source_key),'[]')from paged),
  'accountTotals',(select coalesce(jsonb_agg(value order by account_number),'[]')from totals_json where level='account'),
  'currencyTotals',(select coalesce(jsonb_agg(value order by account_number,currency_code nulls last),'[]')from totals_json where level='currency'),
  'departmentTotals',(select coalesce(jsonb_agg(value order by account_number,currency_code nulls last,department_name nulls last),'[]')from totals_json where level='department'),
  'leafTotals',(select coalesce(jsonb_agg(value order by account_number,currency_code nulls last,department_name nulls last,cost_center_code nulls last),'[]')from totals_json where level='leaf'),
  'summary',jsonb_build_object('controlOpeningLocal',(select opening from control),'controlDebitLocal',(select debit from control),'controlCreditLocal',(select credit from control),'controlClosingLocal',(select closing from control),
   'reportedOpeningLocal',(select coalesce(sum(opening_local),0)from active_leaves),'reportedClosingLocal',(select coalesce(sum(closing_local),0)from active_leaves),
   'differenceLocal',case when account is null and currency is null and department is null and cost is null then(select coalesce(sum(closing_local),0)from active_leaves)-(select closing from control)end,
   'reconciliationAvailable',account is null and currency is null and department is null and cost is null,
   'reconciliationReason',case when account is not null or currency is not null or department is not null or cost is not null then'FILTERED_SELECTION'end,
   'unattributedMovementCount',(select coalesce(sum(unattributed_movements),0)from active_leaves),
   'unattributedOpeningCount',(select coalesce(sum(unattributed_opening),0)from active_leaves)))into result;
 return result;
end$$;

revoke all on function accrued_payroll_report_private.source_rows(bigint,date,bigint)from public,anon,authenticated,service_role;
revoke all on function public.run_accrued_payroll_payables_report(jsonb)from public,anon,authenticated,service_role;
grant execute on function public.run_accrued_payroll_payables_report(jsonb)to authenticated;
notify pgrst,'reload schema';
