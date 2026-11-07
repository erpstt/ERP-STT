-- Add one controlled inverse of a classic match. No historical DML, no
-- changes to existing writers, source guards, financial amounts or table ACLs.
do $$declare item record;begin
 for item in select * from(values
  ('reconciliation_private.access(text,text)','db49a13764d60473eb083ed784e76786'),
  ('reconciliation_private.bank_scope(bigint,date,boolean)','dea2f3c05681394fad5cf646ed4bde79'),
  ('reconciliation_private.protect_sources()','f02c37fc3475482de15a710a7c96df50'),
  ('public.capture_row_audit()','8773839fa0f03e93c4cbd39fb38f1d24'),
  ('public.record_system_event(text,text,text,text,jsonb)','0caee715abdf2beeb35eacad18878339'),
  ('public.resolve_audit_actor()','f61dcd48ae93e52ebe25664a6c122c3b')
 )v(signature,source_md5)loop
  if not exists(select 1 from pg_proc where oid=to_regprocedure(item.signature)and md5(prosrc)=item.source_md5)then
   raise exception 'Unexpected classic-unmatch dependency: %',item.signature;
  end if;
 end loop;
 for item in select unnest(array['bank_transaction','bank_statement_line','bank_reconciliation_match'])name loop
  if not exists(select 1 from pg_trigger where tgrelid=('public.'||item.name)::regclass
   and tgfoid='public.capture_row_audit()'::regprocedure and tgenabled in('O','A')and not tgisinternal)
   or not exists(select 1 from pg_trigger where tgrelid=('public.'||item.name)::regclass
   and tgfoid='reconciliation_private.protect_sources()'::regprocedure and tgenabled in('O','A')and not tgisinternal)then
   raise exception 'Missing current audit/source protection for %',item.name;
  end if;
 end loop;
 if to_regprocedure('public.unmatch_bank_reconciliation(bigint,date,bigint)')is not null then
  raise exception 'Classic-unmatch RPC already exists';
 end if;
end$$;

create function public.unmatch_bank_reconciliation(p_bank_account_id bigint,p_cutoff date,p_match_id bigint)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$
declare
 sid bigint;rec_key bigint;statement_key bigint;affected integer;
 rec public.bank_reconciliation;matched public.bank_reconciliation_match;
 book public.bank_transaction;line public.bank_statement_line;statement_row public.bank_statement;
 actor jsonb;before_book jsonb;before_line jsonb;after_book jsonb;after_line jsonb;
