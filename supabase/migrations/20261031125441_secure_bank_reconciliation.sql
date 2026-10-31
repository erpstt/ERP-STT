-- C-04: classic reconciliation, quadratic proof and statement lifecycle.
set local lock_timeout='5s';set local statement_timeout='60s';
create schema reconciliation_private;
revoke all on schema reconciliation_private from public,anon,authenticated,service_role;
grant usage on schema reconciliation_private to authenticated;

create function reconciliation_private.identity() returns bigint language plpgsql stable security definer set search_path=pg_catalog,public,pg_temp as $$
declare sid bigint:=public.active_subsidiary_id();
begin if auth.uid() is null or public.app_user_id() is null or public.app_active_role_id() is null or sid is null then raise exception using errcode='42501',message='Seleccione usuario, rol y subsidiaria autorizados.';end if;return sid;end$$;
create function reconciliation_private.access(p_resource text,p_action text) returns bigint language plpgsql stable security definer set search_path=pg_catalog,public,pg_temp as $$
declare sid bigint:=reconciliation_private.identity();begin perform public.security_assert_role_access(p_resource,p_action);return sid;end$$;
create function reconciliation_private.allowed(p_resource text,p_action text) returns boolean language plpgsql stable security definer set search_path=pg_catalog,public,pg_temp as $$
begin perform reconciliation_private.access(p_resource,p_action);return true;exception when insufficient_privilege then return false;end$$;
create function reconciliation_private.finite(p_value numeric) returns boolean language sql immutable set search_path=pg_catalog as $$select p_value is not null and p_value::text not in('NaN','Infinity','-Infinity')$$;
create function reconciliation_private.numbers(p_payload jsonb,p_fields text[]) returns void language plpgsql immutable set search_path=pg_catalog,public,pg_temp as $$
declare field text;begin foreach field in array p_fields loop if p_payload?field and not reconciliation_private.finite((p_payload->>field)::numeric) then raise exception using errcode='22023',message='Los importes deben ser finitos.';end if;end loop;end$$;

create function reconciliation_private.bank_scope(p_bank bigint,p_date date default null,p_write boolean default false) returns bigint language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$
declare sid bigint:=reconciliation_private.identity();
begin
 if not exists(select 1 from public.bank_account b where b.bank_account_id=p_bank and b.subsidiary_id=sid) then raise exception using errcode='42501',message='La cuenta no está disponible en la subsidiaria activa.';end if;
 if p_write then
  if p_date is null then raise exception using errcode='22023',message='Indique fecha de conciliación.';end if;
  perform 1 from public.bank_account b where b.bank_account_id=p_bank and b.subsidiary_id=sid for update;
  if exists(select 1 from public.bank_reconciliation r where r.bank_account_id=p_bank and r.status='CERRADA' and r.reconciliation_date>=p_date)
   or exists(select 1 from public.quadratic_bank_reconciliations q where q.bank_account_id=p_bank and q.status in('approved','closed') and(make_date(q.period_year,q.period_month,1)+interval '1 month'-interval '1 day')::date>=p_date) then
   raise exception using errcode='55000',message='La cuenta y fecha están protegidas por una conciliación aprobada o cerrada.';
  end if;
 end if;return sid;
end$$;



create function reconciliation_private.statement_mutable(p_id bigint) returns void language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$
declare s public.bank_statement;
begin
 select * into s from public.bank_statement where statement_id=p_id for update;
 if not found then raise exception using errcode='42501',message='El extracto no está disponible.';end if;
 perform reconciliation_private.bank_scope(s.bank_account_id,s.statement_date,true);
 perform 1 from public.bank_statement_line l where l.statement_id=p_id order by l.statement_line_id for update;
 if exists(select 1 from public.bank_statement_line l where l.statement_id=p_id and(l.reconciliation_status<>'PENDIENTE'
  or exists(select 1 from public.bank_reconciliation_match m where m.statement_line_id=l.statement_line_id)
  or exists(select 1 from public.quadratic_reconciliation_matches m where m.statement_line_id=l.statement_line_id)
  or exists(select 1 from public.quadratic_reconciliation_items i where i.statement_line_id=l.statement_line_id))) then
  raise exception using errcode='55000',message='El extracto tiene líneas conciliadas o utilizadas; no puede reemplazarse ni eliminarse.';
 end if;
end$$;

