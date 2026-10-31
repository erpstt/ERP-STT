-- C-04: bank account metadata is a guarded API; balances are posted by accounting.
set local lock_timeout='5s';
set local statement_timeout='30s';
create schema bank_account_private;
revoke all on schema bank_account_private from public,anon,authenticated,service_role;

create function bank_account_private.assert_access(p_action text)
returns bigint language plpgsql stable security definer set search_path=pg_catalog,public,pg_temp as $$
declare sid bigint:=public.active_subsidiary_id();
begin
 if auth.uid() is null or public.app_user_id() is null or public.app_active_role_id() is null or sid is null then
  raise exception using errcode='42501',message='Seleccione un usuario, rol y subsidiaria autorizados.';
 end if;
 perform public.security_assert_role_access('banking:bank-accounts',p_action);
 return sid;
end$$;

-- Called only after a FOR UPDATE lock, which conflicts with new FK references.
-- Discover all referencing tables rather than omit opening balances or future modules.
create function bank_account_private.has_references(p_id bigint)
returns boolean language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$
declare ref record;present boolean;
begin
 for ref in select n.nspname,c.relname,a.attname,array_length(k.conkey,1) key_count
  from pg_catalog.pg_constraint k join pg_catalog.pg_class c on c.oid=k.conrelid
  join pg_catalog.pg_namespace n on n.oid=c.relnamespace
  join pg_catalog.pg_attribute a on a.attrelid=c.oid and a.attnum=k.conkey[1]
  where k.contype='f' and k.confrelid='public.bank_account'::regclass loop
  if ref.key_count<>1 then return true;end if;
  execute format('select exists(select 1 from %I.%I where %I=$1)',ref.nspname,ref.relname,ref.attname) into present using p_id;
  if present then return true;end if;
 end loop;
 return false;
end$$;

create function bank_account_private.mutate(p_id bigint,p_payload jsonb,p_action text)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$
declare sid bigint;old_row public.bank_account;new_row public.bank_account;data jsonb;
begin
 if p_action not in('create','edit','delete') then raise exception using errcode='22023',message='Acción inválida.';end if;
 sid:=bank_account_private.assert_access(p_action);
 if p_action<>'create' then
  if p_id is null or p_id<=0 then raise exception using errcode='22023',message='Seleccione una cuenta válida.';end if;
  select * into old_row from public.bank_account b where b.bank_account_id=p_id and b.subsidiary_id=sid for update;
  if not found then raise exception using errcode='42501',message='La cuenta no está disponible en la subsidiaria activa.';end if;
 end if;
 if p_action='delete' then
  if old_row.balance<>0 or bank_account_private.has_references(p_id) then
   raise exception using errcode='55000',message='No se puede eliminar una cuenta con saldo o documentos vinculados.';
  end if;
  delete from public.bank_account where bank_account_id=p_id;
  return jsonb_build_object('success',true);
 end if;
 if p_payload is null or jsonb_typeof(p_payload)<>'object' then raise exception using errcode='22023',message='Datos de cuenta inválidos.';end if;
 if exists(select 1 from jsonb_object_keys(p_payload) k where k not in('country_id','bank_id','subsidiary_id','currency_id','account_id','account_number','iban','is_credit_card','balance')) then
  raise exception using errcode='22023',message='La solicitud contiene campos no permitidos.';
 end if;
 if p_payload?'balance' and (p_action='edit' or (p_payload->>'balance')::numeric is distinct from 0::numeric) then
  raise exception using errcode='22023',message='El saldo se modifica mediante procesos contables, no desde el catálogo.';
 end if;
 data:=case when p_action='edit' then to_jsonb(old_row) else jsonb_build_object('is_credit_card',false) end||p_payload;
 select * into new_row from jsonb_populate_record(null::public.bank_account,data);
 if new_row.subsidiary_id is distinct from sid then raise exception using errcode='42501',message='La cuenta debe pertenecer a la subsidiaria activa.';end if;
 if nullif(btrim(new_row.account_number),'') is null then raise exception using errcode='22023',message='Indique un número de cuenta.';end if;
 if not exists(select 1 from public.subsidiaries s join public.banks b on b.bank_id=new_row.bank_id and b.country_id=s.country_id
  where s.subsidiary_id=sid and s.is_active and s.country_id=new_row.country_id) then
  raise exception using errcode='42501',message='Banco, país y subsidiaria deben corresponder.';
 end if;
 if not exists(select 1 from public.currencies c where c.currency_id=new_row.currency_id)
  or not exists(select 1 from public.chart_accounts a join public.account_subsidiaries s using(account_id)
   where a.account_id=new_row.account_id and s.subsidiary_id=sid and s.is_active
   and not coalesce(a.is_inactive,false) and not coalesce(a.is_summary,false) and coalesce(a.accepts_entries,true)
   and (a.currency_id is null or a.currency_id=new_row.currency_id)) then
  raise exception using errcode='42501',message='La moneda o cuenta contable no está habilitada para esta subsidiaria.';
 end if;
 if p_action='create' then
  insert into public.bank_account(account_number,iban,bank_id,subsidiary_id,currency_id,account_id,country_id,is_credit_card,balance)
   values(btrim(new_row.account_number),nullif(btrim(new_row.iban),''),new_row.bank_id,sid,new_row.currency_id,new_row.account_id,new_row.country_id,coalesce(new_row.is_credit_card,false),0)
   returning * into new_row;
 else
  if row(old_row.bank_id,old_row.country_id,old_row.currency_id,old_row.account_id,old_row.is_credit_card)
   is distinct from row(new_row.bank_id,new_row.country_id,new_row.currency_id,new_row.account_id,new_row.is_credit_card)
   and (old_row.balance<>0 or bank_account_private.has_references(p_id)) then
   raise exception using errcode='55000',message='No se puede cambiar banco, país, moneda, cuenta contable o tipo de una cuenta con saldo o documentos vinculados.';
  end if;
  update public.bank_account set account_number=btrim(new_row.account_number),iban=nullif(btrim(new_row.iban),''),bank_id=new_row.bank_id,
   currency_id=new_row.currency_id,account_id=new_row.account_id,country_id=new_row.country_id,is_credit_card=coalesce(new_row.is_credit_card,false)
   where bank_account_id=p_id returning * into new_row;
 end if;
 return to_jsonb(new_row);
