-- Delete only an exact, open and empty classic reconciliation header.
-- Existing financial writers, matches, sources, table ACLs and guards stay intact.
set local lock_timeout='5s';set local statement_timeout='60s';

do $guard$declare item record;begin
 for item in select *from(values
  ('public.bank_reconciliation_options()','1a88017f9a9e994e4e4e574a33fe8628'),
  ('reconciliation_private.bank_reconciliation_options()','e10722072e58391d995cad3cd618deda'),
  ('reconciliation_private.access(text,text)','db49a13764d60473eb083ed784e76786'),
  ('reconciliation_private.allowed(text,text)','927712f39f6253a97bfe95b32d942fa2'),
  ('reconciliation_private.bank_scope(bigint,date,boolean)','dea2f3c05681394fad5cf646ed4bde79'),
  ('reconciliation_private.protect_sources()','f02c37fc3475482de15a710a7c96df50'),
  ('public.capture_row_audit()','8773839fa0f03e93c4cbd39fb38f1d24'),
  ('public.resolve_audit_actor()','f61dcd48ae93e52ebe25664a6c122c3b'),
  ('public.record_system_event(text,text,text,text,jsonb)','0caee715abdf2beeb35eacad18878339')
 )v(signature,source_md5)loop
  if not exists(select 1 from pg_proc where oid=to_regprocedure(item.signature)and md5(prosrc)=item.source_md5)then
   raise exception 'Unexpected classic draft-delete dependency: %',item.signature;
  end if;
 end loop;
 if not exists(select 1 from pg_trigger where tgrelid='public.bank_reconciliation'::regclass
   and tgfoid='public.capture_row_audit()'::regprocedure and tgenabled in('O','A')and not tgisinternal)
  or not exists(select 1 from pg_trigger where tgrelid='public.bank_reconciliation'::regclass
   and tgfoid='reconciliation_private.protect_sources()'::regprocedure and tgenabled in('O','A')and not tgisinternal)then
  raise exception 'Missing current classic reconciliation header audit/source protection';
 end if;
 if to_regprocedure('reconciliation_private.draft_delete_snapshot(bigint,date,bigint)')is not null
  or to_regprocedure('reconciliation_private.annotate_draft_delete_options(jsonb)')is not null
  or to_regprocedure('public.preview_bank_reconciliation_draft_delete(bigint,date,bigint)')is not null
  or to_regprocedure('public.delete_bank_reconciliation_draft(bigint,date,bigint,text)')is not null then
  raise exception 'Classic draft-delete capability already exists';
 end if;
end$guard$;

create function reconciliation_private.draft_delete_snapshot(p_bank_account_id bigint,p_cutoff date,p_reconciliation_id bigint)
returns jsonb language plpgsql volatile security invoker set search_path=pg_catalog,public,pg_temp as $$
declare
 sid bigint;rec public.bank_reconciliation;period public.fiscal_periods;header_version text;
 context jsonb;bank_identity jsonb;members jsonb;windows jsonb;foreign_keys jsonb;fingerprint text;
 match_count bigint;foreign_key_count bigint;known_foreign_key boolean;protection_available boolean;reason text;
