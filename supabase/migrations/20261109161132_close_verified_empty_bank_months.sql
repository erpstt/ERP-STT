-- Carry an evidenced previous month-end balance only across a genuinely empty
-- month. Never fabricate a statement, bank line, payment, adjustment or GL row.
set local lock_timeout='5s';set local statement_timeout='60s';
do $guard$declare item record;begin
 for item in select *from(values
  ('public.close_bank_reconciliation(bigint,date,numeric)','74fcd8e12ab9f25143121060f7764a09'),
  ('public.run_bank_reconciliation_report(jsonb)','4bd2d5b77f2a11befbeb67831694ac5c'),
  ('public.bank_reconciliation_options()','fbd63272061f1bf077ae57873f1a8c93'),
  ('reconciliation_private.close_bank_reconciliation(bigint,date,numeric)','d9b0ed5ad9f7d69a6b789680de2020cd'),
  ('reconciliation_private.ensure_open_bank_reconciliation(bigint,date)','0ef6b20e15bd7577b1bfb8eae988a5de'),
  ('reconciliation_private.auto_match_bank_reconciliation(bigint,date)','36adbeb1acb624d480fd00227152ecb3'),
  ('reconciliation_private.run_bank_reconciliation_report(jsonb)','f26b990cd9dd4019640d43980b522b88'),
  ('reconciliation_private.access(text,text)','db49a13764d60473eb083ed784e76786'),
  ('reconciliation_private.allowed(text,text)','927712f39f6253a97bfe95b32d942fa2'),
  ('reconciliation_private.bank_scope(bigint,date,boolean)','dea2f3c05681394fad5cf646ed4bde79'),
  ('reconciliation_private.finite(numeric)','fee60f1df8e749618e109694780894b6'),
  ('public.capture_row_audit()','8773839fa0f03e93c4cbd39fb38f1d24'),
  ('public.resolve_audit_actor()','f61dcd48ae93e52ebe25664a6c122c3b'),
  ('public.record_system_event(text,text,text,text,jsonb)','0caee715abdf2beeb35eacad18878339')
 )v(signature,source_md5)loop
  if not exists(select 1 from pg_proc where oid=to_regprocedure(item.signature)and md5(prosrc)=item.source_md5)then
   raise exception 'Unexpected empty-month close dependency: %',item.signature;
  end if;
 end loop;
 if not exists(select 1 from pg_trigger where tgrelid='public.bank_reconciliation'::regclass
   and tgfoid='public.capture_row_audit()'::regprocedure and tgenabled in('O','A')and not tgisinternal)
  or not exists(select 1 from pg_trigger where tgrelid='public.bank_reconciliation'::regclass
   and tgfoid='reconciliation_private.protect_sources()'::regprocedure and tgenabled in('O','A')and not tgisinternal)then
  raise exception 'Missing current classic reconciliation header audit/source protection';
 end if;
 if to_regprocedure('reconciliation_private.bank_closing_context(bigint,date,numeric)')is not null then
  raise exception 'Verified empty-month context already exists';
 end if;
end$guard$;

create function reconciliation_private.bank_closing_context(p_bank_account_id bigint,p_cutoff date,p_bank_adjustments numeric)
returns jsonb language plpgsql volatile security invoker set search_path=pg_catalog,public,pg_temp as $$
declare
 sid bigint:=reconciliation_private.identity();previous_date date;period_count bigint;period public.fiscal_periods;
 statement_count bigint;statement_row public.bank_statement;prior_count bigint;prior public.bank_statement;
 closed_count bigint;closed_row public.bank_reconciliation;source_period public.fiscal_periods;
 source_kind text;source_date date;source_balance numeric;statement_key bigint;closed_key bigint;
 books numeric;checks numeric;deposits numeric;difference_value numeric;finite_books boolean;
 reason text;mode_value text:='UNAVAILABLE';empty_month boolean:=false;permitted boolean;
