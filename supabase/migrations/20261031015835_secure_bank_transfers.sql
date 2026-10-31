-- C-04 / bank transfers only. No financial rows are changed by this migration.
set local lock_timeout='5s';
set local statement_timeout='30s';
create schema bank_transfer_private;
revoke all on schema bank_transfer_private from public,anon,authenticated,service_role;
grant usage on schema bank_transfer_private to authenticated;

alter function public.bank_transfer_options() set schema bank_transfer_private;
alter function public.create_bank_transfer(jsonb) set schema bank_transfer_private;
alter function public.run_bank_transfer_report(jsonb) set schema bank_transfer_private;
alter function public.bank_transfer_journal(bigint) set schema bank_transfer_private;
alter function bank_transfer_private.bank_transfer_options() set search_path=pg_catalog,public,pg_temp;
alter function bank_transfer_private.create_bank_transfer(jsonb) set search_path=pg_catalog,public,pg_temp;
alter function bank_transfer_private.run_bank_transfer_report(jsonb) set search_path=pg_catalog,public,pg_temp;
alter function bank_transfer_private.bank_transfer_journal(bigint) set search_path=pg_catalog,public,pg_temp;

-- Do not expose account details if a legacy transfer has inconsistent pointers.
do $$declare original text;modified text;
begin
  original:=pg_get_functiondef('bank_transfer_private.run_bank_transfer_report(jsonb)'::regprocedure);
  modified:=replace(original,'where bt.subsidiary_id=sid and bt.status=',
    'where bt.subsidiary_id=sid and sa.subsidiary_id=sid and da.subsidiary_id=sid and bt.status=');
  if modified=original then raise exception 'Unexpected bank transfer report definition; review before applying.';end if;
  execute modified;
end$$;

create function bank_transfer_private.assert_access(p_action text)
returns bigint language plpgsql stable security definer set search_path=pg_catalog,public,pg_temp as $$
declare sid bigint:=public.active_subsidiary_id();uid bigint:=public.app_user_id();
begin
  if auth.uid() is null or uid is null or public.app_active_role_id() is null or sid is null
    or not exists(select 1 from public.user_subsidiaries m where m.user_id=uid and m.subsidiary_id=sid) then
    raise exception using errcode='42501',message='Seleccione un rol y una subsidiaria autorizados para operar transferencias.';
  end if;
  perform public.security_assert_role_access('banking:bank-transfers',p_action);
  return sid;
end$$;

create function bank_transfer_private.can_read(p_subsidiary bigint)
returns boolean language plpgsql stable security definer set search_path=pg_catalog,public,pg_temp as $$
begin
  return p_subsidiary=bank_transfer_private.assert_access('view');
exception when insufficient_privilege then return false;
end$$;

create function public.bank_transfer_options()
returns jsonb language plpgsql stable security definer set search_path=pg_catalog,public,pg_temp as $$
begin
  perform bank_transfer_private.assert_access('view');
  return bank_transfer_private.bank_transfer_options();
end$$;