begin
 sid:=reconciliation_private.access('banking:bank-reconciliations','delete');
 perform reconciliation_private.access('reports:accounting-reports','view');
 if not exists(select 1 from public.users where user_id=public.app_user_id()and is_active)
  or not exists(select 1 from public.user_subsidiaries where user_id=public.app_user_id()and subsidiary_id=sid)then
  raise exception using errcode='42501',message='Seleccione un usuario y una subsidiaria autorizados.';
 end if;
 if p_bank_account_id is null or p_bank_account_id<=0 or p_reconciliation_id is null or p_reconciliation_id<=0
  or p_cutoff is null or not isfinite(p_cutoff)then
  raise exception using errcode='22023',message='Indique cuenta, fecha y borrador válidos.';
 end if;
 perform reconciliation_private.bank_scope(p_bank_account_id);
 context:=jsonb_build_object('userId',public.app_user_id(),'roleId',public.app_active_role_id(),
  'subsidiaryId',sid,'sessionId',public.app_session_id());
 if nullif(context->>'sessionId','')is null then raise exception using errcode='42501',message='Seleccione una sesión autorizada.';end if;
 select r.*into rec from public.bank_reconciliation r
  where r.reconciliation_id=p_reconciliation_id and r.bank_account_id=p_bank_account_id and r.reconciliation_date=p_cutoff;
 if rec.reconciliation_id is null then
  raise exception using errcode='PBD01',message='El borrador cambió o ya no está disponible; actualice el historial.';
 end if;
 select xmin::text into header_version from public.bank_reconciliation where reconciliation_id=rec.reconciliation_id;
 select *into period from public.fiscal_periods where fiscal_period_id=rec.fiscal_period_id and subsidiary_id=sid;
 select jsonb_build_object('bankAccountId',b.bank_account_id,'subsidiaryId',b.subsidiary_id,'bankId',b.bank_id,
  'accountNumber',b.account_number,'bankName',n.bank_name,'currencyId',b.currency_id,'currencyCode',c.currency_code)
 into bank_identity from public.bank_account b join public.banks n using(bank_id)join public.currencies c using(currency_id)
 where b.bank_account_id=p_bank_account_id and b.subsidiary_id=sid;
 select count(*),coalesce(jsonb_agg(m.match_id order by m.match_id),'[]'::jsonb)into match_count,members
  from public.bank_reconciliation_match m where m.reconciliation_id=rec.reconciliation_id;
 select jsonb_build_object('classic',coalesce((select jsonb_agg(jsonb_build_array(r.reconciliation_id,r.reconciliation_date,r.status)order by r.reconciliation_id)
   from public.bank_reconciliation r where r.bank_account_id=p_bank_account_id and r.status='CERRADA'and r.reconciliation_date>=p_cutoff),'[]'::jsonb),
  'quadratic',coalesce((select jsonb_agg(jsonb_build_array(q.reconciliation_id,q.period_year,q.period_month,q.status)order by q.reconciliation_id)
   from public.quadratic_bank_reconciliations q where q.bank_account_id=p_bank_account_id and q.status in('approved','closed')
    and(make_date(q.period_year,q.period_month,1)+interval'1 month'-interval'1 day')::date>=p_cutoff),'[]'::jsonb))into windows;
 -- Whitelist the only deployed child relation. Do not permit a future cascade
 -- to delete data silently, or lose the FK key lock that serializes inserts.
 select count(*),coalesce(bool_and(c.conrelid='public.bank_reconciliation_match'::regclass
   and c.conkey=array[(select attnum from pg_attribute where attrelid='public.bank_reconciliation_match'::regclass and attname='reconciliation_id')]::smallint[]
   and c.confkey=array[(select attnum from pg_attribute where attrelid='public.bank_reconciliation'::regclass and attname='reconciliation_id')]::smallint[]
   and c.confdeltype='c'and c.convalidated and not c.condeferrable),false),
  coalesce(jsonb_agg(jsonb_build_object('table',c.conrelid::regclass::text,'name',c.conname,'definition',pg_get_constraintdef(c.oid),'validated',c.convalidated)order by c.oid),'[]'::jsonb)
 into foreign_key_count,known_foreign_key,foreign_keys from pg_constraint c
 where c.contype='f'and c.confrelid='public.bank_reconciliation'::regclass;
 protection_available:=exists(select 1 from pg_trigger where tgrelid='public.bank_reconciliation'::regclass
   and tgfoid='public.capture_row_audit()'::regprocedure and tgenabled in('O','A')and not tgisinternal)
  and exists(select 1 from pg_trigger where tgrelid='public.bank_reconciliation'::regclass
   and tgfoid='reconciliation_private.protect_sources()'::regprocedure and tgenabled in('O','A')and not tgisinternal);
 reason:=case
  when rec.status<>'ABIERTA'or rec.closed_at is not null or rec.closed_by is not null then 'NOT_OPEN'
  when period.fiscal_period_id is null or p_cutoff not between period.start_date and period.end_date then 'INVALID_PERIOD'
  when period.is_closed or period.is_inactive then 'PERIOD_PROTECTED'
  when bank_identity is null then 'INVALID_BANK'
  when jsonb_array_length(windows->'classic')>0 or jsonb_array_length(windows->'quadratic')>0 then 'PROTECTED_WINDOW'
  when match_count<>0 then 'HAS_MATCHES'
  when rec.book_balance is not null or rec.statement_balance is not null or rec.difference is not null
   or rec.transit_payments is null or rec.transit_payments<>0 or rec.transit_deposits is null or rec.transit_deposits<>0
   or rec.bank_adjustments is null or rec.bank_adjustments<>0 then 'NOT_EMPTY'
  when foreign_key_count<>1 or not known_foreign_key then 'UNSUPPORTED_REFERENCES'
  when not protection_available then 'AUDIT_PROTECTION_UNAVAILABLE'
  else null end;
 -- xmin detects header ABA changes. Actor execution IDs and clocks never enter
 -- this state proof; reading options or renewing the technical lease is stable.
 fingerprint:=encode(sha256(convert_to(jsonb_build_object('context',context,'header',to_jsonb(rec),'headerVersion',header_version,
  'period',to_jsonb(period),'bank',bank_identity,'matches',members,'windows',windows,'foreignKeys',foreign_keys,
  'auditProtectionAvailable',protection_available,'blockedReason',reason)::text,'UTF8')),'hex');
 return jsonb_build_object('reconciliationId',rec.reconciliation_id,'bankAccountId',p_bank_account_id,'cutoff',p_cutoff,
  'fiscalPeriodId',rec.fiscal_period_id,'subsidiaryId',sid,'status',rec.status,'matchCount',match_count,
  'bankName',bank_identity->>'bankName','accountNumber',bank_identity->>'accountNumber','currencyCode',bank_identity->>'currencyCode',
  'periodName',period.period_name,'canDelete',reason is null,'blockedReason',reason,'fingerprint',fingerprint);
