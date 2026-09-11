create table if not exists wf_workflows(
 id bigint generated always as identity primary key,nombre text not null,entity_type text not null check(entity_type in('PURCHASE_ORDER','SALES_ORDER','PAYMENT_REQUEST')),
 estado_activo boolean not null default true,subsidiaria_id bigint not null references subsidiaries,descripcion text,created_by bigint references users,created_at timestamptz default now(),updated_at timestamptz default now());
create unique index if not exists wf_one_active_entity on wf_workflows(subsidiaria_id,entity_type) where estado_activo;
create table if not exists wf_rules(
 id bigint generated always as identity primary key,workflow_id bigint not null references wf_workflows on delete cascade,nivel int not null check(nivel>0),
 nombre_nivel text not null,rol_aprobador_id bigint references roles,usuario_aprobador_id bigint references users,
 condicion_monto_min numeric(24,6),condicion_monto_max numeric(24,6),departamento_id bigint references departments,centro_costo_id bigint references cost_centers,
 porcentaje_descuento_min numeric(12,6),tipo_desembolso text,json_condiciones_extra jsonb not null default '{}',
 politica text not null default 'CUALQUIERA' check(politica in('CUALQUIERA','TODOS')),
 check((rol_aprobador_id is null)<>(usuario_aprobador_id is null)),unique(workflow_id,nivel));
create table if not exists wf_instances(
 id bigint generated always as identity primary key,workflow_id bigint references wf_workflows,subsidiaria_id bigint not null references subsidiaries,
 entity_type text not null,entity_id bigint not null,amount numeric(24,6) not null,approval_context jsonb not null default '{}',
 current_level int,status text not null check(status in('BORRADOR','PENDIENTE_APROBACION','EN_REVISION','APROBADO','RECHAZADO','CANCELADO')),
 requested_by bigint references users,created_at timestamptz default now(),updated_at timestamptz default now(),completed_at timestamptz,unique(entity_type,entity_id));
create table if not exists wf_instance_steps(
 id bigint generated always as identity primary key,instance_id bigint not null references wf_instances on delete cascade,nivel int not null,nombre_nivel text not null,
 rol_aprobador_id bigint references roles,usuario_aprobador_id bigint references users,politica text not null,required_count int not null default 1,status text not null default 'PENDIENTE',unique(instance_id,nivel));
create table if not exists wf_step_decisions(
 id bigint generated always as identity primary key,step_id bigint not null references wf_instance_steps on delete cascade,usuario_id bigint not null references users,
 accion text not null check(accion in('APROBAR','RECHAZAR')),comentario text,fecha_hora timestamptz default now(),ip_address inet,unique(step_id,usuario_id));
create table if not exists wf_historial_logs(
 id bigint generated always as identity primary key,instance_id bigint not null references wf_instances on delete cascade,nivel int,usuario_id bigint references users,
 rol_id bigint references roles,accion_tomada text not null,comentario_motivo text,ip_address inet,fecha_hora timestamptz default now());
create table if not exists wf_notifications(
 id bigint generated always as identity primary key,usuario_id bigint not null references users,instance_id bigint not null references wf_instances on delete cascade,
 titulo text not null,mensaje text not null,deep_link text,leida boolean default false,created_at timestamptz default now());
create table if not exists wf_email_outbox(
 id bigint generated always as identity primary key,usuario_id bigint references users,email text not null,subject text not null,body text not null,deep_link text,
 status text not null default 'PENDIENTE',attempts int not null default 0,created_at timestamptz default now(),sent_at timestamptz);

create index if not exists wf_inbox_idx on wf_instances(subsidiaria_id,status,current_level);
create index if not exists wf_notify_user_idx on wf_notifications(usuario_id,leida,created_at desc);
alter table wf_workflows enable row level security;alter table wf_rules enable row level security;alter table wf_instances enable row level security;alter table wf_instance_steps enable row level security;alter table wf_step_decisions enable row level security;alter table wf_historial_logs enable row level security;alter table wf_notifications enable row level security;alter table wf_email_outbox enable row level security;
drop policy if exists wf_notifications_own on wf_notifications;create policy wf_notifications_own on wf_notifications for select to authenticated using(usuario_id=app_user_id());
grant select on wf_notifications to authenticated;revoke all on wf_workflows,wf_rules,wf_instances,wf_instance_steps,wf_step_decisions,wf_historial_logs,wf_email_outbox from public,anon,authenticated;