create function public.create_bank_transfer(p_payload jsonb)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$
declare sid bigint;src bigint;dst bigint;fee_account bigint;sa numeric;da numeric;fee numeric;
begin
  sid:=bank_transfer_private.assert_access('create');
  if p_payload is null or jsonb_typeof(p_payload)<>'object' then
    raise exception using errcode='22023',message='La transferencia requiere un objeto de datos válido.';
  end if;
  src:=(p_payload->>'sourceAccountId')::bigint;dst:=(p_payload->>'destinationAccountId')::bigint;
  sa:=(p_payload->>'sourceAmount')::numeric;da:=(p_payload->>'destinationAmount')::numeric;
  fee:=coalesce(nullif(p_payload->>'commissionAmount','')::numeric,0);
  if src is null or dst is null or src=dst or sa is null or da is null or sa<=0 or da<=0 or fee<0
    or sa::text in ('NaN','Infinity','-Infinity') or da::text in ('NaN','Infinity','-Infinity')
    or fee::text in ('NaN','Infinity','-Infinity') then
    raise exception using errcode='22023',message='Seleccione cuentas distintas y montos positivos y finitos.';
  end if;
  -- Lock only authorized accounts, in a consistent order, before validating ledger references.
  perform 1 from public.bank_account a where a.bank_account_id in(src,dst) and a.subsidiary_id=sid
    order by a.bank_account_id for update;
  if (select count(*) from public.bank_account a where a.bank_account_id in(src,dst) and a.subsidiary_id=sid)<>2 then
    raise exception using errcode='42501',message='Las cuentas bancarias no están disponibles en la subsidiaria activa.';
  end if;
  if exists(select 1 from public.bank_account b where b.bank_account_id in(src,dst) and not exists(
    select 1 from public.chart_accounts a join public.account_subsidiaries m using(account_id)
    where a.account_id=b.account_id and m.subsidiary_id=sid and m.is_active and not a.is_inactive and not a.is_summary
  )) then raise exception using errcode='42501',message='Las cuentas contables deben estar habilitadas para la subsidiaria activa.';end if;
  if fee>0 then
    fee_account:=nullif(p_payload->>'commissionAccountId','')::bigint;
    if not exists(select 1 from public.chart_accounts a join public.account_subsidiaries m using(account_id)
      where a.account_id=fee_account and m.subsidiary_id=sid and m.is_active and not a.is_inactive and not a.is_summary
        and (lower(a.account_name) like '%comisi%' or lower(a.account_name) like '%gasto banc%')) then
      raise exception using errcode='42501',message='La cuenta de comisión no está disponible en la subsidiaria activa.';
    end if;
  end if;
  return bank_transfer_private.create_bank_transfer(p_payload);
end$$;

create function public.run_bank_transfer_report(p_filters jsonb default '{}'::jsonb)
returns jsonb language plpgsql stable security definer set search_path=pg_catalog,public,pg_temp as $$
begin
  perform bank_transfer_private.assert_access('view');
  return bank_transfer_private.run_bank_transfer_report(p_filters);
end$$;

create function public.bank_transfer_journal(p_transfer_id bigint)
returns jsonb language plpgsql stable security definer set search_path=pg_catalog,public,pg_temp as $$
declare sid bigint;
begin
  sid:=bank_transfer_private.assert_access('view');
  if not exists(select 1 from public.bank_transfer t
    join public.journal j on j.journal_id=t.journal_id and j.subsidiary_id=sid
    join public.bank_account src on src.bank_account_id=t.from_account_id and src.subsidiary_id=sid
    join public.bank_account dst on dst.bank_account_id=t.to_account_id and dst.subsidiary_id=sid
    where t.transfer_id=p_transfer_id and t.subsidiary_id=sid) then
    raise exception using errcode='42501',message='La transferencia no está disponible en la subsidiaria activa.';
  end if;
  return bank_transfer_private.bank_transfer_journal(p_transfer_id);
end$$;

do $$declare p record;
begin
  for p in select policyname from pg_policies where schemaname='public' and tablename='bank_transfer' loop
    execute format('drop policy %I on public.bank_transfer',p.policyname);
  end loop;
end$$;
alter table public.bank_transfer enable row level security;
revoke all on public.bank_transfer from public,anon,authenticated;
grant select on public.bank_transfer to authenticated;
create policy bank_transfer_authorized_read on public.bank_transfer for select to authenticated
using(bank_transfer_private.can_read(subsidiary_id));

revoke all on all functions in schema bank_transfer_private from public,anon,authenticated,service_role;
grant execute on function bank_transfer_private.can_read(bigint) to authenticated;
revoke all on function public.bank_transfer_options(),public.create_bank_transfer(jsonb),
  public.run_bank_transfer_report(jsonb),public.bank_transfer_journal(bigint) from public,anon,authenticated,service_role;
grant execute on function public.bank_transfer_options(),public.create_bank_transfer(jsonb),
  public.run_bank_transfer_report(jsonb),public.bank_transfer_journal(bigint) to authenticated;
notify pgrst,'reload schema';