end$$;

create function reconciliation_private.annotate_draft_delete_options(p_options jsonb)
returns jsonb language plpgsql stable security invoker set search_path=pg_catalog,public,pg_temp as $$
declare item jsonb;items jsonb:='[]'::jsonb;snapshot jsonb;can_delete boolean;permitted boolean;actions jsonb;
begin
 permitted:=reconciliation_private.allowed('banking:bank-reconciliations','delete')
  and reconciliation_private.allowed('reports:accounting-reports','view');
 if jsonb_typeof(p_options->'reconciliations')is distinct from 'array'then
  raise exception using errcode='22023',message='El historial de conciliación no está disponible.';
 end if;
 for item in select value from jsonb_array_elements(p_options->'reconciliations')loop
  can_delete:=false;
  if permitted then
   begin
    snapshot:=reconciliation_private.draft_delete_snapshot((item->>'bankAccountId')::bigint,(item->>'date')::date,(item->>'id')::bigint);
    can_delete:=coalesce((snapshot->>'canDelete')::boolean,false);
   exception when insufficient_privilege or sqlstate 'PBD01'then can_delete:=false;
   end;
  end if;
  actions:=case when jsonb_typeof(item->'_actions')='object'then item->'_actions'else '{}'::jsonb end;
  items:=items||jsonb_build_array(item||jsonb_build_object('_actions',actions||jsonb_build_object('canDeleteDraft',can_delete)));
 end loop;
 return jsonb_set(p_options,'{reconciliations}',items,false);
end$$;

create function public.preview_bank_reconciliation_draft_delete(p_bank_account_id bigint,p_cutoff date,p_reconciliation_id bigint)
returns jsonb language sql stable security definer set search_path=pg_catalog,public,pg_temp as $$
 select reconciliation_private.draft_delete_snapshot(p_bank_account_id,p_cutoff,p_reconciliation_id)
$$;

