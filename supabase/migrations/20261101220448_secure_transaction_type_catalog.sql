-- Expansion: keep existing writers until the compatible server is deployed.
create schema transaction_type_private;
revoke all on schema transaction_type_private from public,anon,authenticated,service_role;
create function transaction_type_private.allowed(a text)returns boolean language plpgsql stable security definer set search_path=pg_catalog,public,pg_temp as $$begin
 perform core_dictionary_private.actor();if a is null or a not in('view','create','edit','delete')then return false;end if;
 return(a='view'and(public.app_is_admin()or exists(select 1 from role_access_matrix where role_id=public.app_active_role_id()and resource_key='legacy:all'and can_view)))or exists(select 1 from role_access_matrix m where m.role_id=public.app_active_role_id()and m.resource_key='core:transaction-types'and m.can_view and case a when'view'then true when'create'then m.can_create when'edit'then m.can_edit else m.can_delete end);
 exception when insufficient_privilege then return false;end$$;
create function transaction_type_private.access(a text)returns bigint language plpgsql stable security definer set search_path=pg_catalog,public,pg_temp as $$declare u bigint:=core_dictionary_private.actor();begin if not transaction_type_private.allowed(a)or(a<>'view'and not core_dictionary_private.global_scope())then raise exception using errcode='42501',message='Requiere permiso explicito y acceso a todas las filiales.';end if;return u;end$$;
create function transaction_type_private.categories()returns text[] language sql immutable set search_path=pg_catalog,public,pg_temp as $$select array['CORE','Seguridad','Organización','Configuración','Contabilidad','Bancos','Tesorería','Bancos y Tesorería','Finanzas','Fiscal','Entidades','Inventario','Ventas','Transacciones','Motor Transacciones','Compras','Gastos','Activos Fijos','Proyectos','Workflow','Documentos','Auditoría','API e Integraciones','Consolidación','Consolidación Global','IA','Inteligencia Artificial']$$;
create function transaction_type_private.used(r public.transaction_types)returns boolean language plpgsql stable security definer set search_path=pg_catalog,public,pg_temp as $$declare fk record;found_ref boolean;begin
 -- Preserve types selected by literal code/name in deployed business routines,
 -- even if no document has been posted yet.
 if exists(select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace where p.prokind='f'and n.nspname not in('pg_catalog','information_schema')and(position(quote_literal(r.abbreviation)in p.prosrc)>0 or position(quote_literal(r.code)in p.prosrc)>0 or position(quote_literal(r.name)in p.prosrc)>0))then return true;end if;
 for fk in select n.nspname,t.relname,a.attname from pg_constraint c join pg_class t on t.oid=c.conrelid join pg_namespace n on n.oid=t.relnamespace join pg_attribute a on a.attrelid=c.conrelid and a.attnum=c.conkey[1]where c.contype='f'and c.confrelid='public.transaction_types'::regclass and cardinality(c.conkey)=1 loop
  execute format('select exists(select 1 from %I.%I where %I=$1)',fk.nspname,fk.relname,fk.attname)into found_ref using r.transaction_type_id;if found_ref then return true;end if;
 end loop;return false;end$$;
create function transaction_type_private.dto(r public.transaction_types)returns jsonb language plpgsql stable security definer set search_path=pg_catalog,public,pg_temp as $$declare used boolean:=transaction_type_private.used(r);scope boolean:=core_dictionary_private.global_scope();begin
 return jsonb_build_object('transaction_type_id',r.transaction_type_id,'code',r.code,'abbreviation',r.abbreviation,'name',r.name,'module_category',r.module_category,'description',r.description,'_revision',md5(to_jsonb(r)::text),'_immutable',case when used then array['code','abbreviation','name','module_category']else array['code']end,'_actions',jsonb_build_object('canEdit',scope and transaction_type_private.allowed('edit'),'canDelete',scope and not used and transaction_type_private.allowed('delete')));end$$;