create or replace function wf_entity_data(p_type text,p_id bigint)returns jsonb language plpgsql stable security definer set search_path=public,pg_temp as $$
declare x jsonb;begin
 if p_type='PURCHASE_ORDER' then select jsonb_build_object('subsidiaryId',subsidiary_id,'amount',total_amount,'number',document_number,'status',status,'departmentId',(select min(department_id)from purchase_document_line where document_id=p_id),'costCenterId',(select min(cost_center_id)from purchase_document_line where document_id=p_id),'deepLink','/purchase-documents.html?type=ORDER&id='||p_id)into x from purchase_document where document_id=p_id and document_type='ORDER';
 elsif p_type='SALES_ORDER' then select jsonb_build_object('subsidiaryId',subsidiary_id,'amount',total_amount,'number',document_number,'status',status,'departmentId',(select min(department_id)from sales_document_line where document_id=p_id),'costCenterId',(select min(cost_center_id)from sales_document_line where document_id=p_id),'discountPercent',0,'customerId',customer_id,'deepLink','/sales-documents.html?type=ORDER&id='||p_id)into x from sales_document where document_id=p_id and document_type='ORDER';
 elsif p_type='PAYMENT_REQUEST' then select jsonb_build_object('subsidiaryId',id_subsidiaria,'amount',total,'number',numero,'status',estado,'paymentType',tipo_solicitud,'deepLink','/payment-requests.html?id='||id)into x from solicitudes_pago where id=p_id;
 end if;if x is null then raise exception'Documento no encontrado para el flujo.';end if;return x;end$$;
create or replace function wf_apply_entity_status(p_type text,p_id bigint,p_status text)returns void language plpgsql security definer set search_path=public,pg_temp as $$
begin
 if p_type='PURCHASE_ORDER'then update purchase_document set status=p_status,updated_at=now()where document_id=p_id;
 elsif p_type='SALES_ORDER'then update sales_document set status=p_status,updated_at=now()where document_id=p_id;
 elsif p_type='PAYMENT_REQUEST'then update solicitudes_pago set estado=case p_status when'CANCELADO'then'ANULADO'else p_status end,version=version+1,updated_at=now()where id=p_id;
 end if;
end$$;
create or replace function wf_notify_level(p_instance bigint)returns void language plpgsql security definer set search_path=public,pg_temp as $$
declare st wf_instance_steps%rowtype;ins wf_instances%rowtype;u record;title text;link text;begin select*into ins from wf_instances where id=p_instance;select*into st from wf_instance_steps where instance_id=p_instance and nivel=ins.current_level;
 title:='Aprobación pendiente · '||(wf_entity_data(ins.entity_type,ins.entity_id)->>'number');link:=wf_entity_data(ins.entity_type,ins.entity_id)->>'deepLink';
 for u in select distinct x.user_id,x.email from users x where x.is_active and(x.user_id=st.usuario_aprobador_id or exists(select 1 from user_roles ur where ur.user_id=x.user_id and ur.role_id=st.rol_aprobador_id))loop
  insert into wf_notifications(usuario_id,instance_id,titulo,mensaje,deep_link)values(u.user_id,ins.id,title,'Requiere su aprobación en el nivel '||st.nivel||': '||st.nombre_nivel,link);
  insert into wf_email_outbox(usuario_id,email,subject,body,deep_link)values(u.user_id,u.email,title,'Tiene un documento pendiente de aprobación en NEXO.',link);
 end loop;end$$;
