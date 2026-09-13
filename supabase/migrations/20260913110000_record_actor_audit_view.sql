-- Runs as the requesting user: the target table's SELECT grants and RLS apply.
create or replace function public.record_actor_audit(p_table text, p_id text)
returns jsonb language plpgsql security invoker set search_path=pg_catalog,public as $$
declare target regclass; key_name text; key_count integer; result jsonb;
begin
 if p_table !~ '^[a-z][a-z0-9_]*$' or length(p_id)>100 or nullif(p_id,'') is null then
   raise exception 'Registro no válido.';
 end if;
 select c.oid::regclass into target from pg_class c join pg_namespace n on n.oid=c.relnamespace
 where n.nspname='public' and c.relname=p_table and c.relkind in ('r','p');
 if target is null then raise exception 'Registro no disponible.'; end if;
 select count(*),min(a.attname) into key_count,key_name from pg_index i
 cross join lateral unnest(i.indkey) with ordinality k(attnum,position)
 join pg_attribute a on a.attrelid=i.indrelid and a.attnum=k.attnum
 where i.indrelid=target and i.indisprimary and k.position<=i.indnkeyatts;
 if key_count<>1 then raise exception 'El registro requiere una clave individual.'; end if;
 execute format('select jsonb_build_object(
   ''created_by_name'',t.created_by_name,''created_by_email'',t.created_by_email,
   ''actor_type'',t.actor_type,''actor_source'',t.actor_source,
   ''execution_context_id'',t.execution_context_id,
   ''updated_by_name'',t.updated_by_name,''updated_by_email'',t.updated_by_email,
   ''updated_actor_type'',t.updated_actor_type,''updated_actor_source'',t.updated_actor_source,
   ''updated_execution_context_id'',t.updated_execution_context_id)
   from %s t where t.%I::text=$1',target,key_name) into result using p_id;
 return result;
end $$;
revoke all on function public.record_actor_audit(text,text) from public,anon;
grant execute on function public.record_actor_audit(text,text) to authenticated,service_role;
notify pgrst,'reload schema';
