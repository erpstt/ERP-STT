alter table public.customers add column envio_estado_cuenta_auto boolean not null default false;
alter table public.customers add constraint customer_statement_email_required check(not envio_estado_cuenta_auto or (email is not null and email ~ '^[^[:space:]@,;<>]+@[^[:space:]@,;<>]+\.[^[:space:]@,;<>]+$'));
alter table public.configuraciones_correos drop constraint configuraciones_correos_tipo_notificacion_check;
alter table public.configuraciones_correos add constraint configuraciones_correos_tipo_notificacion_check check(tipo_notificacion in ('PAGO_PROVEEDOR','ESTADO_CUENTA'));
alter table public.comunicaciones_logs alter column payment_id drop not null;
alter table public.comunicaciones_logs add column tipo_notificacion text not null default 'PAGO_PROVEEDOR',add column customer_id bigint,add column fecha_corte date;
alter table public.comunicaciones_logs add constraint comunicaciones_subject check((tipo_notificacion='PAGO_PROVEEDOR' and payment_id is not null and customer_id is null)or(tipo_notificacion='ESTADO_CUENTA' and payment_id is null and customer_id is not null and fecha_corte is not null));
create unique index customer_statement_dedup on public.comunicaciones_logs(id_subsidiaria,customer_id,fingerprint)where tipo_notificacion='ESTADO_CUENTA';

-- Keep payment settings and workers scoped to their original notification type.
do $$declare fn text; definition text;begin
 foreach fn in array array['payment_email_settings(text,jsonb)','payment_email_resend(bigint,text)','payment_email_claim()']loop
  definition:=pg_get_functiondef(('public.'||fn)::regprocedure);
  definition:=replace(definition,'where id_subsidiaria=sid;','where id_subsidiaria=sid and tipo_notificacion=''PAGO_PROVEEDOR'';');
  definition:=replace(definition,'where id_subsidiaria=job.id_subsidiaria and activo','where id_subsidiaria=job.id_subsidiaria and tipo_notificacion=''PAGO_PROVEEDOR'' and activo');
  definition:=replace(definition,'c.id_subsidiaria=l.id_subsidiaria;','c.id_subsidiaria=l.id_subsidiaria and c.tipo_notificacion=''PAGO_PROVEEDOR'';');
  definition:=replace(definition,'where estado=''PENDIENTE'' order by created_at','where estado=''PENDIENTE'' and tipo_notificacion=''PAGO_PROVEEDOR'' order by created_at');
  execute definition;
 end loop;
end$$;

