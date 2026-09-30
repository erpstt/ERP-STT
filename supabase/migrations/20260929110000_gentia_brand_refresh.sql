begin;

-- Refresh only system-provided copy. User-authored company names and templates
-- remain under each subsidiary's control.
do $$
begin
  if to_regclass('public.tax_calendar_email_templates') is not null then
    update public.tax_calendar_email_templates
       set body_template = replace(body_template, 'NEXO ERP', 'GENTIA ERP'),
           updated_at = now()
     where body_template like '%NEXO ERP%';
  end if;

  if to_regclass('public.pdf_templates') is not null then
    update public.pdf_templates
       set visual_schema = replace(
             replace(visual_schema::text, 'NEXO ERP', 'GENTIA ERP'),
             '#123047', '#042E72'
           )::jsonb,
           html_compiled = replace(
             replace(html_compiled, 'NEXO ERP', 'GENTIA ERP'),
             '#123047', '#042E72'
           ),
           updated_at = now()
     where is_system
       and (
         visual_schema::text like '%NEXO ERP%'
         or visual_schema::text like '%#123047%'
         or html_compiled like '%NEXO ERP%'
         or html_compiled like '%#123047%'
       );
  end if;

  if to_regclass('public.wf_email_outbox') is not null then
    update public.wf_email_outbox
       set body = replace(body, 'NEXO', 'GENTIA')
     where status = 'PENDIENTE' and body like '%NEXO%';
  end if;
end
$$;

create or replace function public.wf_notify_level(p_instance bigint) returns void
language plpgsql security definer set search_path=public,pg_temp as $$
declare
  st public.wf_instance_steps%rowtype;
  ins public.wf_instances%rowtype;
  u record;
  title text;
  link text;
begin
  select * into ins from public.wf_instances where id=p_instance;
  select * into st from public.wf_instance_steps where instance_id=p_instance and nivel=ins.current_level;
  title:='Aprobación pendiente · '||(public.wf_entity_data(ins.entity_type,ins.entity_id)->>'number');
  link:=public.wf_entity_data(ins.entity_type,ins.entity_id)->>'deepLink';
  for u in
    select distinct x.user_id,x.email
      from public.users x
     where x.is_active
       and (x.user_id=st.usuario_aprobador_id or exists(
         select 1 from public.user_roles ur
          where ur.user_id=x.user_id and ur.role_id=st.rol_aprobador_id
       ))
  loop
    insert into public.wf_notifications(usuario_id,instance_id,titulo,mensaje,deep_link)
    values(u.user_id,ins.id,title,'Requiere su aprobación en el nivel '||st.nivel||': '||st.nombre_nivel,link);
    insert into public.wf_email_outbox(usuario_id,email,subject,body,deep_link)
    values(u.user_id,u.email,title,'Tiene un documento pendiente de aprobación en GENTIA.',link);
  end loop;
end
$$;

create or replace function public.resolve_audit_actor() returns jsonb
language plpgsql stable security definer set search_path=pg_catalog,public as $$
declare
  claims jsonb:=coalesce(auth.jwt(),'{}');
  metadata jsonb;
  actor_email text;
  name text;
  actor_id text;
  kind text;
  source text;
  headers jsonb;
  trace text;
begin
  headers:=coalesce(nullif(current_setting('request.headers',true),'')::jsonb,'{}');
  trace:=coalesce(nullif(headers->>'x-audit-execution-context-id',''),nullif(claims->>'session_id',''),txid_current()::text);
  if length(trace)>100 then raise exception 'El identificador de ejecución supera 100 caracteres.'; end if;
  if nullif(claims->>'sub','') is not null then
    select u.id::text,u.email,u.raw_app_meta_data into actor_id,actor_email,metadata
      from auth.users u where u.id::text=claims->>'sub';
    if actor_id is null then raise exception 'Actor de auditoría no registrado.'; end if;
    kind:=coalesce(nullif(metadata->>'actor_type',''),'HUMAN');
    source:=coalesce(nullif(metadata->>'actor_source',''),case when kind='HUMAN' then 'Gentia Web App' end);
    select nullif(trim(concat_ws(' ',u.first_name,u.last_name)),'') into name
      from public.users u where lower(u.email)=lower(actor_email) limit 1;
    name:=coalesce(nullif(metadata->>'actor_name',''),name,actor_email);
  elsif claims->>'role'='service_role' then
    kind:='SYSTEM_JOB'; actor_email:='system@gentia.local'; name:='Proceso de sistema Gentia'; source:='Gentia ERP / servicio interno';
  elsif session_user not in ('authenticator','anon','authenticated','service_role') and claims='{}'::jsonb then
    kind:='SYSTEM_JOB'; actor_email:='database@gentia.local'; name:='Proceso de base de datos'; source:='PostgreSQL / '||session_user;
  else
    raise exception 'La escritura requiere un actor autenticado.';
  end if;
  if kind not in ('HUMAN','AI_AGENT','SYSTEM_JOB','EXTERNAL_API') or source is null or actor_email is null or name is null then
    raise exception 'Configure correo, nombre, tipo y origen del actor registrado.';
  end if;
  if length(actor_email)>150 or length(name)>150 or length(source)>100 then
    raise exception 'Los datos del actor superan los límites de auditoría.';
  end if;
  return jsonb_build_object('id',actor_id,'email',actor_email,'name',name,'type',kind,'source',source,'trace',trace);
end
$$;

revoke all on function public.resolve_audit_actor() from public,anon,authenticated;

notify pgrst,'reload schema';
commit;