create function reconciliation_private.check_match(p_bank bigint,p_line bigint,p_cutoff date) returns bigint language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$
declare b public.bank_transaction;l public.bank_statement_line;s public.bank_statement;
begin
 select * into b from public.bank_transaction where bank_tran_id=p_bank;
 perform reconciliation_private.bank_scope(b.bank_account_id,p_cutoff,true);
 select * into b from public.bank_transaction where bank_tran_id=p_bank for update;
 select bs.* into s from public.bank_statement bs join public.bank_statement_line sl using(statement_id) where sl.statement_line_id=p_line and bs.bank_account_id=b.bank_account_id and bs.statement_date<=p_cutoff for update of bs;
 if not found then raise exception using errcode='42501',message='El movimiento del extracto no corresponde al banco y fecha seleccionados.';end if;
 select * into l from public.bank_statement_line where statement_line_id=p_line for update;
 if b.tran_type='SALDO_INICIAL' or b.tran_date>p_cutoff or l.bank_date>p_cutoff or not reconciliation_private.finite(b.amount) or not reconciliation_private.finite(l.amount)
  or round(b.amount-l.amount,2)<>0 or b.reconciliation_status<>'PENDIENTE_EN_TRANSITO' or l.reconciliation_status<>'PENDIENTE'
  or exists(select 1 from public.bank_reconciliation_match m where m.bank_tran_id=p_bank or m.statement_line_id=p_line) then
  raise exception using errcode='55000',message='Los movimientos no son elegibles para punteo por importe, fecha o estado.';
 end if;return b.bank_account_id;
end$$;

create function reconciliation_private.quad_scope(p_id bigint,p_write boolean default false,p_transition boolean default false) returns public.quadratic_bank_reconciliations language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$
declare r public.quadratic_bank_reconciliations;sid bigint:=reconciliation_private.identity();
begin
 if p_write then select * into r from public.quadratic_bank_reconciliations where reconciliation_id=p_id and subsidiary_id=sid for update;
 else select * into r from public.quadratic_bank_reconciliations where reconciliation_id=p_id and subsidiary_id=sid;end if;
 if not found then raise exception using errcode='42501',message='La prueba de efectivo no está disponible en la subsidiaria activa.';end if;
 perform reconciliation_private.bank_scope(r.bank_account_id);
 if p_write and(r.status='closed' or(r.status='approved' and not p_transition)) then raise exception using errcode='55000',message='La conciliación aprobada o cerrada no admite cambios.';end if;
 if p_write then perform 1 from public.bank_account where bank_account_id=r.bank_account_id for update;end if;return r;
end$$;
create function reconciliation_private.quad_save(p jsonb) returns jsonb language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$
declare key bigint; r public.quadratic_bank_reconciliations;sid bigint:=reconciliation_private.identity();
begin
 if p is null or jsonb_typeof(p)<>'object' then raise exception using errcode='22023',message='Datos de conciliación inválidos.';end if;
 perform reconciliation_private.numbers(p,array['bankStartBalance','bankTotalReceipts','bankTotalDisbursements','bankEndBalance']);
 key:=nullif(p->>'id','')::bigint;
 if key is null then
  perform reconciliation_private.bank_scope((p->>'bankAccountId')::bigint);
  perform 1 from public.bank_account where bank_account_id=(p->>'bankAccountId')::bigint for update;
  select reconciliation_id into key from public.quadratic_bank_reconciliations where bank_account_id=(p->>'bankAccountId')::bigint and period_year=(p->>'periodYear')::int and period_month=(p->>'periodMonth')::int;
 end if;
 if key is null then perform reconciliation_private.access('banking:cash-proof','create');
 else perform reconciliation_private.access('banking:cash-proof','edit');r:=reconciliation_private.quad_scope(key,true);p:=p||jsonb_build_object('id',key);end if;
 return p;
end$$;
create function reconciliation_private.quad_transition(p_id bigint,p_status text) returns void language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$
declare r public.quadratic_bank_reconciliations;code text;
begin
 perform reconciliation_private.access('banking:cash-proof','edit');r:=reconciliation_private.quad_scope(p_id,true,true);
 code:=case when lower(p_status) in('approved','approve','closed','close') or r.status='approved' then 'BANK_QUADRATIC_APPROVE' else 'BANK_QUADRATIC_MANAGE' end;
 if not public.quadratic_can(r.subsidiary_id,code) then raise exception using errcode='42501',message='El rol activo no tiene el permiso técnico requerido para esta transición.';end if;
end$$;

