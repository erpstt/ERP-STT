-- C-04: interactive checks/outgoing transfers, retaining posting and payment-request callers.
set local lock_timeout='5s';
set local statement_timeout='30s';
create schema bank_check_private;
revoke all on schema bank_check_private from public,anon,authenticated,service_role;
grant usage on schema bank_check_private to authenticated;
alter function public.bank_check_options() set schema bank_check_private;
alter function public.bank_check_periods() set schema bank_check_private;
alter function public.bank_check_report(jsonb) set schema bank_check_private;
alter function public.bank_check_detail(bigint) set schema bank_check_private;
alter function public.save_bank_check_transfer(jsonb,bigint) set schema bank_check_private;
alter function public.save_bank_check_transfer_without_tax_agency(jsonb,bigint) set schema bank_check_private;
alter function public.delete_bank_check_transfer(bigint) set schema bank_check_private;

create function bank_check_private.assert_access(p_action text)
returns bigint language plpgsql stable security definer set search_path=pg_catalog,public,pg_temp as $$
declare sid bigint:=public.active_subsidiary_id();
begin
 if auth.uid() is null or public.app_user_id() is null or public.app_active_role_id() is null or sid is null then
  raise exception using errcode='42501',message='Seleccione un usuario, rol y subsidiaria autorizados.';
 end if;
 perform public.security_assert_role_access('banking:bank-checks',p_action);
 return sid;
end$$;

create function bank_check_private.can_read(p_id bigint)
returns boolean language plpgsql stable security definer set search_path=pg_catalog,public,pg_temp as $$
declare sid bigint;
begin
 sid:=bank_check_private.assert_access('view');
 return exists(select 1 from public.bank_check h join public.bank_account b using(bank_account_id)
  join public.journal j on j.journal_id=h.journal_id join public."transaction" t on t.transaction_id=h.transaction_id
  where h.check_id=p_id and h.subsidiary_id=sid and b.subsidiary_id=sid and j.subsidiary_id=sid and t.subsidiary_id=sid and j.transaction_id=t.transaction_id);
exception when insufficient_privilege then return false;
end$$;

