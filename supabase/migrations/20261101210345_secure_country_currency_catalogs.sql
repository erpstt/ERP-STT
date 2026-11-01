-- Expansion: deploy RPC clients before activating the table ACL boundary.
create schema core_dictionary_private;
revoke all on schema core_dictionary_private from public,anon,authenticated,service_role;
grant usage on schema core_dictionary_private to authenticated;
create table core_dictionary_private.contexts(id bigint generated always as identity primary key,backend_pid integer not null,transaction_id bigint not null,kind text not null);
alter table core_dictionary_private.contexts enable row level security;
create policy internal_owner on core_dictionary_private.contexts for all to postgres using(true)with check(true);
revoke all on core_dictionary_private.contexts from public,anon,authenticated,service_role;
create function core_dictionary_private.enter(k text)returns bigint language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$declare cid bigint;begin insert into core_dictionary_private.contexts(backend_pid,transaction_id,kind)values(pg_backend_pid(),txid_current(),k)returning id into cid;return cid;end$$;
create function core_dictionary_private.has_context(k text)returns boolean language sql volatile security definer set search_path=pg_catalog,public,pg_temp as $$select exists(select 1 from core_dictionary_private.contexts c where c.backend_pid=pg_backend_pid()and c.transaction_id=txid_current()and c.kind=k)$$;

create function core_dictionary_private.actor()returns bigint language sql stable security definer set search_path=pg_catalog,public,pg_temp as $$select access_admin_private.actor()$$;
create function core_dictionary_private.allowed(k text,a text)returns boolean language plpgsql stable security definer set search_path=pg_catalog,public,pg_temp as $$
begin
 perform core_dictionary_private.actor();
 if k is null or a is null or k not in('countries','currencies')or a not in('view','create','edit','delete')then return false;end if;
 return(a='view'and(public.app_is_admin()or exists(select 1 from public.role_access_matrix where role_id=public.app_active_role_id()and resource_key='legacy:all'and can_view)))
 or exists(select 1 from public.role_access_matrix m where m.role_id=public.app_active_role_id()and m.resource_key='core:'||k and m.can_view and case a when'view'then true when'create'then m.can_create when'edit'then m.can_edit else m.can_delete end);
 exception when insufficient_privilege then return false;
end$$;
create function core_dictionary_private.global_scope()returns boolean language sql stable security definer set search_path=pg_catalog,public,pg_temp as $$
 select not exists(select 1 from public.subsidiaries s where s.is_active and not exists(select 1 from public.user_subsidiaries u where u.user_id=public.app_user_id()and u.subsidiary_id=s.subsidiary_id))
$$;
create function core_dictionary_private.access(k text,a text)returns bigint language plpgsql stable security definer set search_path=pg_catalog,public,pg_temp as $$
declare u bigint:=core_dictionary_private.actor();begin
 if not core_dictionary_private.allowed(k,a)or(a<>'view'and not core_dictionary_private.global_scope())then raise exception using errcode='42501',message='Requiere permiso explicito y acceso global para mantener el catalogo.';end if;return u;
end$$;

-- Inspect every FK, including SET NULL and CASCADE: deleting a dictionary must
-- never silently rewrite dependent business records.
create function core_dictionary_private.used(k text,id bigint)returns boolean language plpgsql stable security definer set search_path=pg_catalog,public,pg_temp as $$
declare target regclass;r record;found_ref boolean;begin
 target:=case k when'countries'then'public.countries'::regclass when'currencies'then'public.currencies'::regclass end;
 if target is null or id is null then raise exception using errcode='22023',message='Catalogo invalido.';end if;
 for r in select n.nspname,t.relname,a.attname from pg_constraint c join pg_class t on t.oid=c.conrelid join pg_namespace n on n.oid=t.relnamespace join pg_attribute a on a.attrelid=c.conrelid and a.attnum=c.conkey[1]where c.contype='f'and c.confrelid=target and cardinality(c.conkey)=1 loop
  execute format('select exists(select 1 from %I.%I where %I=$1)',r.nspname,r.relname,r.attname)into found_ref using id;
  if found_ref then return true;end if;
 end loop;return false;
end$$;
create function core_dictionary_private.validate_change(k text,old_row jsonb,new_row jsonb)returns void language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$
declare id bigint;begin
 id:=(old_row->>case k when'countries'then'country_id'else'currency_id'end)::bigint;
 if old_row is not null and core_dictionary_private.used(k,id)then
  if new_row is null then raise exception using errcode='55000',message='El catalogo utilizado no se elimina.';end if;
  if(k='countries'and row(old_row->>'name',old_row->>'country_code_iso2',old_row->>'country_code_iso3')is distinct from row(new_row->>'name',new_row->>'country_code_iso2',new_row->>'country_code_iso3'))
  or(k='currencies'and row(old_row->>'currency_code',old_row->>'fx_rate_precision')is distinct from row(new_row->>'currency_code',new_row->>'fx_rate_precision'))then raise exception using errcode='55000',message='El catalogo utilizado conserva su identidad y precision.';end if;
 end if;