-- RPC originals are moved and explicitly rewired below; public entry points get guards.
do $$declare sig text;f regprocedure;name text;body text;modified text;names text[]:=array['bank_reconciliation_options','run_bank_reconciliation_report','import_bank_statement','auto_match_bank_reconciliation','match_bank_transaction','close_bank_reconciliation','bank_reconciliation_close_report','quadratic_reconciliation_options','quadratic_reconciliation_list','quadratic_reconciliation_get','quadratic_reconciliation_save','quadratic_reconciliation_item_save','quadratic_reconciliation_item_delete','quadratic_reconciliation_match','quadratic_reconciliation_unmatch','quadratic_reconciliation_auto_match','quadratic_reconciliation_transition','ensure_open_bank_reconciliation','bank_reconciliation_close_report_before_opening_bank','quadratic_reconciliation_get_before_opening_bank'];
begin
 foreach sig in array array['bank_reconciliation_options()','run_bank_reconciliation_report(jsonb)','import_bank_statement(bigint,date,numeric,numeric,text,jsonb)','auto_match_bank_reconciliation(bigint,date)','match_bank_transaction(bigint,bigint,date)','close_bank_reconciliation(bigint,date,numeric)','bank_reconciliation_close_report(bigint,date)','quadratic_reconciliation_options()','quadratic_reconciliation_list(jsonb)','quadratic_reconciliation_get(bigint)','quadratic_reconciliation_save(jsonb)','quadratic_reconciliation_item_save(bigint,jsonb)','quadratic_reconciliation_item_delete(bigint,bigint)','quadratic_reconciliation_match(bigint,bigint,bigint)','quadratic_reconciliation_unmatch(bigint,bigint)','quadratic_reconciliation_auto_match(bigint,integer)','quadratic_reconciliation_transition(bigint,text)','ensure_open_bank_reconciliation(bigint,date)','bank_reconciliation_close_report_before_opening_bank(bigint,date)','quadratic_reconciliation_get_before_opening_bank(bigint)'] loop execute format('alter function public.%s set schema reconciliation_private',sig);end loop;
 for f in select p.oid::regprocedure from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='reconciliation_private' and p.proname=any(names) loop
  execute format('alter function %s set search_path=pg_catalog,public,pg_temp',f);
  body:=pg_get_functiondef(f);
  foreach name in array names loop
   body:=replace(body,'public.'||name||'(','reconciliation_private.'||name||'(');
   body:=regexp_replace(body,'(?<![a-zA-Z0-9_.])'||name||'\(','reconciliation_private.'||name||'(','g');
  end loop;execute body;
 end loop;
 body:=pg_get_functiondef('reconciliation_private.bank_reconciliation_options()'::regprocedure);
 modified:=replace(body,'where u.user_id=app_user_id()','where u.user_id=app_user_id() and ba.subsidiary_id=public.active_subsidiary_id()');
 if body=modified then raise exception 'Unexpected classic options';end if;execute modified;
 body:=pg_get_functiondef('reconciliation_private.run_bank_reconciliation_report(jsonb)'::regprocedure);
 modified:=replace(body,'where bt.bank_account_id=account_key and bt.tran_type',
 'where bt.bank_account_id=account_key and (bt.transaction_id is null or t.subsidiary_id=public.active_subsidiary_id()) and (j.journal_id is null or j.subsidiary_id=public.active_subsidiary_id()) and bt.tran_type');
 if body=modified then raise exception 'Unexpected classic report source scope';end if;execute modified;
 body:=pg_get_functiondef('reconciliation_private.auto_match_bank_reconciliation(bigint,date)'::regprocedure);
 modified:=replace(body,' loop'||chr(10)||'  insert into public.bank_reconciliation_match',
 ' loop'||chr(10)||'  if not exists(select 1 from public.bank_transaction b where b.bank_tran_id=r.bank_tran_id and b.reconciliation_status=''PENDIENTE_EN_TRANSITO'') or not exists(select 1 from public.bank_statement_line l where l.statement_line_id=r.statement_line_id and l.reconciliation_status=''PENDIENTE'') then continue;end if;perform reconciliation_private.check_match(r.bank_tran_id,r.statement_line_id,p_cutoff);'||chr(10)||'  insert into public.bank_reconciliation_match');
 if body=modified then raise exception 'Unexpected classic automatic match loop';end if;execute modified;
 -- The commission workflow has its own create permission and retains a trusted helper call.
 body:=pg_get_functiondef('bank_fee_private.register_bank_statement_fees(bigint,date,bigint[])'::regprocedure);
 modified:=replace(body,'public.ensure_open_bank_reconciliation(','reconciliation_private.ensure_open_bank_reconciliation(');
 if body=modified then raise exception 'Unexpected statement commission caller';end if;execute modified;
 -- Options bundles must omit unauthorized bank data instead of failing other options.
 body:=pg_get_functiondef('public.accounting_report_options_bundle()'::regprocedure);
 modified:=replace(body,'public.bank_reconciliation_options()','case when reconciliation_private.allowed(''reports:accounting-reports'',''view'') then reconciliation_private.bank_reconciliation_options() else ''{}''::jsonb end');
 if body=modified then raise exception 'Unexpected accounting options bundle';end if;execute modified;
 -- Validate active company in the existing technical permission helper as well.
 body:=pg_get_functiondef('public.quadratic_can(bigint,text)'::regprocedure);
 modified:=replace(body,'select public.quadratic_has_permission(p_code)and exists(','select p_subsidiary_id=public.active_subsidiary_id() and public.quadratic_has_permission(p_code)and exists(');
 if body=modified then raise exception 'Unexpected quadratic permission helper';end if;execute modified;
 -- Trusted ensure helper must still honor active company and immutable sources.
 body:=pg_get_functiondef('reconciliation_private.ensure_open_bank_reconciliation(bigint,date)'::regprocedure);
 modified:=regexp_replace(body,'(?i)begin','begin perform reconciliation_private.bank_scope(p_bank_account_id,p_cutoff,true);');
 execute modified;
