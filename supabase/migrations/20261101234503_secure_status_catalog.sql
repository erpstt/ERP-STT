-- Expansion: keep existing writers until the compatible server is deployed.
create schema status_master_private;
revoke all on schema status_master_private from public,anon,authenticated,service_role;
create function status_master_private.allowed(a text)returns boolean language plpgsql stable security definer set search_path=pg_catalog,public,pg_temp as $$begin
 perform core_dictionary_private.actor();if a is null or a not in('view','create','edit','delete')then return false;end if;
 return(a='view'and(public.app_is_admin()or exists(select 1 from role_access_matrix where role_id=public.app_active_role_id()and resource_key='legacy:all'and can_view)))or exists(select 1 from role_access_matrix m where m.role_id=public.app_active_role_id()and m.resource_key='core:status'and m.can_view and case a when'view'then true when'create'then m.can_create when'edit'then m.can_edit else m.can_delete end);
 exception when insufficient_privilege then return false;end$$;
create function status_master_private.access(a text)returns bigint language plpgsql stable security definer set search_path=pg_catalog,public,pg_temp as $$declare u bigint:=core_dictionary_private.actor();begin if not status_master_private.allowed(a)or(a<>'view'and not core_dictionary_private.global_scope())then raise exception using errcode='42501',message='Requiere permiso explicito y acceso a todas las filiales.';end if;return u;end$$;
create function status_master_private.categories()returns text[] language sql immutable set search_path=pg_catalog,public,pg_temp as $$select array['CORE','Seguridad','Organización','Configuración','Contabilidad','Bancos','Tesorería','Bancos y Tesorería','Finanzas','Fiscal','Entidades','Inventario','Ventas','Transacciones','Motor Transacciones','Compras','Gastos','Activos Fijos','Proyectos','Workflow','Documentos','Auditoría','API e Integraciones','Consolidación','Consolidación Global','IA','Inteligencia Artificial']$$;
create function status_master_private.canonical(c text)returns boolean language sql immutable set search_path=pg_catalog,public,pg_temp as $$select c=any(array['ACTIVO','INACTIVO','BLOQUEADO','SOLICITADO','ORDENADO','RECIBIDO_PARCIAL','RECIBIDO_TOTAL','COTIZADO','PEDIDO_CONFIRMADO','DESPACHADO','FACTURADO','BORRADOR','PENDIENTE_APROBACION','APROBADO','ANULADO','CERRADO','PENDIENTE_PAGO','PAGADO_PARCIAL','PAGADO','DISPONIBLE','COMPROMETIDO','EN_TRANSITO','PERIODO_ABIERTO','PERIODO_CERRADO'])$$;
create function status_master_private.used(r public.status)returns boolean language plpgsql stable security definer set search_path=pg_catalog,public,pg_temp as $$declare fk record;found_ref boolean;begin
 if status_master_private.canonical(r.code)or exists(select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace where p.prokind='f'and n.nspname not in('pg_catalog','information_schema')and(position(quote_literal(r.code)in p.prosrc)>0 or position(quote_literal(r.name)in p.prosrc)>0))then return true;end if;
 for fk in select n.nspname,t.relname,a.attname from pg_constraint c join pg_class t on t.oid=c.conrelid join pg_namespace n on n.oid=t.relnamespace join pg_attribute a on a.attrelid=c.conrelid and a.attnum=c.conkey[1]where c.contype='f'and c.confrelid='public.status'::regclass and cardinality(c.conkey)=1 loop
  execute format('select exists(select 1 from %I.%I where %I=$1)',fk.nspname,fk.relname,fk.attname)into found_ref using r.status_id;if found_ref then return true;end if;
 end loop;return false;end$$;
create function status_master_private.dto(r public.status)returns jsonb language plpgsql stable security definer set search_path=pg_catalog,public,pg_temp as $$declare used boolean:=status_master_private.used(r);scope boolean:=core_dictionary_private.global_scope();begin
 return jsonb_build_object('status_id',r.status_id,'code',r.code,'name',r.name,'module',r.module,'description',r.description,'_revision',md5(to_jsonb(r)::text),'_immutable',case when used then array['code','name','module']else array['code']end,'_actions',jsonb_build_object('canEdit',scope and status_master_private.allowed('edit'),'canDelete',scope and not used and status_master_private.allowed('delete')));end$$;
