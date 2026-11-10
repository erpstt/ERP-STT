-- Describe the existing fiscal closure permission and authoritative deletion
-- blockers. This changes no role grants, period states or closure policy.
do $patch$
declare definition text;needle text;replacement text;
begin
 if not exists(select 1 from pg_proc where oid=to_regprocedure('fiscal_structure_private.options(text)')and md5(prosrc)='4b5e040076fd4f73f1509cef81b34289')
 or not exists(select 1 from pg_proc where oid=to_regprocedure('fiscal_structure_private.dto(text,bigint)')and md5(prosrc)='53484687bfab9fb1721510221bbc9b37')
 or not exists(select 1 from pg_proc where oid=to_regprocedure('fiscal_structure_private.closure_allowed()')and md5(prosrc)='de88c590691005e3c1ba976ccadbb803')
 or to_regprocedure('access_admin_private.allowed(text,text)')is null then
  raise exception 'Unexpected fiscal structure capabilities before clarification';
 end if;
 definition:=pg_get_functiondef('fiscal_structure_private.options(text)'::regprocedure);
 needle:=$body$'canManageClosure',fiscal_structure_private.closure_allowed(),'references'$body$;
 replacement:=$body$'canManageClosure',fiscal_structure_private.closure_allowed(),
 'canConfigureClosurePermission',access_admin_private.allowed('role-access-matrix','edit'),
 'requiredClosurePermission',jsonb_build_object('code','CONF_PERIODOS_FISCALES_CERRAR','label','Cerrar y reabrir períodos fiscales'),
 'closureBlockedReason',case when fiscal_structure_private.closure_allowed()then null else 'MISSING_CLOSURE_PERMISSION'end,'references'$body$;
 if(length(definition)-length(replace(definition,needle,'')))/length(needle)<>1 then raise exception 'Unexpected fiscal closure capability boundary';end if;
 execute replace(definition,needle,replacement);
 definition:=pg_get_functiondef('fiscal_structure_private.dto(text,bigint)'::regprocedure);
 needle:=$body$'canDelete',organization_master_private.allowed(k,'delete')and fiscal_structure_private.writable(k,id)and not entity_master_private.used(c.t,id)$body$;
 replacement:=$body$'canDelete',organization_master_private.allowed(k,'delete')and fiscal_structure_private.writable(k,id)and not coalesce((r->>'is_closed')::boolean,false)and not entity_master_private.used(c.t,id),
 'deleteBlockedReason',case
 when not organization_master_private.allowed(k,'delete')or not fiscal_structure_private.writable(k,id)then 'NOT_AUTHORIZED'
 when coalesce((r->>'is_closed')::boolean,false)then 'CLOSED'
 when entity_master_private.used(c.t,id)then 'REFERENCED'
 else null end$body$;
 if(length(definition)-length(replace(definition,needle,'')))/length(needle)<>1 then raise exception 'Unexpected fiscal deletion capability boundary';end if;
 execute replace(definition,needle,replacement);
end $patch$;
notify pgrst,'reload schema';