end$$;

create function reconciliation_private.before_import(p_bank bigint,p_date date,p_open numeric,p_close numeric,p_lines jsonb) returns void language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$
declare key bigint;line jsonb;
begin
 perform reconciliation_private.bank_scope(p_bank,p_date,true);
 select statement_id into key from public.bank_statement where bank_account_id=p_bank and statement_date=p_date for update;
 perform reconciliation_private.access('banking:bank-statements',case when key is null then 'create' else 'edit' end);
 if key is not null then perform reconciliation_private.statement_mutable(key);end if;
 if not reconciliation_private.finite(p_open) or not reconciliation_private.finite(p_close) or p_lines is null or jsonb_typeof(p_lines)<>'array' then raise exception using errcode='22023',message='Saldos o líneas del extracto inválidos.';end if;
 for line in select value from jsonb_array_elements(p_lines) loop
  if jsonb_typeof(line)<>'object' or nullif(line->>'date','')::date is null or (line->>'date')::date>p_date or not reconciliation_private.finite((line->>'amount')::numeric) or (line->>'amount')::numeric=0 then
   raise exception using errcode='22023',message='Cada línea requiere fecha válida e importe finito no cero.';
  end if;
 end loop;
end$$;

create function public.save_bank_statement_metadata(p_statement_id bigint,p_payload jsonb) returns jsonb language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$
declare s public.bank_statement;result public.bank_statement;selected_bank_key bigint;d date;sid bigint;
begin
 sid:=reconciliation_private.access('banking:bank-statements',case when p_statement_id is null then 'create' else 'edit' end);
 if p_payload is null or jsonb_typeof(p_payload)<>'object' or exists(select 1 from jsonb_object_keys(p_payload) k where k not in('statement_date','bank_account_id','opening_balance','closing_balance','source_file_name')) then raise exception using errcode='22023',message='Datos de extracto inválidos.';end if;
 selected_bank_key:=(p_payload->>'bank_account_id')::bigint;d:=(p_payload->>'statement_date')::date;
 if p_statement_id is not null then
  select bs.* into s from public.bank_statement bs join public.bank_account b using(bank_account_id) where bs.statement_id=p_statement_id and b.subsidiary_id=sid for update of bs;
  if not found then raise exception using errcode='42501',message='El extracto no está disponible en la subsidiaria activa.';end if;
 end if;
 perform 1 from public.bank_account b where b.bank_account_id in(selected_bank_key,s.bank_account_id) and b.subsidiary_id=sid order by b.bank_account_id for update;
 perform reconciliation_private.bank_scope(selected_bank_key,d,true);
 if p_statement_id is not null then
  perform reconciliation_private.statement_mutable(p_statement_id);
  if(s.bank_account_id is distinct from selected_bank_key or s.statement_date is distinct from d) and exists(select 1 from public.bank_statement_line l where l.statement_id=p_statement_id) then raise exception using errcode='55000',message='Un extracto con líneas no puede cambiar de banco o fecha.';end if;
 end if;
 if not reconciliation_private.finite((p_payload->>'opening_balance')::numeric) or not reconciliation_private.finite((p_payload->>'closing_balance')::numeric) then raise exception using errcode='22023',message='Los saldos deben ser finitos.';end if;
 if p_statement_id is null then
  insert into public.bank_statement(statement_date,bank_account_id,opening_balance,closing_balance,source_file_name) values(d,selected_bank_key,(p_payload->>'opening_balance')::numeric,(p_payload->>'closing_balance')::numeric,p_payload->>'source_file_name') returning * into result;
 else
  update public.bank_statement set statement_date=d,bank_account_id=selected_bank_key,opening_balance=(p_payload->>'opening_balance')::numeric,closing_balance=(p_payload->>'closing_balance')::numeric,
   source_file_name=case when p_payload?'source_file_name' then p_payload->>'source_file_name' else s.source_file_name end where statement_id=p_statement_id returning * into result;
 end if;return to_jsonb(result);
