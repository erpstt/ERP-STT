-- C-04: commission posting remains atomic, behind action and subsidiary authorization.
set local lock_timeout='5s';set local statement_timeout='30s';
create schema bank_fee_private;
revoke all on schema bank_fee_private from public,anon,authenticated,service_role;
grant usage on schema bank_fee_private to authenticated;
alter function public.bank_fee_options() set schema bank_fee_private;
alter function public.bank_fee_report(jsonb) set schema bank_fee_private;
alter function public.bank_fee_detail(bigint) set schema bank_fee_private;
alter function public.save_bank_fee(jsonb) set schema bank_fee_private;
alter function public.import_bank_fees(jsonb) set schema bank_fee_private;
alter function public.update_bank_fee(bigint,jsonb) set schema bank_fee_private;
alter function public.delete_bank_fee(bigint) set schema bank_fee_private;
alter function public.post_bank_fee_internal(jsonb,boolean) set schema bank_fee_private;
alter function public.register_bank_statement_fees(bigint,date,bigint[]) set schema bank_fee_private;
alter function public.bank_fee_active_subsidiary() set schema bank_fee_private;
create or replace function bank_fee_private.bank_fee_active_subsidiary() returns bigint language sql stable security definer set search_path=pg_catalog,public,pg_temp as $$select public.active_subsidiary_id()$$;

-- The existing public expense helper is also used by customer payments: retain it.
-- Commissions use their own strict assignment/active/movement checks instead.
create function bank_fee_private.expense_account(p_sid bigint) returns bigint language sql stable security definer set search_path=pg_catalog,public,pg_temp as $$
 select a.account_id from public.chart_accounts a join public.account_subsidiaries s using(account_id)
 where s.subsidiary_id=p_sid and s.is_active and coalesce(a.accepts_entries,true) and not coalesce(a.is_inactive,false) and not coalesce(a.is_summary,false)
 and(lower(a.account_name) like '%comisi%bancar%' or lower(a.account_name) like '%gasto%bancar%')
 order by case when lower(a.account_name) like '%comisi%' then 0 else 1 end,a.account_number limit 1
$$;
create function bank_fee_private.assert_access(p_action text) returns bigint language plpgsql stable security definer set search_path=pg_catalog,public,pg_temp as $$
declare sid bigint:=public.active_subsidiary_id();
begin
 if auth.uid() is null or public.app_user_id() is null or public.app_active_role_id() is null or sid is null then raise exception using errcode='42501',message='Seleccione usuario, rol y subsidiaria autorizados.';end if;
 perform public.security_assert_role_access('banking:bank-fees',p_action);return sid;
end$$;
create function bank_fee_private.can_read(p_id bigint) returns boolean language plpgsql stable security definer set search_path=pg_catalog,public,pg_temp as $$
declare sid bigint;
begin
 sid:=bank_fee_private.assert_access('view');return exists(select 1 from public.bank_fee f join public.bank_account b using(bank_account_id)
 join public.journal j on j.journal_id=f.journal_id join public."transaction" t on t.transaction_id=f.transaction_id
 where f.fee_id=p_id and f.subsidiary_id=sid and b.subsidiary_id=sid and j.subsidiary_id=sid and t.subsidiary_id=sid and j.transaction_id=t.transaction_id);
exception when insufficient_privilege then return false;
end$$;

