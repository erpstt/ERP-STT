-- Durable outbox. No historical payments are queued by this migration.
create table public.configuraciones_correos (
 id uuid primary key default gen_random_uuid(), id_subsidiaria bigint not null references public.subsidiaries,
 tipo_notificacion text not null default 'PAGO_PROVEEDOR' check(tipo_notificacion='PAGO_PROVEEDOR'),
 asunto_template varchar(200) not null default 'Notificación de pago · {{empresa_nombre}} · {{referencia_pago}}',
 cuerpo_template text not null default '<p>Estimado/a {{proveedor_nombre}},</p><p>{{empresa_nombre}} ha registrado un pago por {{total_pagado}} {{moneda}}, referencia {{referencia_pago}}, de fecha {{fecha_pago}}.</p>',
 -- The shared audit trigger sets updated_by_email to NULL on INSERT; created_by_email records the initial author.
 activo boolean not null default false, updated_by_email text, updated_at timestamptz not null default now(),
 unique(id_subsidiaria,tipo_notificacion), check(length(cuerpo_template) between 1 and 20000)
);
create table public.comunicaciones_logs (
 id uuid primary key default gen_random_uuid(), id_subsidiaria bigint not null references public.subsidiaries,
 payment_id bigint not null, fingerprint text not null, destinatario text,
 estado text not null check(estado in ('PENDIENTE','ENVIANDO','ENVIADO','ERROR_SIN_CORREO','ERROR','INCIERTO','OMITIDO','CANCELADO')),
 payload jsonb not null, asunto_template text not null, cuerpo_template text not null,
 intentos integer not null default 0, lease uuid, iniciado_at timestamptz, enviado_at timestamptz,
 ultimo_error text, message_id text, created_at timestamptz not null default now(),
 unique(payment_id,fingerprint)
);
create index comunicaciones_queue_idx on public.comunicaciones_logs(created_at) where estado='PENDIENTE';
create table public.comunicaciones_intentos (
 id bigint generated always as identity primary key, comunicacion_id uuid not null references public.comunicaciones_logs,
 fecha timestamptz not null default now(), estado text not null, destinatario text, detalle text, actor text
);
alter table public.configuraciones_correos enable row level security;
alter table public.comunicaciones_logs enable row level security;
alter table public.comunicaciones_intentos enable row level security;
revoke all on public.configuraciones_correos, public.comunicaciones_logs, public.comunicaciones_intentos from anon, authenticated;

create function public.payment_email_snapshot(p_id bigint) returns jsonb language sql stable security definer set search_path=public,pg_temp as $$
 select jsonb_build_object('subsidiaryId',t.subsidiary_id,'email',s.email,'empresa_nombre',sub.name,'empresa_logo_url',sub.logo_url,
 'proveedor_nombre',s.company_name,'fecha_pago',p.payment_date,'referencia_pago',p.bank_reference,'moneda',c.currency_code,
 'total_pagado',p.amount_paid,'aplicado',a.total,'retenciones',w.total,'anticipos',adv.total,'invoices',a.items,
 'valid',p.status='APROBADO' and j.status='CONTABILIZADO' and a.total>0 and not a.mixed
 and abs(a.total-w.total-adv.total-p.amount_paid)<0.000001
 and abs(coalesce(bt.total,0)-p.amount_paid)<0.000001
 and not exists(select 1 from solicitudes_pago r where r.payment_id=p.payment_id and (r.tipo_solicitud<>'CXP' or r.estado<>'APLICADO')))
 from supplier_payment p join "transaction" t using(transaction_id) join suppliers s on s.supplier_id=p.supplier_id
 join subsidiaries sub on sub.subsidiary_id=t.subsidiary_id join currencies c on c.currency_id=p.currency_id
 join journal j on j.journal_id=p.journal_id
 cross join lateral(select coalesce(sum(x.amount),0)total,coalesce(bool_or(i.currency_id<>p.currency_id),false)mixed,
 coalesce(jsonb_agg(jsonb_build_object('number',i.invoice_number,'date',i.invoice_date,'total',i.total_amount,'applied',x.amount,
 'withholding',coalesce(wh.total,0),'withholdingDetail',wh.detail)order by i.invoice_id),'[]')items
 from supplier_payment_application x join supplier_invoice i using(invoice_id)
 left join lateral(select sum(sw.withholding_amount)total,string_agg(tc.code_name,', ' order by tc.code_name)detail from supplier_payment_withholding sw join tax_codes tc using(tax_code_id) where sw.payment_id=p.payment_id and sw.invoice_id=i.invoice_id)wh on true
 where x.payment_id=p.payment_id)a
 cross join lateral(select coalesce(sum(withholding_amount),0)total from supplier_payment_withholding where payment_id=p.payment_id)w
 cross join lateral(select coalesce(sum(amount),0)total from supplier_advance_application where payment_id=p.payment_id)adv
 cross join lateral(select -sum(amount)total from bank_transaction where transaction_id=p.transaction_id)bt
 where p.payment_id=p_id
