CREATE OR REPLACE FUNCTION public.wf_admin_list()
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
select coalesce(jsonb_agg(to_jsonb(w)||jsonb_build_object('rules',coalesce((select jsonb_agg(to_jsonb(r)order by nivel)from wf_rules r where r.workflow_id=w.id),'[]'))order by w.entity_type,w.nombre),'[]')from wf_workflows w where w.subsidiaria_id=active_subsidiary_id()$function$;

CREATE OR REPLACE FUNCTION public.wf_delete_workflow(p_id bigint)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$begin if not app_is_admin()then raise exception'Solo un administrador puede eliminar flujos.';end if;if exists(select 1 from wf_instances where workflow_id=p_id)then update wf_workflows set estado_activo=false where id=p_id and subsidiaria_id=active_subsidiary_id();else delete from wf_workflows where id=p_id and subsidiaria_id=active_subsidiary_id();end if;return true;end$function$;

CREATE OR REPLACE FUNCTION public.wf_save_workflow(p jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare wid bigint:=nullif(p->>'id','')::bigint;r jsonb;lvl int:=0;begin if not app_is_admin()then raise exception'Solo un administrador puede configurar flujos.';end if;
 if coalesce(jsonb_array_length(p->'rules'),0)=0 then raise exception'Agregue al menos un nivel de aprobación.';end if;
 if wid is null then insert into wf_workflows(nombre,entity_type,estado_activo,subsidiaria_id,descripcion,created_by)values(p->>'name',p->>'entityType',coalesce((p->>'active')::boolean,true),active_subsidiary_id(),p->>'description',app_user_id())returning id into wid;
 else update wf_workflows set nombre=p->>'name',entity_type=p->>'entityType',estado_activo=coalesce((p->>'active')::boolean,true),descripcion=p->>'description',updated_at=now()where id=wid and subsidiaria_id=active_subsidiary_id();if not found then raise exception'Flujo no encontrado.';end if;delete from wf_rules where workflow_id=wid;end if;
 for r in select value from jsonb_array_elements(p->'rules')loop lvl:=lvl+1;insert into wf_rules(workflow_id,nivel,nombre_nivel,rol_aprobador_id,usuario_aprobador_id,condicion_monto_min,condicion_monto_max,departamento_id,centro_costo_id,porcentaje_descuento_min,tipo_desembolso,json_condiciones_extra,politica)
 values(wid,lvl,coalesce(nullif(r->>'name',''),'Nivel '||lvl),nullif(r->>'roleId','')::bigint,nullif(r->>'userId','')::bigint,nullif(r->>'minAmount','')::numeric,nullif(r->>'maxAmount','')::numeric,nullif(r->>'departmentId','')::bigint,nullif(r->>'costCenterId','')::bigint,nullif(r->>'discountMin','')::numeric,nullif(r->>'paymentType',''),coalesce(r->'extra','{}'),coalesce(nullif(r->>'policy',''),'CUALQUIERA'));end loop;return jsonb_build_object('id',wid);end$function$;

CREATE OR REPLACE FUNCTION public.wf_options()
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
 select r||jsonb_build_object('entityTypes',(r->'entityTypes')||jsonb_build_array(jsonb_build_object('id','BUDGET_TRANSFER','name','Modificaciones presupuestarias')))from(select wf_options_without_budget()r)x
$function$;

CREATE OR REPLACE FUNCTION public.wf_options_without_budget()
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
select jsonb_build_object('company',s.name,'isAdmin',app_is_admin(),'entityTypes',jsonb_build_array(jsonb_build_object('id','PURCHASE_ORDER','name','Órdenes de Compra'),jsonb_build_object('id','SALES_ORDER','name','Órdenes de Venta'),jsonb_build_object('id','PAYMENT_REQUEST','name','Solicitudes de Pago')),
'roles',coalesce((select jsonb_agg(jsonb_build_object('id',role_id,'name',role_name)order by role_name)from roles),'[]'),
'users',coalesce((select jsonb_agg(jsonb_build_object('id',u.user_id,'name',trim(u.first_name||' '||u.last_name),'email',u.email)order by u.first_name,u.last_name)from users u join user_subsidiaries us using(user_id)where us.subsidiary_id=s.subsidiary_id and u.is_active),'[]'),
'departments',coalesce((select jsonb_agg(jsonb_build_object('id',department_id,'name',name)order by name)from departments where subsidiary_id=s.subsidiary_id),'[]'),
'costCenters',coalesce((select jsonb_agg(jsonb_build_object('id',cost_center_id,'name',name)order by name)from cost_centers where subsidiary_id=s.subsidiary_id),'[]'))from subsidiaries s where s.subsidiary_id=active_subsidiary_id()$function$;
