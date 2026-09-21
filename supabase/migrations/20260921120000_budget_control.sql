-- Budget controls are opt-in: only approved annual versions affect transactions.
create table public.presupuestos_encabezado(
 id bigint generated always as identity primary key,
 id_subsidiaria bigint not null references public.subsidiaries,anio integer not null check(anio between 2000 and 2199),
 nombre_version text not null check(length(trim(nombre_version))between 1 and 100),moneda text not null,
 estado text not null default 'BORRADOR'check(estado in('BORRADOR','APROBADO','CERRADO','HISTORICO')),
 tipo_control text not null default 'HARD_LOCK'check(tipo_control in('HARD_LOCK','SOFT_LOCK','WARNING')),
 revision integer not null default 1,created_at timestamptz not null default now(),updated_at timestamptz not null default now(),
 unique(id_subsidiaria,anio,nombre_version)
);
create unique index budget_one_approved_year on public.presupuestos_encabezado(id_subsidiaria,anio)where estado in('APROBADO','CERRADO');
create table public.presupuestos_lineas(
 id bigint generated always as identity primary key,id_presupuesto_encabezado bigint not null references public.presupuestos_encabezado on delete cascade,
 periodo_mes date not null check(extract(day from periodo_mes)=1),id_cuenta_contable bigint not null references public.chart_accounts,
 id_centro_costo bigint references public.cost_centers,id_proyecto bigint,
 monto_presupuestado numeric(24,6)not null check(monto_presupuestado>=0 and monto_presupuestado<1e18),
 monto_modificaciones numeric(24,6)not null default 0,
 check(monto_presupuestado+monto_modificaciones>=0)
);
create unique index budget_unique_dimensions on public.presupuestos_lineas(id_presupuesto_encabezado,periodo_mes,id_cuenta_contable,coalesce(id_centro_costo,0),coalesce(id_proyecto,0));
create table public.presupuestos_modificaciones(
 id bigint generated always as identity primary key,id_subsidiaria bigint not null references public.subsidiaries,
 tipo_modificacion text not null check(tipo_modificacion in('TRASLADO','ADICION','REDUCCION')),
 motivo_justificacion text not null check(length(trim(motivo_justificacion))>=15),
 estado_workflow text not null default 'BORRADOR'check(estado_workflow in('BORRADOR','PENDIENTE_APROBACION','APROBADO','RECHAZADO','CANCELADO')),
 id_linea_origen bigint references public.presupuestos_lineas,id_linea_destino bigint references public.presupuestos_lineas,
 monto_solicitado numeric(24,6)not null check(monto_solicitado>0 and monto_solicitado<1e18),
 approved_by_email text,created_at timestamptz not null default now(),approved_at timestamptz,
 check((tipo_modificacion='TRASLADO'and id_linea_origen is not null and id_linea_destino is not null and id_linea_origen<>id_linea_destino)
 or(tipo_modificacion='ADICION'and id_linea_origen is null and id_linea_destino is not null)
 or(tipo_modificacion='REDUCCION'and id_linea_origen is not null and id_linea_destino is null))
);
create table public.budget_overrides(
 id bigint generated always as identity primary key,subsidiary_id bigint not null references public.subsidiaries,
 source_type text not null,source_id bigint,fingerprint text not null,payload jsonb not null,detail jsonb not null,
 status text not null default 'PENDIENTE'check(status in('PENDIENTE','APROBADO','RECHAZADO','CONSUMIDO')),
 requested_by bigint not null references public.users,approved_by bigint references public.users,
 reason text,created_at timestamptz not null default now(),approved_at timestamptz,unique(subsidiary_id,source_type,fingerprint)
);
create table public.budget_events(
 id bigint generated always as identity primary key,subsidiary_id bigint not null references public.subsidiaries,
 source_type text not null,source_id bigint,event text not null,details jsonb not null default '{}',created_at timestamptz not null default now()
);
do $$declare t text;begin foreach t in array array['presupuestos_encabezado','presupuestos_lineas','presupuestos_modificaciones','budget_overrides','budget_events']loop
 execute format('alter table public.%I enable row level security',t);
 execute format('revoke all on public.%I from public,anon,authenticated',t);
end loop;end$$;

insert into public.permissions(code,module,description)values
 ('BUDGET_VIEW','Contabilidad','Consultar ejecución presupuestaria.'),
 ('BUDGET_MANAGE','Contabilidad','Crear e importar presupuestos.'),
 ('BUDGET_TRANSFER_REQUEST','Contabilidad','Solicitar modificaciones presupuestarias.'),
 ('BUDGET_APPROVE','Contabilidad','Aprobar presupuestos y modificaciones.'),
 ('BUDGET_OVERRIDE_APPROVE','Contabilidad','Autorizar sobregiros presupuestarios.')on conflict(code)do nothing;
insert into public.role_permissions(role_id,permission_id)
 select r.role_id,p.permission_id from public.roles r cross join public.permissions p where p.code like 'BUDGET_%'
 and(lower(r.role_name)in('administrador','administrator','admin')or r.role_id in(2,5))on conflict do nothing;

create function public.budget_can(p_code text)returns boolean language sql stable security definer set search_path=public,pg_temp as $$
 select app_user_id()is not null and exists(select 1 from user_subsidiaries where user_id=app_user_id()and subsidiary_id=active_subsidiary_id())
 and(app_is_admin()or exists(select 1 from role_permissions rp join permissions p using(permission_id)where rp.role_id=app_active_role_id()and p.code=p_code))
