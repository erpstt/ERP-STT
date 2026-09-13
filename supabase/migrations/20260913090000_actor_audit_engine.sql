-- Actor identity is authoritative auth data; request headers only carry correlation.
create or replace function public.resolve_audit_actor() returns jsonb
language plpgsql stable security definer set search_path=pg_catalog,public as $$
declare claims jsonb:=coalesce(auth.jwt(),'{}'); metadata jsonb; actor_email text; name text;
 actor_id text; kind text; source text; headers jsonb; trace text;
begin
 headers:=coalesce(nullif(current_setting('request.headers',true),'')::jsonb,'{}');
 trace:=coalesce(nullif(headers->>'x-audit-execution-context-id',''),nullif(claims->>'session_id',''),txid_current()::text);
 if length(trace)>100 then raise exception 'El identificador de ejecución supera 100 caracteres.'; end if;
 if nullif(claims->>'sub','') is not null then
   select u.id::text,u.email,u.raw_app_meta_data into actor_id,actor_email,metadata
   from auth.users u where u.id::text=claims->>'sub';
   if actor_id is null then raise exception 'Actor de auditoría no registrado.'; end if;
   kind:=coalesce(nullif(metadata->>'actor_type',''),'HUMAN');
   source:=coalesce(nullif(metadata->>'actor_source',''),case when kind='HUMAN' then 'Nexo Web App' end);
   select nullif(trim(concat_ws(' ',u.first_name,u.last_name)),'') into name
   from public.users u where lower(u.email)=lower(actor_email) limit 1;
   name:=coalesce(nullif(metadata->>'actor_name',''),name,actor_email);
 elsif claims->>'role'='service_role' then
   kind:='SYSTEM_JOB'; actor_email:='system@nexo.local'; name:='Proceso de sistema Nexo'; source:='Nexo ERP / servicio interno';
 elsif session_user not in ('authenticator','anon','authenticated','service_role') and claims='{}'::jsonb then
   kind:='SYSTEM_JOB'; actor_email:='database@nexo.local'; name:='Proceso de base de datos'; source:='PostgreSQL / '||session_user;
 else
   raise exception 'La escritura requiere un actor autenticado.';
 end if;
 if kind not in ('HUMAN','AI_AGENT','SYSTEM_JOB','EXTERNAL_API') or source is null or actor_email is null or name is null then
   raise exception 'Configure correo, nombre, tipo y origen del actor registrado.';
 end if;
 if length(actor_email)>150 or length(name)>150 or length(source)>100 then raise exception 'Los datos del actor superan los límites de auditoría.'; end if;
 return jsonb_build_object('id',actor_id,'email',actor_email,'name',name,'type',kind,'source',source,'trace',trace);
end $$;
revoke all on function public.resolve_audit_actor() from public,anon,authenticated;

create or replace function public.stamp_actor_audit() returns trigger
language plpgsql security definer set search_path=pg_catalog,public as $$
declare actor jsonb:=public.resolve_audit_actor(); k text; before_data jsonb; after_data jsonb;
begin
 if tg_op='INSERT' then
   new.created_by_id:=actor->>'id'; new.created_by_email:=actor->>'email'; new.created_by_name:=actor->>'name';
   new.actor_type:=actor->>'type'; new.actor_source:=actor->>'source'; new.execution_context_id:=actor->>'trace';
   new.updated_by_id:=null; new.updated_by_email:=null; new.updated_by_name:=null;
   new.updated_actor_type:=null; new.updated_actor_source:=null; new.updated_execution_context_id:=null;
 else
   before_data:=to_jsonb(old); after_data:=to_jsonb(new);
   foreach k in array array['created_by_id','created_by_email','created_by_name','actor_type','actor_source','execution_context_id'] loop
     if before_data->k is distinct from after_data->k then raise exception 'El campo de creación % es inmutable.',k; end if;
   end loop;
   new.updated_by_id:=actor->>'id'; new.updated_by_email:=actor->>'email'; new.updated_by_name:=actor->>'name';
   new.updated_actor_type:=actor->>'type'; new.updated_actor_source:=actor->>'source'; new.updated_execution_context_id:=actor->>'trace';
 end if;
 return new;
end $$;

create or replace function public.reject_audit_mutation() returns trigger
language plpgsql as $$begin raise exception 'La bitácora de auditoría es inmutable.'; end$$;
create or replace function public.reject_audit_truncate() returns trigger
language plpgsql as $$begin raise exception 'TRUNCATE no permite auditoría por registro. Utilice DELETE.'; end$$;

