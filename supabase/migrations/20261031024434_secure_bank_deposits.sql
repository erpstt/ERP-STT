-- C-04: deposits. All financial posting bodies are retained behind authorization.
set local lock_timeout='5s';
set local statement_timeout='30s';
create schema bank_deposit_private;
revoke all on schema bank_deposit_private from public,anon,authenticated,service_role;
grant usage on schema bank_deposit_private to authenticated;
alter function public.bank_deposit_options() set schema bank_deposit_private;
alter function public.bank_deposit_report(jsonb) set schema bank_deposit_private;
alter function public.bank_deposit_detail(bigint) set schema bank_deposit_private;
alter function public.save_bank_deposit(jsonb) set schema bank_deposit_private;
alter function public.update_bank_deposit(bigint,jsonb) set schema bank_deposit_private;
alter function public.delete_bank_deposit(bigint) set schema bank_deposit_private;
do $$declare f regprocedure;body text;modified text;
begin
 for f in select p.oid::regprocedure from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='bank_deposit_private' loop
  execute format('alter function %s set search_path=pg_catalog,public,pg_temp',f);
 end loop;
 body:=pg_get_functiondef('bank_deposit_private.bank_deposit_report(jsonb)'::regprocedure);
 modified:=replace(body,'where d.subsidiary_id=active_subsidiary_id()',
  'where ba.subsidiary_id=d.subsidiary_id and d.subsidiary_id=active_subsidiary_id()');
 if body=modified then raise exception 'Unexpected deposit report definition; review before applying.';end if;
 execute modified;
end$$;

create function bank_deposit_private.assert_access(p_action text)
returns bigint language plpgsql stable security definer set search_path=pg_catalog,public,pg_temp as $$
declare sid bigint:=public.active_subsidiary_id();
begin
 if auth.uid() is null or public.app_user_id() is null or public.app_active_role_id() is null or sid is null then
  raise exception using errcode='42501',message='Seleccione un usuario, rol y subsidiaria autorizados.';
 end if;
 perform public.security_assert_role_access('banking:bank-deposits',p_action);
 return sid;
end$$;

create function bank_deposit_private.can_read(p_sid bigint)
returns boolean language plpgsql stable security definer set search_path=pg_catalog,public,pg_temp as $$
begin return p_sid=bank_deposit_private.assert_access('view');
exception when insufficient_privilege then return false;
end$$;

create function bank_deposit_private.validate_payload(p_payload jsonb,p_sid bigint,p_previous_bank bigint default null)
returns void language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$
declare ba public.bank_account;line jsonb;amount numeric;rate numeric;field text;kind text;entity_kind text;loc bigint;
begin
 if p_payload is null or jsonb_typeof(p_payload)<>'object' or jsonb_typeof(p_payload->'lines') is distinct from 'array' then
  raise exception using errcode='22023',message='El depósito requiere encabezado y líneas válidas.';
 end if;
 if jsonb_array_length(p_payload->'lines')=0 then raise exception using errcode='22023',message='Agregue al menos una línea.';end if;
 perform 1 from public.bank_account b where b.bank_account_id in((p_payload->>'bank_account_id')::bigint,p_previous_bank)
  and b.subsidiary_id=p_sid order by b.bank_account_id for update;
 select * into ba from public.bank_account b where b.bank_account_id=(p_payload->>'bank_account_id')::bigint and b.subsidiary_id=p_sid;
 if not found or ba.currency_id is distinct from (p_payload->>'currency_id')::bigint then
  raise exception using errcode='42501',message='La cuenta bancaria o moneda no está disponible en la subsidiaria activa.';
 end if;
 if p_previous_bank is not null and not exists(select 1 from public.bank_account b where b.bank_account_id=p_previous_bank and b.subsidiary_id=p_sid) then
  raise exception using errcode='42501',message='La cuenta bancaria original no está disponible en la subsidiaria activa.';
 end if;
 if not exists(select 1 from public.chart_accounts a join public.account_subsidiaries s using(account_id)
   where a.account_id=ba.account_id and s.subsidiary_id=p_sid and s.is_active
    and not coalesce(a.is_inactive,false) and not coalesce(a.is_summary,false) and coalesce(a.accepts_entries,true)) then
  raise exception using errcode='42501',message='La cuenta contable del banco no está habilitada para la subsidiaria.';
 end if;
 rate:=(p_payload->>'exchange_rate')::numeric;
 if rate is null or rate<=0 or rate::text in('NaN','Infinity','-Infinity') then
  raise exception using errcode='22023',message='El tipo de cambio debe ser positivo y finito.';
 end if;
 if not exists(select 1 from public.fiscal_periods f where f.fiscal_period_id=(p_payload->>'fiscal_period_id')::bigint
  and f.subsidiary_id=p_sid and (p_payload->>'deposit_date')::date between f.start_date and f.end_date
  and not coalesce(f.is_closed,false) and not coalesce(f.gl_closed,false) and not coalesce(f.is_inactive,false)) then
  raise exception using errcode='55000',message='El período debe estar abierto y corresponder a la fecha y subsidiaria.';
 end if;
 loc:=nullif(p_payload->>'location_id','')::bigint;
 if loc is not null and not exists(select 1 from public.locations l where l.location_id=loc and (l.subsidiary_id=p_sid or l.subsidiary_id is null)) then
  raise exception using errcode='42501',message='La ubicación no está disponible en la subsidiaria activa.';
 end if;
 for line in select value from jsonb_array_elements(p_payload->'lines') loop
  amount:=(line->>'amount')::numeric;
  if amount is null or amount<=0 or amount::text in('NaN','Infinity','-Infinity') then
   raise exception using errcode='22023',message='Los importes deben ser positivos y finitos.';
  end if;
  if not exists(select 1 from public.chart_accounts a join public.account_subsidiaries s using(account_id)
   where a.account_id=(line->>'account_id')::bigint and s.subsidiary_id=p_sid and s.is_active
    and not coalesce(a.is_inactive,false) and not coalesce(a.is_summary,false) and coalesce(a.accepts_entries,true)) then
   raise exception using errcode='42501',message='La cuenta de contrapartida no está habilitada para la subsidiaria.';
  end if;
  entity_kind:=nullif(line->>'entity_type','');
  if entity_kind is not null then
   if entity_kind not in('Cliente','Proveedor','Empleado') or nullif(line->>'entity_id','') is null then
    raise exception using errcode='22023',message='Seleccione una entidad válida.';
   end if;
   perform public.journal_csv_lookup(entity_kind,'ID:'||(line->>'entity_id'));
  end if;
  for field,kind in select * from (values('department_id','departamento'),('class_id','clase'),('cost_center_id','centro_costos'),
   ('financial_creditor_id','acreedor_financiero'),('related_company_id','compania_relacionada')) refs(field,kind) loop
   if nullif(line->>field,'') is not null then perform public.journal_csv_lookup(kind,'ID:'||(line->>field));end if;
  end loop;
 end loop;
