-- Expansion: protect audit values before exposing configuration RPCs.
do $$begin if md5((select prosrc from pg_proc where oid='public.audit_field_is_sensitive(text)'::regprocedure))is distinct from'cff63da5ced52d69b7d4efe36784ea5c'then raise exception 'Reviewed audit classifier changed; inspect before extending.';end if;end$$;
create or replace function public.audit_field_is_sensitive(p_field text)returns boolean language sql immutable set search_path=pg_catalog as $$
 select regexp_replace(lower(coalesce(p_field,'')),'[^a-z0-9]+','_','g')~'(password|passwd|passphrase|token|secret|credential|authorization|cookie|api_?key|private_?key|auth_user_id|hash|smtp|service_?role|connection_?string|database_?url|(^|_)dsn($|_)|(^|_)pwd($|_))'
 or regexp_replace(lower(coalesce(p_field,'')),'[^a-z0-9]+','_','g')in('parameter_value','setting_value')
$$;
revoke all on function public.audit_field_is_sensitive(text)from public,anon,authenticated,service_role;
create schema global_configuration_private;
revoke all on schema global_configuration_private from public,anon,authenticated,service_role;
create function global_configuration_private.allowed(k text,a text)returns boolean language plpgsql stable security definer set search_path=pg_catalog,public,pg_temp as $$begin
 perform core_dictionary_private.actor();if k is null or a is null or k not in('parameters','settings')or a not in('view','create','edit','delete')then return false;end if;
 return exists(select 1 from role_access_matrix m where m.role_id=public.app_active_role_id()and m.resource_key='core:'||k and m.can_view and case a when'view'then true when'create'then m.can_create when'edit'then m.can_edit else m.can_delete end);
 exception when insufficient_privilege then return false;end$$;
create function global_configuration_private.access(k text,a text)returns bigint language plpgsql stable security definer set search_path=pg_catalog,public,pg_temp as $$declare u bigint:=core_dictionary_private.actor();begin
 if not global_configuration_private.allowed(k,a)or not core_dictionary_private.global_scope()then raise exception using errcode='42501',message='Requiere permiso explicito y acceso global incluso para consultar configuracion.';end if;return u;
end$$;
create function global_configuration_private.validate_value(v text)returns void language plpgsql immutable security definer set search_path=pg_catalog,public,pg_temp as $$declare parsed jsonb;begin
 if v is null then return;end if;
 if length(v)>8192 or replace(replace(replace(v,chr(10),''),chr(13),''),chr(9),'')~'[[:cntrl:]]'then raise exception using errcode='22023',message='Valor de configuracion invalido.';end if;
 if v~*'(sb_secret_|-----BEGIN [A-Z ]*PRIVATE KEY-----|bearer[[:space:]]+[a-z0-9_.-]+|eyJ[a-z0-9_-]+\.[a-z0-9_-]+\.[a-z0-9_-]+|[a-z][a-z0-9+.-]*://[^[:space:]/:@]+:[^[:space:]/@]+@)'then raise exception using errcode='22023',message='Este catalogo no almacena credenciales.';end if;
 begin parsed:=v::jsonb;exception when invalid_text_representation then return;end;
 if public.audit_redact_jsonb(parsed)is distinct from parsed then raise exception using errcode='22023',message='Este catalogo no almacena credenciales.';end if;
end$$;
create function global_configuration_private.dto(k text,r jsonb)returns jsonb language plpgsql stable security definer set search_path=pg_catalog,public,pg_temp as $$declare result jsonb;begin
 if k='parameters'then result:=jsonb_build_object('parameter_id',r->'parameter_id','parameter_key',r->'parameter_key','parameter_value',r->'parameter_value','description',r->'description');else result:=jsonb_build_object('setting_id',r->'setting_id','setting_key',r->'setting_key','setting_value',r->'setting_value','scope',r->'scope');end if;
 return result||jsonb_build_object('_revision',md5(r::text),'_immutable',case k when'parameters'then array['parameter_key']else array['setting_key','scope']end,'_actions',jsonb_build_object('canEdit',global_configuration_private.allowed(k,'edit'),'canDelete',global_configuration_private.allowed(k,'delete')));
end$$;
create function public.global_configuration_catalog(p_catalog text)returns jsonb language plpgsql stable security definer set search_path=pg_catalog,public,pg_temp as $$begin
 perform global_configuration_private.access(p_catalog,'view');if p_catalog='parameters'then return(select coalesce(jsonb_agg(global_configuration_private.dto(p_catalog,to_jsonb(r))order by r.parameter_id),'[]'::jsonb)from parameters r);end if;
 return(select coalesce(jsonb_agg(global_configuration_private.dto(p_catalog,to_jsonb(r))order by r.setting_id),'[]'::jsonb)from settings r);end$$;
create function public.global_configuration_access(p_catalog text)returns jsonb language plpgsql stable security definer set search_path=pg_catalog,public,pg_temp as $$begin
 perform global_configuration_private.access(p_catalog,'view');return jsonb_build_object('canView',true,'canCreate',global_configuration_private.allowed(p_catalog,'create'),'canEdit',global_configuration_private.allowed(p_catalog,'edit'),'canDelete',global_configuration_private.allowed(p_catalog,'delete'));