create function bank_fee_private.post_checked(p_payload jsonb,p_statement boolean default false) returns jsonb language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$
declare sid bigint:=public.active_subsidiary_id();b public.bank_account;amount_value numeric;d date;expense bigint;period_id bigint;
begin
 if auth.uid() is null or public.app_user_id() is null or public.app_active_role_id() is null or sid is null then raise exception using errcode='42501',message='Seleccione usuario, rol y subsidiaria autorizados.';end if;
 if p_payload is null or jsonb_typeof(p_payload)<>'object' then raise exception using errcode='22023',message='Datos de comisión inválidos.';end if;
 amount_value:=nullif(p_payload->>'amount','')::numeric;d:=nullif(p_payload->>'fee_date','')::date;
 if d is null or amount_value is null or amount_value<=0 or amount_value::text in('NaN','Infinity','-Infinity') then raise exception using errcode='22023',message='Fecha e importe positivo finito son obligatorios.';end if;
 select * into b from public.bank_account ba where ba.bank_account_id=(p_payload->>'bank_account_id')::bigint and ba.subsidiary_id=sid for update;
 if not found or coalesce(b.is_credit_card,false) then raise exception using errcode='42501',message='La cuenta bancaria no está habilitada para la subsidiaria activa.';end if;
 expense:=bank_fee_private.expense_account(sid);
 if expense is null or not exists(select 1 from public.chart_accounts a join public.account_subsidiaries s using(account_id)
  where a.account_id=b.account_id and s.subsidiary_id=sid and s.is_active and coalesce(a.accepts_entries,true) and not coalesce(a.is_summary,false) and not coalesce(a.is_inactive,false)
   and (a.currency_id is null or a.currency_id=b.currency_id))
 or not exists(select 1 from public.chart_accounts a where a.account_id=expense and(a.currency_id is null or a.currency_id=b.currency_id)) then
  raise exception using errcode='42501',message='Las cuentas contables no están habilitadas para esta subsidiaria y moneda.';
 end if;
 select fiscal_period_id into period_id from public.fiscal_periods f where f.subsidiary_id=sid and d between f.start_date and f.end_date
  and not coalesce(f.is_closed,false) and not coalesce(f.gl_closed,false) and not coalesce(f.is_inactive,false) order by start_date desc limit 1 for share;
 if period_id is null then raise exception using errcode='55000',message='No existe período abierto para la fecha y subsidiaria.';end if;
 if exists(select 1 from public.bank_reconciliation r where r.bank_account_id=b.bank_account_id and r.status='CERRADA' and r.reconciliation_date>=d) then
  raise exception using errcode='55000',message='La comisión corresponde a una conciliación cerrada.';
 end if;
 if b.balance is null or b.balance::text in('NaN','Infinity','-Infinity') or(not p_statement and b.balance<amount_value) then raise exception using errcode='55000',message='Saldo bancario insuficiente o inválido.';end if;
 return bank_fee_private.post_bank_fee_internal(p_payload,p_statement);
end$$;

do $$declare f regprocedure;body text;modified text;
begin
 for f in select p.oid::regprocedure from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='bank_fee_private' loop
  execute format('alter function %s set search_path=pg_catalog,public,pg_temp',f);
 end loop;
 -- Route original bodies explicitly; edits must not require create/delete permissions.
 foreach f in array array['bank_fee_private.bank_fee_options()'::regprocedure,'bank_fee_private.bank_fee_detail(bigint)'::regprocedure,
  'bank_fee_private.delete_bank_fee(bigint)'::regprocedure,'bank_fee_private.update_bank_fee(bigint,jsonb)'::regprocedure,
  'bank_fee_private.import_bank_fees(jsonb)'::regprocedure,'bank_fee_private.save_bank_fee(jsonb)'::regprocedure,
  'bank_fee_private.post_bank_fee_internal(jsonb,boolean)'::regprocedure,'bank_fee_private.register_bank_statement_fees(bigint,date,bigint[])'::regprocedure] loop
  body:=pg_get_functiondef(f);
  body:=replace(body,'public.bank_fee_expense_account(','bank_fee_private.expense_account(');
  body:=regexp_replace(body,'(?<![a-zA-Z0-9_.])bank_fee_expense_account\(','bank_fee_private.expense_account(','g');
  body:=regexp_replace(body,'(?<![a-zA-Z0-9_.])bank_fee_active_subsidiary\(','bank_fee_private.bank_fee_active_subsidiary(','g');
  body:=replace(body,'public.post_bank_fee_internal(','bank_fee_private.post_checked(');
  body:=regexp_replace(body,'(?<![a-zA-Z0-9_.])delete_bank_fee\(','bank_fee_private.delete_bank_fee(','g');
  body:=regexp_replace(body,'(?<![a-zA-Z0-9_.])save_bank_fee\(','bank_fee_private.save_bank_fee(','g');
  execute body;
 end loop;
 body:=pg_get_functiondef('bank_fee_private.post_bank_fee_internal(jsonb,boolean)'::regprocedure);
 modified:=replace(body,'and not is_closed','and not is_closed and not coalesce(gl_closed,false) and not coalesce(is_inactive,false)');
 if body=modified then raise exception 'Unexpected fee period selection';end if;body:=modified;
 modified:=replace(body,'  begin'||chr(10)||'    fee_number_value',
 '  if exchange_rate_value is null or exchange_rate_value<=0 or exchange_rate_value::text in(''NaN'',''Infinity'',''-Infinity'') then raise exception using errcode=''22023'',message=''El tipo de cambio debe ser positivo y finito.'';end if;'||chr(10)||'  begin'||chr(10)||'    fee_number_value');
 if body=modified then raise exception 'Unexpected fee exchange-rate calculation';end if;execute modified;
 body:=pg_get_functiondef('bank_fee_private.register_bank_statement_fees(bigint,date,bigint[])'::regprocedure);
 modified:=replace(body,'  where statement_line.statement_line_id=any(p_statement_line_ids)'||chr(10)||'  order by statement_line.statement_line_id',
  '  where statement_line.statement_line_id=any(p_statement_line_ids) and statement_line.statement_id=statement_key'||chr(10)||'  order by statement_line.statement_line_id');
 if body=modified then raise exception 'Unexpected statement fee row locking';end if;execute modified;
 body:=pg_get_functiondef('bank_fee_private.bank_fee_report(jsonb)'::regprocedure);
 modified:=replace(body,'where f.subsidiary_id=active_subsidiary_id()','where bank_fee_private.can_read(f.fee_id) and f.subsidiary_id=active_subsidiary_id()');
 if body=modified then raise exception 'Unexpected fee report';end if;execute modified;