begin
 sid:=reconciliation_private.access('banking:bank-reconciliations','edit');
 if p_bank_account_id is null or p_bank_account_id<=0 or p_match_id is null or p_match_id<=0
  or p_cutoff is null or not isfinite(p_cutoff)then
  raise exception using errcode='22023',message='Indique cuenta, fecha y punteo válidos.';
 end if;
 -- The account lock serializes this operation with current matching, source
 -- writers and approved/closed-period guards. It is acquired before row locks.
 perform reconciliation_private.bank_scope(p_bank_account_id,p_cutoff,true);
 select m.reconciliation_id into rec_key from public.bank_reconciliation_match m
  join public.bank_reconciliation r using(reconciliation_id)
  where m.match_id=p_match_id and r.bank_account_id=p_bank_account_id and r.reconciliation_date=p_cutoff;
 if rec_key is null then
  raise exception using errcode='PBU01',message='El punteo ya no está disponible en la cuenta y fecha seleccionadas.';
 end if;
 select * into rec from public.bank_reconciliation where reconciliation_id=rec_key for update;
 if not found or rec.bank_account_id<>p_bank_account_id or rec.reconciliation_date<>p_cutoff or rec.status<>'ABIERTA'or rec.closed_at is not null then
  raise exception using errcode='PBU01',message='El punteo no pertenece a una conciliación abierta vigente.';
 end if;
 select * into matched from public.bank_reconciliation_match where match_id=p_match_id for update;
 if not found or matched.reconciliation_id<>rec.reconciliation_id then
  raise exception using errcode='PBU01',message='El punteo cambió; actualice la conciliación.';
 end if;
 -- Lock sources in a fixed table order. Resolve the statement header before
 -- locking its line, matching the existing statement writer's order.
 select * into book from public.bank_transaction where bank_tran_id=matched.bank_tran_id for update;
 if not found then raise exception using errcode='PBU01',message='El movimiento del punteo ya no está disponible.';end if;
 select statement_id into statement_key from public.bank_statement_line where statement_line_id=matched.statement_line_id;
 select * into statement_row from public.bank_statement where statement_id=statement_key for update;
 if not found then raise exception using errcode='PBU01',message='El extracto del punteo ya no está disponible.';end if;
 select * into line from public.bank_statement_line where statement_line_id=matched.statement_line_id for update;
 if not found or line.statement_id<>statement_row.statement_id
  or book.bank_account_id<>p_bank_account_id or statement_row.bank_account_id<>p_bank_account_id
  or book.tran_date>p_cutoff or line.bank_date>p_cutoff or statement_row.statement_date>p_cutoff
  or book.reconciliation_status<>'CONCILIADO'or line.reconciliation_status<>'CONCILIADO'
  or book.tran_type='SALDO_INICIAL'
  or not reconciliation_private.finite(book.amount)or not reconciliation_private.finite(line.amount)
  or abs(book.amount-line.amount)>=.005 then
  raise exception using errcode='PBU01',message='Las fuentes del punteo cambiaron; actualice la conciliación.';
 end if;
 if book.transaction_id is not null and(not exists(select 1 from public."transaction" t
   where t.transaction_id=book.transaction_id and t.subsidiary_id=sid)
   or exists(select 1 from public.journal j where j.transaction_id=book.transaction_id and j.subsidiary_id is distinct from sid))then
  raise exception using errcode='PBU01',message='La trazabilidad del movimiento no corresponde a la subsidiaria activa.';
 end if;
 perform 1 from public.bank_reconciliation_match m where m.bank_tran_id=book.bank_tran_id
  or m.statement_line_id=line.statement_line_id order by m.match_id for update;
 if(select count(*)from public.bank_reconciliation_match where bank_tran_id=book.bank_tran_id)<>1
  or(select count(*)from public.bank_reconciliation_match where statement_line_id=line.statement_line_id)<>1
  or exists(select 1 from public.quadratic_reconciliation_matches q where q.bank_tran_id=book.bank_tran_id or q.statement_line_id=line.statement_line_id)
  or exists(select 1 from public.quadratic_reconciliation_items q where q.bank_tran_id=book.bank_tran_id or q.statement_line_id=line.statement_line_id)then
  raise exception using errcode='PBU01',message='Las fuentes tienen otros vínculos de conciliación y no se pueden liberar.';
 end if;
 -- A source can predate its owning reconciliation; retain its earlier closed
 -- period protection as well as the owning cutoff's protection.
 perform reconciliation_private.bank_scope(p_bank_account_id,least(p_cutoff,book.tran_date,statement_row.statement_date),true);
 -- Audit provenance is authoritative; no caller-provided actor/snapshot is used.
 actor:=public.resolve_audit_actor();before_book:=to_jsonb(book);before_line:=to_jsonb(line);
 delete from public.bank_reconciliation_match where match_id=matched.match_id and reconciliation_id=rec.reconciliation_id;
 get diagnostics affected=row_count;
 if affected<>1 then raise exception using errcode='PBU01',message='El punteo cambió; actualice la conciliación.';end if;
 update public.bank_transaction set reconciliation_status='PENDIENTE_EN_TRANSITO'
  where bank_tran_id=book.bank_tran_id and reconciliation_status='CONCILIADO'returning to_jsonb(bank_transaction)into after_book;
 get diagnostics affected=row_count;
 if affected<>1 then raise exception using errcode='PBU01',message='El movimiento cambió; actualice la conciliación.';end if;
 update public.bank_statement_line set reconciliation_status='PENDIENTE'
  where statement_line_id=line.statement_line_id and reconciliation_status='CONCILIADO'returning to_jsonb(bank_statement_line)into after_line;
 get diagnostics affected=row_count;
 if affected<>1 then raise exception using errcode='PBU01',message='La línea cambió; actualice la conciliación.';end if;
 perform public.record_system_event('BANK_RECONCILIATION_UNMATCH','bank-reconciliation',
  'Punteo clásico deshecho por un usuario autorizado.','EXITOSA',jsonb_build_object(
   'actor',actor,'userId',public.app_user_id(),'subsidiaryId',sid,'bankAccountId',p_bank_account_id,'cutoff',p_cutoff,
   'reconciliation',to_jsonb(rec),'statement',to_jsonb(statement_row),'match',to_jsonb(matched),
   'before',jsonb_build_object('bankTransaction',before_book,'statementLine',before_line),
   'after',jsonb_build_object('bankTransaction',after_book,'statementLine',after_line)));
 return jsonb_build_object('success',true,'bankAccountId',p_bank_account_id,'cutoff',p_cutoff,
  'matchId',matched.match_id,'reconciliationId',rec.reconciliation_id,'bankTransactionId',book.bank_tran_id,
  'statementId',statement_row.statement_id,'statementLineId',line.statement_line_id);