exception when raise_exception then
 raise exception using errcode='42501',message='Una entidad o dimensión no está disponible en la subsidiaria activa.';
end$$;

create function bank_deposit_private.lock_source(p_id bigint,p_action text)
returns public.bank_deposit language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$
declare sid bigint;r public.bank_deposit;tid bigint;
begin
 sid:=bank_deposit_private.assert_access(p_action);
 select * into r from public.bank_deposit d where d.deposit_id=p_id and d.subsidiary_id=sid for update;
 if not found then raise exception using errcode='42501',message='El depósito no está disponible en la subsidiaria activa.';end if;
 select j.transaction_id into tid from public.journal j join public."transaction" t on t.transaction_id=j.transaction_id
  join public.bank_account b on b.bank_account_id=r.bank_account_id
  where j.journal_id=r.journal_id and j.subsidiary_id=sid and t.subsidiary_id=sid and b.subsidiary_id=sid
   and exists(select 1 from public.transaction_types tt where tt.transaction_type_id=t.transaction_type_id and tt.abbreviation='DEP_BAN') and j.status='CONTABILIZADO'
   and j.journal_number=r.deposit_number and t.tran_number=r.deposit_number
   and j.fiscal_period_id=r.fiscal_period_id and t.fiscal_period_id=r.fiscal_period_id for update of j,t;
 if not found then raise exception using errcode='42501',message='El origen contable del depósito requiere revisión.';end if;
 if not exists(select 1 from public.fiscal_periods f where f.fiscal_period_id=r.fiscal_period_id and f.subsidiary_id=sid
  and not coalesce(f.is_closed,false) and not coalesce(f.gl_closed,false) and not coalesce(f.is_inactive,false)) then
  raise exception using errcode='55000',message='El período original del depósito está cerrado o inactivo.';
 end if;
 perform 1 from public.bank_transaction b where b.transaction_id=tid and b.tran_type='DEP_BAN' for update;
 if (select count(*) from public.bank_transaction b where b.transaction_id=tid and b.tran_type='DEP_BAN')<>1
  or exists(select 1 from public.bank_transaction b where b.transaction_id=tid and b.tran_type='DEP_BAN'
   and (b.bank_account_id is distinct from r.bank_account_id or b.amount is distinct from r.total_amount or b.tran_date is distinct from r.deposit_date
    or b.reconciliation_status is distinct from 'PENDIENTE_EN_TRANSITO')) then
  raise exception using errcode='55000',message='El movimiento bancario está conciliado o requiere revisión de integridad.';
 end if;
 if exists(select 1 from public.bank_reconciliation b where b.bank_account_id=r.bank_account_id and b.status='CERRADA' and b.reconciliation_date>=r.deposit_date) then
  raise exception using errcode='55000',message='El depósito pertenece a una conciliación cerrada.';
 end if;
 return r;