do $$declare f regprocedure;body text;modified text;
begin
 for f in select p.oid::regprocedure from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='bank_check_private' loop
  execute format('alter function %s set search_path=pg_catalog,public,pg_temp',f);
 end loop;
 body:=pg_get_functiondef('bank_check_private.save_bank_check_transfer(jsonb,bigint)'::regprocedure);
 modified:=replace(body,'public.save_bank_check_transfer_without_tax_agency(','bank_check_private.save_bank_check_transfer_without_tax_agency(');
 if body=modified then raise exception 'Unexpected tax-agency posting wrapper';end if;execute modified;
 body:=pg_get_functiondef('bank_check_private.save_bank_check_transfer_without_tax_agency(jsonb,bigint)'::regprocedure);
 modified:=replace(body,'ba.balance+old.amount<total','ba.balance+(case when ba.bank_account_id=old.bank_account_id then old.amount else 0 end)<total');
 if body=modified then raise exception 'Unexpected check funds calculation';end if;
 body:=modified;
 modified:=replace(body,'update bank_transaction set tran_date=d,value_date=d,','update bank_transaction set tran_type=kind,beneficiary=nullif(p_payload->>''beneficiary'',''''),tran_date=d,value_date=d,');
 if body=modified then raise exception 'Unexpected bank movement update';end if;execute modified;
 body:=pg_get_functiondef('bank_check_private.bank_check_report(jsonb)'::regprocedure);
 modified:=replace(body,'where h.subsidiary_id=active_subsidiary_id()','where bank_check_private.can_read(h.check_id) and h.subsidiary_id=active_subsidiary_id()');
 if body=modified then raise exception 'Unexpected check report';end if;execute modified;
 -- Existing payment requests retain their own authorization and do not acquire a new catalog permission.
 body:=pg_get_functiondef('public.pr_execute_without_budget(jsonb)'::regprocedure);
 modified:=replace(body,'public.save_bank_check_transfer(','bank_check_private.save_bank_check_transfer(');
 if body=modified then raise exception 'Unexpected payment request check caller';end if;execute modified;
end$$;

create function bank_check_private.validate_payload(p_payload jsonb,p_sid bigint,p_old public.bank_check default null)
returns void language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$
declare ba public.bank_account;line jsonb;amount numeric;rate numeric;total numeric:=0;field text;kind text;entity_kind text;loc bigint;
begin
 if p_payload is null or jsonb_typeof(p_payload)<>'object' or jsonb_typeof(p_payload->'lines') is distinct from 'array' then
  raise exception using errcode='22023',message='El egreso requiere encabezado y líneas válidas.';
 end if;
 if jsonb_array_length(p_payload->'lines')=0 or p_payload->>'payment_type' is null or p_payload->>'payment_type' not in('CHEQUE','TRANSFERENCIA')
  or nullif(btrim(p_payload->>'bank_reference'),'') is null then raise exception using errcode='22023',message='Indique tipo, referencia y líneas del egreso.';end if;
 perform 1 from public.bank_account b where b.bank_account_id in((p_payload->>'bank_account_id')::bigint,p_old.bank_account_id)
  and b.subsidiary_id=p_sid order by b.bank_account_id for update;
 select * into ba from public.bank_account b where b.bank_account_id=(p_payload->>'bank_account_id')::bigint and b.subsidiary_id=p_sid;
 if not found or ba.currency_id is distinct from (p_payload->>'currency_id')::bigint or coalesce(ba.is_credit_card,false) then
  raise exception using errcode='42501',message='La cuenta bancaria o moneda no está disponible para este egreso.';
 end if;
 if p_old.bank_account_id is not null and not exists(select 1 from public.bank_account b where b.bank_account_id=p_old.bank_account_id and b.subsidiary_id=p_sid) then
  raise exception using errcode='42501',message='La cuenta bancaria original no está disponible.';
 end if;
 if not exists(select 1 from public.chart_accounts a join public.account_subsidiaries s using(account_id)
  where a.account_id=ba.account_id and s.subsidiary_id=p_sid and s.is_active and not coalesce(a.is_inactive,false)
   and not coalesce(a.is_summary,false) and coalesce(a.accepts_entries,true) and (a.currency_id is null or a.currency_id=ba.currency_id)) then
  raise exception using errcode='42501',message='La cuenta contable del banco no está habilitada para la subsidiaria.';
 end if;
 rate:=(p_payload->>'exchange_rate')::numeric;
 if rate is null or rate<=0 or rate::text in('NaN','Infinity','-Infinity') then raise exception using errcode='22023',message='El tipo de cambio debe ser positivo y finito.';end if;
 if not exists(select 1 from public.fiscal_periods f where f.fiscal_period_id=(p_payload->>'fiscal_period_id')::bigint and f.subsidiary_id=p_sid
  and (p_payload->>'payment_date')::date between f.start_date and f.end_date and not coalesce(f.is_closed,false)
  and not coalesce(f.gl_closed,false) and not coalesce(f.is_inactive,false)) then
  raise exception using errcode='55000',message='El período debe estar abierto y corresponder a fecha y subsidiaria.';
 end if;
 loc:=nullif(p_payload->>'location_id','')::bigint;
 if exists(select 1 from public.bank_reconciliation b where b.bank_account_id=ba.bank_account_id and b.status='CERRADA' and b.reconciliation_date>=(p_payload->>'payment_date')::date) then
  raise exception using errcode='55000',message='La fecha del egreso pertenece a una conciliación cerrada.';
 end if;
 if loc is not null and not exists(select 1 from public.locations l where l.location_id=loc and (l.subsidiary_id=p_sid or l.subsidiary_id is null)) then
  raise exception using errcode='42501',message='La ubicación no está disponible en la subsidiaria activa.';
 end if;
 for line in select value from jsonb_array_elements(p_payload->'lines') loop
  amount:=(line->>'amount')::numeric;
  if amount is null or amount<=0 or amount::text in('NaN','Infinity','-Infinity') then raise exception using errcode='22023',message='Los importes deben ser positivos y finitos.';end if;
  total:=total+amount;
  if not exists(select 1 from public.chart_accounts a join public.account_subsidiaries s using(account_id)
   where a.account_id=(line->>'account_id')::bigint and s.subsidiary_id=p_sid and s.is_active and not coalesce(a.is_inactive,false)
   and not coalesce(a.is_summary,false) and coalesce(a.accepts_entries,true) and (a.currency_id is null or a.currency_id=ba.currency_id)) then
   raise exception using errcode='42501',message='La cuenta de contrapartida no está habilitada para esta subsidiaria y moneda.';
  end if;
  entity_kind:=nullif(line->>'entity_type','');
  if entity_kind='Agencia Tributaria' then
   if not exists(select 1 from public.tax_agency_subsidiaries s join public.tax_agencies a using(tax_agency_id)
    join public.subsidiaries sub on sub.subsidiary_id=s.subsidiary_id where s.subsidiary_id=p_sid
    and s.tax_agency_id=(line->>'entity_id')::bigint and a.country_id=sub.country_id) then
    raise exception using errcode='42501',message='La agencia tributaria no está habilitada para esta subsidiaria.';
   end if;
  elsif entity_kind is not null then
   if entity_kind not in('Cliente','Proveedor','Empleado') or nullif(line->>'entity_id','') is null then raise exception using errcode='22023',message='Seleccione una entidad válida.';end if;
   perform public.journal_csv_lookup(entity_kind,'ID:'||(line->>'entity_id'));
  elsif nullif(line->>'entity_id','') is not null then raise exception using errcode='22023',message='Indique el tipo de entidad.';
  end if;
  for field,kind in select * from (values('department_id','departamento'),('class_id','clase'),('cost_center_id','centro_costos'),
   ('financial_creditor_id','acreedor_financiero'),('related_company_id','compania_relacionada')) refs(field,kind) loop
   if nullif(line->>field,'') is not null then perform public.journal_csv_lookup(kind,'ID:'||(line->>field));end if;
  end loop;
 end loop;
 if ba.balance is null or ba.balance::text in('NaN','Infinity','-Infinity') or total>ba.balance+(case when p_old.bank_account_id=ba.bank_account_id then p_old.amount else 0 end) then
  raise exception using errcode='55000',message='La cuenta de destino del egreso no dispone de saldo suficiente.';
 end if;
exception when raise_exception then raise exception using errcode='42501',message='Una entidad o dimensión no está disponible en la subsidiaria activa.';
end$$;

create function bank_check_private.lock_source(p_id bigint,p_action text)
returns public.bank_check language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$
declare sid bigint;r public.bank_check;
begin
 sid:=bank_check_private.assert_access(p_action);
 select * into r from public.bank_check h where h.check_id=p_id and h.subsidiary_id=sid for update;
 if not found then raise exception using errcode='42501',message='El egreso no está disponible en la subsidiaria activa.';end if;
 perform 1 from public.journal j join public."transaction" t on t.transaction_id=j.transaction_id
  join public.bank_account b on b.bank_account_id=r.bank_account_id
  where j.journal_id=r.journal_id and t.transaction_id=r.transaction_id and j.subsidiary_id=sid and t.subsidiary_id=sid and b.subsidiary_id=sid
   and exists(select 1 from public.transaction_types tt where tt.transaction_type_id=t.transaction_type_id and tt.abbreviation='CHQ_TRF')
   and j.status='CONTABILIZADO' and j.journal_type=r.payment_type and r.status='APROBADA' and j.journal_number=r.check_number and t.tran_number=r.check_number
   and j.fiscal_period_id=r.fiscal_period_id and t.fiscal_period_id=r.fiscal_period_id
   and j.currency_id=r.currency_id and t.currency_id=r.currency_id and b.currency_id=r.currency_id
   and j.journal_date=r.payment_date and t.tran_date=r.payment_date
   and t.total_amount=r.amount and r.amount>0 and r.amount::text not in('NaN','Infinity','-Infinity') for update of j,t;
 if not found then raise exception using errcode='42501',message='El origen contable del egreso requiere revisión.';end if;
 if exists(select 1 from public.bank_check other where other.check_id<>r.check_id and (other.journal_id=r.journal_id or other.transaction_id=r.transaction_id)) then
  raise exception using errcode='42501',message='El origen contable está compartido y requiere revisión.';
 end if;
 if not exists(select 1 from public.fiscal_periods f where f.fiscal_period_id=r.fiscal_period_id and f.subsidiary_id=sid
  and not coalesce(f.is_closed,false) and not coalesce(f.gl_closed,false) and not coalesce(f.is_inactive,false)) then
  raise exception using errcode='55000',message='El período original del egreso está cerrado o inactivo.';
 end if;
 perform 1 from public.bank_transaction bt where bt.transaction_id=r.transaction_id for update;
 if (select count(*) from public.bank_transaction bt where bt.transaction_id=r.transaction_id)<>1 or exists(
  select 1 from public.bank_transaction bt where bt.transaction_id=r.transaction_id and (bt.bank_account_id is distinct from r.bank_account_id
   or bt.tran_type is distinct from r.payment_type or bt.amount is distinct from -r.amount or bt.tran_date is distinct from r.payment_date
   or bt.reconciliation_status is distinct from 'PENDIENTE_EN_TRANSITO')) then
  raise exception using errcode='55000',message='El movimiento bancario está conciliado o requiere revisión de integridad.';
 end if;
 if exists(select 1 from public.bank_reconciliation b where b.bank_account_id=r.bank_account_id and b.status='CERRADA' and b.reconciliation_date>=r.payment_date) then
  raise exception using errcode='55000',message='El egreso pertenece a una conciliación cerrada.';
 end if;
 return r;
end$$;

create function public.bank_check_options() returns jsonb language plpgsql stable security definer set search_path=pg_catalog,public,pg_temp as $$
begin perform bank_check_private.assert_access('view');return bank_check_private.bank_check_options();end$$;
create function public.bank_check_periods() returns jsonb language plpgsql stable security definer set search_path=pg_catalog,public,pg_temp as $$
begin perform bank_check_private.assert_access('view');return bank_check_private.bank_check_periods();end$$;
create function public.bank_check_report(p_filters jsonb default '{}'::jsonb) returns jsonb language plpgsql stable security definer set search_path=pg_catalog,public,pg_temp as $$
begin perform bank_check_private.assert_access('view');return bank_check_private.bank_check_report(p_filters);end$$;
create function public.bank_check_detail(p_check_id bigint) returns jsonb language plpgsql stable security definer set search_path=pg_catalog,public,pg_temp as $$
begin perform bank_check_private.assert_access('view');if not bank_check_private.can_read(p_check_id) then raise exception using errcode='42501',message='El egreso no está disponible en la subsidiaria activa.';end if;return bank_check_private.bank_check_detail(p_check_id);end$$;
create function public.save_bank_check_transfer(p_payload jsonb,p_check_id bigint default null) returns jsonb language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$
declare sid bigint;r public.bank_check;
begin
 if p_check_id is null then sid:=bank_check_private.assert_access('create');else r:=bank_check_private.lock_source(p_check_id,'edit');sid:=r.subsidiary_id;end if;
 perform bank_check_private.validate_payload(p_payload,sid,r);
 return bank_check_private.save_bank_check_transfer(p_payload,p_check_id);
end$$;
create function public.delete_bank_check_transfer(p_check_id bigint) returns jsonb language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$
declare r public.bank_check;
begin r:=bank_check_private.lock_source(p_check_id,'delete');perform 1 from public.bank_account b where b.bank_account_id=r.bank_account_id and b.subsidiary_id=r.subsidiary_id for update;return bank_check_private.delete_bank_check_transfer(p_check_id);end$$;

do $$declare p record;t text;col record;
begin
 for p in select tablename,policyname from pg_policies where schemaname='public' and tablename in('bank_check','bank_check_line') loop
  execute format('drop policy %I on public.%I',p.policyname,p.tablename);
 end loop;
 foreach t in array array['bank_check','bank_check_line'] loop
  execute format('alter table public.%I enable row level security',t);
  execute format('revoke all on public.%I from public,anon,authenticated,service_role',t);
  for col in select attname from pg_attribute where attrelid=('public.'||t)::regclass and attnum>0 and not attisdropped loop
   execute format('revoke all(%I) on public.%I from public,anon,authenticated,service_role',col.attname,t);
  end loop;
  execute format('grant select on public.%I to authenticated',t);
 end loop;
end$$;
create policy check_authorized_read on public.bank_check for select to authenticated using(bank_check_private.can_read(check_id));
create policy check_line_authorized_read on public.bank_check_line for select to authenticated using(bank_check_private.can_read(check_id));
revoke all on all functions in schema bank_check_private from public,anon,authenticated,service_role;
grant execute on function bank_check_private.can_read(bigint) to authenticated;
revoke all on function public.bank_check_options(),public.bank_check_periods(),public.bank_check_report(jsonb),public.bank_check_detail(bigint),public.save_bank_check_transfer(jsonb,bigint),public.delete_bank_check_transfer(bigint) from public,anon,authenticated,service_role;
grant execute on function public.bank_check_options(),public.bank_check_periods(),public.bank_check_report(jsonb),public.bank_check_detail(bigint),public.save_bank_check_transfer(jsonb,bigint),public.delete_bank_check_transfer(bigint) to authenticated;
notify pgrst,'reload schema';