begin
 perform reconciliation_private.bank_scope(p_bank_account_id);
 if p_cutoff is null or not isfinite(p_cutoff)or not reconciliation_private.finite(p_bank_adjustments)then
  raise exception using errcode='22023',message='Indique fecha y ajustes válidos.';
 end if;
 permitted:=reconciliation_private.allowed('banking:bank-reconciliations','edit')
  and exists(select 1 from public.users where user_id=public.app_user_id()and is_active)
  and exists(select 1 from public.user_subsidiaries where user_id=public.app_user_id()and subsidiary_id=sid);
 previous_date:=(date_trunc('month',p_cutoff)::date-1);
 select count(*)into period_count from public.fiscal_periods p where p.subsidiary_id=sid and p_cutoff between p.start_date and p.end_date;
 select *into period from public.fiscal_periods p where p.subsidiary_id=sid and p_cutoff between p.start_date and p.end_date
  order by p.start_date desc,p.fiscal_period_id desc limit 1;
 select count(*)into statement_count from public.bank_statement where bank_account_id=p_bank_account_id and statement_date=p_cutoff;
 select *into statement_row from public.bank_statement where bank_account_id=p_bank_account_id and statement_date=p_cutoff order by statement_id limit 1;
 select coalesce(sum(b.amount),0),coalesce(bool_and(reconciliation_private.finite(b.amount)),true)into books,finite_books
  from public.bank_transaction b where b.bank_account_id=p_bank_account_id and b.tran_date<=p_cutoff;
 select coalesce(sum(greatest(-b.amount,0)),0),coalesce(sum(greatest(b.amount,0)),0)into checks,deposits
  from public.bank_transaction b where b.bank_account_id=p_bank_account_id and b.tran_date<=p_cutoff
   and b.reconciliation_status='PENDIENTE_EN_TRANSITO'and b.tran_type<>'SALDO_INICIAL';
 if not permitted then reason:='NOT_AUTHORIZED';
 elsif period.fiscal_period_id is null then reason:='INVALID_PERIOD';
 elsif exists(select 1 from public.bank_reconciliation r where r.bank_account_id=p_bank_account_id and r.status='CERRADA'and r.reconciliation_date>=p_cutoff)
  or exists(select 1 from public.quadratic_bank_reconciliations q where q.bank_account_id=p_bank_account_id and q.status in('approved','closed')
   and(make_date(q.period_year,q.period_month,1)+interval'1 month'-interval'1 day')::date>=p_cutoff)then reason:='PROTECTED_WINDOW';
 elsif not finite_books or not reconciliation_private.finite(books)or not reconciliation_private.finite(checks)or not reconciliation_private.finite(deposits)then reason:='INVALID_BALANCE';
 end if;
 if statement_count>0 then
  -- Preserve the ordinary close path and its exact statement/balance formula.
  statement_key:=statement_row.statement_id;source_date:=p_cutoff;source_kind:='STATEMENT';source_balance:=statement_row.closing_balance;
  if reason is null and statement_count<>1 then reason:='AMBIGUOUS_SOURCE';end if;
  if reason is null and not reconciliation_private.finite(source_balance)then reason:='INVALID_BALANCE';end if;
  difference_value:=(books+checks-deposits+p_bank_adjustments)-source_balance;
  if reason is null and(not reconciliation_private.finite(difference_value)or abs(difference_value)>=.005)then reason:='BALANCE_MISMATCH';end if;
  if reason is null then mode_value:='EXACT_STATEMENT';end if;
 else
  if reason is null and p_cutoff<>(date_trunc('month',p_cutoff)+interval'1 month'-interval'1 day')::date then reason:='INVALID_CUTOFF';end if;
  if reason is null and period_count<>1 then reason:='INVALID_PERIOD';end if;
  if reason is null and(period.is_closed or period.is_inactive)then reason:='PERIOD_PROTECTED';end if;
  if reason is null and p_bank_adjustments<>0 then reason:='ADJUSTMENTS_NOT_ALLOWED';end if;
  select count(*)into prior_count from public.bank_statement where bank_account_id=p_bank_account_id and statement_date=previous_date;
  select *into prior from public.bank_statement where bank_account_id=p_bank_account_id and statement_date=previous_date order by statement_id limit 1;
  select count(*)into closed_count from public.bank_reconciliation where bank_account_id=p_bank_account_id and reconciliation_date=previous_date and status='CERRADA';
  select *into closed_row from public.bank_reconciliation where bank_account_id=p_bank_account_id and reconciliation_date=previous_date and status='CERRADA'order by reconciliation_id limit 1;
  select *into source_period from public.fiscal_periods where fiscal_period_id=closed_row.fiscal_period_id and subsidiary_id=sid;
  if reason is null and(prior_count>1 or closed_count>1)then reason:='AMBIGUOUS_SOURCE';end if;
  if reason is null and prior_count=0 and closed_count=0 then reason:='MISSING_PREVIOUS_BALANCE';end if;
  if reason is null and prior_count=1 and(not reconciliation_private.finite(prior.opening_balance)or not reconciliation_private.finite(prior.closing_balance))then reason:='INVALID_BALANCE';end if;
  if reason is null and closed_count=1 and(source_period.fiscal_period_id is null or source_period.end_date<>previous_date
   or closed_row.closed_at is null or not isfinite(closed_row.closed_at)or closed_row.closed_by is null
   or not exists(select 1 from public.users where user_id=closed_row.closed_by)
   or not reconciliation_private.finite(closed_row.statement_balance)or not reconciliation_private.finite(closed_row.difference)
   or abs(closed_row.difference)>=.005 or not reconciliation_private.finite(closed_row.book_balance)
   or not reconciliation_private.finite(closed_row.transit_payments)or not reconciliation_private.finite(closed_row.transit_deposits)
   or not reconciliation_private.finite(closed_row.bank_adjustments)
   or not reconciliation_private.finite(closed_row.book_balance+closed_row.transit_payments-closed_row.transit_deposits+closed_row.bank_adjustments-closed_row.statement_balance)
   or abs(closed_row.book_balance+closed_row.transit_payments-closed_row.transit_deposits+closed_row.bank_adjustments-closed_row.statement_balance)>=.005
   or abs((closed_row.book_balance+closed_row.transit_payments-closed_row.transit_deposits+closed_row.bank_adjustments-closed_row.statement_balance)-closed_row.difference)>=.005)then reason:='AMBIGUOUS_SOURCE';end if;
  if prior_count=1 then statement_key:=prior.statement_id;source_balance:=prior.closing_balance;source_kind:='STATEMENT';end if;
  if closed_count=1 then
   closed_key:=closed_row.reconciliation_id;
   if prior_count=0 then source_balance:=closed_row.statement_balance;source_kind:='CLOSED_RECONCILIATION';else source_kind:='STATEMENT_AND_CLOSED_RECONCILIATION';end if;
  end if;
  if prior_count=1 or closed_count=1 then source_date:=previous_date;end if;
  if reason is null and prior_count=1 and closed_count=1 and abs(prior.closing_balance-closed_row.statement_balance)>=.005 then reason:='INCONSISTENT_SOURCES';end if;
  -- Presence counts, never net sums: offsetting, zero and opening rows all count
  -- as activity. Partial statement headers are not silently bypassed either.
  if reason is null and(exists(select 1 from public.bank_transaction b where b.bank_account_id=p_bank_account_id and b.tran_date>previous_date and b.tran_date<=p_cutoff)
   or exists(select 1 from public.bank_statement_line l join public.bank_statement s using(statement_id)
    where s.bank_account_id=p_bank_account_id and l.bank_date>previous_date and l.bank_date<=p_cutoff)
   or exists(select 1 from public.bank_statement s where s.bank_account_id=p_bank_account_id and s.statement_date>previous_date and s.statement_date<=p_cutoff))then reason:='ACTIVITY_AFTER_SOURCE';end if;
  difference_value:=(books+checks-deposits+p_bank_adjustments)-source_balance;
  if reason is null and(not reconciliation_private.finite(difference_value)or abs(difference_value)>=.005)then reason:='BALANCE_MISMATCH';end if;
  if reason is null then mode_value:='NO_MOVEMENTS';empty_month:=true;end if;
 end if;
 return jsonb_build_object('bankAccountId',p_bank_account_id,'cutoff',p_cutoff,'subsidiaryId',sid,'fiscalPeriodId',period.fiscal_period_id,
  'canClose',reason is null,'mode',mode_value,'reason',reason,'sourceDate',source_date,
  'balance',case when reconciliation_private.finite(source_balance)then source_balance else null end,'sourceKind',source_kind,
  'sourceStatementId',statement_key,'sourceReconciliationId',closed_key,'noMovements',empty_month);