$$;
create function public.budget_access(p_code text)returns bigint language plpgsql stable security definer set search_path=public,pg_temp as $$
begin if not budget_can(p_code)then raise exception using errcode='42501',message='No tiene permiso para esta operación presupuestaria.';end if;return active_subsidiary_id();end$$;

create function public.budget_match(p_header bigint,p_month date,p_account bigint,p_center bigint,p_project bigint)returns bigint language sql stable security definer set search_path=public,pg_temp as $$
 select id from presupuestos_lineas where id_presupuesto_encabezado=p_header and periodo_mes=date_trunc('month',p_month)::date and id_cuenta_contable=p_account
 and(id_centro_costo is null or id_centro_costo=p_center)and(id_proyecto is null or id_proyecto=p_project)
 order by ((id_centro_costo is not null)::int*2+(id_proyecto is not null)::int)desc,id limit 1
$$;

create function public.budget_save_header(p jsonb)returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare sid bigint:=budget_access('BUDGET_MANAGE');h presupuestos_encabezado%rowtype;key bigint:=nullif(p->>'id','')::bigint;cur text;
begin
 select c.currency_code into cur from subsidiaries s join currencies c using(currency_id)where s.subsidiary_id=sid;
 if key is null then
  insert into presupuestos_encabezado(id_subsidiaria,anio,nombre_version,moneda,tipo_control)
  values(sid,(p->>'year')::int,p->>'name',cur,coalesce(p->>'control','HARD_LOCK'))returning * into h;
 else
  select * into h from presupuestos_encabezado where id=key and id_subsidiaria=sid for update;
  if h.id is null or h.estado<>'BORRADOR'then raise exception 'Solo se puede editar un presupuesto en borrador.';end if;
  if h.revision is distinct from(p->>'revision')::int then raise exception 'El presupuesto cambió; vuelva a cargarlo.';end if;
  if h.anio<>(p->>'year')::int and exists(select 1 from presupuestos_lineas where id_presupuesto_encabezado=h.id)then raise exception 'No cambie el año de una versión con líneas; duplique la versión.';end if;
  update presupuestos_encabezado set nombre_version=p->>'name',anio=(p->>'year')::int,tipo_control=p->>'control',revision=revision+1,updated_at=now()where id=key returning * into h;
 end if;return to_jsonb(h);
end$$;

-- Projects use the existing cost-center dimension, as selected for this installation.
alter table public.presupuestos_lineas add constraint budget_project_center_fk foreign key(id_proyecto)references public.cost_centers;
alter table public.presupuestos_lineas add constraint budget_project_is_center check(id_proyecto is null or id_proyecto=id_centro_costo);
alter table public.solicitudes_pago add column budget_exchange_rate numeric(24,10) check(budget_exchange_rate>0);

-- Allocate the primary GL amounts to their journal dimensions. GL remains the source of totals.
create function public.budget_actuals(p_sid bigint)returns table(account_id bigint,"month" date,center_id bigint,amount numeric)
language sql stable security definer set search_path=public,pg_temp as $$
 with g as(select x.transaction_id,x.account_id,date_trunc('month',x.posting_date)::date as "month",sum(x.debit_amount)d,sum(x.credit_amount)c
 from gl_impact x join accounting_books b using(accounting_book_id)join chart_accounts a on a.account_id=x.account_id
 where x.subsidiary_id=p_sid and b.is_primary and b.is_active and a.category in('Costo','Gasto')group by 1,2,3),
 dims as(select j.transaction_id,l.account_id,l.cost_center_id,sum(l.debit*j.exchange_rate)d,sum(l.credit*j.exchange_rate)c
 from journal_line l join journal j using(journal_id)where j.subsidiary_id=p_sid and j.status='CONTABILIZADO'group by 1,2,3),
 totals as(select transaction_id,account_id,sum(d)d,sum(c)c from dims group by 1,2),
 allocated as(select g.account_id,g.month,dims.cost_center_id,
 case when totals.d>0 then g.d*dims.d/totals.d else 0 end-case when totals.c>0 then g.c*dims.c/totals.c else 0 end amount
 from g join totals using(transaction_id,account_id)join dims using(transaction_id,account_id)
 union all select g.account_id,g.month,null,case when coalesce(t.d,0)=0 then g.d else 0 end-case when coalesce(t.c,0)=0 then g.c else 0 end
 from g left join totals t using(transaction_id,account_id))
 select a.account_id,a.month,a.cost_center_id,sum(a.amount)from allocated a group by 1,2,3 having sum(a.amount)<>0
$$;