end$$;

create function bank_fee_private.lock_source(p_id bigint,p_action text) returns public.bank_fee language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$
declare sid bigint;f public.bank_fee;
begin
 sid:=bank_fee_private.assert_access(p_action);
 select * into f from public.bank_fee h where h.fee_id=p_id and h.subsidiary_id=sid for update;
 if not found then raise exception using errcode='42501',message='La comisión no está disponible en la subsidiaria activa.';end if;
 perform 1 from public.journal j join public."transaction" t on t.transaction_id=j.transaction_id join public.bank_account b on b.bank_account_id=f.bank_account_id
 where j.journal_id=f.journal_id and t.transaction_id=f.transaction_id and j.subsidiary_id=sid and t.subsidiary_id=sid and b.subsidiary_id=sid
 and exists(select 1 from public.transaction_types tt where tt.transaction_type_id=t.transaction_type_id and tt.abbreviation='COM_BAN')
 and j.status='CONTABILIZADO' and j.journal_type='Comisiones bancarias' and j.journal_number=f.fee_number and t.tran_number=f.fee_number
 and j.fiscal_period_id=f.fiscal_period_id and t.fiscal_period_id=f.fiscal_period_id and j.currency_id=f.currency_id and t.currency_id=f.currency_id and b.currency_id=f.currency_id
 and j.journal_date=f.fee_date and t.tran_date=f.fee_date and t.total_amount=f.amount and f.amount>0 and f.amount::text not in('NaN','Infinity','-Infinity') for update of j,t;
 if not found or exists(select 1 from public.bank_fee other where other.fee_id<>f.fee_id and(other.journal_id=f.journal_id or other.transaction_id=f.transaction_id)) then raise exception using errcode='42501',message='El origen contable de la comisión requiere revisión.';end if;
 if not exists(select 1 from public.fiscal_periods p where p.fiscal_period_id=f.fiscal_period_id and p.subsidiary_id=sid and not coalesce(p.is_closed,false) and not coalesce(p.gl_closed,false) and not coalesce(p.is_inactive,false)) then raise exception using errcode='55000',message='El período original está cerrado o inactivo.';end if;
 perform 1 from public.bank_transaction bt where bt.transaction_id=f.transaction_id for update;
 if(select count(*) from public.bank_transaction bt where bt.transaction_id=f.transaction_id)<>1 or exists(select 1 from public.bank_transaction bt where bt.transaction_id=f.transaction_id and(bt.bank_account_id is distinct from f.bank_account_id or bt.amount is distinct from -f.amount or bt.tran_type is distinct from 'COM_BAN' or bt.tran_date is distinct from f.fee_date or bt.reconciliation_status is distinct from 'PENDIENTE_EN_TRANSITO'
  or exists(select 1 from public.bank_reconciliation_match m where m.bank_tran_id=bt.bank_tran_id))) then raise exception using errcode='55000',message='La comisión está conciliada o requiere revisión de integridad.';end if;
 if exists(select 1 from public.bank_reconciliation r where r.bank_account_id=f.bank_account_id and r.status='CERRADA' and r.reconciliation_date>=f.fee_date) then raise exception using errcode='55000',message='La comisión corresponde a una conciliación cerrada.';end if;
 return f;
end$$;