end$$;
create function public.save_global_configuration(p_catalog text,p_payload jsonb,p_id bigint default null)returns jsonb language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$
declare old_r jsonb;merged jsonb;result jsonb;fields text[];key_field text;value_field text;key_value text;config_value text;descr text;scope_value text;cid bigint;begin
 perform global_configuration_private.access(p_catalog,case when p_id is null then'create'else'edit'end);perform pg_advisory_xact_lock(hashtextextended('global-configuration:'||p_catalog,0));
 key_field:=case p_catalog when'parameters'then'parameter_key'else'setting_key'end;value_field:=case p_catalog when'parameters'then'parameter_value'else'setting_value'end;
 fields:=case p_catalog when'parameters'then array['parameter_key','parameter_value','description','_revision']else array['setting_key','setting_value','scope','_revision']end;
 if jsonb_typeof(p_payload)is distinct from'object'or pg_column_size(p_payload)>64000 or exists(select 1 from jsonb_each(p_payload)e where not(e.key=any(fields))or jsonb_typeof(e.value)not in('string','null'))then raise exception using errcode='22023',message='Campos de configuracion invalidos.';end if;
 if p_id is not null then
  if p_catalog='parameters'then select to_jsonb(r)into old_r from parameters r where parameter_id=p_id for update;else select to_jsonb(r)into old_r from settings r where setting_id=p_id for update;end if;
  if old_r is null then raise exception using errcode='42501',message='Configuracion no autorizada.';end if;
  if p_payload->>'_revision'is null or p_payload->>'_revision'is distinct from md5(old_r::text)then raise exception using errcode='55000',message='La configuracion cambio. Consulte nuevamente.';end if;
 end if;
 merged:=coalesce(old_r,'{}')||p_payload;key_value:=btrim(merged->>key_field);config_value:=merged->>value_field;descr:=nullif(btrim(merged->>'description'),'');scope_value:=lower(btrim(coalesce(merged->>'scope','global')));
 if key_value is null or key_value!~'^[A-Za-z][A-Za-z0-9_.:-]{0,119}$'or public.audit_field_is_sensitive(key_value)then raise exception using errcode='22023',message='Clave invalida o destinada a credenciales.';end if;
 if p_id is not null and key_value is distinct from old_r->>key_field then raise exception using errcode='55000',message='La clave de configuracion es inmutable.';end if;
 perform global_configuration_private.validate_value(config_value);
 if p_catalog='parameters'then
  if length(coalesce(descr,''))>2000 or descr~'[<>]'or replace(replace(replace(descr,chr(10),''),chr(13),''),chr(9),'')~'[[:cntrl:]]'then raise exception using errcode='22023',message='Descripcion invalida.';end if;
  perform global_configuration_private.validate_value(descr);
  if exists(select 1 from parameters where parameter_id is distinct from p_id and lower(parameter_key)=lower(key_value))then raise exception using errcode='23505',message='La clave ya existe.';end if;
 else
  if scope_value is distinct from'global'then raise exception using errcode='22023',message='Solo se admite alcance global.';end if;
  if exists(select 1 from settings where setting_id is distinct from p_id and lower(setting_key)=lower(key_value))then raise exception using errcode='23505',message='La clave ya existe.';end if;
 end if;
 cid:=core_dictionary_private.enter(case when p_id is null then'INSERT:'else'UPDATE:'end||p_catalog);
 if p_catalog='parameters'then
  if p_id is null then insert into parameters(parameter_key,parameter_value,description)values(key_value,config_value,descr)returning to_jsonb(parameters)into result;else update parameters set parameter_value=config_value,description=descr where parameter_id=p_id returning to_jsonb(parameters)into result;end if;
 else
  if p_id is null then insert into settings(setting_key,setting_value,scope)values(key_value,config_value,'global')returning to_jsonb(settings)into result;else update settings set setting_value=config_value where setting_id=p_id returning to_jsonb(settings)into result;end if;
 end if;
 delete from core_dictionary_private.contexts where id=cid;return global_configuration_private.dto(p_catalog,result);
end$$;
create function public.delete_global_configuration(p_catalog text,p_id bigint,p_revision text)returns boolean language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$declare r jsonb;cid bigint;begin
 perform global_configuration_private.access(p_catalog,'delete');perform pg_advisory_xact_lock(hashtextextended('global-configuration:'||p_catalog,0));
 if p_catalog='parameters'then select to_jsonb(t)into r from parameters t where parameter_id=p_id for update;else select to_jsonb(t)into r from settings t where setting_id=p_id for update;end if;
 if r is null then raise exception using errcode='42501',message='Configuracion no autorizada.';end if;
 if p_revision is null or p_revision is distinct from md5(r::text)then raise exception using errcode='55000',message='La configuracion cambio. Consulte nuevamente.';end if;
 cid:=core_dictionary_private.enter('DELETE:'||p_catalog);if p_catalog='parameters'then delete from parameters where parameter_id=p_id;else delete from settings where setting_id=p_id;end if;delete from core_dictionary_private.contexts where id=cid;return true;
end$$;
revoke all on all functions in schema global_configuration_private from public,anon,authenticated,service_role;
revoke all on function public.global_configuration_catalog(text),public.global_configuration_access(text),public.save_global_configuration(text,jsonb,bigint),public.delete_global_configuration(text,bigint,text)from public,anon,authenticated,service_role;
grant execute on function public.global_configuration_catalog(text),public.global_configuration_access(text),public.save_global_configuration(text,jsonb,bigint),public.delete_global_configuration(text,bigint,text)to authenticated;
notify pgrst,'reload schema';