create or replace function wf_start_entity(p_entity_type text,p_entity_id bigint,p_context jsonb default '{}')returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare d jsonb;w wf_workflows%rowtype;ins wf_instances%rowtype;r wf_rules%rowtype;n int;ctx jsonb;begin d:=wf_entity_data(p_entity_type,p_entity_id);
 if(d->>'subsidiaryId')::bigint<>active_subsidiary_id()then raise exception'Documento fuera de la subsidiaria activa.';end if;
 select*into w from wf_workflows where subsidiaria_id=active_subsidiary_id()and entity_type=p_entity_type and estado_activo order by id desc limit 1;
 if not found then raise exception'No existe un flujo de aprobación activo para este tipo de documento.';end if;
 ctx:=d||coalesce(p_context,'{}');select*into ins from wf_instances where entity_type=p_entity_type and entity_id=p_entity_id for update;
 if found and ins.status not in('BORRADOR','RECHAZADO','CANCELADO')then return jsonb_build_object('id',ins.id,'status',ins.status);end if;
 if found then delete from wf_instances where id=ins.id;end if;
 insert into wf_instances(workflow_id,subsidiaria_id,entity_type,entity_id,amount,approval_context,current_level,status,requested_by)
 values(w.id,active_subsidiary_id(),p_entity_type,p_entity_id,(d->>'amount')::numeric,ctx,1,'PENDIENTE_APROBACION',app_user_id())returning*into ins;
 for r in select*from wf_rules where workflow_id=w.id and(condicion_monto_min is null or(d->>'amount')::numeric>=condicion_monto_min)and(condicion_monto_max is null or(d->>'amount')::numeric<=condicion_monto_max)
 and(departamento_id is null or(ctx->>'departmentId')::bigint=departamento_id)and(centro_costo_id is null or(ctx->>'costCenterId')::bigint=centro_costo_id)
 and(porcentaje_descuento_min is null or coalesce((ctx->>'discountPercent')::numeric,0)>porcentaje_descuento_min)
 and(tipo_desembolso is null or ctx->>'paymentType'=tipo_desembolso)order by nivel loop
  insert into wf_instance_steps(instance_id,nivel,nombre_nivel,rol_aprobador_id,usuario_aprobador_id,politica,required_count)
  values(ins.id,r.nivel,r.nombre_nivel,r.rol_aprobador_id,r.usuario_aprobador_id,r.politica,case when r.politica='TODOS'and r.rol_aprobador_id is not null then greatest((select count(*)from user_roles ur join users u using(user_id)where ur.role_id=r.rol_aprobador_id and u.is_active),1)else 1 end);
 end loop;
 select min(nivel)into n from wf_instance_steps where instance_id=ins.id;
 if n is null then update wf_instances set status='APROBADO',current_level=null,completed_at=now()where id=ins.id;perform wf_apply_entity_status(p_entity_type,p_entity_id,'APROBADO');
 else update wf_instances set current_level=n,status='EN_REVISION'where id=ins.id;perform wf_apply_entity_status(p_entity_type,p_entity_id,'PENDIENTE_APROBACION');perform wf_notify_level(ins.id);end if;
 insert into wf_historial_logs(instance_id,nivel,usuario_id,accion_tomada,comentario_motivo)values(ins.id,n,app_user_id(),'ENVIADO','Documento enviado a aprobación');
 return(select jsonb_build_object('id',id,'status',status,'currentLevel',current_level)from wf_instances where id=ins.id);end$$;
create or replace function wf_act(p_instance_id bigint,p_action text,p_comment text default null,p_ip inet default null)returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare ins wf_instances%rowtype;st wf_instance_steps%rowtype;eligible boolean;approved int;next_level int;act text:=upper(p_action);begin
 select*into ins from wf_instances where id=p_instance_id and subsidiaria_id=active_subsidiary_id()for update;if not found then raise exception'Flujo no encontrado.';end if;
 if act='CANCELAR' then if ins.requested_by<>app_user_id()and not app_is_admin()then raise exception'Solo el solicitante puede cancelar.';end if;update wf_instances set status='CANCELADO',updated_at=now(),completed_at=now()where id=ins.id;perform wf_apply_entity_status(ins.entity_type,ins.entity_id,'CANCELADO');
 elsif act in('APROBAR','RECHAZAR')then
  select*into st from wf_instance_steps where instance_id=ins.id and nivel=ins.current_level for update;if not found then raise exception'No existe un nivel pendiente.';end if;
  eligible:=st.usuario_aprobador_id=app_user_id()or exists(select 1 from user_roles where user_id=app_user_id()and role_id=st.rol_aprobador_id);if not eligible and not app_is_admin()then raise exception'No está asignado como aprobador de este nivel.';end if;
  if act='RECHAZAR'and nullif(trim(p_comment),'')is null then raise exception'El motivo de rechazo es obligatorio.';end if;
  insert into wf_step_decisions(step_id,usuario_id,accion,comentario,ip_address)values(st.id,app_user_id(),act,p_comment,p_ip)on conflict(step_id,usuario_id)do nothing;
  if act='RECHAZAR'then update wf_instance_steps set status='RECHAZADO'where id=st.id;update wf_instances set status='RECHAZADO',updated_at=now(),completed_at=now()where id=ins.id;perform wf_apply_entity_status(ins.entity_type,ins.entity_id,'RECHAZADO');
  else select count(*)into approved from wf_step_decisions where step_id=st.id and accion='APROBAR';if st.politica='CUALQUIERA'or approved>=st.required_count then update wf_instance_steps set status='APROBADO'where id=st.id;select min(nivel)into next_level from wf_instance_steps where instance_id=ins.id and nivel>st.nivel and status='PENDIENTE';if next_level is null then update wf_instances set status='APROBADO',current_level=null,updated_at=now(),completed_at=now()where id=ins.id;perform wf_apply_entity_status(ins.entity_type,ins.entity_id,'APROBADO');else update wf_instances set status='EN_REVISION',current_level=next_level,updated_at=now()where id=ins.id;perform wf_notify_level(ins.id);end if;end if;end if;
 else raise exception'Acción inválida.';end if;
 insert into wf_historial_logs(instance_id,nivel,usuario_id,rol_id,accion_tomada,comentario_motivo,ip_address)values(ins.id,st.nivel,app_user_id(),st.rol_aprobador_id,act,p_comment,p_ip);
 return(select jsonb_build_object('id',id,'status',status,'currentLevel',current_level)from wf_instances where id=ins.id);end$$;

