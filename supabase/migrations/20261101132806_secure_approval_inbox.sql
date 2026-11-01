-- C-04: approval inbox, personal notifications and document history.
set local lock_timeout='5s';set local statement_timeout='60s';
create schema approval_inbox_private;
revoke all on schema approval_inbox_private from public,anon,authenticated,service_role;
grant usage on schema approval_inbox_private to authenticated;
create function approval_inbox_private.identity()returns bigint language plpgsql stable security definer set search_path=pg_catalog,public,pg_temp as $$declare sid bigint:=asset_posting_private.identity();begin
 if not exists(select 1 from public.users u join public.user_roles ur using(user_id)where u.user_id=public.app_user_id()and u.is_active and ur.role_id=public.app_active_role_id())then raise exception using errcode='42501',message='Seleccione usuario y rol activos autorizados.';end if;return sid;end$$;
create function approval_inbox_private.access()returns bigint language plpgsql stable security definer set search_path=pg_catalog,public,pg_temp as $$declare sid bigint:=approval_inbox_private.identity();begin perform public.security_assert_role_access('workflow:approval-inbox','view');return sid;end$$;
create function approval_inbox_private.source_visible(kind text,id bigint)returns boolean language plpgsql stable security definer set search_path=pg_catalog,public,pg_temp as $$declare sid bigint:=approval_inbox_private.identity();begin
 if kind='PURCHASE_ORDER'then return purchase_order_private.visible(id);
 elsif kind='SALES_ORDER'then return sales_workflow_private.visible(id);
 elsif kind='PAYMENT_REQUEST'then return payment_request_private.visible(id);
 elsif kind='BUDGET_TRANSFER'then return budget_private.visible(sid)and exists(select 1 from public.presupuestos_modificaciones m where m.id=$2 and m.id_subsidiaria=sid);
 end if;return false;exception when insufficient_privilege then return false;end$$;
create function approval_inbox_private.actionable(id bigint)returns boolean language sql stable security definer set search_path=pg_catalog,public,pg_temp as $$
 select exists(select 1 from public.wf_instances i join public.wf_instance_steps s on s.instance_id=i.id and s.nivel=i.current_level where i.id=$1 and i.subsidiaria_id=approval_inbox_private.access()and i.status='EN_REVISION'and s.status='PENDIENTE'and(s.usuario_aprobador_id=public.app_user_id()or s.rol_aprobador_id=public.app_active_role_id())and not exists(select 1 from public.wf_step_decisions d where d.step_id=s.id and d.usuario_id=public.app_user_id())and approval_inbox_private.source_visible(i.entity_type,i.entity_id)and(i.entity_type<>'BUDGET_TRANSFER'or budget_private.allowed('BUDGET_APPROVE','edit')))$$;
create function approval_inbox_private.notification_visible(uid bigint,instance bigint)returns boolean language plpgsql stable security definer set search_path=pg_catalog,public,pg_temp as $$declare sid bigint:=approval_inbox_private.access();begin return uid=public.app_user_id()and exists(select 1 from public.wf_instances i where i.id=instance and i.subsidiaria_id=sid and approval_inbox_private.source_visible(i.entity_type,i.entity_id));exception when insufficient_privilege then return false;end$$;

alter function public.wf_inbox()set schema approval_inbox_private;
alter function public.wf_instance_detail(text,bigint)set schema approval_inbox_private;
alter function public.wf_bulk_approve(jsonb,text,inet)set schema approval_inbox_private;
alter function public.wf_notifications_list(boolean)set schema approval_inbox_private;

create function public.wf_inbox()returns jsonb language plpgsql stable security definer set search_path=pg_catalog,public,pg_temp as $$declare sid bigint:=approval_inbox_private.access();begin
 return coalesce((select jsonb_agg(jsonb_build_object('instanceId',i.id,'entityType',i.entity_type,'entityId',i.entity_id,'amount',i.amount,'status',i.status,'level',i.current_level,'levelName',s.nombre_nivel,'policy',s.politica,'requestedAt',i.created_at,'number',public.wf_entity_data(i.entity_type,i.entity_id)->>'number','deepLink',public.wf_entity_data(i.entity_type,i.entity_id)->>'deepLink','actions',jsonb_build_object('canApprove',true,'canReject',true))order by i.created_at,i.id)from public.wf_instances i join public.wf_instance_steps s on s.instance_id=i.id and s.nivel=i.current_level where i.subsidiaria_id=sid and approval_inbox_private.actionable(i.id)),'[]'::jsonb);end$$;
create function public.wf_instance_detail(p_entity_type text,p_entity_id bigint)returns jsonb language plpgsql stable security definer set search_path=pg_catalog,public,pg_temp as $$begin
 perform approval_inbox_private.identity();if p_entity_type is null or p_entity_type not in('PURCHASE_ORDER','SALES_ORDER','PAYMENT_REQUEST','BUDGET_TRANSFER')or p_entity_id is null or p_entity_id<=0 then raise exception using errcode='22023',message='Documento de aprobación inválido.';end if;
 if not approval_inbox_private.source_visible(p_entity_type,p_entity_id)then raise exception using errcode='42501',message='Historial no disponible para este documento y rol.';end if;return approval_inbox_private.wf_instance_detail(p_entity_type,p_entity_id);end$$;