create function public.bank_fee_options() returns jsonb language plpgsql stable security definer set search_path=pg_catalog,public,pg_temp as $$begin perform bank_fee_private.assert_access('view');return bank_fee_private.bank_fee_options();end$$;
create function public.bank_fee_report(p_filters jsonb default '{}'::jsonb) returns jsonb language plpgsql stable security definer set search_path=pg_catalog,public,pg_temp as $$begin perform bank_fee_private.assert_access('view');return bank_fee_private.bank_fee_report(p_filters);end$$;
create function public.bank_fee_detail(p_fee_id bigint) returns jsonb language plpgsql stable security definer set search_path=pg_catalog,public,pg_temp as $$begin perform bank_fee_private.assert_access('view');if not bank_fee_private.can_read(p_fee_id) then raise exception using errcode='42501',message='La comisión no está disponible en la subsidiaria activa.';end if;return bank_fee_private.bank_fee_detail(p_fee_id);end$$;
create function public.save_bank_fee(p_payload jsonb) returns jsonb language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$begin perform bank_fee_private.assert_access('create');return bank_fee_private.save_bank_fee(p_payload);end$$;
create function public.import_bank_fees(p_payload jsonb) returns jsonb language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$begin perform bank_fee_private.assert_access('create');
 if p_payload is null or jsonb_typeof(p_payload)<>'object' or jsonb_typeof(p_payload->'rows') is distinct from 'array' or jsonb_array_length(p_payload->'rows')=0 then raise exception using errcode='22023',message='El archivo requiere filas válidas.';end if;
 return bank_fee_private.import_bank_fees(p_payload);end$$;
create function public.update_bank_fee(p_fee_id bigint,p_payload jsonb) returns jsonb language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$declare f public.bank_fee;begin
 f:=bank_fee_private.lock_source(p_fee_id,'edit');
 perform 1 from public.bank_account b where b.bank_account_id in(f.bank_account_id,(p_payload->>'bank_account_id')::bigint) and b.subsidiary_id=f.subsidiary_id order by b.bank_account_id for update;
 return bank_fee_private.update_bank_fee(p_fee_id,p_payload);end$$;
create function public.delete_bank_fee(p_fee_id bigint) returns jsonb language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$declare f public.bank_fee;begin f:=bank_fee_private.lock_source(p_fee_id,'delete');perform 1 from public.bank_account b where b.bank_account_id=f.bank_account_id and b.subsidiary_id=f.subsidiary_id for update;return bank_fee_private.delete_bank_fee(p_fee_id);end$$;
create function public.register_bank_statement_fees(p_bank_account_id bigint,p_cutoff date,p_statement_line_ids bigint[]) returns jsonb language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$declare sid bigint;begin
 sid:=bank_fee_private.assert_access('create');
 perform 1 from public.bank_account b where b.bank_account_id=p_bank_account_id and b.subsidiary_id=sid and not coalesce(b.is_credit_card,false) for update;
 if not found then raise exception using errcode='42501',message='La cuenta bancaria no está disponible en la subsidiaria activa.';end if;
 if exists(select 1 from public.bank_reconciliation r where r.bank_account_id=p_bank_account_id and r.status='CERRADA' and r.reconciliation_date>=p_cutoff) then raise exception using errcode='55000',message='La conciliación está cerrada.';end if;
 return bank_fee_private.register_bank_statement_fees(p_bank_account_id,p_cutoff,p_statement_line_ids);end$$;

do $$declare p record;col record;
begin
 for p in select policyname from pg_policies where schemaname='public' and tablename='bank_fee' loop execute format('drop policy %I on public.bank_fee',p.policyname);end loop;
 for col in select attname from pg_attribute where attrelid='public.bank_fee'::regclass and attnum>0 and not attisdropped loop execute format('revoke all(%I) on public.bank_fee from public,anon,authenticated,service_role',col.attname);end loop;
end$$;
alter table public.bank_fee enable row level security;
revoke all on public.bank_fee from public,anon,authenticated,service_role;
grant select on public.bank_fee to authenticated;
create policy fee_authorized_read on public.bank_fee for select to authenticated using(bank_fee_private.can_read(fee_id));
revoke all on all functions in schema bank_fee_private from public,anon,authenticated,service_role;
grant execute on function bank_fee_private.can_read(bigint) to authenticated;
revoke all on function public.bank_fee_options(),public.bank_fee_report(jsonb),public.bank_fee_detail(bigint),public.save_bank_fee(jsonb),public.import_bank_fees(jsonb),public.update_bank_fee(bigint,jsonb),public.delete_bank_fee(bigint),public.register_bank_statement_fees(bigint,date,bigint[]) from public,anon,authenticated,service_role;
grant execute on function public.bank_fee_options(),public.bank_fee_report(jsonb),public.bank_fee_detail(bigint),public.save_bank_fee(jsonb),public.import_bank_fees(jsonb),public.update_bank_fee(bigint,jsonb),public.delete_bank_fee(bigint),public.register_bank_statement_fees(bigint,date,bigint[]) to authenticated;
notify pgrst,'reload schema';