end$$;
revoke all on function reconciliation_private.bank_closing_context(bigint,date,numeric)from public,anon,authenticated,service_role;

do $patch_close$
declare definition text;needle text;replacement text;
begin
 definition:=pg_get_functiondef('public.close_bank_reconciliation(bigint,date,numeric)'::regprocedure);
 needle:='return reconciliation_private.close_bank_reconciliation(p_bank_account_id,p_cutoff,p_bank_adjustments);';
 if(length(definition)-length(replace(definition,needle,'')))/length(needle)<>1 then raise exception 'Unexpected ordinary bank-close boundary';end if;
 replacement:=$fallback$declare
  context jsonb;rec public.bank_reconciliation;rec_id bigint;period_key bigint;source_date date;actor jsonb;
  books numeric;checks numeric;deposits numeric;diff numeric;before_header jsonb;affected integer;reason text;
 begin
  if exists(select 1 from public.bank_statement where bank_account_id=p_bank_account_id and statement_date=p_cutoff)then
   return reconciliation_private.close_bank_reconciliation(p_bank_account_id,p_cutoff,p_bank_adjustments);
  end if;
  source_date:=date_trunc('month',p_cutoff)::date-1;
  -- The wrapper already owns the canonical bank mutex. Lock available basis
  -- rows and the target period before the fresh, read-only eligibility check.
  perform 1 from public.bank_statement where bank_account_id=p_bank_account_id and statement_date=source_date order by statement_id for share;
  perform 1 from public.bank_reconciliation where bank_account_id=p_bank_account_id and reconciliation_date=source_date and status='CERRADA'order by reconciliation_id for share;
  perform 1 from public.fiscal_periods where subsidiary_id=public.active_subsidiary_id()and p_cutoff between start_date and end_date order by fiscal_period_id for share;
  context:=reconciliation_private.bank_closing_context(p_bank_account_id,p_cutoff,p_bank_adjustments);reason:=context->>'reason';
  if not coalesce((context->>'canClose')::boolean,false)or context->>'mode'<>'NO_MOVEMENTS'then
   case reason
    when 'NOT_AUTHORIZED'then raise exception using errcode='42501',message='El rol activo no puede finalizar la conciliación.';
    when 'ACTIVITY_AFTER_SOURCE'then raise exception using errcode='PBN02',message='El período tiene movimientos; importe el extracto correspondiente antes de finalizar.';
    when 'INVALID_CUTOFF','INVALID_PERIOD','PERIOD_PROTECTED'then raise exception using errcode='PBN03',message='Indique un cierre de mes y un período fiscal activo y abierto.';
    when 'BALANCE_MISMATCH','INVALID_BALANCE'then raise exception using errcode='PBN04',message='Los saldos no permiten finalizar la conciliación sin movimientos.';
    when 'ADJUSTMENTS_NOT_ALLOWED'then raise exception using errcode='PBN05',message='El cierre sin movimientos no admite ajustes bancarios.';
    else raise exception using errcode='PBN01',message='No existe un saldo bancario anterior único y concordante para finalizar este mes.';
   end case;
  end if;
  period_key:=(context->>'fiscalPeriodId')::bigint;
  rec_id:=reconciliation_private.ensure_open_bank_reconciliation(p_bank_account_id,p_cutoff);
  select *into rec from public.bank_reconciliation where reconciliation_id=rec_id and bank_account_id=p_bank_account_id
   and reconciliation_date=p_cutoff and fiscal_period_id=period_key and status='ABIERTA'and closed_at is null and closed_by is null for update;
  if not found then raise exception using errcode='PBN03',message='El período de la conciliación cambió; actualice la revisión.';end if;
  before_header:=to_jsonb(rec);
  select coalesce(sum(amount),0)into books from public.bank_transaction where bank_account_id=p_bank_account_id and tran_date<=p_cutoff;
  select coalesce(sum(greatest(-amount,0)),0),coalesce(sum(greatest(amount,0)),0)into checks,deposits
   from public.bank_transaction where bank_account_id=p_bank_account_id and tran_date<=p_cutoff
    and reconciliation_status='PENDIENTE_EN_TRANSITO'and tran_type<>'SALDO_INICIAL';
  diff:=(books+checks-deposits)-(context->>'balance')::numeric;
  if not reconciliation_private.finite(diff)or abs(diff)>=.005 then raise exception using errcode='PBN04',message='Los saldos cambiaron; revise la conciliación.';end if;
  actor:=public.resolve_audit_actor();
  update public.bank_reconciliation set reconciliation_date=p_cutoff,status='CERRADA',book_balance=books,
   statement_balance=(context->>'balance')::numeric,transit_payments=checks,transit_deposits=deposits,
   bank_adjustments=0,difference=diff,closed_at=now(),closed_by=public.app_user_id()
   where reconciliation_id=rec_id and bank_account_id=p_bank_account_id and fiscal_period_id=period_key and status='ABIERTA';
  get diagnostics affected=row_count;
  if affected<>1 then raise exception using errcode='PBN03',message='La conciliación cambió; actualice la revisión.';end if;
  perform public.record_system_event('BANK_RECONCILIATION_EMPTY_MONTH_CLOSE','bank-reconciliation',
   'Mes bancario sin movimientos cerrado con saldo anterior acreditado.','EXITOSA',jsonb_build_object(
    'actor',actor,'userId',public.app_user_id(),'subsidiaryId',public.active_subsidiary_id(),'bankAccountId',p_bank_account_id,
    'cutoff',p_cutoff,'reconciliationId',rec_id,'basis',context,'before',before_header,
    'after',(select to_jsonb(r)from public.bank_reconciliation r where reconciliation_id=rec_id)));
  return rec_id;
 end;$fallback$;
 execute replace(definition,needle,replacement);