create function public.budget_commitments(p_sid bigint)returns table(source_type text,source_id bigint,account_id bigint,"month" date,center_id bigint,amount numeric)
language sql stable security definer set search_path=public,pg_temp as $$
 with orders as(select d.document_id,l.account_id,date_trunc('month',d.document_date)::date as "month",l.cost_center_id,
 sum(l.quantity*l.unit_cost*d.exchange_rate)ordered
 from purchase_document d join purchase_document_line l on l.document_id=d.document_id join chart_accounts a on a.account_id=l.account_id
 where d.subsidiary_id=p_sid and d.document_type='ORDER'and d.status not in('CANCELADO','ANULADO','RECHAZADO','CERRADO')and a.category in('Costo','Gasto')group by 1,2,3,4),
 invoiced as(select r.source_document_id order_id,l.account_id,l.cost_center_id,sum(l.amount*case when i.currency_id=o.currency_id then o.exchange_rate else i.exchange_rate end)amount
 from supplier_invoice i join supplier_invoice_line l using(invoice_id)join purchase_document r on r.document_id=i.purchase_receipt_document_id
 join purchase_document o on o.document_id=r.source_document_id
 where i.subsidiary_id=p_sid and r.document_type='RECEIPT'group by 1,2,3)
 select 'ORD_COM',o.document_id,o.account_id,o.month,o.cost_center_id,greatest(o.ordered-coalesce(i.amount,0),0)
 from orders o left join invoiced i on i.order_id=o.document_id and i.account_id=o.account_id and i.cost_center_id is not distinct from o.cost_center_id
 union all
 select 'SOL_PAG',h.id,l.id_cuenta_contable,date_trunc('month',h.fecha_pago_programada)::date,l.id_centro_costo,sum(l.monto*coalesce(h.budget_exchange_rate,opening_balance_rate(h.id_moneda,h.fecha_pago_programada)))
 from solicitudes_pago h join solicitudes_pago_lineas l on l.id_solicitud=h.id join chart_accounts a on a.account_id=l.id_cuenta_contable
 where h.id_subsidiaria=p_sid and h.tipo_solicitud='OTROS'and h.estado not in('APLICADO','ANULADO','RECHAZADO')and a.category in('Costo','Gasto')group by 1,2,3,4,5
$$;

create function public.budget_usage(p_header bigint)returns table(key text,line_id bigint,account_id bigint,"month" date,center_id bigint,initial numeric,modifications numeric,committed numeric,executed numeric,available numeric)
language sql stable security definer set search_path=public,pg_temp as $$
 with h as(select * from presupuestos_encabezado where id=p_header),
 moves as(select a.account_id,a.month,a.center_id,0::numeric committed,a.amount executed from h cross join lateral budget_actuals(h.id_subsidiaria)a where extract(year from a.month)=h.anio
 union all select c.account_id,c.month,c.center_id,c.amount,0 from h cross join lateral budget_commitments(h.id_subsidiaria)c where extract(year from c.month)=h.anio),
 mapped as(select m.*,budget_match(p_header,m.month,m.account_id,m.center_id,m.center_id)line_id from moves m),
 keys as(select 'L:'||l.id key,l.id line_id,l.id_cuenta_contable account_id,l.periodo_mes as "month",l.id_centro_costo center_id,l.monto_presupuestado initial,l.monto_modificaciones modifications from presupuestos_lineas l where l.id_presupuesto_encabezado=p_header
 union all select distinct 'U:'||m.account_id||':'||m.month||':'||coalesce(m.center_id,0),null::bigint,m.account_id,m.month,m.center_id,0,0 from mapped m where m.line_id is null),
 amounts as(select k.*,coalesce(sum(m.committed),0)committed,coalesce(sum(m.executed),0)executed from keys k left join mapped m on
 (k.line_id is not null and m.line_id=k.line_id)or(k.line_id is null and m.line_id is null and m.account_id=k.account_id and m.month=k.month and m.center_id is not distinct from k.center_id)group by k.key,k.line_id,k.account_id,k.month,k.center_id,k.initial,k.modifications)
 select a.*,a.initial+a.modifications-a.committed-a.executed from amounts a
$$;

create function public.budget_save_lines(p jsonb)returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare sid bigint:=budget_access('BUDGET_MANAGE');h presupuestos_encabezado%rowtype;r jsonb;acc bigint;cc bigint;dt date;amount numeric;
begin
 select * into h from presupuestos_encabezado where id=(p->>'id')::bigint and id_subsidiaria=sid for update;
 if h.id is null or h.estado<>'BORRADOR'then raise exception 'Seleccione una versión en borrador.';end if;
 if h.revision is distinct from(p->>'revision')::int then raise exception 'La versión cambió. Recargue la matriz.';end if;
 if jsonb_typeof(p->'lines')is distinct from 'array'or jsonb_array_length(p->'lines')>12000 then raise exception 'Importe hasta 12.000 líneas.';end if;
 delete from presupuestos_lineas where id_presupuesto_encabezado=h.id;
 for r in select value from jsonb_array_elements(p->'lines')loop
  acc:=nullif(r->>'accountId','')::bigint;cc:=coalesce(nullif(r->>'centerId',''),nullif(r->>'projectId',''))::bigint;
  if nullif(r->>'centerId','')is not null and nullif(r->>'projectId','')is not null and r->>'centerId'<>r->>'projectId'then raise exception 'Proyecto y centro de costo deben identificar la misma dimensión.';end if;
  if acc is null then select account_id into acc from chart_accounts where account_number=r->>'account';end if;
  if not exists(select 1 from chart_accounts a where a.account_id=acc and a.category in('Costo','Gasto')and a.accepts_entries and not a.is_inactive and(exists(select 1 from account_subsidiaries x where x.account_id=a.account_id and x.subsidiary_id=sid and x.is_active)or not exists(select 1 from account_subsidiaries where account_id=a.account_id)))then raise exception 'Seleccione una cuenta de costo/gasto habilitada para la subsidiaria.';end if;
  if cc is not null and not exists(select 1 from cost_centers where cost_center_id=cc and subsidiary_id=sid and not coalesce(is_inactive,false))then raise exception 'Centro de costo/proyecto inválido.';end if;
  dt:=(r->>'month'||'-01')::date;amount:=(r->>'amount')::numeric;
  if extract(year from dt)<>h.anio then raise exception 'El mes debe pertenecer al año del presupuesto.';end if;
  insert into presupuestos_lineas(id_presupuesto_encabezado,periodo_mes,id_cuenta_contable,id_centro_costo,id_proyecto,monto_presupuestado)values(h.id,dt,acc,cc,cc,amount);
 end loop;
 update presupuestos_encabezado set revision=revision+1,updated_at=now()where id=h.id returning * into h;return to_jsonb(h);
