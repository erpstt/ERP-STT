-- C-04: approval configuration. Operational start/act/inbox gateways are preserved.
set local lock_timeout='5s';
set local statement_timeout='60s';
create schema workflow_config_private;
revoke all on schema workflow_config_private from public,anon,authenticated,service_role;
grant usage on schema workflow_config_private to authenticated;

create function workflow_config_private.allowed(a text)returns boolean language plpgsql stable security definer set search_path=pg_catalog,public,pg_temp as $$
begin perform asset_posting_private.identity();
 if not exists(select 1 from public.users u join public.user_roles ur using(user_id)where u.user_id=public.app_user_id()and u.is_active and ur.role_id=public.app_active_role_id())then return false;end if;
 return asset_posting_private.allowed('workflow:approval-workflows',a)and(a='view'or public.app_is_admin());
exception when insufficient_privilege then return false;end$$;
create function workflow_config_private.access(a text default null)returns bigint language plpgsql stable security definer set search_path=pg_catalog,public,pg_temp as $$
declare sid bigint:=asset_posting_private.identity();begin
 if(a is null and not(workflow_config_private.allowed('view')or workflow_config_private.allowed('create')or workflow_config_private.allowed('edit')or workflow_config_private.allowed('delete')))or(a is not null and not workflow_config_private.allowed(a))then raise exception using errcode='42501',message='El rol activo no puede realizar esta operación de configuración.';end if;return sid;end$$;
create function workflow_config_private.visible(sid bigint)returns boolean language plpgsql stable security definer set search_path=pg_catalog,public,pg_temp as $$begin return sid=workflow_config_private.access();exception when insufficient_privilege then return false;end$$;
create function workflow_config_private.lock_scope()returns void language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$begin perform pg_advisory_xact_lock(hashtextextended('workflow-config:'||asset_posting_private.identity(),0));end$$;
-- Serialize configuration edits with the snapshot of rules copied into new instances.
-- Dynamic payment approvals without a workflow_id keep their existing protected path.
create function workflow_config_private.guard_instance_configuration()returns trigger language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$
begin if new.workflow_id is null then return new;end if;
 perform pg_advisory_xact_lock(hashtextextended('workflow-config:'||new.subsidiaria_id,0));
 if not exists(select 1 from public.wf_workflows w where w.id=new.workflow_id and w.subsidiaria_id=new.subsidiaria_id and w.entity_type=new.entity_type and w.estado_activo)then raise exception using errcode='55000',message='La configuración del flujo cambió. Revise y envíe nuevamente.';end if;return new;end$$;
create trigger workflow_configuration_snapshot before insert on public.wf_instances for each row execute function workflow_config_private.guard_instance_configuration();
create function workflow_config_private.fingerprint(id bigint)returns text language sql stable security definer set search_path=pg_catalog,public,pg_temp as $$
 select md5(jsonb_build_array(to_jsonb(w),coalesce((select jsonb_agg(to_jsonb(r)order by r.nivel)from public.wf_rules r where r.workflow_id=w.id),'[]'::jsonb))::text)from public.wf_workflows w where w.id=$1$$;
create function workflow_config_private.current(id bigint,expected text)returns public.wf_workflows language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$
declare w public.wf_workflows;begin if id is null or id<=0 then raise exception using errcode='22023',message='Flujo inválido.';end if;
 select *into w from public.wf_workflows where wf_workflows.id=$1 and subsidiaria_id=asset_posting_private.identity()for update;
 if not found then raise exception using errcode='42501',message='Flujo no disponible.';end if;
 if expected is null or expected is distinct from workflow_config_private.fingerprint(w.id)then raise exception using errcode='55000',message='La configuración cambió. Consúltela nuevamente.';end if;return w;end$$;

alter function public.wf_options()set schema workflow_config_private;
alter function public.wf_options_without_budget()set schema workflow_config_private;
alter function public.wf_admin_list()set schema workflow_config_private;
alter function public.wf_save_workflow(jsonb)set schema workflow_config_private;
alter function public.wf_delete_workflow(bigint)set schema workflow_config_private;

