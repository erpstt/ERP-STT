CREATE OR REPLACE FUNCTION public.wf_bulk_approve(p_ids jsonb, p_comment text DEFAULT NULL::text, p_ip inet DEFAULT NULL::inet)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$declare x jsonb;ok int:=0;begin for x in select value from jsonb_array_elements(p_ids)loop perform wf_act((x#>>'{}')::bigint,'APROBAR',p_comment,p_ip);ok:=ok+1;end loop;return jsonb_build_object('approved',ok);end$function$;

CREATE OR REPLACE FUNCTION public.wf_inbox()
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
select coalesce(jsonb_agg(jsonb_build_object('instanceId',i.id,'entityType',i.entity_type,'entityId',i.entity_id,'amount',i.amount,'status',i.status,'level',i.current_level,'levelName',s.nombre_nivel,'policy',s.politica,'requestedAt',i.created_at,'number',wf_entity_data(i.entity_type,i.entity_id)->>'number','deepLink',wf_entity_data(i.entity_type,i.entity_id)->>'deepLink')order by i.created_at),'[]')
from wf_instances i join wf_instance_steps s on s.instance_id=i.id and s.nivel=i.current_level where (i.entity_type<>'PURCHASE_ORDER' or (purchase_order_private.visible(i.entity_id) and (s.usuario_aprobador_id=public.app_user_id() or s.rol_aprobador_id=public.app_active_role_id() or public.app_is_admin()))) and (i.entity_type<>'PAYMENT_REQUEST' or (payment_request_private.visible(i.entity_id) and (s.usuario_aprobador_id=public.app_user_id() or s.rol_aprobador_id=public.app_active_role_id() or public.app_is_admin()))) and (i.entity_type<>'SALES_ORDER' or (sales_workflow_private.visible(i.entity_id) and (s.usuario_aprobador_id=public.app_user_id() or s.rol_aprobador_id=public.app_active_role_id()))) and(i.entity_type<>'BUDGET_TRANSFER'or(budget_private.visible(i.subsidiaria_id)and(s.usuario_aprobador_id=public.app_user_id()or s.rol_aprobador_id=public.app_active_role_id()))) and i.subsidiaria_id=active_subsidiary_id()and i.status='EN_REVISION'and(s.usuario_aprobador_id=app_user_id()or exists(select 1 from user_roles ur where ur.user_id=app_user_id()and ur.role_id=s.rol_aprobador_id)or app_is_admin())and not exists(select 1 from wf_step_decisions d where d.step_id=s.id and d.usuario_id=app_user_id())$function$;

CREATE OR REPLACE FUNCTION public.wf_instance_detail(p_entity_type text, p_entity_id bigint)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$begin if p_entity_type='BUDGET_TRANSFER'then perform budget_private.context_access();perform budget_private.transfer(p_entity_id);end if;return budget_private.wf_instance_detail(p_entity_type,p_entity_id);end$function$;

CREATE OR REPLACE FUNCTION public.wf_notifications_list(p_mark_read boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$declare out jsonb;begin select coalesce(jsonb_agg(to_jsonb(n)order by created_at desc),'[]')into out from wf_notifications n where usuario_id=app_user_id();if p_mark_read then update wf_notifications set leida=true where usuario_id=app_user_id();end if;return out;end$function$;