end$$;

create function public.budget_state(p_sid bigint)returns jsonb language sql stable security definer set search_path=public,pg_temp as $$
 select coalesce(jsonb_agg(to_jsonb(u)||jsonb_build_object('headerId',h.id,'revision',h.revision,'control',case when h.estado='CERRADO'then 'HARD_LOCK'else h.tipo_control end,'closed',h.estado='CERRADO','account',a.account_number,'center',coalesce(cc.name,'General'))),'[]')
 from presupuestos_encabezado h cross join lateral budget_usage(h.id)u join chart_accounts a on a.account_id=u.account_id left join cost_centers cc on cc.cost_center_id=u.center_id
 where h.id_subsidiaria=p_sid and h.estado in('APROBADO','CERRADO')
$$;

alter function public.save_purchase_document(jsonb,bigint)rename to save_purchase_document_without_budget;
alter function public.save_supplier_invoice(jsonb,bigint)rename to save_supplier_invoice_without_budget;
alter function public.pr_save(jsonb)rename to pr_save_without_budget;
alter function public.pr_execute(jsonb)rename to pr_execute_without_budget;
alter function public.wf_start_entity(text,bigint,jsonb)rename to wf_start_entity_without_budget;
revoke all on function public.save_purchase_document_without_budget(jsonb,bigint),public.save_supplier_invoice_without_budget(jsonb,bigint),public.pr_save_without_budget(jsonb),public.pr_execute_without_budget(jsonb),public.wf_start_entity_without_budget(text,bigint,jsonb)from public,anon,authenticated;

create function public.budget_run(p_type text,p_payload jsonb,p_id bigint default null)returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare sid bigint:=active_subsidiary_id();before_state jsonb;after_state jsonb;violations jsonb;result jsonb;fingerprint_key text;override_row budget_overrides%rowtype;pending_id bigint;err_detail text;rate numeric;
begin
 if app_user_id()is null or not exists(select 1 from user_subsidiaries where user_id=app_user_id()and subsidiary_id=sid)then raise exception 'Sin acceso a la subsidiaria.';end if;
 perform pg_advisory_xact_lock(hashtextextended('budget:'||sid,0));
 before_state:=budget_state(sid);
 fingerprint_key:=md5(jsonb_build_object('requester',app_user_id(),'type',p_type,'id',p_id,'payload',p_payload,'versions',(select jsonb_agg(jsonb_build_array(id,revision)order by id)from presupuestos_encabezado where id_subsidiaria=sid and estado='APROBADO'))::text);
 select * into override_row from budget_overrides where subsidiary_id=sid and source_type=p_type and fingerprint=fingerprint_key for update;
 if override_row.status='CONSUMIDO'then raise exception 'Esta autorización ya fue aplicada. Abra el documento generado.';end if;
 begin
  case p_type
  when 'ORD_COM'then result:=save_purchase_document_without_budget(p_payload,p_id);
  when 'FAC_PRO'then result:=save_supplier_invoice_without_budget(p_payload,p_id);
  when 'SOL_PAG'then
   result:=pr_save_without_budget(p_payload);
   if p_payload->>'type'='OTROS'and exists(select 1 from presupuestos_encabezado where id_subsidiaria=sid and estado='APROBADO')and exists(select 1 from solicitudes_pago_lineas l join chart_accounts a on a.account_id=l.id_cuenta_contable where l.id_solicitud=(result->>'id')::bigint and a.category in('Costo','Gasto'))then
    rate:=case when(p_payload->>'currencyId')::bigint=(select currency_id from subsidiaries where subsidiary_id=sid)then 1 else opening_balance_rate((p_payload->>'currencyId')::bigint,(p_payload->>'plannedDate')::date)end;
    update solicitudes_pago set budget_exchange_rate=rate where id=(result->>'id')::bigint;
   end if;
  when 'SOL_PAG_EXECUTE'then result:=pr_execute_without_budget(p_payload);
  when 'WORKFLOW_START'then result:=wf_start_entity_without_budget(p_payload->>'entityType',p_id,coalesce(p_payload->'context','{}'));
  else raise exception 'Operación presupuestaria no válida.';end case;
  after_state:=budget_state(sid);
  select coalesce(jsonb_agg(a),'[]')into violations from jsonb_array_elements(after_state)a
  left join jsonb_array_elements(before_state)b on a->>'headerId'=b->>'headerId'and a->>'key'=b->>'key'
  where ((a->>'available')::numeric<-.000001 or (a->>'closed')::boolean)and((a->>'committed')::numeric+(a->>'executed')::numeric)>coalesce((b->>'committed')::numeric+(b->>'executed')::numeric,0)+.000001;
  if exists(select 1 from jsonb_array_elements(violations)v where v->>'control'='HARD_LOCK')then
   raise exception using errcode='PT422',message='Saldo presupuestario insuficiente en la combinación Cta/Centro de Costo.',detail=violations::text;
  end if;
  if exists(select 1 from jsonb_array_elements(violations)v where v->>'control'='SOFT_LOCK')and coalesce(override_row.status,'')<>'APROBADO'then
   raise exception using errcode='BZ001',message='Sobreaprobación presupuestaria requerida.',detail=violations::text;
  end if;
  if jsonb_array_length(violations)>0 then
   insert into budget_events(subsidiary_id,source_type,source_id,event,details)values(sid,p_type,coalesce((result->>'invoiceId')::bigint,(result->>'id')::bigint,p_id),'DESVIACION',violations);
  end if;
  if override_row.status='APROBADO'then update budget_overrides set status='CONSUMIDO',source_id=coalesce((result->>'invoiceId')::bigint,(result->>'id')::bigint,p_id)where id=override_row.id;end if;
  return result||jsonb_build_object('budgetWarnings',violations);
 exception when sqlstate 'BZ001'then
  get stacked diagnostics err_detail=PG_EXCEPTION_DETAIL;
 end;
 -- The operational changes above were rolled back; the request remains durable for over-approval.
 insert into budget_overrides(subsidiary_id,source_type,source_id,fingerprint,payload,detail,requested_by)
 values(sid,p_type,p_id,fingerprint_key,p_payload,err_detail::jsonb,app_user_id())
 on conflict(subsidiary_id,source_type,fingerprint)do update set detail=excluded.detail,status='PENDIENTE',approved_by=null,approved_at=null,reason=null returning id into pending_id;
 return jsonb_build_object('budgetPending',true,'budgetRequestId',pending_id,'message','Solicitud guardada pendiente de sobreaprobación presupuestaria. El documento todavía no fue emitido ni contabilizado.');