create or replace function wf_options()returns jsonb language sql stable security definer set search_path=public,pg_temp as $$
select jsonb_build_object('company',s.name,'isAdmin',app_is_admin(),'entityTypes',jsonb_build_array(jsonb_build_object('id','PURCHASE_ORDER','name','Órdenes de Compra'),jsonb_build_object('id','SALES_ORDER','name','Órdenes de Venta'),jsonb_build_object('id','PAYMENT_REQUEST','name','Solicitudes de Pago')),
'roles',coalesce((select jsonb_agg(jsonb_build_object('id',role_id,'name',role_name)order by role_name)from roles),'[]'),
'users',coalesce((select jsonb_agg(jsonb_build_object('id',u.user_id,'name',trim(u.first_name||' '||u.last_name),'email',u.email)order by u.first_name,u.last_name)from users u join user_subsidiaries us using(user_id)where us.subsidiary_id=s.subsidiary_id and u.is_active),'[]'),
'departments',coalesce((select jsonb_agg(jsonb_build_object('id',department_id,'name',name)order by name)from departments where subsidiary_id=s.subsidiary_id),'[]'),
'costCenters',coalesce((select jsonb_agg(jsonb_build_object('id',cost_center_id,'name',name)order by name)from cost_centers where subsidiary_id=s.subsidiary_id),'[]'))from subsidiaries s where s.subsidiary_id=active_subsidiary_id()$$;
create or replace function wf_admin_list()returns jsonb language sql stable security definer set search_path=public,pg_temp as $$
select coalesce(jsonb_agg(to_jsonb(w)||jsonb_build_object('rules',coalesce((select jsonb_agg(to_jsonb(r)order by nivel)from wf_rules r where r.workflow_id=w.id),'[]'))order by w.entity_type,w.nombre),'[]')from wf_workflows w where w.subsidiaria_id=active_subsidiary_id()$$;
create or replace function wf_save_workflow(p jsonb)returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare wid bigint:=nullif(p->>'id','')::bigint;r jsonb;lvl int:=0;begin if not app_is_admin()then raise exception'Solo un administrador puede configurar flujos.';end if;
 if coalesce(jsonb_array_length(p->'rules'),0)=0 then raise exception'Agregue al menos un nivel de aprobación.';end if;
 if wid is null then insert into wf_workflows(nombre,entity_type,estado_activo,subsidiaria_id,descripcion,created_by)values(p->>'name',p->>'entityType',coalesce((p->>'active')::boolean,true),active_subsidiary_id(),p->>'description',app_user_id())returning id into wid;
 else update wf_workflows set nombre=p->>'name',entity_type=p->>'entityType',estado_activo=coalesce((p->>'active')::boolean,true),descripcion=p->>'description',updated_at=now()where id=wid and subsidiaria_id=active_subsidiary_id();if not found then raise exception'Flujo no encontrado.';end if;delete from wf_rules where workflow_id=wid;end if;
 for r in select value from jsonb_array_elements(p->'rules')loop lvl:=lvl+1;insert into wf_rules(workflow_id,nivel,nombre_nivel,rol_aprobador_id,usuario_aprobador_id,condicion_monto_min,condicion_monto_max,departamento_id,centro_costo_id,porcentaje_descuento_min,tipo_desembolso,json_condiciones_extra,politica)
 values(wid,lvl,coalesce(nullif(r->>'name',''),'Nivel '||lvl),nullif(r->>'roleId','')::bigint,nullif(r->>'userId','')::bigint,nullif(r->>'minAmount','')::numeric,nullif(r->>'maxAmount','')::numeric,nullif(r->>'departmentId','')::bigint,nullif(r->>'costCenterId','')::bigint,nullif(r->>'discountMin','')::numeric,nullif(r->>'paymentType',''),coalesce(r->'extra','{}'),coalesce(nullif(r->>'policy',''),'CUALQUIERA'));end loop;return jsonb_build_object('id',wid);end$$;