end$$;
create function public.delete_bank_statement(p_statement_id bigint) returns jsonb language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$
begin perform reconciliation_private.access('banking:bank-statements','delete');perform reconciliation_private.statement_mutable(p_statement_id);delete from public.bank_statement_line where statement_id=p_statement_id;delete from public.bank_statement where statement_id=p_statement_id;return jsonb_build_object('success',true);end$$;

-- Read predicates never grant financial writes, and validate the active company.
create function reconciliation_private.can_read(p_kind text,p_id bigint) returns boolean language plpgsql stable security definer set search_path=pg_catalog,public,pg_temp as $$
declare bank_key bigint;sid bigint:=null;
begin
 sid:=reconciliation_private.identity();
 if p_kind='statement' then
  if not reconciliation_private.allowed('banking:bank-statements','view') then return false;end if;
  select bank_account_id into bank_key from public.bank_statement where statement_id=p_id;
 elsif p_kind='classic' then
  if not(reconciliation_private.allowed('banking:bank-reconciliations','view') or reconciliation_private.allowed('reports:accounting-reports','view')) then return false;end if;
  select bank_account_id into bank_key from public.bank_reconciliation where reconciliation_id=p_id;
 elsif p_kind='book' then
  if not(reconciliation_private.allowed('banking:bank-transactions','view') or reconciliation_private.allowed('reports:accounting-reports','view')) then return false;end if;
  select bank_account_id into bank_key from public.bank_transaction where bank_tran_id=p_id;
 elsif p_kind='quad' then
  if not reconciliation_private.allowed('banking:cash-proof','view') then return false;end if;
  select bank_account_id into bank_key from public.quadratic_bank_reconciliations where reconciliation_id=p_id and subsidiary_id=sid;
  if not public.quadratic_can(sid,'BANK_QUADRATIC_VIEW') then return false;end if;
 else return false;end if;
 return exists(select 1 from public.bank_account b where b.bank_account_id=bank_key and b.subsidiary_id=sid);
exception when insufficient_privilege then return false;
end$$;

