-- Atomic classic unmatch for the exact selected bank statement.
-- Fingerprints are state preconditions, never authorization credentials.
do $$declare item record;begin
 for item in select * from(values
  ('public.unmatch_bank_reconciliation(bigint,date,bigint)','b7954303b31d3a51edea37f052f74bf0'),
  ('reconciliation_private.access(text,text)','db49a13764d60473eb083ed784e76786'),
  ('reconciliation_private.bank_scope(bigint,date,boolean)','dea2f3c05681394fad5cf646ed4bde79'),
  ('reconciliation_private.protect_sources()','f02c37fc3475482de15a710a7c96df50'),
  ('public.capture_row_audit()','8773839fa0f03e93c4cbd39fb38f1d24'),
  ('public.record_system_event(text,text,text,text,jsonb)','0caee715abdf2beeb35eacad18878339'),
  ('public.resolve_audit_actor()','f61dcd48ae93e52ebe25664a6c122c3b')
 )v(signature,source_md5)loop
  if not exists(select 1 from pg_proc where oid=to_regprocedure(item.signature)and md5(prosrc)=item.source_md5)then
   raise exception 'Unexpected bulk-unmatch dependency: %',item.signature;
  end if;
 end loop;
 for item in select unnest(array['bank_transaction','bank_statement_line','bank_reconciliation_match'])name loop
  if not exists(select 1 from pg_trigger where tgrelid=('public.'||item.name)::regclass
   and tgfoid='public.capture_row_audit()'::regprocedure and tgenabled in('O','A')and not tgisinternal)
   or not exists(select 1 from pg_trigger where tgrelid=('public.'||item.name)::regclass
   and tgfoid='reconciliation_private.protect_sources()'::regprocedure and tgenabled in('O','A')and not tgisinternal)then
   raise exception 'Missing current bulk-unmatch audit/source protection for %',item.name;
  end if;
 end loop;
 if to_regprocedure('reconciliation_private.unmatch_all_snapshot(bigint,date,bigint)')is not null
  or to_regprocedure('public.preview_bank_reconciliation_unmatch_all(bigint,date)')is not null
  or to_regprocedure('public.unmatch_all_bank_reconciliation(bigint,date,bigint,text,integer)')is not null then
  raise exception 'Bulk classic-unmatch capability already exists';
 end if;
end$$;

create function reconciliation_private.unmatch_all_snapshot(p_bank_account_id bigint,p_cutoff date,p_statement_id bigint)
returns jsonb language plpgsql stable security definer set search_path=pg_catalog,public,pg_temp as $$
declare
 sid bigint:=reconciliation_private.access('banking:bank-reconciliations','edit');
 statement_row public.bank_statement;context jsonb;members jsonb;fingerprint text;count_matches bigint;
 eligible boolean;reason text;groups jsonb;currency_key bigint;currency_code_value text;protected_date date;