create or replace function wf_delete_workflow(p_id bigint)returns boolean language plpgsql security definer set search_path=public,pg_temp as $$begin if not app_is_admin()then raise exception'Solo un administrador puede eliminar flujos.';end if;if exists(select 1 from wf_instances where workflow_id=p_id)then update wf_workflows set estado_activo=false where id=p_id and subsidiaria_id=active_subsidiary_id();else delete from wf_workflows where id=p_id and subsidiaria_id=active_subsidiary_id();end if;return true;end$$;
create or replace function wf_inbox()returns jsonb language sql stable security definer set search_path=public,pg_temp as $$
select coalesce(jsonb_agg(jsonb_build_object('instanceId',i.id,'entityType',i.entity_type,'entityId',i.entity_id,'amount',i.amount,'status',i.status,'level',i.current_level,'levelName',s.nombre_nivel,'policy',s.politica,'requestedAt',i.created_at,'number',wf_entity_data(i.entity_type,i.entity_id)->>'number','deepLink',wf_entity_data(i.entity_type,i.entity_id)->>'deepLink')order by i.created_at),'[]')
from wf_instances i join wf_instance_steps s on s.instance_id=i.id and s.nivel=i.current_level where i.subsidiaria_id=active_subsidiary_id()and i.status='EN_REVISION'and(s.usuario_aprobador_id=app_user_id()or exists(select 1 from user_roles ur where ur.user_id=app_user_id()and ur.role_id=s.rol_aprobador_id)or app_is_admin())and not exists(select 1 from wf_step_decisions d where d.step_id=s.id and d.usuario_id=app_user_id())$$;
create or replace function wf_instance_detail(p_entity_type text,p_entity_id bigint)returns jsonb language plpgsql stable security definer set search_path=public,pg_temp as $$
declare ins wf_instances%rowtype;steps_json jsonb;history_json jsonb;begin
 select*into ins from wf_instances where entity_type=p_entity_type and entity_id=p_entity_id and subsidiaria_id=active_subsidiary_id();
 if not found then return null;end if;
 select coalesce(jsonb_agg(to_jsonb(s)order by s.nivel),'[]')into steps_json from wf_instance_steps s where s.instance_id=ins.id;
 select coalesce(jsonb_agg(to_jsonb(h)||jsonb_build_object('user',trim(coalesce(u.first_name,'')||' '||coalesce(u.last_name,'')),'role',r.role_name)order by h.fecha_hora),'[]')into history_json from wf_historial_logs h left join users u on u.user_id=h.usuario_id left join roles r on r.role_id=h.rol_id where h.instance_id=ins.id;
 return jsonb_build_object('instance',to_jsonb(ins),'steps',steps_json,'history',history_json);
