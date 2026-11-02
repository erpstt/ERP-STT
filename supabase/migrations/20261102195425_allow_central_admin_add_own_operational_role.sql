-- A central administrator may add a separate operational role to their own
-- account. Existing self-assignment links remain immutable and undeletable,
-- and adding an administrative alias to oneself remains forbidden.
set local lock_timeout='5s';
set local statement_timeout='30s';

do $patch$
declare
 target regprocedure:='public.security_save_access_master(text,jsonb,bigint)'::regprocedure;
 definition text:=replace(pg_get_functiondef(target),E'\r\n',E'\n');
 needle text:=$old$if (p_payload->>'user_id')::bigint=u or not exists$old$;
 replacement text:=$new$if ((p_payload->>'user_id')::bigint=u and (
    id is not null or not access_admin_private.central() or exists(
      select 1 from public.roles self_role
      where self_role.role_id=(p_payload->>'role_id')::bigint
        and lower(btrim(self_role.role_name))in('administrador','administrator','admin')
    )
  )) or not exists$new$;
 occurrences integer;
begin
 occurrences:=(length(definition)-length(replace(definition,needle,'')))/length(needle);
 if occurrences<>1 then
  raise exception 'Unexpected self-role assignment guard: expected 1, found %',occurrences;
 end if;
 execute replace(definition,needle,replacement);
end
$patch$;

notify pgrst,'reload schema';
