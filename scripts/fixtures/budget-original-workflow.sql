CREATE OR REPLACE FUNCTION public.wf_act(p_instance_id bigint, p_action text, p_comment text DEFAULT NULL::text, p_ip inet DEFAULT NULL::inet)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$declare i public.wf_instances;d public.sales_document;prior text:=current_setting('nexo.sales_order_id',true);r jsonb;begin
 perform asset_posting_private.identity();select * into i from public.wf_instances where id=p_instance_id for update;
 if i.entity_type='SALES_ORDER' then
 d:=sales_workflow_private.header(i.entity_id,case upper(p_action) when 'CANCELAR' then 'delete' else 'view' end);d:=sales_workflow_private.lock_header(d.document_id);
 if d.document_type<>'ORDER' or i.subsidiaria_id<>d.subsidiary_id or i.status<>'EN_REVISION' or d.status<>'PENDIENTE_APROBACION' or i.amount is distinct from d.total_amount or i.approval_context->>'orderFingerprint' is distinct from sales_workflow_private.fingerprint(d.document_id) then raise exception using errcode='55000',message='Orden o aprobación protegida por estado o importe.';end if;
 if upper(p_action) in('APROBAR','RECHAZAR') and not exists(select 1 from public.wf_instance_steps s where s.instance_id=i.id and s.nivel=i.current_level and s.status='PENDIENTE' and(s.usuario_aprobador_id=public.app_user_id() or s.rol_aprobador_id=public.app_active_role_id())) then raise exception using errcode='42501',message='El rol activo no está asignado a este nivel.';end if;
 if upper(p_action) in('RECHAZAR','CANCELAR') and nullif(trim(p_comment),'') is null then raise exception using errcode='22023',message='Indique el motivo.';end if;perform set_config('nexo.sales_order_id',d.document_id::text,true);
 end if;
 r:=sales_workflow_private.wf_act(p_instance_id,p_action,p_comment,p_ip);perform set_config('nexo.sales_order_id',coalesce(prior,''),true);return r;end$function$;

CREATE OR REPLACE FUNCTION public.wf_instance_detail(p_entity_type text, p_entity_id bigint)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$begin if p_entity_type='SALES_ORDER' and not sales_workflow_private.visible(p_entity_id) then raise exception using errcode='42501',message='Orden no disponible.';end if;return sales_workflow_private.wf_instance_detail(p_entity_type,p_entity_id);end$function$;

CREATE OR REPLACE FUNCTION public.wf_start_entity(p_entity_type text, p_entity_id bigint, p_context jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
begin
 if p_entity_type='PAYMENT_REQUEST'then
  raise exception using errcode='42501',
   message='Las solicitudes de pago deben enviarse desde la acción Enviar a aprobación.';
 end if;
 return public.budget_run('WORKFLOW_START',
  jsonb_build_object('entityType',p_entity_type,'context',coalesce(p_context,'{}'::jsonb)),p_entity_id);
end$function$;