end$$;
revoke all on function public.unmatch_bank_reconciliation(bigint,date,bigint)from public,anon,authenticated,service_role;
grant execute on function public.unmatch_bank_reconciliation(bigint,date,bigint)to authenticated;
-- Private handoff fragment. Integrate into the reviewed unmatch migration; do not apply alone.
-- Preserve every existing public wrapper guard, signature, owner, ACL and configuration.
do $patch_classic_projection$
declare definition text;needle text;replacement text;begin
 definition:=pg_get_functiondef('public.run_bank_reconciliation_report(jsonb)'::regprocedure);
 if md5(definition)<>'ffc761494d4d0cb716a268a67a33416c' then
  raise exception 'Unexpected reviewed classic reconciliation report wrapper';
 end if;
 needle:='return reconciliation_private.run_bank_reconciliation_report(p_filters);';
 if(length(definition)-length(replace(definition,needle,'')))/length(needle)<>1 then
  raise exception 'Missing unique classic reconciliation report projection boundary';
 end if;
 replacement:=$projection$return (
  with report_source as materialized(
   select reconciliation_private.run_bank_reconciliation_report(p_filters) payload
  ),params as materialized(
   select nullif(p_filters->>'bankAccountId','')::bigint bank_id,public.active_subsidiary_id() subsidiary_id,
    reconciliation_private.allowed('banking:bank-reconciliations','edit') can_edit
  ),erp_rows as materialized(
   select value payload,ordinality position from report_source,
    jsonb_array_elements(payload->'rows')with ordinality
  ),statement_rows as materialized(
   select value payload,ordinality position from report_source,
    jsonb_array_elements(payload->'statementLines')with ordinality
  ),closed_after as materialized(
   select
    (select max(r.reconciliation_date)from public.bank_reconciliation r,params p
     where r.bank_account_id=p.bank_id and r.status='CERRADA') classic_date,
    (select max((make_date(q.period_year,q.period_month,1)+interval'1 month'-interval'1 day')::date)
     from public.quadratic_bank_reconciliations q,params p
     where q.bank_account_id=p.bank_id and q.status in('approved','closed')) quadratic_date
  ),matched_sources as materialized(
   select m.match_id,m.bank_tran_id,m.statement_line_id,bt.transaction_id,r.reconciliation_id,
    r.reconciliation_date reconciliation_cutoff,
    coalesce(p.can_edit and r.status='ABIERTA'and r.closed_at is null
     and bt.reconciliation_status='CONCILIADO'and sl.reconciliation_status='CONCILIADO'
     and bt.tran_type<>'SALDO_INICIAL'
     and bt.tran_date<=r.reconciliation_date and sl.bank_date<=r.reconciliation_date
     and st.statement_date<=r.reconciliation_date
     and reconciliation_private.finite(bt.amount)and reconciliation_private.finite(sl.amount)
     and abs(bt.amount-sl.amount)<.005
     and(bt.transaction_id is null or t.transaction_id is not null and t.subsidiary_id=p.subsidiary_id)
     and(c.classic_date is null or c.classic_date<least(r.reconciliation_date,bt.tran_date,st.statement_date))
     and(c.quadratic_date is null or c.quadratic_date<least(r.reconciliation_date,bt.tran_date,st.statement_date)),false) eligible
   from public.bank_reconciliation_match m
   join public.bank_reconciliation r on r.reconciliation_id=m.reconciliation_id
   join public.bank_transaction bt on bt.bank_tran_id=m.bank_tran_id
   left join public."transaction" t on t.transaction_id=bt.transaction_id
   join public.bank_statement_line sl on sl.statement_line_id=m.statement_line_id
   join public.bank_statement st on st.statement_id=sl.statement_id
   cross join params p cross join closed_after c
   where r.bank_account_id=p.bank_id and bt.bank_account_id=p.bank_id and st.bank_account_id=p.bank_id
    and(m.bank_tran_id in(select nullif(payload->>'id','')::bigint from erp_rows)
     or m.statement_line_id in(select nullif(payload->>'statement_line_id','')::bigint from statement_rows))
  ),foreign_journal_references as materialized(
   select distinct m.match_id from matched_sources m join public.journal j on j.transaction_id=m.transaction_id
    cross join params p where j.subsidiary_id is distinct from p.subsidiary_id
  ),quadratic_references as materialized(
   select m.match_id from matched_sources m join public.quadratic_reconciliation_matches q
    on q.bank_tran_id=m.bank_tran_id or q.statement_line_id=m.statement_line_id
   union
   select m.match_id from matched_sources m join public.quadratic_reconciliation_items q
    on q.bank_tran_id=m.bank_tran_id or q.statement_line_id=m.statement_line_id
  ),classic_conflicts as materialized(
   select distinct m.match_id from matched_sources m join public.bank_reconciliation_match other
    on other.match_id<>m.match_id and(other.bank_tran_id=m.bank_tran_id or other.statement_line_id=m.statement_line_id)
  ),erp_metadata as(
   select m.bank_tran_id,
    case when count(*)=1 then min(m.match_id)end match_id,
    case when count(*)=1 then min(m.reconciliation_id)end reconciliation_id,
    case when count(*)=1 then min(m.reconciliation_cutoff)end reconciliation_cutoff,
    count(*)=1 and bool_and(m.eligible and q.match_id is null and x.match_id is null and j.match_id is null)can_unmatch
   from matched_sources m left join quadratic_references q using(match_id)left join classic_conflicts x using(match_id)
    left join foreign_journal_references j using(match_id)
   group by m.bank_tran_id
  ),statement_metadata as(
   select m.statement_line_id,
    case when count(*)=1 then min(m.match_id)end match_id,
    case when count(*)=1 then min(m.reconciliation_id)end reconciliation_id,
    case when count(*)=1 then min(m.reconciliation_cutoff)end reconciliation_cutoff,
    count(*)=1 and bool_and(m.eligible and q.match_id is null and x.match_id is null and j.match_id is null)can_unmatch
   from matched_sources m left join quadratic_references q using(match_id)left join classic_conflicts x using(match_id)
    left join foreign_journal_references j using(match_id)
   group by m.statement_line_id
  )
  select report_source.payload||jsonb_build_object(
   'rows',coalesce((select jsonb_agg(v.payload||jsonb_build_object(
    'match_id',m.match_id,'reconciliation_id',m.reconciliation_id,
    'reconciliation_cutoff',m.reconciliation_cutoff,'can_unmatch',coalesce(m.can_unmatch,false))order by v.position)
    from erp_rows v left join erp_metadata m on m.bank_tran_id=nullif(v.payload->>'id','')::bigint),'[]'::jsonb),
   'statementLines',coalesce((select jsonb_agg(v.payload||jsonb_build_object(
    'match_id',m.match_id,'reconciliation_id',m.reconciliation_id,
    'reconciliation_cutoff',m.reconciliation_cutoff,'can_unmatch',coalesce(m.can_unmatch,false))order by v.position)
    from statement_rows v left join statement_metadata m on m.statement_line_id=nullif(v.payload->>'statement_line_id','')::bigint),'[]'::jsonb)
  )from report_source
 );$projection$;
 execute replace(definition,needle,replacement);
end$patch_classic_projection$;

notify pgrst,'reload schema';
