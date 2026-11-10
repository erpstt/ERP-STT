-- Keep Data API entry points at caller privileges. The narrowly scoped,
-- identity-checked authority lives only in a non-exposed private schema.
-- No function body, permission assignment or fiscal-period state is changed.
set local lock_timeout='5s';
do $guard$declare item record;actual text;begin
  if 'fiscal_closure_permission_private'=any(array(select trim(unnest(string_to_array(coalesce(current_setting('pgrst.db_schemas',true),'public'),',')))))
    or exists(select 1 from pg_db_role_setting s cross join lateral unnest(s.setconfig)c
      where c like 'pgrst.db_schemas=%'and 'fiscal_closure_permission_private'=any(array(select trim(unnest(string_to_array(substr(c,length('pgrst.db_schemas=')+1),','))))))then
    raise exception 'Fiscal closure authority schema must not be exposed through the Data API';
  end if;
  for item in select * from(values
    ('fiscal_closure_permission_private.options()','235291caf4a0600b454adb0535ddd6ea'),
    ('fiscal_closure_permission_private.set_permission(boolean,text)','7f00c9648872c79d2f27bf4cda9d0b13'),
    ('public.fiscal_closure_permission_options()','872936be853f6dcb2ff25fbd59b9120e'),
    ('public.set_fiscal_closure_permission(boolean,text)','d71fe59f52770be80fa6e3405fe5ac98'),
    ('access_admin_private.actor()','f459f14ee190a10f3f48ad655b608801'),
    ('access_admin_private.central()','2f75856c6c4e3d80b8a2ff251c075561'),
    ('access_admin_private.access(text,text)','8725395583288a3dabe9ec39afe669b0'),
    ('access_admin_private.allowed(text,text)','996e6857b3c4d74877fdbdc408eed7bf'),
    ('access_admin_private.matrix_revision(bigint)','8407d37581e9f2f47c9a6b202e6b4cfe'),
    ('public.app_user_id()','cd0d2c51e48fc57710a19bfd69ad3208'),
    ('public.app_active_role_id()','636cf36a793bef66b1dc8ec1b66f367b'),
    ('public.active_subsidiary_id()','49104d91b9f738494af73d925158a3cf')
  )v(signature,expected)loop
    select md5(prosrc) into actual from pg_proc where oid=to_regprocedure(item.signature);
    if actual is distinct from item.expected then raise exception 'Reviewed fiscal closure authority changed: %',item.signature;end if;
  end loop;
  if exists(select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where p.oid in('fiscal_closure_permission_private.options()'::regprocedure,
      'fiscal_closure_permission_private.set_permission(boolean,text)'::regprocedure,
      'public.fiscal_closure_permission_options()'::regprocedure,
      'public.set_fiscal_closure_permission(boolean,text)'::regprocedure)
    and(pg_get_userbyid(p.proowner)<>'postgres'
      or p.prosecdef is distinct from(n.nspname='public')
      or exists(select 1 from aclexplode(coalesce(p.proacl,acldefault('f',p.proowner)))a where a.grantee=0 and a.privilege_type='EXECUTE')
      or has_function_privilege('anon',p.oid,'execute')
      or has_function_privilege('service_role',p.oid,'execute')
      or has_function_privilege('authenticated',p.oid,'execute')is distinct from(n.nspname='public')
      or not coalesce('search_path=pg_catalog, public, pg_temp'=any(p.proconfig),false)))then
    raise exception 'Unexpected fiscal closure authority attributes before isolation';
  end if;
end$guard$;

alter function fiscal_closure_permission_private.options() security definer;
alter function fiscal_closure_permission_private.set_permission(boolean,text) security definer;
alter function public.fiscal_closure_permission_options() security invoker;
alter function public.set_fiscal_closure_permission(boolean,text) security invoker;

revoke all on schema fiscal_closure_permission_private from public,anon,authenticated,service_role;
grant usage on schema fiscal_closure_permission_private to authenticated;
revoke all on function fiscal_closure_permission_private.options(),fiscal_closure_permission_private.set_permission(boolean,text) from public,anon,authenticated,service_role;
grant execute on function fiscal_closure_permission_private.options(),fiscal_closure_permission_private.set_permission(boolean,text) to authenticated;
-- Preserve the two public caller-privilege entry points for signed-in clients.
revoke all on function public.fiscal_closure_permission_options(),public.set_fiscal_closure_permission(boolean,text) from public,anon,authenticated,service_role;
grant execute on function public.fiscal_closure_permission_options(),public.set_fiscal_closure_permission(boolean,text) to authenticated;
notify pgrst,'reload schema';
