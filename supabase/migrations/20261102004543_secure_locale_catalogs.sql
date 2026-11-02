-- Expansion: compatible clients first; existing preferences and fiscal dates remain intact.
create schema locale_catalog_private;revoke all on schema locale_catalog_private from public,anon,authenticated,service_role;
create function locale_catalog_private.allowed(k text,a text)returns boolean language plpgsql stable security definer set search_path=pg_catalog,public,pg_temp as $$
begin
 perform core_dictionary_private.actor();
 if k is null or a is null or k not in('languages','timezones')or a not in('view','create','edit','delete')then return false;end if;
 return exists(select 1 from public.role_access_matrix m where m.role_id=public.app_active_role_id()and m.resource_key='core:'||k and m.can_view and case a when'view'then true when'create'then m.can_create when'edit'then m.can_edit else m.can_delete end);
 exception when insufficient_privilege then return false;
end$$;
create function locale_catalog_private.access(k text,a text)returns bigint language plpgsql stable security definer set search_path=pg_catalog,public,pg_temp as $$
declare u bigint:=core_dictionary_private.actor();begin
 if not locale_catalog_private.allowed(k,a)or(a<>'view'and not core_dictionary_private.global_scope())then raise exception using errcode='42501',message='Requiere permiso explicito y acceso global para mantener el catalogo.';end if;return u;
end$$;

-- Inspect every FK, including SET NULL and CASCADE: deleting a dictionary must
-- never silently rewrite dependent business records.
create function locale_catalog_private.used(k text,id bigint)returns boolean language plpgsql stable security definer set search_path=pg_catalog,public,pg_temp as $$
declare target regclass;r record;found_ref boolean;begin
 target:=case k when'languages'then'public.languages'::regclass when'timezones'then'public.timezones'::regclass end;
 if target is null or id is null then raise exception using errcode='22023',message='Catalogo invalido.';end if;
 for r in select n.nspname,t.relname,a.attname from pg_constraint c join pg_class t on t.oid=c.conrelid join pg_namespace n on n.oid=t.relnamespace join pg_attribute a on a.attrelid=c.conrelid and a.attnum=c.conkey[1]where c.contype='f'and c.confrelid=target and cardinality(c.conkey)=1 loop
  execute format('select exists(select 1 from %I.%I where %I=$1)',r.nspname,r.relname,r.attname)into found_ref using id;
  if found_ref then return true;end if;
 end loop;return false;
end$$;
create function locale_catalog_private.protected(k text,r jsonb)returns boolean language sql stable security definer set search_path=pg_catalog,public,pg_temp as $$select locale_catalog_private.used(k,(r->>case k when'languages'then'language_id'else'timezone_id'end)::bigint)or(k='languages'and public.app_supported_language_locale(r->>'code',r->>'iso_code')is not null)$$;
create function locale_catalog_private.validate_change(k text,old_r jsonb,new_r jsonb)returns void language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$begin
 if old_r is null then return;end if;
 if k='languages'and new_r is not null and row(old_r->>'code',old_r->>'iso_code')is distinct from row(new_r->>'code',new_r->>'iso_code')then raise exception using errcode='55000',message='Los codigos de idioma son inmutables.';end if;
 if locale_catalog_private.protected(k,old_r)then
  if new_r is null or (old_r->>'is_active')::boolean and not(new_r->>'is_active')::boolean or(k='timezones'and row(old_r->>'name',old_r->>'utc_offset')is distinct from row(new_r->>'name',new_r->>'utc_offset'))then raise exception using errcode='55000',message='Idioma soportado o catalogo utilizado: conserve su significado y disponibilidad.';end if;
 end if;end$$;