end$$;
create or replace function wf_bulk_approve(p_ids jsonb,p_comment text default null,p_ip inet default null)returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$declare x jsonb;ok int:=0;begin for x in select value from jsonb_array_elements(p_ids)loop perform wf_act((x#>>'{}')::bigint,'APROBAR',p_comment,p_ip);ok:=ok+1;end loop;return jsonb_build_object('approved',ok);end$$;
create or replace function wf_notifications_list(p_mark_read boolean default false)returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$declare out jsonb;begin select coalesce(jsonb_agg(to_jsonb(n)order by created_at desc),'[]')into out from wf_notifications n where usuario_id=app_user_id();if p_mark_read then update wf_notifications set leida=true where usuario_id=app_user_id();end if;return out;end$$;

create or replace function wf_protect_purchase_order()returns trigger language plpgsql security definer set search_path=public,pg_temp as $$declare i wf_instances%rowtype;begin if old.document_type<>'ORDER'then return new;end if;select*into i from wf_instances where entity_type='PURCHASE_ORDER'and entity_id=old.document_id;if i.status in('PENDIENTE_APROBACION','EN_REVISION')and(to_jsonb(new)-array['status','updated_at'])<>(to_jsonb(old)-array['status','updated_at'])then raise exception'La orden está en aprobación y no puede modificarse.';elsif i.status='APROBADO'and(to_jsonb(new)-array['status','updated_at'])<>(to_jsonb(old)-array['status','updated_at'])then update wf_instances set status='BORRADOR',current_level=null,updated_at=now()where id=i.id;new.status:='BORRADOR';insert into wf_historial_logs(instance_id,usuario_id,accion_tomada,comentario_motivo)values(i.id,app_user_id(),'REINICIADO','El documento aprobado fue modificado y debe evaluarse nuevamente.');end if;return new;end$$;
drop trigger if exists wf_protect_purchase_order_trigger on purchase_document;create trigger wf_protect_purchase_order_trigger before update on purchase_document for each row execute function wf_protect_purchase_order();
create or replace function wf_protect_sales_order()returns trigger language plpgsql security definer set search_path=public,pg_temp as $$declare i wf_instances%rowtype;begin if old.document_type<>'ORDER'then return new;end if;select*into i from wf_instances where entity_type='SALES_ORDER'and entity_id=old.document_id;if i.status in('PENDIENTE_APROBACION','EN_REVISION')and(to_jsonb(new)-array['status','updated_at'])<>(to_jsonb(old)-array['status','updated_at'])then raise exception'La orden está en aprobación y no puede modificarse.';elsif i.status='APROBADO'and(to_jsonb(new)-array['status','updated_at'])<>(to_jsonb(old)-array['status','updated_at'])then update wf_instances set status='BORRADOR',current_level=null,updated_at=now()where id=i.id;new.status:='BORRADOR';insert into wf_historial_logs(instance_id,usuario_id,accion_tomada,comentario_motivo)values(i.id,app_user_id(),'REINICIADO','El documento aprobado fue modificado y debe evaluarse nuevamente.');end if;return new;end$$;
drop trigger if exists wf_protect_sales_order_trigger on sales_document;create trigger wf_protect_sales_order_trigger before update on sales_document for each row execute function wf_protect_sales_order();

revoke all on function wf_entity_data(text,bigint),wf_apply_entity_status(text,bigint,text),wf_notify_level(bigint),wf_start_entity(text,bigint,jsonb),wf_act(bigint,text,text,inet),wf_options(),wf_admin_list(),wf_save_workflow(jsonb),wf_delete_workflow(bigint),wf_inbox(),wf_instance_detail(text,bigint),wf_bulk_approve(jsonb,text,inet),wf_notifications_list(boolean),wf_protect_purchase_order(),wf_protect_sales_order()from public,anon;
grant execute on function wf_start_entity(text,bigint,jsonb),wf_act(bigint,text,text,inet),wf_options(),wf_admin_list(),wf_save_workflow(jsonb),wf_delete_workflow(bigint),wf_inbox(),wf_instance_detail(text,bigint),wf_bulk_approve(jsonb,text,inet),wf_notifications_list(boolean)to authenticated;
do $$begin alter publication supabase_realtime add table wf_notifications;exception when duplicate_object then null;when undefined_object then null;end$$;
notify pgrst,'reload schema';

-- Configuración inicial para que los tres adaptadores queden operativos desde la instalación.
do $$declare s record;e text;wid bigint;admin_role bigint;approver bigint;begin select role_id into admin_role from roles where lower(role_name)='administrador'order by role_id limit 1;for s in select subsidiary_id,administrative_approver from subsidiaries loop foreach e in array array['PURCHASE_ORDER','SALES_ORDER','PAYMENT_REQUEST']loop if not exists(select 1 from wf_workflows where subsidiaria_id=s.subsidiary_id and entity_type=e and estado_activo)then insert into wf_workflows(nombre,entity_type,subsidiaria_id,descripcion)values('Aprobación estándar · '||case e when'PURCHASE_ORDER'then'Órdenes de Compra'when'SALES_ORDER'then'Órdenes de Venta'else'Solicitudes de Pago'end,e,s.subsidiary_id,'Flujo inicial editable desde Configuración de Flujos de Aprobación')returning id into wid;approver:=case when s.administrative_approver like'user:%'then split_part(s.administrative_approver,':',2)::bigint else null end;if approver is not null or admin_role is not null then insert into wf_rules(workflow_id,nivel,nombre_nivel,rol_aprobador_id,usuario_aprobador_id,politica)values(wid,1,'Aprobación administrativa',case when approver is null then admin_role end,approver,'CUALQUIERA');else update wf_workflows set estado_activo=false where id=wid;end if;end if;end loop;end loop;end$$;