end$$;
create function public.save_purchase_document(p_payload jsonb,p_document_id bigint default null)returns jsonb language sql security definer set search_path=public,pg_temp as $$select budget_run('ORD_COM',p_payload,p_document_id)$$;
create function public.save_supplier_invoice(payload jsonb,target_invoice_id bigint default null)returns jsonb language sql security definer set search_path=public,pg_temp as $$select budget_run('FAC_PRO',payload,target_invoice_id)$$;
create function public.pr_save(p jsonb)returns jsonb language sql security definer set search_path=public,pg_temp as $$select budget_run('SOL_PAG',p,nullif(p->>'id','')::bigint)$$;
create function public.pr_execute(p jsonb)returns jsonb language sql security definer set search_path=public,pg_temp as $$select budget_run('SOL_PAG_EXECUTE',p,nullif(p->>'id','')::bigint)$$;
create function public.wf_start_entity(p_entity_type text,p_entity_id bigint,p_context jsonb default '{}')returns jsonb language sql security definer set search_path=public,pg_temp as $$select budget_run('WORKFLOW_START',jsonb_build_object('entityType',p_entity_type,'context',p_context),p_entity_id)$$;

create function public.budget_override_action(p jsonb)returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare o budget_overrides%rowtype;action text:=p->>'action';result jsonb;
begin
 if action='apply'then perform budget_access('BUDGET_VIEW');else perform budget_access('BUDGET_OVERRIDE_APPROVE');end if;
 perform pg_advisory_xact_lock(hashtextextended('budget:'||active_subsidiary_id(),0));
 select * into o from budget_overrides where id=(p->>'id')::bigint and subsidiary_id=active_subsidiary_id()for update;
 if o.id is null then raise exception 'Solicitud no encontrada.';end if;
 if action='apply'then
  if o.status<>'APROBADO'or o.requested_by<>app_user_id()then raise exception 'Solo el solicitante puede aplicar la autorización aprobada.';end if;
  result:=budget_run(o.source_type,o.payload,o.source_id);
  if coalesce((result->>'budgetPending')::boolean,false)then raise exception 'El presupuesto cambió; solicite una autorización actualizada.';end if;
  return result;
 end if;
 if o.status<>'PENDIENTE'or action not in('approve','reject')then raise exception 'La solicitud no está pendiente.';end if;
 if o.requested_by=app_user_id()then raise exception 'La sobreaprobación debe realizarla otra persona autorizada.';end if;
 if length(trim(coalesce(p->>'reason','')))<15 then raise exception 'Indique una justificación de al menos 15 caracteres.';end if;
 update budget_overrides set status=case action when 'approve'then 'APROBADO'else 'RECHAZADO'end,approved_by=app_user_id(),reason=p->>'reason',approved_at=now()where id=o.id;
 insert into budget_events(subsidiary_id,source_type,source_id,event,details)values(o.subsidiary_id,o.source_type,o.source_id,'SOBREAPROBACION',p);
 return jsonb_build_object('id',o.id);
end$$;