create function public.wf_bulk_approve(p_ids jsonb,p_comment text default null,p_ip inet default null)returns jsonb language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$declare x jsonb;ids bigint[];id bigint;begin
 perform approval_inbox_private.access();if length(coalesce(p_comment,''))>4000 then raise exception using errcode='22023',message='Comentario demasiado largo.';end if;if jsonb_typeof(p_ids)is distinct from'array'or jsonb_array_length(p_ids)not between 1 and 100 then raise exception using errcode='22023',message='Seleccione entre uno y cien documentos.';end if;
 for x in select value from jsonb_array_elements(p_ids)loop if jsonb_typeof(x)not in('number','string')or(x#>>'{}')!~'^[1-9][0-9]{0,15}$'or(x#>>'{}')::numeric>9007199254740991 then raise exception using errcode='22023',message='Identificador de aprobación inválido.';end if;end loop;
 select array_agg((value#>>'{}')::bigint order by(value#>>'{}')::bigint)into ids from jsonb_array_elements(p_ids);
 if cardinality(ids)<>(select count(distinct v)from unnest(ids)v)then raise exception using errcode='22023',message='No repita documentos en la selección.';end if;
 foreach id in array ids loop if not approval_inbox_private.actionable(id)then raise exception using errcode='42501',message='Una aprobación ya no está disponible para el rol y subsidiaria activos.';end if;end loop;
 foreach id in array ids loop perform public.wf_act(id,'APROBAR',p_comment,p_ip);end loop;return jsonb_build_object('approved',cardinality(ids));end$$;
create function public.wf_notifications_list(p_mark_read boolean default false)returns jsonb language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$declare ids bigint[];begin
 perform approval_inbox_private.access();select array_agg(id)into ids from(select n.id from public.wf_notifications n where approval_inbox_private.notification_visible(n.usuario_id,n.instance_id)order by n.created_at desc,n.id desc limit 200)q;
 if coalesce(p_mark_read,false)then update public.wf_notifications set leida=true where id=any(ids)and usuario_id=public.app_user_id();end if;
 return coalesce((select jsonb_agg(jsonb_build_object('id',n.id,'instance_id',n.instance_id,'titulo',n.titulo,'mensaje',n.mensaje,'deep_link',n.deep_link,'leida',n.leida,'created_at',n.created_at)order by n.created_at desc,n.id desc)from public.wf_notifications n where n.id=any(ids)),'[]'::jsonb);end$$;

-- Configured role unanimity counts only active members of the instance subsidiary.
-- Dynamic payment approvals preserve their existing snapshot/error reporting path.
create function approval_inbox_private.guard_step_recipients()returns trigger language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$declare i public.wf_instances;n int;begin
 select *into i from public.wf_instances where id=new.instance_id;if i.workflow_id is null then return new;end if;
 if new.usuario_aprobador_id is not null then
  if not exists(select 1 from public.users u join public.user_subsidiaries us using(user_id)where u.user_id=new.usuario_aprobador_id and u.is_active and us.subsidiary_id=i.subsidiaria_id)then raise exception using errcode='55000',message='El aprobador ya no tiene acceso activo a la subsidiaria.';end if;
 elsif new.rol_aprobador_id is not null then
  select count(distinct u.user_id)into n from public.users u join public.user_roles ur using(user_id)join public.user_subsidiaries us using(user_id)where u.is_active and ur.role_id=new.rol_aprobador_id and us.subsidiary_id=i.subsidiaria_id;
  if n=0 then raise exception using errcode='55000',message='El rol aprobador ya no tiene usuarios activos en la subsidiaria.';end if;if new.politica='TODOS'then new.required_count:=n;end if;
 else raise exception using errcode='55000',message='No hay un aprobador asignado al nivel.';end if;return new;end$$;
create trigger approval_step_recipient_scope before insert on public.wf_instance_steps for each row execute function approval_inbox_private.guard_step_recipients();

do $$declare t text;p record;c record;begin foreach t in array array['wf_instances','wf_instance_steps','wf_step_decisions','wf_historial_logs','wf_notifications','wf_email_outbox']loop
 execute format('alter table public.%I enable row level security',t);for p in select policyname from pg_policies where schemaname='public'and tablename=t loop execute format('drop policy %I on public.%I',p.policyname,t);end loop;
 execute format('revoke all on public.%I from public,anon,authenticated,service_role',t);for c in select column_name from information_schema.columns where table_schema='public'and table_name=t loop execute format('revoke insert(%I),update(%I),select(%I),references(%I)on public.%I from public,anon,authenticated,service_role',c.column_name,c.column_name,c.column_name,c.column_name,t);end loop;
 if t<>'wf_notifications'then execute format('create policy approval_internal_closed on public.%I for select to authenticated using(false)',t);end if;
end loop;end$$;
create policy approval_notification_read on public.wf_notifications for select to authenticated using(approval_inbox_private.notification_visible(usuario_id,instance_id));
grant select on public.wf_notifications to authenticated;
revoke all on all functions in schema approval_inbox_private from public,anon,authenticated,service_role;
grant execute on function approval_inbox_private.notification_visible(bigint,bigint)to authenticated;
revoke all on function public.wf_inbox(),public.wf_instance_detail(text,bigint),public.wf_bulk_approve(jsonb,text,inet),public.wf_notifications_list(boolean),public.wf_notify_level(bigint)from public,anon,authenticated,service_role;
grant execute on function public.wf_inbox(),public.wf_instance_detail(text,bigint),public.wf_bulk_approve(jsonb,text,inet),public.wf_notifications_list(boolean)to authenticated;
notify pgrst,'reload schema';