-- Reuse the same aging calculation for interactive reports and the trusted server worker.
do $$declare definition text; needle text:='if sid is null or not exists(select 1 from user_subsidiaries where user_id=app_user_id() and subsidiary_id=sid) then';begin
 definition:=pg_get_functiondef('public.run_aging_report(text,jsonb)'::regprocedure);
 if strpos(definition,needle)=0 then raise exception 'La validación de acceso del reporte de antigüedad cambió; revise esta migración.';end if;
 execute replace(definition,needle,'if sid is null or (coalesce(auth.role(),'''')<>''service_role'' and not exists(select 1 from user_subsidiaries where user_id=app_user_id() and subsidiary_id=sid)) then');
end$$;

create function public.statement_settings(p_action text,p_payload jsonb default '{}')returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare sid bigint:=active_subsidiary_id();cfg configuraciones_correos%rowtype;
begin
 if app_user_id()is null or sid is null or not app_is_admin()then raise exception 'Solo un administrador puede configurar las notificaciones.';end if;
 if p_action='save' then
  if length(trim(p_payload->>'subject'))not between 1 and 200 or p_payload->>'subject'~E'[\r\n]' or length(p_payload->>'body')not between 1 and 20000 then raise exception 'Plantilla inválida.';end if;
  insert into configuraciones_correos(id_subsidiaria,tipo_notificacion,asunto_template,cuerpo_template,activo,updated_by_email)
  values(sid,'ESTADO_CUENTA',p_payload->>'subject',p_payload->>'body',coalesce((p_payload->>'active')::boolean,false),'sistema')
  on conflict(id_subsidiaria,tipo_notificacion)do update set asunto_template=excluded.asunto_template,cuerpo_template=excluded.cuerpo_template,activo=excluded.activo,updated_at=now();
 elsif p_action<>'get'then raise exception 'Acción inválida.';end if;
 select * into cfg from configuraciones_correos where id_subsidiaria=sid and tipo_notificacion='ESTADO_CUENTA';
 return jsonb_build_object('template',case when cfg.id is null then null else to_jsonb(cfg)||jsonb_build_object('updated_by_email',coalesce(cfg.updated_by_email,to_jsonb(cfg)->>'created_by_email'))end,'subsidiary',(select jsonb_build_object('name',name,'logo',logo_url)from subsidiaries where subsidiary_id=sid));
end$$;

create function public.statement_snapshot(p_sid bigint,p_customer bigint,p_cutoff date)returns jsonb language plpgsql stable security definer set search_path=public,pg_temp as $$
declare report jsonb;rows jsonb:='[]';page integer:=1;balance numeric;result jsonb;
begin
 if p_cutoff is null or p_cutoff>(now()at time zone 'America/Costa_Rica')::date then raise exception 'Fecha de corte inválida.';end if;
 if not exists(select 1 from entity_subsidiaries where subsidiary_id=p_sid and customer_id=p_customer)then raise exception 'El cliente no pertenece a la subsidiaria.';end if;
 loop
  report:=run_aging_report('AR',jsonb_build_object('subsidiaryIds',jsonb_build_array(p_sid),'dateTo',p_cutoff,'agingEntityId',p_customer,'agingCurrencyMode','LOCAL','onlyPending',true,'page',page,'pageSize',250));
  rows:=rows||(report->'rows');exit when page*250>=coalesce((report->>'total')::integer,0);page:=page+1;
 end loop;
 balance:=coalesce((report->'summary'->>'netBalance')::numeric,0);
 select jsonb_build_object('empresa_nombre',s.name,'empresa_logo_url',s.logo_url,'address',s.address,'cliente_nombre',c.company_name,'customerCode',c.customer_number,'email',c.email,'fecha_corte',p_cutoff,'saldo_total',balance,'moneda',m.currency_code,'rows',rows,'summary',report->'summary') into result
 from customers c cross join subsidiaries s join currencies m on m.currency_id=s.currency_id where c.customer_id=p_customer and s.subsidiary_id=p_sid;
 return result;
end$$;

create function public.statement_customer(p_customer bigint,p_cutoff date,p_sid bigint default null)returns jsonb language plpgsql stable security definer set search_path=public,pg_temp as $$
declare sid bigint:=coalesce(p_sid,active_subsidiary_id());snap jsonb;
begin
 if app_user_id()is null or not exists(select 1 from user_subsidiaries where user_id=app_user_id()and subsidiary_id=sid)then raise exception 'Sin acceso a la subsidiaria.';end if;
 snap:=statement_snapshot(sid,p_customer,p_cutoff);
 return jsonb_build_object('statement',snap,'history',coalesce((select jsonb_agg(jsonb_build_object('id',l.id,'estado',l.estado,'destinatario',l.destinatario,'fecha_corte',l.fecha_corte,'created_at',l.created_at,'enviado_at',l.enviado_at,'ultimo_error',l.ultimo_error)order by l.created_at desc)from comunicaciones_logs l where l.customer_id=p_customer and l.id_subsidiaria=sid and l.tipo_notificacion='ESTADO_CUENTA'),'[]'));
end$$;

create function public.statement_enqueue(p_sid bigint,p_customer bigint,p_cutoff date,p_key text,p_note text default '',p_auto boolean default false)returns uuid language plpgsql security definer set search_path=public,pg_temp as $$
declare snap jsonb;cfg configuraciones_correos%rowtype;key uuid;
begin
 if length(p_note)>2000 then raise exception 'La nota admite hasta 2.000 caracteres.';end if;
 select * into cfg from configuraciones_correos where id_subsidiaria=p_sid and tipo_notificacion='ESTADO_CUENTA';
 if cfg.id is null or not cfg.activo then raise exception 'Active la plantilla de estados de cuenta en Configuración.';end if;
 snap:=statement_snapshot(p_sid,p_customer,p_cutoff)||jsonb_build_object('note',p_note,'automatic',p_auto);
 if (snap->>'saldo_total')::numeric<=0 then return null;end if;
 insert into comunicaciones_logs(id_subsidiaria,customer_id,fecha_corte,tipo_notificacion,fingerprint,destinatario,estado,payload,asunto_template,cuerpo_template,ultimo_error)
 values(p_sid,p_customer,p_cutoff,'ESTADO_CUENTA',p_key,snap->>'email',case when coalesce(snap->>'email','')~'^[^[:space:]@,;<>]+@[^[:space:]@,;<>]+\.[^[:space:]@,;<>]+$'then 'PENDIENTE'else 'ERROR_SIN_CORREO'end,snap,cfg.asunto_template,cfg.cuerpo_template,case when nullif(snap->>'email','')is null then 'El cliente no tiene correo electrónico.'end)
 on conflict(id_subsidiaria,customer_id,fingerprint)where tipo_notificacion='ESTADO_CUENTA'do nothing returning id into key;
 return coalesce(key,(select id from comunicaciones_logs where id_subsidiaria=p_sid and customer_id=p_customer and fingerprint=p_key));
end$$;
create function public.statement_send(p_customer bigint,p_cutoff date,p_note text,p_request uuid,p_sid bigint default null)returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare key uuid;
begin
 perform statement_customer(p_customer,p_cutoff,p_sid);
 if p_request is null then raise exception 'Falta identificador de envío.';end if;
 key:=statement_enqueue(coalesce(p_sid,active_subsidiary_id()),p_customer,p_cutoff,'MANUAL:'||p_request,coalesce(p_note,''),false);
 if key is null then raise exception 'El cliente no tiene saldo pendiente al corte.';end if;
 return(select jsonb_build_object('id',id,'estado',estado)from comunicaciones_logs where id=key);
end$$;

create function public.statement_schedule()returns integer language plpgsql security definer set search_path=public,pg_temp as $$
declare localnow timestamp:=now()at time zone 'America/Costa_Rica';cutoff date;item record;count integer:=0;
begin
 if extract(day from localnow)<>1 or extract(hour from localnow)<8 then return 0;end if;
 if not pg_try_advisory_xact_lock(hashtextextended('monthly-customer-statements',0))then return 0;end if;
 cutoff:=date_trunc('month',localnow)::date-1;
 for item in select distinct c.customer_id,e.subsidiary_id from customers c join entity_subsidiaries e using(customer_id)join configuraciones_correos cfg on cfg.id_subsidiaria=e.subsidiary_id and cfg.tipo_notificacion='ESTADO_CUENTA'and cfg.activo
 where c.envio_estado_cuenta_auto and not exists(select 1 from comunicaciones_logs l where l.id_subsidiaria=e.subsidiary_id and l.customer_id=c.customer_id and l.fingerprint='AUTO:'||cutoff)
 loop
  begin
   if statement_enqueue(item.subsidiary_id,item.customer_id,cutoff,'AUTO:'||cutoff,'',true)is not null then count:=count+1;end if;
  exception when others then
   insert into comunicaciones_logs(id_subsidiaria,customer_id,fecha_corte,tipo_notificacion,fingerprint,destinatario,estado,payload,asunto_template,cuerpo_template,ultimo_error)
   select item.subsidiary_id,item.customer_id,cutoff,'ESTADO_CUENTA','AUTO:'||cutoff,c.email,'ERROR','{}',cfg.asunto_template,cfg.cuerpo_template,'No fue posible generar el estado de cuenta: '||left(sqlerrm,350)
   from customers c join configuraciones_correos cfg on cfg.id_subsidiaria=item.subsidiary_id and cfg.tipo_notificacion='ESTADO_CUENTA'where c.customer_id=item.customer_id
   on conflict(id_subsidiaria,customer_id,fingerprint)where tipo_notificacion='ESTADO_CUENTA'do nothing;
  end;
 end loop;return count;
end$$;
create function public.statement_claim()returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare job comunicaciones_logs%rowtype;
begin
 select * into job from comunicaciones_logs where estado='PENDIENTE'and tipo_notificacion='ESTADO_CUENTA'order by created_at for update skip locked limit 1;
 if job.id is null then return null;end if;
 if not exists(select 1 from configuraciones_correos where id_subsidiaria=job.id_subsidiaria and tipo_notificacion='ESTADO_CUENTA'and activo)
 or not exists(select 1 from entity_subsidiaries where subsidiary_id=job.id_subsidiaria and customer_id=job.customer_id)
 or not exists(select 1 from customers where customer_id=job.customer_id and email=job.destinatario)
 or (coalesce((job.payload->>'automatic')::boolean,false)and not exists(select 1 from customers where customer_id=job.customer_id and envio_estado_cuenta_auto))then
 update comunicaciones_logs set estado='CANCELADO',ultimo_error='Se desactivó el envío o cambió la asignación del cliente.'where id=job.id;return null;end if;
 update comunicaciones_logs set estado='ENVIANDO',intentos=intentos+1,lease=gen_random_uuid(),iniciado_at=now()where id=job.id returning * into job;
 insert into comunicaciones_intentos(comunicacion_id,estado,destinatario)values(job.id,'ENVIANDO',job.destinatario);
 return to_jsonb(job);
end$$;
revoke all on function public.statement_settings(text,jsonb),public.statement_snapshot(bigint,bigint,date),public.statement_customer(bigint,date,bigint),public.statement_enqueue(bigint,bigint,date,text,text,boolean),public.statement_send(bigint,date,text,uuid,bigint),public.statement_schedule(),public.statement_claim() from public,anon,authenticated;
grant execute on function public.statement_settings(text,jsonb),public.statement_customer(bigint,date,bigint),public.statement_send(bigint,date,text,uuid,bigint) to authenticated;
grant execute on function public.statement_schedule(),public.statement_claim() to service_role;
notify pgrst,'reload schema';