$$;

create function public.payment_email_enqueue(p_id bigint) returns void language plpgsql security definer set search_path=public,pg_temp as $$
declare snap jsonb; cfg configuraciones_correos%rowtype; sid bigint; fp text; st text;
begin
 -- Same payment saves are serialized; deferred triggers observe final accounting values.
 if p_id is null then return; end if;
 perform pg_advisory_xact_lock(hashtextextended('payment-email:'||p_id,0));
 snap:=payment_email_snapshot(p_id);
 if snap is null or not coalesce((snap->>'valid')::boolean,false) then
  update comunicaciones_logs set estado='CANCELADO',ultimo_error='Pago eliminado, anulado o importes no conciliados.' where payment_id=p_id and estado in ('PENDIENTE','ERROR','ERROR_SIN_CORREO','OMITIDO'); return;
 end if;
 sid:=(snap->>'subsidiaryId')::bigint;
 fp:=md5((snap-'email'-'empresa_logo_url')::text);
 select * into cfg from configuraciones_correos where id_subsidiaria=sid and tipo_notificacion='PAGO_PROVEEDOR';
 if cfg.id is null then
  insert into configuraciones_correos(id_subsidiaria,updated_by_email) values(sid,'sistema') on conflict do nothing;
  select * into cfg from configuraciones_correos where id_subsidiaria=sid and tipo_notificacion='PAGO_PROVEEDOR';
 end if;
 st:=case when not cfg.activo then 'OMITIDO' when coalesce(snap->>'email','') !~ '^[^[:space:]@,;<>]+@[^[:space:]@,;<>]+\.[^[:space:]@,;<>]+$' then 'ERROR_SIN_CORREO' else 'PENDIENTE' end;
 update comunicaciones_logs set estado='CANCELADO',ultimo_error='El pago fue modificado.' where payment_id=p_id and fingerprint<>fp and estado in ('PENDIENTE','ERROR','ERROR_SIN_CORREO','OMITIDO');
 insert into comunicaciones_logs(id_subsidiaria,payment_id,fingerprint,destinatario,estado,payload,asunto_template,cuerpo_template,ultimo_error)
 values(sid,p_id,fp,snap->>'email',st,snap,cfg.asunto_template,cfg.cuerpo_template,
 case st when 'OMITIDO' then 'Notificaciones desactivadas para esta subsidiaria.' when 'ERROR_SIN_CORREO' then 'El proveedor no tiene un correo válido.' end) on conflict(payment_id,fingerprint) do nothing;
end$$;

create function public.payment_email_event() returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
begin
 if TG_OP<>'INSERT' then perform payment_email_enqueue(old.payment_id); end if;
 if TG_OP<>'DELETE' then perform payment_email_enqueue(new.payment_id); end if;
 return null;
end$$;
create constraint trigger supplier_payment_email_event after insert or update or delete on public.supplier_payment deferrable initially deferred for each row execute function public.payment_email_event();
create constraint trigger supplier_payment_application_email_event after insert or update or delete on public.supplier_payment_application deferrable initially deferred for each row execute function public.payment_email_event();
create constraint trigger supplier_payment_withholding_email_event after insert or update or delete on public.supplier_payment_withholding deferrable initially deferred for each row execute function public.payment_email_event();
create constraint trigger supplier_advance_application_email_event after insert or update or delete on public.supplier_advance_application deferrable initially deferred for each row execute function public.payment_email_event();
create constraint trigger payment_request_email_event after update on public.solicitudes_pago deferrable initially deferred for each row execute function public.payment_email_event();