end$$;

create function public.bank_deposit_options() returns jsonb language plpgsql stable security definer set search_path=pg_catalog,public,pg_temp as $$
begin perform bank_deposit_private.assert_access('view');return bank_deposit_private.bank_deposit_options();end$$;
create function public.bank_deposit_report(p_filters jsonb default '{}'::jsonb) returns jsonb language plpgsql stable security definer set search_path=pg_catalog,public,pg_temp as $$
begin perform bank_deposit_private.assert_access('view');return bank_deposit_private.bank_deposit_report(p_filters);end$$;
create function public.bank_deposit_detail(p_deposit_id bigint) returns jsonb language plpgsql stable security definer set search_path=pg_catalog,public,pg_temp as $$
declare sid bigint;
begin
 sid:=bank_deposit_private.assert_access('view');
 if not exists(select 1 from public.bank_deposit d join public.bank_account b on b.bank_account_id=d.bank_account_id
   join public.journal j on j.journal_id=d.journal_id where d.deposit_id=p_deposit_id and d.subsidiary_id=sid
    and b.subsidiary_id=sid and j.subsidiary_id=sid) then
  raise exception using errcode='42501',message='El depósito no está disponible en la subsidiaria activa.';
 end if;
 return bank_deposit_private.bank_deposit_detail(p_deposit_id);
end$$;
create function public.save_bank_deposit(p_payload jsonb) returns jsonb language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$
declare sid bigint;
begin sid:=bank_deposit_private.assert_access('create');perform bank_deposit_private.validate_payload(p_payload,sid);return bank_deposit_private.save_bank_deposit(p_payload);end$$;
create function public.update_bank_deposit(p_deposit_id bigint,p_payload jsonb) returns jsonb language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$
declare r public.bank_deposit;
begin r:=bank_deposit_private.lock_source(p_deposit_id,'edit');perform bank_deposit_private.validate_payload(p_payload,r.subsidiary_id,r.bank_account_id);return bank_deposit_private.update_bank_deposit(p_deposit_id,p_payload);end$$;
create function public.delete_bank_deposit(p_deposit_id bigint) returns jsonb language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$
declare r public.bank_deposit;
begin
 r:=bank_deposit_private.lock_source(p_deposit_id,'delete');
 perform 1 from public.bank_account b where b.bank_account_id=r.bank_account_id and b.subsidiary_id=r.subsidiary_id for update;
 if not found then raise exception using errcode='42501',message='La cuenta original no está disponible en la subsidiaria activa.';end if;
 return bank_deposit_private.delete_bank_deposit(p_deposit_id);
end$$;

do $$declare p record;t text;
begin
 for p in select tablename,policyname from pg_policies where schemaname='public' and tablename in('bank_deposit','bank_deposit_line') loop
  execute format('drop policy %I on public.%I',p.policyname,p.tablename);
 end loop;
 foreach t in array array['bank_deposit','bank_deposit_line'] loop
  execute format('alter table public.%I enable row level security',t);
  execute format('revoke all on public.%I from public,anon,authenticated',t);
  execute format('grant select on public.%I to authenticated',t);
 end loop;
end$$;
create policy deposit_authorized_read on public.bank_deposit for select to authenticated using(bank_deposit_private.can_read(subsidiary_id));
create policy deposit_line_authorized_read on public.bank_deposit_line for select to authenticated using(exists(
 select 1 from public.bank_deposit d where d.deposit_id=bank_deposit_line.deposit_id and bank_deposit_private.can_read(d.subsidiary_id)));
revoke all on all functions in schema bank_deposit_private from public,anon,authenticated,service_role;
grant execute on function bank_deposit_private.can_read(bigint) to authenticated;
revoke all on function public.bank_deposit_options(),public.bank_deposit_report(jsonb),public.bank_deposit_detail(bigint),
 public.save_bank_deposit(jsonb),public.update_bank_deposit(bigint,jsonb),public.delete_bank_deposit(bigint) from public,anon,authenticated,service_role;
grant execute on function public.bank_deposit_options(),public.bank_deposit_report(jsonb),public.bank_deposit_detail(bigint),
 public.save_bank_deposit(jsonb),public.update_bank_deposit(bigint,jsonb),public.delete_bank_deposit(bigint) to authenticated;
notify pgrst,'reload schema';
