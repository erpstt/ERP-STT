CREATE OR REPLACE FUNCTION public.wf_protect_sales_order()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$declare i wf_instances%rowtype;begin if old.document_type<>'ORDER'then return new;end if;select*into i from wf_instances where entity_type='SALES_ORDER'and entity_id=old.document_id;if i.status in('PENDIENTE_APROBACION','EN_REVISION')and(to_jsonb(new)-array['status','updated_at'])<>(to_jsonb(old)-array['status','updated_at'])then raise exception'La orden está en aprobación y no puede modificarse.';elsif i.status='APROBADO'and(to_jsonb(new)-array['status','updated_at'])<>(to_jsonb(old)-array['status','updated_at'])then update wf_instances set status='BORRADOR',current_level=null,updated_at=now()where id=i.id;new.status:='BORRADOR';insert into wf_historial_logs(instance_id,usuario_id,accion_tomada,comentario_motivo)values(i.id,app_user_id(),'REINICIADO','El documento aprobado fue modificado y debe evaluarse nuevamente.');end if;return new;end$function$;

CREATE OR REPLACE FUNCTION public.wf_require_approved_source()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
begin
 if tg_table_name='purchase_document'and new.document_type='RECEIPT'and not exists(select 1 from purchase_document where document_id=new.source_document_id and document_type='ORDER'and status='APROBADO')then raise exception'La orden de compra debe completar su flujo de aprobación antes de recibir inventario.';
 elsif tg_table_name='sales_document'and new.document_type='DELIVERY'and not exists(select 1 from sales_document where document_id=new.source_document_id and document_type='ORDER'and status='APROBADO')then raise exception'La orden de venta debe completar su flujo de aprobación antes del despacho.';
 end if;return new;end$function$;