begin
 perform reconciliation_private.bank_scope(p_bank_account_id);
 -- Stable IDs only: no actor trace, wall clock or refreshed session timestamps.
 context:=jsonb_build_object('userId',public.app_user_id(),'roleId',public.app_active_role_id(),
  'subsidiaryId',sid,'sessionId',public.app_session_id());
 if nullif(context->>'sessionId','')is null then raise exception using errcode='42501',message='Seleccione una sesión autorizada.';end if;
 select * into statement_row from public.bank_statement where statement_id=p_statement_id
  and bank_account_id=p_bank_account_id and statement_date=p_cutoff;
 if not found then reason:='No existe un extracto único en la cuenta y fecha seleccionadas.';end if;
 if exists(select 1 from public.bank_reconciliation_match m join public.bank_statement_line l using(statement_line_id)
  where l.statement_id=statement_row.statement_id and not exists(select 1 from public.bank_reconciliation r
   where r.reconciliation_id=m.reconciliation_id and r.bank_account_id=p_bank_account_id))then
  raise exception using errcode='42501',message='Los vínculos de la conciliación no están disponibles en la cuenta activa.';
 end if;
 select b.currency_id,c.currency_code into currency_key,currency_code_value from public.bank_account b
  join public.currencies c using(currency_id)where b.bank_account_id=p_bank_account_id and b.subsidiary_id=sid;
 if currency_key is null or currency_code_value is null then reason:='La moneda de la cuenta bancaria no está disponible.';end if;
 select max(d)into protected_date from(
  select r.reconciliation_date d from public.bank_reconciliation r where r.bank_account_id=p_bank_account_id and r.status='CERRADA'
  union all select(make_date(q.period_year,q.period_month,1)+interval'1 month'-interval'1 day')::date
   from public.quadratic_bank_reconciliations q where q.bank_account_id=p_bank_account_id and q.status in('approved','closed')
 )locked_periods;
 with sources as materialized(
  select m.match_id,to_jsonb(m)matched,to_jsonb(r)reconciliation,to_jsonb(b)book,to_jsonb(l)line,
   to_jsonb(t)transaction_row,r.reconciliation_id,r.reconciliation_date owner_cutoff,
   coalesce((select jsonb_agg(to_jsonb(j)order by j.journal_id)from public.journal j where j.transaction_id=b.transaction_id),'[]'::jsonb)journals,
   coalesce((select jsonb_agg(to_jsonb(x)order by x.match_id)from public.bank_reconciliation_match x
    where x.bank_tran_id=m.bank_tran_id or x.statement_line_id=m.statement_line_id),'[]'::jsonb)classic_references,
   coalesce((select jsonb_agg(to_jsonb(q)order by q.match_id)from public.quadratic_reconciliation_matches q
    where q.bank_tran_id=m.bank_tran_id or q.statement_line_id=m.statement_line_id),'[]'::jsonb)quadratic_matches,
   coalesce((select jsonb_agg(to_jsonb(q)order by q.item_id)from public.quadratic_reconciliation_items q
    where q.bank_tran_id=m.bank_tran_id or q.statement_line_id=m.statement_line_id),'[]'::jsonb)quadratic_items,
   l.amount,
   coalesce(r.reconciliation_id is not null and r.bank_account_id=p_bank_account_id
    and r.status='ABIERTA'and r.closed_at is null
    and b.bank_tran_id is not null and b.bank_account_id=p_bank_account_id
    and b.reconciliation_status='CONCILIADO'and l.reconciliation_status='CONCILIADO'
    and b.tran_type<>'SALDO_INICIAL'and b.tran_date<=r.reconciliation_date
    and l.bank_date<=r.reconciliation_date and statement_row.statement_date<=r.reconciliation_date
    and reconciliation_private.finite(b.amount)and reconciliation_private.finite(l.amount)and abs(b.amount-l.amount)<.005
    and(b.transaction_id is null or t.transaction_id is not null and t.subsidiary_id=sid)
    and not exists(select 1 from public.journal j where j.transaction_id=b.transaction_id and j.subsidiary_id is distinct from sid)
    and(protected_date is null or protected_date<least(r.reconciliation_date,b.tran_date,statement_row.statement_date)),false)source_valid
  from public.bank_reconciliation_match m join public.bank_statement_line l using(statement_line_id)
  left join public.bank_reconciliation r on r.reconciliation_id=m.reconciliation_id and r.bank_account_id=p_bank_account_id
  left join public.bank_transaction b on b.bank_tran_id=m.bank_tran_id and b.bank_account_id=p_bank_account_id
  left join public."transaction" t on t.transaction_id=b.transaction_id
  where l.statement_id=statement_row.statement_id
 ),canonical as materialized(
  select match_id,reconciliation_id,owner_cutoff,jsonb_build_object('match',matched,'reconciliation',reconciliation,
   'book',book,'line',line,'transaction',transaction_row,'journals',journals,'classicReferences',classic_references,
   'quadraticMatches',quadratic_matches,'quadraticItems',quadratic_items)snapshot,
   amount,source_valid and jsonb_array_length(classic_references)=1
    and jsonb_array_length(quadratic_matches)=0 and jsonb_array_length(quadratic_items)=0 valid
  from sources
 ),grouped as(
  select reconciliation_id,owner_cutoff,count(*)match_count,sum(amount)net_amount from canonical
  group by reconciliation_id,owner_cutoff
 )
 select count(*),coalesce(jsonb_agg(snapshot order by match_id),'[]'::jsonb),coalesce(bool_and(valid),false),
  coalesce((select jsonb_agg(jsonb_build_object('reconciliationId',reconciliation_id,'cutoff',owner_cutoff,
   'matchCount',match_count,'currencyId',currency_key,'currencyCode',currency_code_value,'netAmount',net_amount::text)
   order by owner_cutoff,reconciliation_id)from grouped),'[]'::jsonb)
 into count_matches,members,eligible,groups from canonical;
 if reason is null then
  if count_matches=0 then reason:='El extracto seleccionado no tiene punteos para deshacer.';
  elsif not eligible then reason:='Uno o más punteos están protegidos o sus fuentes cambiaron. No se deshará ninguno.';
  end if;
 end if;
 fingerprint:=encode(sha256(convert_to(jsonb_build_object('version',1,'scope','BANK_STATEMENT',
  'context',context,'bankAccountId',p_bank_account_id,'cutoff',p_cutoff,'statement',to_jsonb(statement_row),
  'currencyId',currency_key,'protectedDate',protected_date,'members',members)::text,'UTF8')),'hex');
 return jsonb_build_object('view',jsonb_build_object('scope','BANK_STATEMENT','bankAccountId',p_bank_account_id,
  'cutoff',p_cutoff,'statementId',statement_row.statement_id,'statementDate',statement_row.statement_date,'scopeId',statement_row.statement_id,
  'scopeLabel','Extracto del '||to_char(p_cutoff,'DD/MM/YYYY'),'matchCount',count_matches,'groups',groups,
  'fingerprint',fingerprint,'canUnmatch',reason is null,'blockedReason',reason),'members',members);