create function locale_catalog_private.dto(k text,r jsonb)returns jsonb language plpgsql stable security definer set search_path=pg_catalog,public,pg_temp as $$declare result jsonb;protected boolean:=locale_catalog_private.protected(k,r);scope boolean:=core_dictionary_private.global_scope();begin
 if k='languages'then result:=jsonb_build_object('language_id',r->'language_id','code',r->'code','iso_code',r->'iso_code','name',r->'name','is_active',r->'is_active');else result:=jsonb_build_object('timezone_id',r->'timezone_id','name',r->'name','utc_offset',r->'utc_offset','is_active',r->'is_active');end if;
 return result||jsonb_build_object('_revision',md5(r::text),'_immutable',case when k='languages'then to_jsonb(array['code','iso_code']||case when protected then array['is_active']else array[]::text[]end)when protected then to_jsonb(array['name','utc_offset','is_active'])else'[]'::jsonb end,'_actions',jsonb_build_object('canEdit',scope and locale_catalog_private.allowed(k,'edit'),'canDelete',scope and not protected and locale_catalog_private.allowed(k,'delete')));end$$;
create function public.locale_catalog(p_catalog text)returns jsonb language plpgsql stable security definer set search_path=pg_catalog,public,pg_temp as $$
begin perform locale_catalog_private.access(p_catalog,'view');
 if p_catalog='languages'then return(select coalesce(jsonb_agg(locale_catalog_private.dto(p_catalog,to_jsonb(r))order by r.language_id),'[]'::jsonb)from public.languages r);end if;
 return(select coalesce(jsonb_agg(locale_catalog_private.dto(p_catalog,to_jsonb(r))order by r.timezone_id),'[]'::jsonb)from public.timezones r);
end$$;
create function public.locale_catalog_access(p_catalog text)returns jsonb language plpgsql stable security definer set search_path=pg_catalog,public,pg_temp as $$
declare scope boolean;begin perform locale_catalog_private.access(p_catalog,'view');scope:=core_dictionary_private.global_scope();return jsonb_build_object('canView',true,'canCreate',scope and locale_catalog_private.allowed(p_catalog,'create'),'canEdit',scope and locale_catalog_private.allowed(p_catalog,'edit'),'canDelete',scope and locale_catalog_private.allowed(p_catalog,'delete'));end$$;
create function public.save_locale_catalog(p_catalog text,p_payload jsonb,p_id bigint default null)returns jsonb language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$
declare old_r jsonb;m jsonb;r jsonb;n text;c text;iso text;z text;active boolean;fields text[];cid bigint;locale text;begin
 perform locale_catalog_private.access(p_catalog,case when p_id is null then'create'else'edit'end);perform pg_advisory_xact_lock(793150,1);perform pg_advisory_xact_lock(793154,1);perform pg_advisory_xact_lock(793155,1);
 fields:=case p_catalog when'languages'then array['code','iso_code','name','is_active','_revision']else array['name','utc_offset','is_active','_revision']end;
 if jsonb_typeof(p_payload)is distinct from'object'or pg_column_size(p_payload)>64000 or exists(select 1 from jsonb_each(p_payload)e where not(e.key=any(fields))or(e.key='is_active'and jsonb_typeof(e.value)<>'boolean')or(e.key<>'is_active'and jsonb_typeof(e.value)not in('string','null')))then raise exception using errcode='22023',message='Campos del catalogo invalidos.';end if;
 if p_id is not null then if p_catalog='languages'then select to_jsonb(t)into old_r from languages t where language_id=p_id for update;else select to_jsonb(t)into old_r from timezones t where timezone_id=p_id for update;end if;
 if old_r is null then raise exception using errcode='42501',message='Registro no autorizado.';end if;if p_payload->>'_revision'is null or p_payload->>'_revision'is distinct from md5(old_r::text)then raise exception using errcode='55000',message='El registro cambio. Consulte nuevamente.';end if;end if;
 m:=coalesce(old_r,jsonb_build_object('is_active',true))||p_payload;n:=btrim(m->>'name');active:=(m->>'is_active')::boolean;
 if n is null or length(n)not between 1 and 200 or n~'[[:cntrl:]<>]'or active is null then raise exception using errcode='22023',message='Nombre o disponibilidad invalidos.';end if;
 if p_catalog='languages'then
 c:=upper(btrim(m->>'code'));iso:=upper(btrim(m->>'iso_code'));
 if c is null or c!~'^[A-Z0-9][A-Z0-9_-]{0,9}$'or iso is null or iso!~'^[A-Z]{2,3}(-[A-Z]{2})?$'then raise exception using errcode='22023',message='Codigos de idioma invalidos.';end if;
 locale:=public.app_supported_language_locale(c,iso);
 if exists(select 1 from languages t where t.language_id is distinct from p_id and(upper(t.code)=c or upper(t.iso_code)=iso or lower(t.name)=lower(n)or(locale is not null and public.app_supported_language_locale(t.code,t.iso_code)=locale)))then raise exception using errcode='23505',message='Idioma, codigo o traduccion ya registrados.';end if;
 m:=m||jsonb_build_object('code',c,'iso_code',iso,'name',n,'is_active',active);
 else
 z:=upper(btrim(m->>'utc_offset'));
 if z is null or z!~'^UTC[+-]((0[0-9]|1[0-3]):[0-5][0-9]|14:00)$'then raise exception using errcode='22023',message='Diferencia UTC invalida.';end if;
 if exists(select 1 from timezones t where t.timezone_id is distinct from p_id and lower(t.name)=lower(n))then raise exception using errcode='23505',message='Zona horaria ya registrada.';end if;
 m:=m||jsonb_build_object('name',n,'utc_offset',z,'is_active',active);
 end if;perform locale_catalog_private.validate_change(p_catalog,old_r,m);cid:=core_dictionary_private.enter(case when p_id is null then'INSERT:'else'UPDATE:'end||p_catalog);
 if p_catalog='languages'then
 if p_id is null then insert into languages(code,iso_code,name,is_active)values(c,iso,n,active)returning to_jsonb(languages)into r;else update languages set code=c,iso_code=iso,name=n,is_active=active where language_id=p_id returning to_jsonb(languages)into r;end if;
 else
 if p_id is null then insert into timezones(name,utc_offset,is_active)values(n,z,active)returning to_jsonb(timezones)into r;else update timezones set name=n,utc_offset=z,is_active=active where timezone_id=p_id returning to_jsonb(timezones)into r;end if;end if;
 delete from core_dictionary_private.contexts where id=cid;return locale_catalog_private.dto(p_catalog,r);end$$;