end$$;
create function core_dictionary_private.dto(k text,r jsonb)returns jsonb language plpgsql stable security definer set search_path=pg_catalog,public,pg_temp as $$
declare id bigint;is_used boolean;result jsonb;scope boolean:=core_dictionary_private.global_scope();begin
 id:=(r->>case k when'countries'then'country_id'else'currency_id'end)::bigint;is_used:=core_dictionary_private.used(k,id);
 if k='countries'then result:=jsonb_build_object('country_id',id,'name',r->'name','country_code_iso2',r->'country_code_iso2','country_code_iso3',r->'country_code_iso3','phone_code',r->'phone_code');
 else result:=jsonb_build_object('currency_id',id,'currency_code',r->'currency_code','name',r->'name','symbol',r->'symbol','fx_rate_precision',r->'fx_rate_precision');end if;
 return result||jsonb_build_object('_revision',md5(r::text),'_immutable',case when not is_used then'[]'::jsonb when k='countries'then'["name","country_code_iso2","country_code_iso3"]'::jsonb else'["currency_code","fx_rate_precision"]'::jsonb end,'_actions',jsonb_build_object('canEdit',scope and core_dictionary_private.allowed(k,'edit'),'canDelete',scope and not is_used and core_dictionary_private.allowed(k,'delete')));
end$$;

create function public.core_dictionary_catalog(p_catalog text)returns jsonb language plpgsql stable security definer set search_path=pg_catalog,public,pg_temp as $$
begin perform core_dictionary_private.access(p_catalog,'view');
 if p_catalog='countries'then return(select coalesce(jsonb_agg(core_dictionary_private.dto(p_catalog,to_jsonb(r))order by r.country_id),'[]'::jsonb)from public.countries r);end if;
 return(select coalesce(jsonb_agg(core_dictionary_private.dto(p_catalog,to_jsonb(r))order by r.currency_id),'[]'::jsonb)from public.currencies r);