end$$;

create function public.preview_bank_reconciliation_unmatch_all(p_bank_account_id bigint,p_cutoff date)
returns jsonb language plpgsql stable security definer set search_path=pg_catalog,public,pg_temp as $$
declare statement_count bigint;statement_key bigint;
begin
 perform reconciliation_private.access('banking:bank-reconciliations','edit');
 if p_bank_account_id is null or p_bank_account_id<=0 or p_cutoff is null or not isfinite(p_cutoff)then
  raise exception using errcode='22023',message='Seleccione cuenta y fecha de extracto válidas.';
 end if;
 perform reconciliation_private.bank_scope(p_bank_account_id);
 select count(*),min(statement_id)into statement_count,statement_key from public.bank_statement
  where bank_account_id=p_bank_account_id and statement_date=p_cutoff;
 if statement_count<>1 then statement_key:=null;end if;
 return reconciliation_private.unmatch_all_snapshot(p_bank_account_id,p_cutoff,statement_key)->'view';
end$$;

create function public.unmatch_all_bank_reconciliation(p_bank_account_id bigint,p_cutoff date,p_statement_id bigint,
 p_expected_fingerprint text,p_expected_count integer)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$
declare
 statement_row public.bank_statement;statement_count bigint;snapshot jsonb;preview jsonb;member jsonb;results jsonb;
 match_key bigint;owner_cutoff date;completed integer:=0;actor jsonb;
