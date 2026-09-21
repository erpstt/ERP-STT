alter table public.configuraciones_correos
 add column envio_dia integer not null default 1 check(envio_dia between 1 and 31),
 add column envio_hora time not null default '08:00' check(envio_hora<'24:00'::time and extract(second from envio_hora)=0);

-- Days 29-31 fall on the last calendar day in shorter months. Time is Costa Rica local time.
create function public.statement_schedule_due(p_day integer,p_time time,p_local timestamp)returns boolean
language sql immutable set search_path=public,pg_temp as $$
 select extract(day from p_local)=least(p_day,extract(day from date_trunc('month',p_local)+interval '1 month - 1 day')::integer)
 and p_local::time>=p_time
$$;
revoke all on function public.statement_schedule_due(integer,time,timestamp) from public,anon,authenticated;

create or replace function public.statement_settings(p_action text,p_payload jsonb default '{}')returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare sid bigint:=active_subsidiary_id();cfg configuraciones_correos%rowtype;
begin
 if app_user_id()is null or sid is null or not app_is_admin()then raise exception 'Solo un administrador puede configurar las notificaciones.';end if;
 if p_action='save' then
  if length(trim(p_payload->>'subject'))not between 1 and 200 or p_payload->>'subject'~E'[\r\n]' or length(p_payload->>'body')not between 1 and 20000 then raise exception 'Plantilla inválida.';end if;
  insert into configuraciones_correos(id_subsidiaria,tipo_notificacion,asunto_template,cuerpo_template,activo,updated_by_email,envio_dia,envio_hora)
  values(sid,'ESTADO_CUENTA',p_payload->>'subject',p_payload->>'body',coalesce((p_payload->>'active')::boolean,false),'sistema',coalesce((p_payload->>'day')::integer,1),coalesce((p_payload->>'time')::time,'08:00'::time))
  on conflict(id_subsidiaria,tipo_notificacion)do update set asunto_template=excluded.asunto_template,cuerpo_template=excluded.cuerpo_template,activo=excluded.activo,envio_dia=excluded.envio_dia,envio_hora=excluded.envio_hora,updated_at=now();
 elsif p_action<>'get'then raise exception 'Acción inválida.';end if;
 select * into cfg from configuraciones_correos where id_subsidiaria=sid and tipo_notificacion='ESTADO_CUENTA';
 return jsonb_build_object('template',case when cfg.id is null then null else to_jsonb(cfg)||jsonb_build_object('updated_by_email',coalesce(cfg.updated_by_email,to_jsonb(cfg)->>'created_by_email'))end,'subsidiary',(select jsonb_build_object('name',name,'logo',logo_url)from subsidiaries where subsidiary_id=sid));
end$$;

create or replace function public.statement_schedule()returns integer language plpgsql security definer set search_path=public,pg_temp as $$
declare localnow timestamp:=now()at time zone 'America/Costa_Rica';cutoff date;item record;count integer:=0;
begin
 if not pg_try_advisory_xact_lock(hashtextextended('monthly-customer-statements',0))then return 0;end if;
 cutoff:=date_trunc('month',localnow)::date-1;
 for item in select distinct c.customer_id,e.subsidiary_id from customers c join entity_subsidiaries e using(customer_id)join configuraciones_correos cfg on cfg.id_subsidiaria=e.subsidiary_id and cfg.tipo_notificacion='ESTADO_CUENTA'and cfg.activo
 where c.envio_estado_cuenta_auto and statement_schedule_due(cfg.envio_dia,cfg.envio_hora,localnow) and not exists(select 1 from comunicaciones_logs l where l.id_subsidiaria=e.subsidiary_id and l.customer_id=c.customer_id and l.fingerprint='AUTO:'||cutoff)
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
notify pgrst,'reload schema';