end$$;
create function public.core_dictionary_access(p_catalog text)returns jsonb language plpgsql stable security definer set search_path=pg_catalog,public,pg_temp as $$
declare scope boolean;begin perform core_dictionary_private.access(p_catalog,'view');scope:=core_dictionary_private.global_scope();return jsonb_build_object('canView',true,'canCreate',scope and core_dictionary_private.allowed(p_catalog,'create'),'canEdit',scope and core_dictionary_private.allowed(p_catalog,'edit'),'canDelete',scope and core_dictionary_private.allowed(p_catalog,'delete'));end$$;
create function public.save_core_dictionary(p_catalog text,p_payload jsonb,p_id bigint default null)returns jsonb language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$
declare old_row jsonb;merged jsonb;result jsonb;rid bigint:=p_id;fields text[];n text;code2 text;code3 text;phone text;v_symbol text;precision_n numeric;code text;cid bigint;begin
 perform core_dictionary_private.access(p_catalog,case when p_id is null then'create'else'edit'end);
 perform pg_advisory_xact_lock(793150,1);perform pg_advisory_xact_lock(793154,1);perform pg_advisory_xact_lock(793155,1);
 fields:=case p_catalog when'countries'then array['name','country_code_iso2','country_code_iso3','phone_code','_revision']else array['currency_code','name','symbol','fx_rate_precision','_revision']end;
 if jsonb_typeof(p_payload)is distinct from'object'or pg_column_size(p_payload)>64000 or exists(select 1 from jsonb_object_keys(p_payload)k where not k=any(fields))then raise exception using errcode='22023',message='Campos del catalogo invalidos.';end if;
 if exists(select 1 from jsonb_each(p_payload)e where e.key not in('fx_rate_precision','_revision')and jsonb_typeof(e.value)not in('string','null'))then raise exception using errcode='22023',message='Tipos de campos invalidos.';end if;
 if rid is not null then
  if p_catalog='countries'then select to_jsonb(r)into old_row from public.countries r where country_id=rid for update;
  else select to_jsonb(r)into old_row from public.currencies r where currency_id=rid for update;end if;
  if old_row is null then raise exception using errcode='42501',message='Registro no autorizado.';end if;
  if p_payload->>'_revision'is null or p_payload->>'_revision'is distinct from md5(old_row::text)then raise exception using errcode='55000',message='El registro cambio. Consulte nuevamente.';end if;
 end if;
 merged:=coalesce(old_row,'{}')||p_payload;n:=btrim(merged->>'name');
 if n is null or length(n)not between 1 and 200 or n~'[[:cntrl:]<>]'then raise exception using errcode='22023',message='Nombre invalido.';end if;
 if p_catalog='countries'then
  code2:=nullif(upper(btrim(merged->>'country_code_iso2')),'');code3:=nullif(upper(btrim(merged->>'country_code_iso3')),'');phone:=nullif(btrim(merged->>'phone_code'),'');
  if(code2 is not null and code2!~'^[A-Z]{2}$')or(code3 is not null and code3!~'^[A-Z]{3}$')or(phone is not null and(length(phone)>12 or phone!~'^\+?[0-9 -]+$'))then raise exception using errcode='22023',message='Codigos del pais invalidos.';end if;
  if exists(select 1 from public.countries c where c.country_id is distinct from rid and(lower(c.name)=lower(n)or(code2 is not null and upper(c.country_code_iso2)=code2)or(code3 is not null and upper(c.country_code_iso3)=code3)))then raise exception using errcode='23505',message='El pais o sus codigos ya existen.';end if;
  merged:=merged||jsonb_build_object('name',n,'country_code_iso2',code2,'country_code_iso3',code3,'phone_code',phone);perform core_dictionary_private.validate_change(p_catalog,old_row,merged);
  cid:=core_dictionary_private.enter(case when rid is null then'INSERT:'else'UPDATE:'end||p_catalog);
  if rid is null then insert into public.countries(name,country_code_iso2,country_code_iso3,phone_code)values(n,code2,code3,phone)returning to_jsonb(countries)into result;
  else update public.countries set name=n,country_code_iso2=code2,country_code_iso3=code3,phone_code=phone where country_id=rid returning to_jsonb(countries)into result;end if;
 else
  code:=upper(btrim(merged->>'currency_code'));v_symbol:=btrim(merged->>'symbol');
  if code is null or code!~'^[A-Z]{3}$'or v_symbol is null or length(v_symbol)not between 1 and 10 or v_symbol~'[[:cntrl:]<>]'or coalesce(merged->>'fx_rate_precision','')!~'^[0-9]{1,2}$'then raise exception using errcode='22023',message='Codigo, simbolo o precision invalidos.';end if;
  precision_n:=(merged->>'fx_rate_precision')::numeric;if precision_n>12 then raise exception using errcode='22023',message='Precision invalida.';end if;
  if exists(select 1 from public.currencies c where c.currency_id is distinct from rid and upper(c.currency_code)=code)then raise exception using errcode='23505',message='La moneda ya existe.';end if;
  merged:=merged||jsonb_build_object('name',n,'currency_code',code,'symbol',v_symbol,'fx_rate_precision',precision_n);perform core_dictionary_private.validate_change(p_catalog,old_row,merged);
  cid:=core_dictionary_private.enter(case when rid is null then'INSERT:'else'UPDATE:'end||p_catalog);
  if rid is null then insert into public.currencies(currency_code,name,symbol,fx_rate_precision)values(code,n,v_symbol,precision_n)returning to_jsonb(currencies)into result;
  else update public.currencies set currency_code=code,name=n,symbol=v_symbol,fx_rate_precision=precision_n where currency_id=rid returning to_jsonb(currencies)into result;end if;
 end if;delete from core_dictionary_private.contexts where id=cid;return core_dictionary_private.dto(p_catalog,result);
end$$;
create function public.delete_core_dictionary(p_catalog text,p_id bigint,p_revision text)returns boolean language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$
declare r jsonb;cid bigint;begin
 perform core_dictionary_private.access(p_catalog,'delete');perform pg_advisory_xact_lock(793150,1);perform pg_advisory_xact_lock(793154,1);perform pg_advisory_xact_lock(793155,1);
 if p_catalog='countries'then select to_jsonb(c)into r from public.countries c where country_id=p_id for update;else select to_jsonb(c)into r from public.currencies c where currency_id=p_id for update;end if;
 if r is null then raise exception using errcode='42501',message='Registro no autorizado.';end if;
 if p_revision is null or p_revision is distinct from md5(r::text)then raise exception using errcode='55000',message='El registro cambio. Consulte nuevamente.';end if;
 perform core_dictionary_private.validate_change(p_catalog,r,null);
 cid:=core_dictionary_private.enter('DELETE:'||p_catalog);
 if p_catalog='countries'then delete from public.countries where country_id=p_id;else delete from public.currencies where currency_id=p_id;end if;delete from core_dictionary_private.contexts where id=cid;return true;
end$$;
revoke all on all functions in schema core_dictionary_private from public,anon,authenticated,service_role;
revoke all on function public.core_dictionary_catalog(text),public.core_dictionary_access(text),public.save_core_dictionary(text,jsonb,bigint),public.delete_core_dictionary(text,bigint,text)from public,anon,authenticated,service_role;
grant execute on function public.core_dictionary_catalog(text),public.core_dictionary_access(text),public.save_core_dictionary(text,jsonb,bigint),public.delete_core_dictionary(text,bigint,text)to authenticated;
notify pgrst,'reload schema';
