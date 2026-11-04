-- Recognize the existing named Treasury manager role for approved-request
-- execution. Existing action, company, approval, version and batch guards stay
-- in place; this does not grant permissions or change any financial records.
set local lock_timeout='5s';
set local statement_timeout='30s';
do $treasury$
declare target regprocedure:='public.pr_can_execute()'::regprocedure;definition text;
 needle text:=$old$lower(r.role_name)in('tesoreria','tesorería','tesorero','tesorera','treasury')$old$;
 replacement text:=$new$lower(r.role_name)in('tesoreria','tesorería','tesorero','tesorera','treasury','encargado de tesorería','encargado de tesoreria')$new$;
begin
 if md5((select prosrc from pg_proc where oid=target))is distinct from'666702fa211687f487c6cff69f15ed53'then raise exception 'Reviewed Treasury execution helper changed.';end if;
 definition:=pg_get_functiondef(target);
 if(length(definition)-length(replace(definition,needle,'')))/length(needle)<>1 then raise exception 'Unexpected Treasury role whitelist.';end if;
 execute replace(definition,needle,replacement);
end$treasury$;