create function public.budget_options()returns jsonb language plpgsql stable security definer set search_path=public,pg_temp as $$
declare sid bigint:=budget_access('BUDGET_VIEW');begin
 return jsonb_build_object('userId',app_user_id(),'permissions',jsonb_build_object('manage',budget_can('BUDGET_MANAGE'),'approve',budget_can('BUDGET_APPROVE'),'transfer',budget_can('BUDGET_TRANSFER_REQUEST'),'override',budget_can('BUDGET_OVERRIDE_APPROVE')),
 'subsidiary',(select jsonb_build_object('id',s.subsidiary_id,'name',s.name,'currency',c.currency_code)from subsidiaries s join currencies c using(currency_id)where s.subsidiary_id=sid),
 'accounts',coalesce((select jsonb_agg(jsonb_build_object('id',a.account_id,'number',a.account_number,'name',a.account_name)order by a.account_number)from chart_accounts a where a.category in('Costo','Gasto')and a.accepts_entries and not a.is_inactive and(exists(select 1 from account_subsidiaries x where x.account_id=a.account_id and x.subsidiary_id=sid and x.is_active)or not exists(select 1 from account_subsidiaries where account_id=a.account_id))),'[]'),
 'centers',coalesce((select jsonb_agg(jsonb_build_object('id',cost_center_id,'name',code||' · '||name)order by code)from cost_centers where subsidiary_id=sid and not coalesce(is_inactive,false)),'[]'),
 'headers',coalesce((select jsonb_agg(to_jsonb(h)order by anio desc,id desc)from presupuestos_encabezado h where h.id_subsidiaria=sid),'[]'));
end$$;

create function public.budget_report(p jsonb default '{}')returns jsonb language plpgsql stable security definer set search_path=public,pg_temp as $$
declare sid bigint:=budget_access('BUDGET_VIEW');h presupuestos_encabezado%rowtype;
begin
 select * into h from presupuestos_encabezado where id=(p->>'id')::bigint and id_subsidiaria=sid;
 if h.id is null then raise exception 'Presupuesto no encontrado.';end if;
 return jsonb_build_object('header',to_jsonb(h),'rows',coalesce((select jsonb_agg(to_jsonb(u)||jsonb_build_object('account',a.account_number,'name',a.account_name,'center',coalesce(cc.name,'General / todas las dimensiones'),'percentage',case when u.initial+u.modifications>0 then round((u.committed+u.executed)/(u.initial+u.modifications)*100,2)else null end,'status',case when u.available<0 then 'EXCEDIDO'when u.initial+u.modifications>0 and u.available<=(u.initial+u.modifications)*.1 then 'ALERTA'else 'NORMAL'end)order by u.month,a.account_number,u.center_id)from budget_usage(h.id)u join chart_accounts a on a.account_id=u.account_id left join cost_centers cc on cc.cost_center_id=u.center_id where nullif(p->>'month','')is null or to_char(u.month,'YYYY-MM')=p->>'month'),'[]'),
 'transfers',coalesce((select jsonb_agg(to_jsonb(m)||jsonb_build_object('workflowId',w.id,'workflowStatus',w.status)order by m.id desc)from presupuestos_modificaciones m left join wf_instances w on w.entity_type='BUDGET_TRANSFER'and w.entity_id=m.id where m.id_subsidiaria=sid and(m.id_linea_origen in(select id from presupuestos_lineas where id_presupuesto_encabezado=h.id)or m.id_linea_destino in(select id from presupuestos_lineas where id_presupuesto_encabezado=h.id))),'[]'),
 'overrides',coalesce((select jsonb_agg(to_jsonb(o)-'payload'order by o.id desc)from budget_overrides o where o.subsidiary_id=sid),'[]'),
 'events',coalesce((select jsonb_agg(to_jsonb(e)order by e.id desc)from(select * from budget_events where subsidiary_id=sid order by id desc limit 100)e),'[]'));
end$$;

create function public.budget_header_action(p jsonb)returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare sid bigint:=budget_access(case when p->>'action'='copy'then 'BUDGET_MANAGE'else 'BUDGET_APPROVE'end);h presupuestos_encabezado%rowtype;key bigint;factor numeric;cur text;
begin
 perform pg_advisory_xact_lock(hashtextextended('budget:'||sid,0));
 select * into h from presupuestos_encabezado where id=(p->>'id')::bigint and id_subsidiaria=sid for update;
 if h.id is null then raise exception 'Presupuesto no encontrado.';end if;
 if p->>'action'='copy'then
  factor:=1+coalesce((p->>'percent')::numeric,0)/100;if factor<0 or factor>101 then raise exception 'El ajuste debe estar entre -100%% y 10000%%.';end if;
  insert into presupuestos_encabezado(id_subsidiaria,anio,nombre_version,moneda,tipo_control)values(sid,(p->>'year')::int,p->>'name',h.moneda,h.tipo_control)returning id into key;
  insert into presupuestos_lineas(id_presupuesto_encabezado,periodo_mes,id_cuenta_contable,id_centro_costo,id_proyecto,monto_presupuestado)
  select key,make_date((p->>'year')::int,extract(month from periodo_mes)::int,1),id_cuenta_contable,id_centro_costo,id_proyecto,round((monto_presupuestado+monto_modificaciones)*factor,6)from presupuestos_lineas where id_presupuesto_encabezado=h.id;
 elsif p->>'action'='approve'then
  if h.estado<>'BORRADOR'or not exists(select 1 from presupuestos_lineas where id_presupuesto_encabezado=h.id)then raise exception 'Solo se aprueban borradores con líneas.';end if;
  if(select count(*)from accounting_books where subsidiary_id=sid and is_primary and is_active)<>1 then raise exception 'Configure un único libro principal activo.';end if;
  if h.tipo_control='HARD_LOCK'and exists(select 1 from budget_usage(h.id)where available<-.000001)then raise exception 'El presupuesto estricto no cubre los compromisos y ejecuciones existentes. Revise las líneas sin presupuesto.';end if;
  update presupuestos_encabezado set estado='HISTORICO',updated_at=now()where id_subsidiaria=sid and anio=h.anio and estado in('APROBADO','CERRADO');
  update presupuestos_encabezado set estado='APROBADO',revision=revision+1,updated_at=now()where id=h.id;key:=h.id;
 elsif p->>'action'='close'then
  if h.estado<>'APROBADO'then raise exception 'Solo se puede cerrar una versión aprobada.';end if;
  update presupuestos_encabezado set estado='CERRADO',updated_at=now()where id=h.id;key:=h.id;
 else raise exception 'Acción inválida.';end if;
 insert into budget_events(subsidiary_id,source_type,source_id,event,details)values(sid,'PRESUPUESTO',key,upper(p->>'action'),p);
 return(select to_jsonb(x)from presupuestos_encabezado x where x.id=key);