create function public.delete_bank_reconciliation_draft(p_bank_account_id bigint,p_cutoff date,p_reconciliation_id bigint,p_expected_fingerprint text)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public,pg_temp set lock_timeout='5s' as $$
declare sid bigint;rec public.bank_reconciliation;snapshot jsonb;actor jsonb;affected integer;
begin
 sid:=reconciliation_private.access('banking:bank-reconciliations','delete');
 perform reconciliation_private.access('reports:accounting-reports','view');
 if not exists(select 1 from public.users where user_id=public.app_user_id()and is_active)
  or not exists(select 1 from public.user_subsidiaries where user_id=public.app_user_id()and subsidiary_id=sid)then
  raise exception using errcode='42501',message='Seleccione un usuario y una subsidiaria autorizados.';
 end if;
 if p_bank_account_id is null or p_bank_account_id<=0 or p_reconciliation_id is null or p_reconciliation_id<=0
  or p_cutoff is null or not isfinite(p_cutoff)or p_expected_fingerprint is null or p_expected_fingerprint!~'^[0-9a-f]{64}$'then
  raise exception using errcode='22023',message='Revise el borrador antes de eliminarlo.';
 end if;
 -- Same published bank-row mutex as match/import/close; do not introduce an
 -- unrelated advisory lock. Then lock the exact parent and its fiscal period.
 perform reconciliation_private.bank_scope(p_bank_account_id,p_cutoff,true);
 -- Acquire the DELETE relation lock before inspecting FK metadata, closing
 -- the DDL window for a newly added cascading child. Ordinary DML stays allowed.
 lock table public.bank_reconciliation in row exclusive mode;
 select *into rec from public.bank_reconciliation where reconciliation_id=p_reconciliation_id
  and bank_account_id=p_bank_account_id and reconciliation_date=p_cutoff for update;
 if not found then raise exception using errcode='PBD01',message='El borrador cambió o ya no está disponible; actualice el historial.';end if;
 perform 1 from public.fiscal_periods where fiscal_period_id=rec.fiscal_period_id and subsidiary_id=sid for share;
 snapshot:=reconciliation_private.draft_delete_snapshot(p_bank_account_id,p_cutoff,p_reconciliation_id);
 if snapshot->>'fingerprint'is distinct from p_expected_fingerprint or not coalesce((snapshot->>'canDelete')::boolean,false)then
  raise exception using errcode='PBD01',message='El borrador cambió o está protegido; revíselo de nuevo antes de eliminar.';
 end if;
 actor:=public.resolve_audit_actor();
 -- No child DELETE, no amount/status update, and no statement/source removal.
 -- FOR UPDATE on this parent conflicts with FK key locks for new matches.
 delete from public.bank_reconciliation where reconciliation_id=rec.reconciliation_id
  and bank_account_id=p_bank_account_id and reconciliation_date=p_cutoff and fiscal_period_id=rec.fiscal_period_id and status='ABIERTA'
  and closed_at is null and closed_by is null and book_balance is null and statement_balance is null and difference is null
  and transit_payments=0 and transit_deposits=0 and bank_adjustments=0
  and not exists(select 1 from public.bank_reconciliation_match m where m.reconciliation_id=rec.reconciliation_id)
  and exists(select 1 from public.fiscal_periods p where p.fiscal_period_id=rec.fiscal_period_id and p.subsidiary_id=sid
   and not p.is_closed and not coalesce(p.is_inactive,false)and p_cutoff between p.start_date and p.end_date)
  and not exists(select 1 from public.bank_reconciliation r where r.bank_account_id=p_bank_account_id and r.status='CERRADA'and r.reconciliation_date>=p_cutoff)
  and not exists(select 1 from public.quadratic_bank_reconciliations q where q.bank_account_id=p_bank_account_id and q.status in('approved','closed')
   and(make_date(q.period_year,q.period_month,1)+interval'1 month'-interval'1 day')::date>=p_cutoff);
 get diagnostics affected=row_count;
 if affected<>1 then raise exception using errcode='PBD01',message='El borrador cambió; actualice el historial.';end if;
 perform public.record_system_event('BANK_RECONCILIATION_DRAFT_DELETE','bank-reconciliation',
  'Borrador clásico vacío eliminado por un usuario autorizado.','EXITOSA',jsonb_build_object(
   'actor',actor,'userId',public.app_user_id(),'subsidiaryId',sid,'bankAccountId',p_bank_account_id,'cutoff',p_cutoff,
   'reconciliationId',rec.reconciliation_id,'fiscalPeriodId',rec.fiscal_period_id,'before',to_jsonb(rec),
   'previewFingerprint',p_expected_fingerprint));
 return jsonb_build_object('success',true,'deleted',true,'bankAccountId',p_bank_account_id,'cutoff',p_cutoff,
  'reconciliationId',rec.reconciliation_id,'fiscalPeriodId',rec.fiscal_period_id);
end$$;

revoke all on function reconciliation_private.draft_delete_snapshot(bigint,date,bigint),
 reconciliation_private.annotate_draft_delete_options(jsonb)from public,anon,authenticated,service_role;
revoke all on function public.preview_bank_reconciliation_draft_delete(bigint,date,bigint),
 public.delete_bank_reconciliation_draft(bigint,date,bigint,text)from public,anon,authenticated,service_role;
grant execute on function public.preview_bank_reconciliation_draft_delete(bigint,date,bigint),
 public.delete_bank_reconciliation_draft(bigint,date,bigint,text)to authenticated;

do $patch$declare definition text;needle text:='return reconciliation_private.bank_reconciliation_options();';begin
 definition:=pg_get_functiondef('public.bank_reconciliation_options()'::regprocedure);
 if md5((select prosrc from pg_proc where oid='public.bank_reconciliation_options()'::regprocedure))<>'1a88017f9a9e994e4e4e574a33fe8628'
  or(length(definition)-length(replace(definition,needle,'')))/length(needle)<>1 then
  raise exception 'Unexpected classic reconciliation options annotation boundary';
 end if;
 execute replace(definition,needle,'return reconciliation_private.annotate_draft_delete_options(reconciliation_private.bank_reconciliation_options());');
end$patch$;
notify pgrst,'reload schema';