create function public.transaction_type_catalog()returns jsonb language plpgsql stable security definer set search_path=pg_catalog,public,pg_temp as $$begin perform transaction_type_private.access('view');return(select coalesce(jsonb_agg(transaction_type_private.dto(r)order by r.transaction_type_id),'[]'::jsonb)from public.transaction_types r);end$$;
create function public.transaction_type_access()returns jsonb language plpgsql stable security definer set search_path=pg_catalog,public,pg_temp as $$declare scope boolean;begin perform transaction_type_private.access('view');scope:=core_dictionary_private.global_scope();return jsonb_build_object('canView',true,'canCreate',scope and transaction_type_private.allowed('create'),'canEdit',scope and transaction_type_private.allowed('edit'),'canDelete',scope and transaction_type_private.allowed('delete'),'moduleCategories',transaction_type_private.categories());end$$;
create function public.save_transaction_type(p_payload jsonb,p_id bigint default null)returns jsonb language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$
declare old_r public.transaction_types;r public.transaction_types;merged jsonb;a text;n text;c text;d text;cid bigint;begin
 perform transaction_type_private.access(case when p_id is null then'create'else'edit'end);perform pg_advisory_xact_lock(hashtextextended('transaction-type-catalog',0));
 if jsonb_typeof(p_payload)is distinct from'object'or pg_column_size(p_payload)>64000 or exists(select 1 from jsonb_each(p_payload)e where e.key not in('abbreviation','name','module_category','description','_revision')or jsonb_typeof(e.value)not in('string','null'))then raise exception using errcode='22023',message='Campos de tipo de transaccion invalidos.';end if;
 if p_id is not null then
  perform pg_advisory_xact_lock(hashtextextended('transaction-number:'||p_id::text,0));select *into old_r from transaction_types where transaction_type_id=p_id for update;
  if not found then raise exception using errcode='42501',message='Tipo no autorizado.';end if;
  if p_payload->>'_revision'is null or p_payload->>'_revision'is distinct from md5(to_jsonb(old_r)::text)then raise exception using errcode='55000',message='El tipo cambio. Consulte nuevamente.';end if;
 end if;
 merged:=case when p_id is null then'{}'::jsonb else to_jsonb(old_r)end||p_payload;a:=upper(btrim(merged->>'abbreviation'));n:=btrim(merged->>'name');c:=btrim(merged->>'module_category');d:=btrim(merged->>'description');
 if a is null or a!~'^[A-Z][A-Z0-9_]{0,29}$'or n is null or length(n)not between 1 and 200 or n~'[<>[:cntrl:]]'or c is null or not(c=any(transaction_type_private.categories()))or d is null or length(d)not between 1 and 2000 or d~'[<>]'or replace(replace(replace(d,chr(10),''),chr(13),''),chr(9),'')~'[[:cntrl:]]'then raise exception using errcode='22023',message='Abreviatura, nombre, categoria o descripcion invalidos.';end if;
 if p_id is not null and transaction_type_private.used(old_r)and row(a,n,c)is distinct from row(old_r.abbreviation,old_r.name,old_r.module_category)then raise exception using errcode='55000',message='El tipo utilizado conserva su identidad y clasificacion.';end if;
 if exists(select 1 from transaction_types t where t.transaction_type_id is distinct from p_id and upper(t.abbreviation)=a)then raise exception using errcode='23505',message='La abreviatura ya existe.';end if;
 cid:=core_dictionary_private.enter(case when p_id is null then'INSERT:'else'UPDATE:'end||'transaction_types');
 if p_id is null then insert into transaction_types(abbreviation,name,module_category,description)values(a,n,c,d)returning *into r;
 else update transaction_types set abbreviation=a,name=n,module_category=c,description=d where transaction_type_id=p_id returning *into r;end if;
 delete from core_dictionary_private.contexts where id=cid;return transaction_type_private.dto(r);
end$$;
create function public.delete_transaction_type(p_id bigint,p_revision text)returns boolean language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$declare r public.transaction_types;cid bigint;begin
 perform transaction_type_private.access('delete');perform pg_advisory_xact_lock(hashtextextended('transaction-type-catalog',0));perform pg_advisory_xact_lock(hashtextextended('transaction-number:'||p_id::text,0));select *into r from transaction_types where transaction_type_id=p_id for update;
 if not found then raise exception using errcode='42501',message='Tipo no autorizado.';end if;
 if p_revision is null or p_revision is distinct from md5(to_jsonb(r)::text)or transaction_type_private.used(r)then raise exception using errcode='55000',message='El tipo cambio o tiene dependencias.';end if;
 cid:=core_dictionary_private.enter('DELETE:transaction_types');delete from transaction_types where transaction_type_id=p_id;delete from core_dictionary_private.contexts where id=cid;return true;
end$$;
revoke all on all functions in schema transaction_type_private from public,anon,authenticated,service_role;
revoke all on function public.transaction_type_catalog(),public.transaction_type_access(),public.save_transaction_type(jsonb,bigint),public.delete_transaction_type(bigint,text)from public,anon,authenticated,service_role;
grant execute on function public.transaction_type_catalog(),public.transaction_type_access(),public.save_transaction_type(jsonb,bigint),public.delete_transaction_type(bigint,text)to authenticated;
notify pgrst,'reload schema';