create function public.wf_options()returns jsonb language plpgsql stable security definer set search_path=pg_catalog,public,pg_temp as $$
declare sid bigint:=workflow_config_private.access();can_write boolean:=workflow_config_private.allowed('create')or workflow_config_private.allowed('edit');begin
 return jsonb_build_object('company',(select name from public.subsidiaries where subsidiary_id=sid),'isAdmin',public.app_is_admin(),
 'access',jsonb_build_object('canView',workflow_config_private.allowed('view'),'canCreate',workflow_config_private.allowed('create'),'canEdit',workflow_config_private.allowed('edit'),'canDelete',workflow_config_private.allowed('delete')),
 'entityTypes',jsonb_build_array(jsonb_build_object('id','PURCHASE_ORDER','name','Órdenes de compra'),jsonb_build_object('id','SALES_ORDER','name','Órdenes de venta'),jsonb_build_object('id','PAYMENT_REQUEST','name','Solicitudes de pago'),jsonb_build_object('id','BUDGET_TRANSFER','name','Modificaciones presupuestarias')),
 'roles',case when can_write then coalesce((select jsonb_agg(jsonb_build_object('id',r.role_id,'name',r.role_name)order by r.role_name)from public.roles r where exists(select 1 from public.user_roles ur join public.users u using(user_id)join public.user_subsidiaries us using(user_id)where ur.role_id=r.role_id and u.is_active and us.subsidiary_id=sid)),'[]'::jsonb)else'[]'::jsonb end,
 'users',case when can_write then coalesce((select jsonb_agg(jsonb_build_object('id',u.user_id,'name',trim(u.first_name||' '||u.last_name))order by u.first_name,u.last_name)from public.users u where u.is_active and exists(select 1 from public.user_subsidiaries us where us.user_id=u.user_id and us.subsidiary_id=sid)),'[]'::jsonb)else'[]'::jsonb end,
 'departments',case when can_write then coalesce((select jsonb_agg(jsonb_build_object('id',department_id,'name',name)order by name)from public.departments where subsidiary_id=sid and not is_inactive),'[]'::jsonb)else'[]'::jsonb end,
 'costCenters',case when can_write then coalesce((select jsonb_agg(jsonb_build_object('id',cost_center_id,'name',name)order by name)from public.cost_centers where subsidiary_id=sid and not is_inactive),'[]'::jsonb)else'[]'::jsonb end);end$$;

create function public.wf_admin_list()returns jsonb language plpgsql stable security definer set search_path=pg_catalog,public,pg_temp as $$
declare sid bigint:=workflow_config_private.access();begin return coalesce((select jsonb_agg(to_jsonb(w)||jsonb_build_object('revision',workflow_config_private.fingerprint(w.id),'hasHistory',exists(select 1 from public.wf_instances i where i.workflow_id=w.id),'actions',jsonb_build_object('canEdit',workflow_config_private.allowed('edit'),'canDelete',workflow_config_private.allowed('delete')),'rules',coalesce((select jsonb_agg(to_jsonb(r)order by nivel)from public.wf_rules r where r.workflow_id=w.id),'[]'::jsonb))order by w.entity_type,w.nombre)from public.wf_workflows w where w.subsidiaria_id=sid),'[]'::jsonb);end$$;