create function public.payment_email_settings(p_action text,p_payload jsonb default '{}') returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare sid bigint:=active_subsidiary_id(); cfg configuraciones_correos%rowtype;
begin
 if app_user_id() is null or sid is null or not app_is_admin() then raise exception 'Solo un administrador puede configurar las notificaciones.'; end if;
 if p_action='save' then
  if length(trim(p_payload->>'subject')) not between 1 and 200 or p_payload->>'subject' ~ E'[\r\n]' or length(p_payload->>'body') not between 1 and 20000 then raise exception 'Plantilla inválida.'; end if;
  insert into configuraciones_correos(id_subsidiaria,asunto_template,cuerpo_template,activo,updated_by_email)
  values(sid,p_payload->>'subject',p_payload->>'body',coalesce((p_payload->>'active')::boolean,false),(select email from users where user_id=app_user_id()))
  on conflict(id_subsidiaria,tipo_notificacion) do update set asunto_template=excluded.asunto_template,cuerpo_template=excluded.cuerpo_template,activo=excluded.activo,updated_by_email=excluded.updated_by_email,updated_at=now();
 elsif p_action<>'get' then raise exception 'Acción inválida.'; end if;
 select * into cfg from configuraciones_correos where id_subsidiaria=sid;
 return jsonb_build_object('template',case when cfg.id is null then null else to_jsonb(cfg)||jsonb_build_object('updated_by_email',coalesce(cfg.updated_by_email,to_jsonb(cfg)->>'created_by_email')) end,'subsidiary',(select jsonb_build_object('name',name,'logo',logo_url)from subsidiaries where subsidiary_id=sid));
end$$;

create function public.payment_email_history(p_id bigint) returns jsonb language plpgsql stable security definer set search_path=public,pg_temp as $$
begin
 if app_user_id() is null or not exists(select 1 from supplier_payment p join "transaction"t using(transaction_id) where p.payment_id=p_id and t.subsidiary_id=active_subsidiary_id()) then raise exception 'Pago no encontrado en la subsidiaria activa.'; end if;
 return coalesce((select jsonb_agg(jsonb_build_object('id',l.id,'estado',l.estado,'destinatario',l.destinatario,'created_at',l.created_at,'enviado_at',l.enviado_at,'ultimo_error',l.ultimo_error,'intentos',l.intentos,'history',coalesce((select jsonb_agg(to_jsonb(a)order by a.id desc)from comunicaciones_intentos a where a.comunicacion_id=l.id),'[]')) order by l.created_at desc)from comunicaciones_logs l where l.payment_id=p_id and l.id_subsidiaria=active_subsidiary_id()),'[]');
end$$;

create function public.payment_email_resend(p_id bigint,p_email text default null) returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare snap jsonb; job comunicaciones_logs%rowtype; recipient text; existed boolean;
begin
 perform payment_email_history(p_id);
 perform pg_advisory_xact_lock(hashtextextended('payment-email:'||p_id,0));
 snap:=payment_email_snapshot(p_id);
 select exists(select 1 from comunicaciones_logs where payment_id=p_id and fingerprint=md5((snap-'email'-'empresa_logo_url')::text)) into existed;
 perform payment_email_enqueue(p_id);
 snap:=payment_email_snapshot(p_id);
 select * into job from comunicaciones_logs where payment_id=p_id and fingerprint=md5((snap-'email'-'empresa_logo_url')::text) for update;
 if job.id is null or not coalesce((snap->>'valid')::boolean,false) then raise exception 'El pago no está aplicado o sus importes no concilian.'; end if;
 if job.estado='ENVIANDO' or (existed and job.estado='PENDIENTE') then raise exception 'Ya existe un envío pendiente o en curso.'; end if;
 if not exists(select 1 from configuraciones_correos where id_subsidiaria=job.id_subsidiaria and activo) then raise exception 'Active primero la plantilla de la subsidiaria.'; end if;
 recipient:=coalesce(nullif(trim(p_email),''),nullif(snap->>'email',''),job.destinatario);
 if coalesce(recipient,'') !~ '^[^[:space:]@,;<>]+@[^[:space:]@,;<>]+\.[^[:space:]@,;<>]+$' then raise exception 'Ingrese un correo electrónico válido.'; end if;
 insert into comunicaciones_intentos(comunicacion_id,estado,destinatario,detalle,actor) values(job.id,'REENVIO_SOLICITADO',recipient,'Estado anterior: '||job.estado,(select email from users where user_id=app_user_id()));
 update comunicaciones_logs l set estado='PENDIENTE',destinatario=recipient,lease=null,ultimo_error=null,
 asunto_template=c.asunto_template,cuerpo_template=c.cuerpo_template from configuraciones_correos c where l.id=job.id and c.id_subsidiaria=l.id_subsidiaria;
 return jsonb_build_object('id',job.id,'estado','PENDIENTE');