-- Immutable underlying sources and parent states, even through another definer workflow.
create function reconciliation_private.protect_sources() returns trigger language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$
declare bank_key bigint;d date;parent public.quadratic_bank_reconciliations;key bigint;
begin
 if tg_table_name='bank_reconciliation' then
  if tg_op<>'INSERT' and old.status='CERRADA' and(tg_op='DELETE' or new is distinct from old) then raise exception using errcode='55000',message='La conciliación cerrada es inmutable.';end if;
 elsif tg_table_name='quadratic_bank_reconciliations' then
  if tg_op='DELETE' and old.status in('approved','closed') then raise exception using errcode='55000',message='No se elimina una conciliación aprobada o cerrada.';end if;
  if tg_op<>'DELETE' then perform reconciliation_private.numbers(to_jsonb(new),array['bank_start_balance','bank_total_receipts','bank_total_disbursements','bank_end_balance','book_start_balance','book_total_receipts','book_total_disbursements','book_end_balance']);end if;
 elsif tg_table_name in('quadratic_reconciliation_items','quadratic_reconciliation_matches') then
  key:=case when tg_op='DELETE' then old.reconciliation_id else new.reconciliation_id end;
  select * into parent from public.quadratic_bank_reconciliations where reconciliation_id=key for update;
  if parent.status not in('draft','in_review') then raise exception using errcode='55000',message='La conciliación aprobada o cerrada no admite partidas ni punteos.';end if;
  if tg_op<>'DELETE' then
   d:=(make_date(parent.period_year,parent.period_month,1)+interval'1 month'-interval'1 day')::date;
   if new.bank_tran_id is not null and not exists(select 1 from public.bank_transaction b where b.bank_tran_id=new.bank_tran_id and b.bank_account_id=parent.bank_account_id and b.tran_date<=d) then raise exception using errcode='42501',message='Movimiento de libros ajeno o posterior al período.';end if;
   if new.statement_line_id is not null and not exists(select 1 from public.bank_statement_line l join public.bank_statement s using(statement_id) where l.statement_line_id=new.statement_line_id and s.bank_account_id=parent.bank_account_id and l.bank_date<=d and extract(year from s.statement_date)=parent.period_year and extract(month from s.statement_date)=parent.period_month) then raise exception using errcode='42501',message='Línea de extracto ajena o posterior al período.';end if;
   if tg_table_name='quadratic_reconciliation_items' then
    perform reconciliation_private.numbers(to_jsonb(new),array['amount','impact_start_balance','impact_receipts','impact_disbursements','impact_end_balance']);
   end if;
  end if;
 elsif tg_table_name='bank_statement_line' then
  key:=case when tg_op='DELETE' then old.statement_id else new.statement_id end;
  select bank_account_id,statement_date into bank_key,d from public.bank_statement where statement_id=key for update;
  if exists(select 1 from public.bank_reconciliation r where r.bank_account_id=bank_key and r.status='CERRADA' and r.reconciliation_date>=d) or exists(select 1 from public.quadratic_bank_reconciliations q where q.bank_account_id=bank_key and q.status in('approved','closed') and(make_date(q.period_year,q.period_month,1)+interval'1 month'-interval'1 day')::date>=d) then raise exception using errcode='55000',message='Las líneas del extracto están protegidas por una conciliación.';end if;
  if tg_op<>'DELETE' and not reconciliation_private.finite(new.amount) then raise exception using errcode='22023',message='La línea requiere importe finito.';end if;
 elsif tg_table_name='bank_reconciliation_match' then
  key:=case when tg_op='DELETE' then old.reconciliation_id else new.reconciliation_id end;
  select bank_account_id,reconciliation_date into bank_key,d from public.bank_reconciliation where reconciliation_id=key and status='ABIERTA' for update;
  if not found then raise exception using errcode='55000',message='La conciliación del punteo no está abierta.';end if;
  if tg_op<>'DELETE' and not exists(select 1 from public.bank_transaction b join public.bank_statement_line l on l.statement_line_id=new.statement_line_id join public.bank_statement s on s.statement_id=l.statement_id where b.bank_tran_id=new.bank_tran_id and b.bank_account_id=bank_key and s.bank_account_id=bank_key and b.tran_date<=d and l.bank_date<=d and reconciliation_private.finite(b.amount) and reconciliation_private.finite(l.amount) and abs(b.amount-l.amount)<.005) then raise exception using errcode='42501',message='Punteros, fechas o importes de punteo inconsistentes.';end if;
 elsif tg_table_name='bank_transaction' then
  perform 1 from public.bank_account b where b.bank_account_id in(case when tg_op='INSERT' then null else old.bank_account_id end,case when tg_op='DELETE' then null else new.bank_account_id end) order by b.bank_account_id for update;
  if tg_op<>'DELETE' and not reconciliation_private.finite(new.amount) then raise exception using errcode='22023',message='El movimiento requiere un importe finito.';end if;
  if tg_op<>'INSERT' then bank_key:=old.bank_account_id;d:=old.tran_date;
   if exists(select 1 from public.bank_reconciliation r where r.bank_account_id=bank_key and r.status='CERRADA' and r.reconciliation_date>=d) or exists(select 1 from public.quadratic_bank_reconciliations q where q.bank_account_id=bank_key and q.status in('approved','closed') and(make_date(q.period_year,q.period_month,1)+interval'1 month'-interval'1 day')::date>=d) then raise exception using errcode='55000',message='El movimiento está protegido por una conciliación aprobada o cerrada.';end if;
  end if;
  if tg_op<>'DELETE' then bank_key:=new.bank_account_id;d:=new.tran_date;
   if exists(select 1 from public.bank_reconciliation r where r.bank_account_id=bank_key and r.status='CERRADA' and r.reconciliation_date>=d) or exists(select 1 from public.quadratic_bank_reconciliations q where q.bank_account_id=bank_key and q.status in('approved','closed') and(make_date(q.period_year,q.period_month,1)+interval'1 month'-interval'1 day')::date>=d) then raise exception using errcode='55000',message='La fecha está protegida por una conciliación aprobada o cerrada.';end if;
  end if;
 elsif tg_table_name='bank_statement' then
  if tg_op<>'INSERT' then bank_key:=old.bank_account_id;d:=old.statement_date;
   if exists(select 1 from public.bank_reconciliation r where r.bank_account_id=bank_key and r.status='CERRADA' and r.reconciliation_date>=d) or exists(select 1 from public.quadratic_bank_reconciliations q where q.bank_account_id=bank_key and q.status in('approved','closed') and(make_date(q.period_year,q.period_month,1)+interval'1 month'-interval'1 day')::date>=d) then raise exception using errcode='55000',message='El extracto está protegido por una conciliación.';end if;
  end if;
 end if;
 if tg_op='DELETE' then return old;else return new;end if;
end$$;