create or replace function public.install_actor_audit(target regclass) returns void
language plpgsql security definer set search_path=pg_catalog,public as $$
declare tbl record; col record; is_log boolean;
begin
 select n.nspname,c.relname,c.relispartition into tbl from pg_class c join pg_namespace n on n.oid=c.relnamespace
 where c.oid=target and c.relkind in ('r','p');
 if not found or tbl.nspname<>'public' then return; end if;
 if tbl.relispartition then
   execute format('create or replace trigger actor_no_truncate before truncate on %s for each statement execute function public.reject_audit_truncate()',target);
   return;
 end if;
 -- Constant historical defaults avoid rewriting all existing business records.
 for col in select * from (values
 ('created_by_id','varchar(36)',null),
 ('created_by_email','varchar(150)','legacy-unknown@nexo.invalid'),
 ('created_by_name','varchar(150)','Registro histórico: autor no disponible'),
 ('actor_type','varchar(30)','SYSTEM_JOB'),
 ('actor_source','varchar(100)','Migración histórica / origen desconocido'),
 ('execution_context_id','varchar(100)',null),
 ('updated_by_id','varchar(36)',null),('updated_by_email','varchar(150)',null),
 ('updated_by_name','varchar(150)',null),('updated_actor_type','varchar(30)',null),
 ('updated_actor_source','varchar(100)',null),('updated_execution_context_id','varchar(100)',null)
 ) as columns(name,definition,legacy_default) loop
   if not exists(select 1 from pg_attribute where attrelid=target and attname=col.name and not attisdropped) then
     execute format('alter table %s add column %I %s%s',target,col.name,col.definition,
       case when col.legacy_default is null then '' else format(' not null default %L',col.legacy_default) end);
     if col.legacy_default is not null then execute format('alter table %s alter column %I drop default',target,col.name); end if;
   end if;
 end loop;
 if not exists(select 1 from pg_constraint where conrelid=target and conname='actor_audit_types') then
   execute format('alter table %s add constraint actor_audit_types check (actor_type in (''HUMAN'',''AI_AGENT'',''SYSTEM_JOB'',''EXTERNAL_API'') and (updated_actor_type is null or updated_actor_type in (''HUMAN'',''AI_AGENT'',''SYSTEM_JOB'',''EXTERNAL_API'')))',target);
 end if;
 execute format('create or replace trigger zzzz_actor_stamp before insert or update on %s for each row execute function public.stamp_actor_audit()',target);
 execute format('create or replace trigger actor_no_truncate before truncate on %s for each statement execute function public.reject_audit_truncate()',target);
 is_log:=tbl.relname in ('audit_log','change_log','event_log','activity_log','deleted_records');
 if is_log then
   execute format('create or replace trigger actor_log_immutable before update or delete on %s for each row execute function public.reject_audit_mutation()',target);
   execute format('revoke insert,update,delete,truncate on %s from anon,authenticated,service_role',target);
 else
   perform public.install_audit_trigger(target);
 end if;
end $$;
revoke all on function public.install_actor_audit(regclass) from public,anon,authenticated,service_role;
revoke all on function public.install_audit_trigger(regclass) from public,anon,authenticated,service_role;

do $$declare t record;begin
 for t in select c.oid::regclass target from pg_class c join pg_namespace n on n.oid=c.relnamespace
 where n.nspname='public' and c.relkind in ('r','p') order by c.relispartition loop
   perform public.install_actor_audit(t.target);
 end loop;
end $$;

create or replace function public.actor_audit_new_table() returns event_trigger
language plpgsql security definer set search_path=pg_catalog,public as $$
declare cmd record;
begin
 for cmd in select * from pg_event_trigger_ddl_commands() where object_type='table' and schema_name='public' loop
   if tg_tag in ('CREATE TABLE AS','SELECT INTO') then raise exception 'Use CREATE TABLE seguido de INSERT para conservar la auditoría por registro.'; end if;
   perform public.install_actor_audit(cmd.objid::regclass);
 end loop;
end $$;
drop event trigger if exists actor_audit_new_table;
create event trigger actor_audit_new_table on ddl_command_end when tag in ('CREATE TABLE','CREATE TABLE AS','SELECT INTO')
execute function public.actor_audit_new_table();
notify pgrst,'reload schema';