create function public.wf_save_workflow(p jsonb)returns jsonb language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$
declare wid bigint;sid bigint;r jsonb;w public.wf_workflows;v numeric;lo numeric;hi numeric;uid bigint;rid bigint;did bigint;cid bigint;begin
 sid:=workflow_config_private.access(case when nullif(p->>'id','')is null then'create'else'edit'end);wid:=nullif(p->>'id','')::bigint;perform workflow_config_private.lock_scope();
 if jsonb_typeof(p)is distinct from'object'or length(trim(coalesce(p->>'name','')))not between 1 and 160 or length(coalesce(p->>'description',''))>4000 or coalesce(p->>'entityType','')not in('PURCHASE_ORDER','SALES_ORDER','PAYMENT_REQUEST','BUDGET_TRANSFER')then raise exception using errcode='22023',message='Encabezado de flujo inválido.';end if;
 if jsonb_typeof(p->'rules')is distinct from'array'or jsonb_array_length(p->'rules')not between 1 and 100 then raise exception using errcode='22023',message='Defina entre uno y cien niveles de aprobación.';end if;
 if wid is not null then w:=workflow_config_private.current(wid,p->>'expectedRevision');if w.entity_type is distinct from p->>'entityType'and exists(select 1 from public.wf_instances where workflow_id=wid)then raise exception using errcode='55000',message='Un flujo con historial conserva su tipo de documento.';end if;end if;
 for r in select value from jsonb_array_elements(p->'rules')loop
  if jsonb_typeof(r)is distinct from'object'or length(coalesce(r->>'name',''))>160 or coalesce(nullif(r->>'policy',''),'CUALQUIERA')not in('CUALQUIERA','TODOS')or coalesce(r->>'paymentType','')not in('','CXP','OTROS')or coalesce(r->'extra','{}'::jsonb)<>'{}'::jsonb then raise exception using errcode='22023',message='Nivel de aprobación inválido.';end if;
  uid:=nullif(r->>'userId','')::bigint;rid:=nullif(r->>'roleId','')::bigint;did:=nullif(r->>'departmentId','')::bigint;cid:=nullif(r->>'costCenterId','')::bigint;
  if(uid is null)=(rid is null)then raise exception using errcode='22023',message='Seleccione un usuario o un rol aprobador.';end if;
  if uid is not null and not exists(select 1 from public.users u join public.user_subsidiaries us using(user_id)where u.user_id=uid and u.is_active and us.subsidiary_id=sid)then raise exception using errcode='42501',message='Aprobador no disponible en la subsidiaria.';end if;
  if rid is not null and not exists(select 1 from public.user_roles ur join public.users u using(user_id)join public.user_subsidiaries us using(user_id)where ur.role_id=rid and u.is_active and us.subsidiary_id=sid)then raise exception using errcode='42501',message='El rol aprobador no tiene usuarios activos en la subsidiaria.';end if;
  if(did is not null and not exists(select 1 from public.departments where department_id=did and subsidiary_id=sid and not is_inactive))or(cid is not null and not exists(select 1 from public.cost_centers where cost_center_id=cid and subsidiary_id=sid and not is_inactive))then raise exception using errcode='42501',message='Dimensión no disponible en la subsidiaria.';end if;
  lo:=nullif(r->>'minAmount','')::numeric;hi:=nullif(r->>'maxAmount','')::numeric;v:=nullif(r->>'discountMin','')::numeric;
  if(lo is not null and(not asset_posting_private.finite(lo)or lo<0 or lo>=1e18))or(hi is not null and(not asset_posting_private.finite(hi)or hi<0 or hi>=1e18))or(lo is not null and hi is not null and hi<lo)or(v is not null and(not asset_posting_private.finite(v)or v<0 or v>100))then raise exception using errcode='22023',message='Condiciones numéricas inválidas.';end if;
 end loop;
 return workflow_config_private.wf_save_workflow(p);end$$;
create function public.wf_delete_workflow(p_id bigint,p_expected_revision text default null)returns boolean language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$
begin perform workflow_config_private.access('delete');perform workflow_config_private.lock_scope();perform workflow_config_private.current(p_id,p_expected_revision);return workflow_config_private.wf_delete_workflow(p_id);end$$;

do $$declare t text;p record;c record;begin
 foreach t in array array['wf_workflows','wf_rules','workflow','workflow_step','workflow_rule','workflow_action','approval_matrix','approval','approval_log']loop
  execute format('alter table public.%I enable row level security',t);
  for p in select policyname from pg_policies where schemaname='public'and tablename=t loop execute format('drop policy %I on public.%I',p.policyname,t);end loop;
  execute format('revoke all on public.%I from public,anon,authenticated,service_role',t);
  if t not in('wf_workflows','wf_rules')then execute format('create policy workflow_legacy_closed on public.%I for select to authenticated using(false)',t);end if;
  for c in select column_name from information_schema.columns where table_schema='public'and table_name=t loop execute format('revoke insert(%I),update(%I),select(%I),references(%I)on public.%I from public,anon,authenticated,service_role',c.column_name,c.column_name,c.column_name,c.column_name,t);end loop;
 end loop;
end$$;
create policy workflow_config_read on public.wf_workflows for select to authenticated using(workflow_config_private.visible(subsidiaria_id));
create policy workflow_rules_read on public.wf_rules for select to authenticated using(exists(select 1 from public.wf_workflows w where w.id=workflow_id and workflow_config_private.visible(w.subsidiaria_id)));
grant select on public.wf_workflows,public.wf_rules to authenticated;
revoke all on all functions in schema workflow_config_private from public,anon,authenticated,service_role;
grant execute on function workflow_config_private.visible(bigint)to authenticated;
revoke all on function public.wf_options(),public.wf_admin_list(),public.wf_save_workflow(jsonb),public.wf_delete_workflow(bigint,text)from public,anon,authenticated,service_role;
grant execute on function public.wf_options(),public.wf_admin_list(),public.wf_save_workflow(jsonb),public.wf_delete_workflow(bigint,text)to authenticated;
notify pgrst,'reload schema';