do $$declare t text;
begin foreach t in array array['bank_reconciliation','quadratic_bank_reconciliations','quadratic_reconciliation_items','quadratic_reconciliation_matches','bank_transaction','bank_statement','bank_statement_line','bank_reconciliation_match'] loop
 execute format('create trigger security_reconciliation_sources before insert or update or delete on public.%I for each row execute function reconciliation_private.protect_sources()',t);
end loop;end$$;

-- Build public guarded RPCs with the exact original signatures/defaults/volatility.
do $$declare spec record;p record;body text;
begin
 for spec in select * from (values ('bank_reconciliation_options()','perform reconciliation_private.access(''reports:accounting-reports'',''view'');'),
('run_bank_reconciliation_report(jsonb)','perform reconciliation_private.access(''reports:accounting-reports'',''view'');perform reconciliation_private.bank_scope(nullif(p_filters->>''bankAccountId'','''')::bigint);'),
('import_bank_statement(bigint,date,numeric,numeric,text,jsonb)','perform reconciliation_private.before_import(p_bank_account_id,p_statement_date,p_opening_balance,p_closing_balance,p_lines);'),
('auto_match_bank_reconciliation(bigint,date)','perform reconciliation_private.access(''banking:bank-reconciliations'',''edit'');perform reconciliation_private.bank_scope(p_bank_account_id,p_cutoff,true);'),
('match_bank_transaction(bigint,bigint,date)','perform reconciliation_private.access(''banking:bank-reconciliations'',''edit'');perform reconciliation_private.check_match(p_bank_tran_id,p_statement_line_id,p_cutoff);'),
('close_bank_reconciliation(bigint,date,numeric)','perform reconciliation_private.access(''banking:bank-reconciliations'',''edit'');perform reconciliation_private.bank_scope(p_bank_account_id,p_cutoff,true);if not reconciliation_private.finite(p_bank_adjustments) then raise exception using errcode=''22023'',message=''Ajuste inválido.'';end if;'),
('bank_reconciliation_close_report(bigint,date)','perform reconciliation_private.access(''reports:accounting-reports'',''view'');perform reconciliation_private.bank_scope(p_bank_account_id);'),
('quadratic_reconciliation_options()','perform reconciliation_private.access(''banking:cash-proof'',''view'');'),
('quadratic_reconciliation_list(jsonb)','perform reconciliation_private.access(''banking:cash-proof'',''view'');if nullif(p_filters->>''subsidiaryId'','''')::bigint is not null and (p_filters->>''subsidiaryId'')::bigint<>public.active_subsidiary_id() then raise exception using errcode=''42501'',message=''Seleccione la subsidiaria activa.'';end if;p_filters:=coalesce(p_filters,''{}'')||jsonb_build_object(''subsidiaryId'',public.active_subsidiary_id());'),
('quadratic_reconciliation_get(bigint)','perform reconciliation_private.access(''banking:cash-proof'',''view'');perform reconciliation_private.quad_scope(p_reconciliation_id);'),
('quadratic_reconciliation_save(jsonb)','p_payload:=reconciliation_private.quad_save(p_payload);'),
('quadratic_reconciliation_item_save(bigint,jsonb)','perform reconciliation_private.access(''banking:cash-proof'',''edit'');perform reconciliation_private.quad_scope(p_reconciliation_id,true);perform reconciliation_private.numbers(p_item,array[''amount'',''impactStartBalance'',''impactReceipts'',''impactDisbursements'',''impactEndBalance'']);'),
('quadratic_reconciliation_item_delete(bigint,bigint)','perform reconciliation_private.access(''banking:cash-proof'',''edit'');perform reconciliation_private.quad_scope(p_reconciliation_id,true);'),
('quadratic_reconciliation_match(bigint,bigint,bigint)','perform reconciliation_private.access(''banking:cash-proof'',''edit'');perform reconciliation_private.quad_scope(p_reconciliation_id,true);'),
('quadratic_reconciliation_unmatch(bigint,bigint)','perform reconciliation_private.access(''banking:cash-proof'',''edit'');perform reconciliation_private.quad_scope(p_reconciliation_id,true);'),
('quadratic_reconciliation_auto_match(bigint,integer)','perform reconciliation_private.access(''banking:cash-proof'',''edit'');perform reconciliation_private.quad_scope(p_reconciliation_id,true);if p_tolerance_days is null or p_tolerance_days not between 0 and 31 then raise exception using errcode=''22023'',message=''Tolerancia inválida.'';end if;'),
('quadratic_reconciliation_transition(bigint,text)','perform reconciliation_private.quad_transition(p_id,p_status);')) as registry(signature,guard) loop
  select pr.*,pg_get_function_arguments(pr.oid) args,pg_get_function_result(pr.oid) result into p from pg_proc pr where pr.oid=('reconciliation_private.'||spec.signature)::regprocedure;
  body:='begin '||spec.guard||' return reconciliation_private.'||p.proname||'('||coalesce(array_to_string(p.proargnames,','),'')||');end';
  execute format('create function public.%I(%s) returns %s language plpgsql %s security definer set search_path=pg_catalog,public,pg_temp as %L',p.proname,p.args,p.result,case when p.provolatile='s' then 'stable' else 'volatile' end,body);
  execute format('revoke all on function public.%s from public,anon,authenticated,service_role',spec.signature);
  execute format('grant execute on function public.%s to authenticated',spec.signature);
 end loop;
 -- Existing public quadratic helpers are internal only, not alternate APIs.
 for p in select pr.oid::regprocedure f from pg_proc pr join pg_namespace n on n.oid=pr.pronamespace where n.nspname='public' and pr.proname like 'quadratic_%' and pr.proname not like 'quadratic_reconciliation_%' loop
  execute format('revoke all on function %s from public,anon,authenticated,service_role',p.f);
  execute format('alter function %s set search_path=pg_catalog,public,pg_temp',p.f);
 end loop;