end$$;

-- Worker RPCs are exclusively callable with the server service role.
create function public.payment_email_claim() returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare job comunicaciones_logs%rowtype; snap jsonb;
begin
 with expired as(update comunicaciones_logs set estado='INCIERTO',ultimo_error='El envío se interrumpió. Verifique el servidor SMTP antes de reenviar.' where estado='ENVIANDO' and iniciado_at<now()-interval '5 minutes' returning id,destinatario)
 insert into comunicaciones_intentos(comunicacion_id,estado,destinatario,detalle) select id,'INCIERTO',destinatario,'Tiempo de procesamiento agotado.' from expired;
 select * into job from comunicaciones_logs where estado='PENDIENTE' order by created_at for update skip locked limit 1;
 if job.id is null then return null; end if;
 if not exists(select 1 from configuraciones_correos where id_subsidiaria=job.id_subsidiaria and activo) then update comunicaciones_logs set estado='OMITIDO',ultimo_error='Plantilla desactivada.' where id=job.id;return null;end if;
 snap:=payment_email_snapshot(job.payment_id);
 if snap is null or not coalesce((snap->>'valid')::boolean,false) or md5((snap-'email'-'empresa_logo_url')::text)<>job.fingerprint then update comunicaciones_logs set estado='CANCELADO',ultimo_error='El pago cambió o fue eliminado.' where id=job.id;return null;end if;
 update comunicaciones_logs set estado='ENVIANDO',intentos=intentos+1,lease=gen_random_uuid(),iniciado_at=now() where id=job.id returning * into job;
 insert into comunicaciones_intentos(comunicacion_id,estado,destinatario) values(job.id,'ENVIANDO',job.destinatario);
 return to_jsonb(job);
end$$;
create function public.payment_email_finish(p_id uuid,p_lease uuid,p_status text,p_message text default null,p_error text default null) returns boolean language plpgsql security definer set search_path=public,pg_temp as $$
declare job comunicaciones_logs%rowtype;
begin
 if p_status not in ('ENVIADO','ERROR','INCIERTO') then raise exception 'Estado inválido.';end if;
 update comunicaciones_logs set estado=p_status,enviado_at=case when p_status='ENVIADO' then now() else enviado_at end,
 message_id=coalesce(p_message,message_id),ultimo_error=left(p_error,500) where id=p_id and lease=p_lease and estado='ENVIANDO' returning * into job;
 if job.id is null then return false;end if;
 insert into comunicaciones_intentos(comunicacion_id,estado,destinatario,detalle)values(job.id,p_status,job.destinatario,coalesce(left(p_error,500),p_message));
 return true;
end$$;

revoke all on function public.payment_email_snapshot(bigint),public.payment_email_enqueue(bigint),public.payment_email_event(),public.payment_email_settings(text,jsonb),public.payment_email_history(bigint),public.payment_email_resend(bigint,text),public.payment_email_claim(),public.payment_email_finish(uuid,uuid,text,text,text) from public,anon,authenticated;
grant execute on function public.payment_email_settings(text,jsonb),public.payment_email_history(bigint),public.payment_email_resend(bigint,text) to authenticated;
grant execute on function public.payment_email_claim(),public.payment_email_finish(uuid,uuid,text,text,text) to service_role;