begin
 perform reconciliation_private.access('banking:bank-reconciliations','edit');
 if p_bank_account_id is null or p_bank_account_id<=0 or p_cutoff is null or not isfinite(p_cutoff)
  or p_statement_id is null or p_statement_id<=0 or p_expected_count is null or p_expected_count<1
  or p_expected_fingerprint is null or p_expected_fingerprint!~'^[0-9a-f]{64}$'then
  raise exception using errcode='PBU01',message='Vuelva a revisar los punteos antes de confirmar.';
 end if;
 perform reconciliation_private.bank_scope(p_bank_account_id,p_cutoff,true);
 if not exists(select 1 from public.bank_statement where statement_id=p_statement_id
  and bank_account_id=p_bank_account_id and statement_date=p_cutoff)then
  raise exception using errcode='PBU01',message='El extracto seleccionado cambió; vuelva a revisar.';
 end if;
 -- Bank -> owning headers -> links -> book sources -> statement -> its lines.
 perform 1 from public.bank_reconciliation r where r.reconciliation_id in(
  select m.reconciliation_id from public.bank_reconciliation_match m join public.bank_statement_line l using(statement_line_id)
  where l.statement_id=p_statement_id)and r.bank_account_id=p_bank_account_id order by r.reconciliation_id for update;
 perform 1 from public.bank_reconciliation_match m join public.bank_statement_line l using(statement_line_id)
  where l.statement_id=p_statement_id order by m.match_id for update of m;
 perform 1 from public.bank_transaction b where b.bank_account_id=p_bank_account_id and b.bank_tran_id in(
  select m.bank_tran_id from public.bank_reconciliation_match m join public.bank_statement_line l using(statement_line_id)
  where l.statement_id=p_statement_id)order by b.bank_tran_id for update;
 select * into statement_row from public.bank_statement where statement_id=p_statement_id
  and bank_account_id=p_bank_account_id and statement_date=p_cutoff for update;
 if not found then raise exception using errcode='PBU01',message='El extracto seleccionado cambió; vuelva a revisar.';end if;
 perform 1 from public.bank_statement_line l where l.statement_id=p_statement_id order by l.statement_line_id for update;
 select count(*)into statement_count from public.bank_statement where bank_account_id=p_bank_account_id and statement_date=p_cutoff;
 if statement_count<>1 then raise exception using errcode='PBU01',message='El extracto seleccionado es ambiguo; vuelva a revisar.';end if;
 snapshot:=reconciliation_private.unmatch_all_snapshot(p_bank_account_id,p_cutoff,p_statement_id);preview:=snapshot->'view';
 if preview->>'fingerprint'is distinct from p_expected_fingerprint or(preview->>'matchCount')::bigint<>p_expected_count
  or(preview->>'canUnmatch')::boolean is distinct from true then
  raise exception using errcode='PBU01',message='El conjunto de punteos cambió; vuelva a revisar antes de confirmar.';
 end if;
 actor:=public.resolve_audit_actor();
 for member in select value from jsonb_array_elements(snapshot->'members')loop
  match_key:=(member->'match'->>'match_id')::bigint;
  owner_cutoff:=(member->'reconciliation'->>'reconciliation_date')::date;
  perform public.unmatch_bank_reconciliation(p_bank_account_id,owner_cutoff,match_key);
  completed:=completed+1;
 end loop;
 if completed<>p_expected_count then raise exception using errcode='PBU01',message='El conjunto de punteos cambió; no se deshizo ninguno.';end if;
 select coalesce(jsonb_agg((value->'match'->>'match_id')::bigint),'[]'::jsonb)into results from jsonb_array_elements(snapshot->'members');
 perform public.record_system_event('BANK_RECONCILIATION_UNMATCH_ALL','bank-reconciliation',
  'Punteos de un extracto bancario deshechos en una operación atómica.','EXITOSA',jsonb_build_object(
   'actor',actor,'userId',public.app_user_id(),'bankAccountId',p_bank_account_id,'cutoff',p_cutoff,
   'statementId',p_statement_id,'groups',preview->'groups','fingerprint',p_expected_fingerprint,
   'matchIds',results,'unmatchedCount',completed));
 return jsonb_build_object('success',true,'scope','BANK_STATEMENT','bankAccountId',p_bank_account_id,
  'cutoff',p_cutoff,'statementId',p_statement_id,'fingerprint',p_expected_fingerprint,'unmatchedCount',completed,'matchIds',results);
end$$;
revoke all on function reconciliation_private.unmatch_all_snapshot(bigint,date,bigint)from public,anon,authenticated,service_role;
revoke all on function public.preview_bank_reconciliation_unmatch_all(bigint,date),public.unmatch_all_bank_reconciliation(bigint,date,bigint,text,integer)from public,anon,authenticated,service_role;
grant execute on function public.preview_bank_reconciliation_unmatch_all(bigint,date),public.unmatch_all_bank_reconciliation(bigint,date,bigint,text,integer)to authenticated;
-- Private integration fragment: add only a selected-bank-statement capability
-- hint to the guarded report wrapper. Preview/confirm remain authoritative.
do $bulk_unmatch_report_capability$
declare definition text;needle text;replacement text;begin
 if(select md5(prosrc)from pg_proc where oid=to_regprocedure('public.run_bank_reconciliation_report(jsonb)'))
  is distinct from '89c3297fff9243169a166943955cabd0'then
  raise exception 'Unexpected reviewed classic report source before bulk capability';
 end if;
 definition:=pg_get_functiondef('public.run_bank_reconciliation_report(jsonb)'::regprocedure);
 needle:='select report_source.payload||jsonb_build_object(';
 if(length(definition)-length(replace(definition,needle,'')))/length(needle)<>1 then
  raise exception 'Missing unique bulk capability report boundary';
 end if;
 replacement:=$capability$select report_source.payload||jsonb_build_object(
   'canUnmatchAll',(select coalesce(p.can_edit and(
    select count(*)=1 and coalesce(bool_and(
     (c.classic_date is null or c.classic_date<s.statement_date)
     and(c.quadratic_date is null or c.quadratic_date<s.statement_date)),false)
    from public.bank_statement s
    where s.bank_account_id=p.bank_id
     and s.statement_date=nullif(p_filters->>'dateTo','')::date
   ),false)from params p cross join closed_after c),$capability$;
 execute replace(definition,needle,replacement);
end$bulk_unmatch_report_capability$;

notify pgrst,'reload schema';