end$$;

do $$declare p record;t text;col record;
begin
 for p in select tablename,policyname from pg_policies where schemaname='public' and tablename in('bank_statement','bank_statement_line','bank_reconciliation','bank_reconciliation_match','bank_transaction','quadratic_bank_reconciliations','quadratic_reconciliation_items','quadratic_reconciliation_matches','quadratic_reconciliation_history') loop execute format('drop policy %I on public.%I',p.policyname,p.tablename);end loop;
 foreach t in array array['bank_statement','bank_statement_line','bank_reconciliation','bank_reconciliation_match','bank_transaction','quadratic_bank_reconciliations','quadratic_reconciliation_items','quadratic_reconciliation_matches','quadratic_reconciliation_history'] loop
  execute format('alter table public.%I enable row level security',t);
  execute format('revoke all on public.%I from public,anon,authenticated,service_role',t);
  for col in select attname from pg_attribute where attrelid=('public.'||t)::regclass and attnum>0 and not attisdropped loop execute format('revoke all(%I) on public.%I from public,anon,authenticated,service_role',col.attname,t);end loop;
  if t not like 'quadratic_%' then execute format('grant select on public.%I to authenticated',t);end if;
 end loop;
end$$;
create policy statement_read on public.bank_statement for select to authenticated using(reconciliation_private.can_read('statement',statement_id));
create policy statement_line_read on public.bank_statement_line for select to authenticated using(reconciliation_private.can_read('statement',statement_id));
create policy reconciliation_read on public.bank_reconciliation for select to authenticated using(reconciliation_private.can_read('classic',reconciliation_id));
create policy reconciliation_match_read on public.bank_reconciliation_match for select to authenticated using(reconciliation_private.can_read('classic',reconciliation_id));
create policy bank_movement_read on public.bank_transaction for select to authenticated using(reconciliation_private.can_read('book',bank_tran_id));
create policy quadratic_read on public.quadratic_bank_reconciliations for select to authenticated using(reconciliation_private.can_read('quad',reconciliation_id));
create policy quadratic_item_read on public.quadratic_reconciliation_items for select to authenticated using(reconciliation_private.can_read('quad',reconciliation_id));
create policy quadratic_match_read on public.quadratic_reconciliation_matches for select to authenticated using(reconciliation_private.can_read('quad',reconciliation_id));
create policy quadratic_history_read on public.quadratic_reconciliation_history for select to authenticated using(reconciliation_private.can_read('quad',reconciliation_id));
create or replace function public.bank_statement_in_active_subsidiary(p_statement_id bigint) returns boolean language sql stable security definer set search_path=pg_catalog,public,pg_temp as $$select reconciliation_private.can_read('statement',p_statement_id)$$;
revoke all on function public.bank_statement_in_active_subsidiary(bigint) from public,anon,service_role;
grant execute on function public.bank_statement_in_active_subsidiary(bigint) to authenticated;
revoke all on all functions in schema reconciliation_private from public,anon,authenticated,service_role;
grant execute on function reconciliation_private.can_read(text,bigint) to authenticated;
revoke all on function public.save_bank_statement_metadata(bigint,jsonb),public.delete_bank_statement(bigint) from public,anon,authenticated,service_role;
grant execute on function public.save_bank_statement_metadata(bigint,jsonb),public.delete_bank_statement(bigint) to authenticated;
notify pgrst,'reload schema';