end$$;

create function public.create_bank_account(p_payload jsonb) returns jsonb language sql security definer set search_path=pg_catalog,public,pg_temp as $$
 select bank_account_private.mutate(null,p_payload,'create')
$$;
create function public.update_bank_account(p_bank_account_id bigint,p_payload jsonb) returns jsonb language sql security definer set search_path=pg_catalog,public,pg_temp as $$
 select bank_account_private.mutate(p_bank_account_id,p_payload,'edit')
$$;
create function public.delete_bank_account(p_bank_account_id bigint) returns jsonb language sql security definer set search_path=pg_catalog,public,pg_temp as $$
 select bank_account_private.mutate(p_bank_account_id,null,'delete')
$$;
revoke all on all functions in schema bank_account_private from public,anon,authenticated,service_role;
revoke all on function public.create_bank_account(jsonb),public.update_bank_account(bigint,jsonb),public.delete_bank_account(bigint) from public,anon,authenticated,service_role;
grant execute on function public.create_bank_account(jsonb),public.update_bank_account(bigint,jsonb),public.delete_bank_account(bigint) to authenticated;

-- Keep existing SELECT semantics for reports/selectors. Read authorization is separate C-04 work.
alter table public.bank_account enable row level security;
do $$declare p record;col record;
begin
 for p in select * from pg_policies where schemaname='public' and tablename='bank_account' and cmd<>'SELECT' loop
  if p.cmd='ALL' then raise exception 'Review combined SELECT/write policy before applying bank account migration';end if;
  execute format('drop policy %I on public.bank_account',p.policyname);
 end loop;
 for col in select attname from pg_attribute where attrelid='public.bank_account'::regclass and attnum>0 and not attisdropped loop
  execute format('revoke insert(%I),update(%I),references(%I) on public.bank_account from public,anon,authenticated,service_role',col.attname,col.attname,col.attname);
 end loop;
end$$;
revoke insert,update,delete,truncate,references,trigger on public.bank_account from public,anon,authenticated,service_role;
revoke select on public.bank_account from public,anon;
notify pgrst,'reload schema';