create function public.delete_locale_catalog(p_catalog text,p_id bigint,p_revision text)returns boolean language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$
declare r jsonb;cid bigint;begin
 perform locale_catalog_private.access(p_catalog,'delete');perform pg_advisory_xact_lock(793150,1);perform pg_advisory_xact_lock(793154,1);perform pg_advisory_xact_lock(793155,1);
 if p_catalog='languages'then select to_jsonb(c)into r from public.languages c where language_id=p_id for update;else select to_jsonb(c)into r from public.timezones c where timezone_id=p_id for update;end if;
 if r is null then raise exception using errcode='42501',message='Registro no autorizado.';end if;
 if p_revision is null or p_revision is distinct from md5(r::text)then raise exception using errcode='55000',message='El registro cambio. Consulte nuevamente.';end if;
 perform locale_catalog_private.validate_change(p_catalog,r,null);
 cid:=core_dictionary_private.enter('DELETE:'||p_catalog);
 if p_catalog='languages'then delete from public.languages where language_id=p_id;else delete from public.timezones where timezone_id=p_id;end if;delete from core_dictionary_private.contexts where id=cid;return true;
end$$;
revoke all on all functions in schema locale_catalog_private from public,anon,authenticated,service_role;
revoke all on function public.locale_catalog(text),public.locale_catalog_access(text),public.save_locale_catalog(text,jsonb,bigint),public.delete_locale_catalog(text,bigint,text)from public,anon,authenticated,service_role;
grant execute on function public.locale_catalog(text),public.locale_catalog_access(text),public.save_locale_catalog(text,jsonb,bigint),public.delete_locale_catalog(text,bigint,text)to authenticated;
notify pgrst,'reload schema';
