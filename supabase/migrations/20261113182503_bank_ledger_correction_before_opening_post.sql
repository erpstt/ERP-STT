-- Keep the strict deletion/reference guard. Only a ledger correction on a
-- zero-balance bank with unposted, never-activated opening drafts is eligible.
create function bank_account_private.can_correct_opening_ledger(p_id bigint)
returns boolean language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$
declare ref record;present boolean;
begin
 -- Posting also locks the opening run. Fail rather than race a concurrent post.
 perform 1 from public.opening_balance_runs r where exists(
  select 1 from public.opening_bank_accounts o where o.run_id=r.id and o.bank_account_id=p_id
 )order by r.id for update nowait;
 if exists(select 1 from public.opening_bank_accounts o left join public.opening_balance_runs r on r.id=o.run_id
  where o.bank_account_id=p_id and(o.is_active is distinct from false or o.activated_at is not null
   or o.opening_reversed_at is not null or r.id is null or r.status not in('DRAFT','VALIDATED') or r.journal_id is not null))then return false;end if;
 for ref in select n.nspname,c.relname,a.attname,array_length(k.conkey,1) key_count
  from pg_catalog.pg_constraint k join pg_catalog.pg_class c on c.oid=k.conrelid
  join pg_catalog.pg_namespace n on n.oid=c.relnamespace
  join pg_catalog.pg_attribute a on a.attrelid=c.oid and a.attnum=k.conkey[1]
  where k.contype='f' and k.confrelid='public.bank_account'::regclass loop
  if ref.key_count<>1 then return false;end if;
  if ref.nspname='public' and ref.relname='opening_bank_accounts' and ref.attname='bank_account_id'then continue;end if;
  execute format('select exists(select 1 from %I.%I where %I=$1)',ref.nspname,ref.relname,ref.attname)into present using p_id;
  if present then return false;end if;
 end loop;
 return true;
exception when lock_not_available then
 raise exception using errcode='55000',message='El lote de apertura está en uso. Intente guardar la cuenta nuevamente.';
end$$;
revoke all on function bank_account_private.can_correct_opening_ledger(bigint) from public,anon,authenticated,service_role;

do $patch$
declare original text;patched text;guard text:='and (old_row.balance<>0 or bank_account_private.has_references(p_id)) then';
 anchor text:='update public.bank_account set account_number=btrim(new_row.account_number)';
begin
 select prosrc into original from pg_proc where oid='bank_account_private.mutate(bigint,jsonb,text)'::regprocedure;
 if (length(original)-length(replace(original,guard,'')))/length(guard)<>1
  or (length(original)-length(replace(original,anchor,'')))/length(anchor)<>1 then
  raise exception 'La protección de cuentas bancarias no coincide con la versión revisada.';end if;
 patched:=replace(original,guard,$guard$and (old_row.balance<>0 or bank_account_private.has_references(p_id))
   and not(old_row.balance is not distinct from 0::numeric
    and old_row.account_id is distinct from new_row.account_id
    and row(old_row.bank_id,old_row.country_id,old_row.currency_id,old_row.is_credit_card)
      is not distinct from row(new_row.bank_id,new_row.country_id,new_row.currency_id,new_row.is_credit_card)
    and bank_account_private.can_correct_opening_ledger(p_id)) then$guard$);
 patched:=replace(patched,anchor,$invalidate$if old_row.account_id is distinct from new_row.account_id then
   update public.opening_balance_runs r set status='DRAFT'
   where r.status='VALIDATED' and r.journal_id is null and exists(
    select 1 from public.opening_bank_accounts o where o.run_id=r.id and o.bank_account_id=p_id
     and not o.is_active and o.activated_at is null and o.opening_reversed_at is null);
  end if;
  $invalidate$||anchor);
 execute format('create or replace function bank_account_private.mutate(p_id bigint,p_payload jsonb,p_action text)returns jsonb language plpgsql security definer set search_path=pg_catalog,public,pg_temp as %L',patched);
end $patch$;