create function public.status_master_catalog()returns jsonb language plpgsql stable security definer set search_path=pg_catalog,public,pg_temp as $$begin perform status_master_private.access('view');return(select coalesce(jsonb_agg(status_master_private.dto(r)order by r.status_id),'[]'::jsonb)from public.status r);end$$;
create function public.status_master_access()returns jsonb language plpgsql stable security definer set search_path=pg_catalog,public,pg_temp as $$declare scope boolean;begin perform status_master_private.access('view');scope:=core_dictionary_private.global_scope();return jsonb_build_object('canView',true,'canCreate',scope and status_master_private.allowed('create'),'canEdit',scope and status_master_private.allowed('edit'),'canDelete',scope and status_master_private.allowed('delete'),'moduleCategories',status_master_private.categories());end$$;
create function public.save_status_master(p_payload jsonb,p_id bigint default null)returns jsonb language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$
declare old_r public.status;r public.status;merged jsonb;a text;n text;c text;d text;cid bigint;begin
 perform status_master_private.access(case when p_id is null then'create'else'edit'end);perform pg_advisory_xact_lock(hashtextextended('status-master-catalog',0));
 if jsonb_typeof(p_payload)is distinct from'object'or pg_column_size(p_payload)>64000 or exists(select 1 from jsonb_each(p_payload)e where e.key not in('code','name','module','description','_revision')or jsonb_typeof(e.value)not in('string','null'))then raise exception using errcode='22023',message='Campos de estado maestro invalidos.';end if;
 if p_id is not null then
  select *into old_r from status where status_id=p_id for update;
  if not found then raise exception using errcode='42501',message='Estado no autorizado.';end if;
  if p_payload->>'_revision'is null or p_payload->>'_revision'is distinct from md5(to_jsonb(old_r)::text)then raise exception using errcode='55000',message='El estado cambio. Consulte nuevamente.';end if;
 end if;
 merged:=case when p_id is null then'{}'::jsonb else to_jsonb(old_r)end||p_payload;a:=upper(btrim(merged->>'code'));n:=btrim(merged->>'name');c:=btrim(merged->>'module');d:=nullif(btrim(merged->>'description'),'');
 if a is null or a!~'^[A-Z][A-Z0-9_]{0,29}$'or n is null or length(n)not between 1 and 200 or n~'[<>[:cntrl:]]'or c is null or not(c=any(status_master_private.categories()))or length(coalesce(d,''))>2000 or d~'[<>]'or replace(replace(replace(d,chr(10),''),chr(13),''),chr(9),'')~'[[:cntrl:]]'then raise exception using errcode='22023',message='Abreviatura, nombre, categoria o descripcion invalidos.';end if;
 if p_id is not null and a is distinct from old_r.code then raise exception using errcode='55000',message='El codigo del estado es inmutable.';end if;
 if p_id is not null and status_master_private.used(old_r)and row(a,n,c)is distinct from row(old_r.code,old_r.name,old_r.module)then raise exception using errcode='55000',message='El estado utilizado conserva su identidad y clasificacion.';end if;
 if exists(select 1 from status t where t.status_id is distinct from p_id and (upper(t.code)=a or lower(btrim(t.name))=lower(n)))then raise exception using errcode='23505',message='El codigo o nombre del estado ya existe.';end if;
 if p_id is null then r.code:=a;r.name:=n;r.module:=c;if status_master_private.used(r)then raise exception using errcode='55000',message='El codigo o nombre esta reservado por las rutinas del sistema.';end if;end if;
 cid:=core_dictionary_private.enter(case when p_id is null then'INSERT:'else'UPDATE:'end||'status');
 if p_id is null then insert into status(code,name,module,description)values(a,n,c,d)returning *into r;
 else update status set code=a,name=n,module=c,description=d where status_id=p_id returning *into r;end if;
 delete from core_dictionary_private.contexts where id=cid;return status_master_private.dto(r);
end$$;
create function public.delete_status_master(p_id bigint,p_revision text)returns boolean language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$declare r public.status;cid bigint;begin
 perform status_master_private.access('delete');perform pg_advisory_xact_lock(hashtextextended('status-master-catalog',0));select *into r from status where status_id=p_id for update;
 if not found then raise exception using errcode='42501',message='Estado no autorizado.';end if;
 if p_revision is null or p_revision is distinct from md5(to_jsonb(r)::text)or status_master_private.used(r)then raise exception using errcode='55000',message='El estado cambio o tiene dependencias.';end if;
 cid:=core_dictionary_private.enter('DELETE:status');delete from status where status_id=p_id;delete from core_dictionary_private.contexts where id=cid;return true;
end$$;
revoke all on all functions in schema status_master_private from public,anon,authenticated,service_role;
revoke all on function public.status_master_catalog(),public.status_master_access(),public.save_status_master(jsonb,bigint),public.delete_status_master(bigint,text)from public,anon,authenticated,service_role;
grant execute on function public.status_master_catalog(),public.status_master_access(),public.save_status_master(jsonb,bigint),public.delete_status_master(bigint,text)to authenticated;
notify pgrst,'reload schema';