end$$;

create function public.budget_transfer_finish(p_id bigint,p_status text)returns void language plpgsql security definer set search_path=public,pg_temp as $$
declare m presupuestos_modificaciones%rowtype;amount numeric;
begin
 perform pg_advisory_xact_lock(hashtextextended('budget:'||active_subsidiary_id(),0));
 select * into m from presupuestos_modificaciones where id=p_id and id_subsidiaria=active_subsidiary_id()for update;
 if m.id is null then raise exception 'Modificación no encontrada.';end if;
 if m.estado_workflow='APROBADO'then if p_status='APROBADO'then return;end if;raise exception 'Una modificación aplicada no se puede cancelar.';end if;
 if p_status='APROBADO'then
  perform budget_access('BUDGET_APPROVE');
  if not exists(select 1 from user_roles where user_id=app_user_id()and role_id in(2,5))then raise exception 'La modificación requiere un aprobador con rol 2 o 5.';end if;
  perform 1 from presupuestos_lineas where id in(m.id_linea_origen,m.id_linea_destino)order by id for update;
  if exists(select 1 from presupuestos_lineas l join presupuestos_encabezado h on h.id=l.id_presupuesto_encabezado where l.id in(m.id_linea_origen,m.id_linea_destino)and h.estado<>'APROBADO')then raise exception 'La versión presupuestaria ya no está aprobada.';end if;
  if m.id_linea_origen is not null then
   select u.available into amount from presupuestos_lineas l cross join lateral budget_usage(l.id_presupuesto_encabezado)u where l.id=m.id_linea_origen and u.line_id=l.id;
   if amount<m.monto_solicitado then raise exception using errcode='PT422',message='El origen ya no tiene saldo disponible para ceder.';end if;
   update presupuestos_lineas set monto_modificaciones=monto_modificaciones-m.monto_solicitado where id=m.id_linea_origen;
  end if;
  if m.id_linea_destino is not null then update presupuestos_lineas set monto_modificaciones=monto_modificaciones+m.monto_solicitado where id=m.id_linea_destino;end if;
  update presupuestos_modificaciones set approved_by_email=(select email from users where user_id=app_user_id()),approved_at=now()where id=m.id;
  update presupuestos_encabezado set revision=revision+1,updated_at=now()where id in(select id_presupuesto_encabezado from presupuestos_lineas where id in(m.id_linea_origen,m.id_linea_destino));
 end if;
 update presupuestos_modificaciones set estado_workflow=p_status where id=m.id;
 insert into budget_events(subsidiary_id,source_type,source_id,event,details)values(m.id_subsidiaria,'SOL_TRASLADO',m.id,p_status,to_jsonb(m));
end$$;

alter table public.wf_workflows drop constraint wf_workflows_entity_type_check;
alter table public.wf_workflows add constraint wf_workflows_entity_type_check check(entity_type in('PURCHASE_ORDER','SALES_ORDER','PAYMENT_REQUEST','BUDGET_TRANSFER'));
alter function public.wf_entity_data(text,bigint)rename to wf_entity_data_without_budget;
alter function public.wf_apply_entity_status(text,bigint,text)rename to wf_apply_entity_status_without_budget;
alter function public.wf_options()rename to wf_options_without_budget;
create function public.wf_entity_data(p_type text,p_id bigint)returns jsonb language plpgsql stable security definer set search_path=public,pg_temp as $$
declare result jsonb;begin if p_type<>'BUDGET_TRANSFER'then return wf_entity_data_without_budget(p_type,p_id);end if;
 select jsonb_build_object('subsidiaryId',m.id_subsidiaria,'amount',m.monto_solicitado,'number','SOL_TRASLADO-'||m.id,'status',m.estado_workflow,'deepLink','/apps/budget/dashboard?modification='||m.id)into result from presupuestos_modificaciones m where m.id=p_id;
 if result is null then raise exception 'Modificación no encontrada.';end if;return result;end$$;
create function public.wf_apply_entity_status(p_type text,p_id bigint,p_status text)returns void language plpgsql security definer set search_path=public,pg_temp as $$
begin if p_type='BUDGET_TRANSFER'then perform budget_transfer_finish(p_id,p_status);else perform wf_apply_entity_status_without_budget(p_type,p_id,p_status);end if;end$$;
create function public.wf_options()returns jsonb language sql stable security definer set search_path=public,pg_temp as $$
 select r||jsonb_build_object('entityTypes',(r->'entityTypes')||jsonb_build_array(jsonb_build_object('id','BUDGET_TRANSFER','name','Modificaciones presupuestarias')))from(select wf_options_without_budget()r)x
$$;