end$patch_close$;

do $patch_report$declare definition text;needle text;replacement text;begin
 definition:=pg_get_functiondef('public.run_bank_reconciliation_report(jsonb)'::regprocedure);
 needle:='select reconciliation_private.run_bank_reconciliation_report(p_filters) payload';
 replacement:=$report$with original_report as materialized(
   select reconciliation_private.run_bank_reconciliation_report(p_filters) payload
  ),close_evidence as materialized(
   select reconciliation_private.bank_closing_context(nullif(p_filters->>'bankAccountId','')::bigint,nullif(p_filters->>'dateTo','')::date,0::numeric) value
  )select r.payload||jsonb_build_object('closingContext',c.value)
   ||case when c.value->>'mode'='NO_MOVEMENTS'then jsonb_build_object('summary',
    coalesce(r.payload->'summary','{}'::jsonb)||jsonb_build_object(
     'statementBalance',(c.value->>'balance')::numeric,
     'difference',coalesce((r.payload#>>'{summary,bookBalance}')::numeric,0)
      +coalesce((r.payload#>>'{summary,transitPayments}')::numeric,0)
      -coalesce((r.payload#>>'{summary,transitDeposits}')::numeric,0)
      +coalesce((r.payload#>>'{summary,bankAdjustments}')::numeric,0)
      -(c.value->>'balance')::numeric))else '{}'::jsonb end payload
   from original_report r cross join close_evidence c$report$;
 if(length(definition)-length(replace(definition,needle,'')))/length(needle)<>1 then raise exception 'Unexpected bank report closing-context boundary';end if;
 execute replace(definition,needle,replacement);
end$patch_report$;

do $patch_options$declare definition text;needle text;replacement text;begin
 definition:=pg_get_functiondef('public.bank_reconciliation_options()'::regprocedure);
 needle:='return reconciliation_private.annotate_draft_delete_options(reconciliation_private.bank_reconciliation_options());';
 replacement:='return reconciliation_private.annotate_draft_delete_options(reconciliation_private.bank_reconciliation_options())||jsonb_build_object(''closingContextVersion'',1);';
 if(length(definition)-length(replace(definition,needle,'')))/length(needle)<>1 then raise exception 'Unexpected bank options closing-context marker boundary';end if;
 execute replace(definition,needle,replacement);
end$patch_options$;
notify pgrst,'reload schema';