create function public.budget_transfer_request(p jsonb)returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare sid bigint:=budget_access('BUDGET_TRANSFER_REQUEST');src presupuestos_lineas%rowtype;dest presupuestos_lineas%rowtype;key bigint;wid bigint;amount numeric:=(p->>'amount')::numeric;kind text:=p->>'type';
begin
 perform pg_advisory_xact_lock(hashtextextended('budget:'||sid,0));
 if nullif(p->>'sourceId','')is not null then select l.* into src from presupuestos_lineas l join presupuestos_encabezado h on h.id=l.id_presupuesto_encabezado where l.id=(p->>'sourceId')::bigint and h.id_subsidiaria=sid and h.estado='APROBADO';if src.id is null then raise exception 'Origen inválido.';end if;end if;
 if nullif(p->>'destinationId','')is not null then select l.* into dest from presupuestos_lineas l join presupuestos_encabezado h on h.id=l.id_presupuesto_encabezado where l.id=(p->>'destinationId')::bigint and h.id_subsidiaria=sid and h.estado='APROBADO';if dest.id is null then raise exception 'Destino inválido.';end if;end if;
 if kind='TRASLADO'and(dest.periodo_mes<src.periodo_mes or dest.id_presupuesto_encabezado<>src.id_presupuesto_encabezado)then raise exception 'El traslado debe ser en la misma versión, al mismo mes o uno futuro.';end if;
 if src.id is not null and(select available from budget_usage(src.id_presupuesto_encabezado)where line_id=src.id)<amount then raise exception using errcode='PT422',message='El origen no tiene saldo presupuestario disponible para ceder.';end if;
 insert into presupuestos_modificaciones(id_subsidiaria,tipo_modificacion,motivo_justificacion,id_linea_origen,id_linea_destino,monto_solicitado)values(sid,kind,p->>'reason',src.id,dest.id,amount)returning id into key;
 select id into wid from wf_workflows where subsidiaria_id=sid and entity_type='BUDGET_TRANSFER'and estado_activo;
 if wid is null then
  insert into wf_workflows(nombre,entity_type,subsidiaria_id,created_by)values('Aprobación financiera de modificaciones presupuestarias','BUDGET_TRANSFER',sid,app_user_id())returning id into wid;
  insert into wf_rules(workflow_id,nivel,nombre_nivel,rol_aprobador_id)values(wid,1,'Gerencia Financiera / CFO',5);
 end if;
 perform wf_start_entity('BUDGET_TRANSFER',key);
 return jsonb_build_object('id',key,'message','Modificación enviada al workflow financiero.');
end$$;

create function public.budget_check_availability(p jsonb)returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare sid bigint:=budget_access('BUDGET_VIEW');h presupuestos_encabezado%rowtype;matched_line bigint;dt date;balance numeric:=0;amount numeric:=(p->>'monto')::numeric;
begin
 if (p->>'id_subsidiaria')::bigint is distinct from sid then raise exception 'Seleccione la subsidiaria activa.';end if;
 if amount is null or amount<0 then raise exception 'Importe inválido.';end if;
 dt:=(p->>'periodo'||'-01')::date;
 select * into h from presupuestos_encabezado where id_subsidiaria=sid and anio=extract(year from dt)and estado in('APROBADO','CERRADO');
 if h.id is null then return jsonb_build_object('controlActivo',false,'disponible',true,'saldo_remanente',null);end if;
 matched_line:=budget_match(h.id,dt,(p->>'id_cuenta_contable')::bigint,nullif(p->>'id_centro_costo','')::bigint,nullif(p->>'id_centro_costo','')::bigint);
 if matched_line is not null then select available into balance from budget_usage(h.id)where line_id=matched_line;end if;
 return jsonb_build_object('controlActivo',true,'tipo_control',h.tipo_control,'disponible',h.estado<>'CERRADO'and balance>=amount,'saldo_remanente',balance-amount);
end$$;

-- Only scoped entry points may be called by application users.
do $$declare f record;begin for f in select oid::regprocedure signature from pg_proc where pronamespace='public'::regnamespace and proname like 'budget_%'loop execute format('revoke all on function %s from public,anon,authenticated',f.signature);end loop;end$$;
revoke all on function public.wf_entity_data_without_budget(text,bigint),public.wf_apply_entity_status_without_budget(text,bigint,text),public.wf_options_without_budget(),public.wf_entity_data(text,bigint),public.wf_apply_entity_status(text,bigint,text)from public,anon,authenticated;
grant execute on function public.budget_options(),public.budget_report(jsonb),public.budget_save_header(jsonb),public.budget_save_lines(jsonb),public.budget_header_action(jsonb),public.budget_override_action(jsonb),public.budget_transfer_request(jsonb),public.budget_check_availability(jsonb),public.wf_options(),public.save_purchase_document(jsonb,bigint),public.save_supplier_invoice(jsonb,bigint),public.pr_save(jsonb),public.pr_execute(jsonb),public.wf_start_entity(text,bigint,jsonb)to authenticated;
revoke all on function public.wf_options(),public.save_purchase_document(jsonb,bigint),public.save_supplier_invoice(jsonb,bigint),public.pr_save(jsonb),public.pr_execute(jsonb),public.wf_start_entity(text,bigint,jsonb) from public,anon;
revoke all on function public.save_supplier_invoice_without_withholding(jsonb,bigint) from public,anon,authenticated;
notify pgrst,'reload schema';
