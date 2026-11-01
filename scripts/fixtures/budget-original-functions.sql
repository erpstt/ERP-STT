CREATE OR REPLACE FUNCTION public.budget_access(p_code text)
 RETURNS bigint
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
begin if not budget_can(p_code)then raise exception using errcode='42501',message='No tiene permiso para esta operación presupuestaria.';end if;return active_subsidiary_id();end$function$;

CREATE OR REPLACE FUNCTION public.budget_actuals(p_sid bigint)
 RETURNS TABLE(account_id bigint, month date, center_id bigint, amount numeric)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
 with g as(select x.transaction_id,x.account_id,date_trunc('month',x.posting_date)::date as "month",sum(x.debit_amount)d,sum(x.credit_amount)c
 from gl_impact x join accounting_books b using(accounting_book_id)join chart_accounts a on a.account_id=x.account_id
 where x.subsidiary_id=p_sid and b.is_primary and b.is_active and a.category in('Ingreso','Costo','Gasto')group by 1,2,3),
 dims as(select j.transaction_id,l.account_id,l.cost_center_id,sum(l.debit*j.exchange_rate)d,sum(l.credit*j.exchange_rate)c
 from journal_line l join journal j using(journal_id)where j.subsidiary_id=p_sid and j.status='CONTABILIZADO'group by 1,2,3),
 totals as(select transaction_id,account_id,sum(d)d,sum(c)c from dims group by 1,2),
 allocated as(select g.account_id,g.month,dims.cost_center_id,
 case when totals.d>0 then g.d*dims.d/totals.d else 0 end-case when totals.c>0 then g.c*dims.c/totals.c else 0 end amount
 from g join totals using(transaction_id,account_id)join dims using(transaction_id,account_id)
 union all select g.account_id,g.month,null,case when coalesce(t.d,0)=0 then g.d else 0 end-case when coalesce(t.c,0)=0 then g.c else 0 end
 from g left join totals t using(transaction_id,account_id))
 select a.account_id,a.month,a.cost_center_id,sum(a.amount)*case when ca.category='Ingreso'then -1 else 1 end from allocated a join chart_accounts ca on ca.account_id=a.account_id group by 1,2,3,ca.category having sum(a.amount)<>0
$function$;

CREATE OR REPLACE FUNCTION public.budget_can(p_code text)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
 select app_user_id()is not null and exists(select 1 from user_subsidiaries where user_id=app_user_id()and subsidiary_id=active_subsidiary_id())
 and(app_is_admin()or exists(select 1 from role_permissions rp join permissions p using(permission_id)where rp.role_id=app_active_role_id()and p.code=p_code))
$function$;

CREATE OR REPLACE FUNCTION public.budget_check_availability(p jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare sid bigint:=budget_access('BUDGET_VIEW');h presupuestos_encabezado%rowtype;matched_line bigint;dt date;balance numeric:=0;amount numeric:=(p->>'monto')::numeric;
begin
 if (p->>'id_subsidiaria')::bigint is distinct from sid then raise exception 'Seleccione la subsidiaria activa.';end if;
 if amount is null or amount<0 then raise exception 'Importe inválido.';end if;
 dt:=(p->>'periodo'||'-01')::date;
 select * into h from presupuestos_encabezado where id_subsidiaria=sid and anio=extract(year from dt)and estado in('APROBADO','CERRADO');
 if h.id is null then return jsonb_build_object('controlActivo',false,'disponible',true,'saldo_remanente',null);end if;
 if not exists(select 1 from chart_accounts a where a.account_id=(p->>'id_cuenta_contable')::bigint and a.category in('Costo','Gasto')and a.category=any(h.categorias))then return jsonb_build_object('controlActivo',false,'disponible',true,'saldo_remanente',null);end if;
 matched_line:=budget_match(h.id,dt,(p->>'id_cuenta_contable')::bigint,nullif(p->>'id_centro_costo','')::bigint,nullif(p->>'id_centro_costo','')::bigint);
 if matched_line is not null then select available into balance from budget_usage(h.id)where line_id=matched_line;end if;
 return jsonb_build_object('controlActivo',true,'tipo_control',h.tipo_control,'disponible',h.estado<>'CERRADO'and balance>=amount,'saldo_remanente',balance-amount);
end$function$;

CREATE OR REPLACE FUNCTION public.budget_commitments(p_sid bigint)
 RETURNS TABLE(source_type text, source_id bigint, account_id bigint, month date, center_id bigint, amount numeric)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
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
$function$;

CREATE OR REPLACE FUNCTION public.budget_header_action(p jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare sid bigint;h presupuestos_encabezado%rowtype;line_count bigint;
begin
 if p->>'action' is distinct from 'delete'then return budget_header_action_without_delete(p);end if;
 sid:=budget_access('BUDGET_MANAGE');
 perform pg_advisory_xact_lock(hashtextextended('budget:'||sid,0));
 select * into h from presupuestos_encabezado where id=(p->>'id')::bigint and id_subsidiaria=sid for update;
 if h.id is null then raise exception 'Presupuesto no encontrado en la sociedad activa.';end if;
 if h.estado<>'BORRADOR'then raise exception 'Solo se pueden eliminar presupuestos en borrador. Las versiones aprobadas, cerradas e históricas se conservan para consulta.';end if;
 if h.revision is distinct from (p->>'revision')::int then raise exception 'El presupuesto cambió. Actualice la pantalla antes de eliminarlo.';end if;
 if exists(select 1 from presupuestos_modificaciones m join presupuestos_lineas l on l.id in(m.id_linea_origen,m.id_linea_destino)where l.id_presupuesto_encabezado=h.id)then raise exception 'El presupuesto tiene modificaciones vinculadas y no puede eliminarse.';end if;
 select count(*)into line_count from presupuestos_lineas where id_presupuesto_encabezado=h.id;
 insert into budget_events(subsidiary_id,source_type,source_id,event,details)values(sid,'PRESUPUESTO',h.id,'ELIMINAR_BORRADOR',jsonb_build_object('header',to_jsonb(h),'deletedLines',line_count));
 delete from presupuestos_encabezado where id=h.id;
 return jsonb_build_object('id',h.id,'deleted',true);
end$function$;

CREATE OR REPLACE FUNCTION public.budget_header_action_without_delete(p jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare sid bigint:=budget_access(case when p->>'action'='copy'then 'BUDGET_MANAGE'else 'BUDGET_APPROVE'end);h presupuestos_encabezado%rowtype;key bigint;factor numeric;cur text;
begin
 perform pg_advisory_xact_lock(hashtextextended('budget:'||sid,0));
 select * into h from presupuestos_encabezado where id=(p->>'id')::bigint and id_subsidiaria=sid for update;
 if h.id is null then raise exception 'Presupuesto no encontrado.';end if;
 if p->>'action'='copy'then
  factor:=1+coalesce((p->>'percent')::numeric,0)/100;if factor<0 or factor>101 then raise exception 'El ajuste debe estar entre -100%% y 10000%%.';end if;
  insert into presupuestos_encabezado(id_subsidiaria,anio,nombre_version,moneda,tipo_control,categorias)values(sid,(p->>'year')::int,p->>'name',h.moneda,h.tipo_control,h.categorias)returning id into key;
  insert into presupuestos_lineas(id_presupuesto_encabezado,periodo_mes,id_cuenta_contable,id_centro_costo,id_proyecto,monto_presupuestado)
  select key,make_date((p->>'year')::int,extract(month from periodo_mes)::int,1),id_cuenta_contable,id_centro_costo,id_proyecto,round((monto_presupuestado+monto_modificaciones)*factor,6)from presupuestos_lineas where id_presupuesto_encabezado=h.id;
 elsif p->>'action'='approve'then
  if h.estado<>'BORRADOR'or not exists(select 1 from presupuestos_lineas where id_presupuesto_encabezado=h.id)then raise exception 'Solo se aprueban borradores con líneas.';end if;
  if(select count(*)from accounting_books where subsidiary_id=sid and is_primary and is_active)<>1 then raise exception 'Configure un único libro principal activo.';end if;
  if h.tipo_control='HARD_LOCK'and exists(select 1 from budget_usage(h.id)u join chart_accounts a on a.account_id=u.account_id where a.category in('Costo','Gasto')and available<-.000001)then raise exception 'El presupuesto estricto no cubre los compromisos y ejecuciones existentes. Revise las líneas sin presupuesto.';end if;
  update presupuestos_encabezado set estado='HISTORICO',updated_at=now()where id_subsidiaria=sid and anio=h.anio and estado in('APROBADO','CERRADO');
  update presupuestos_encabezado set estado='APROBADO',revision=revision+1,updated_at=now()where id=h.id;key:=h.id;
 elsif p->>'action'='close'then
  if h.estado<>'APROBADO'then raise exception 'Solo se puede cerrar una versión aprobada.';end if;
  update presupuestos_encabezado set estado='CERRADO',updated_at=now()where id=h.id;key:=h.id;
 else raise exception 'Acción inválida.';end if;
 insert into budget_events(subsidiary_id,source_type,source_id,event,details)values(sid,'PRESUPUESTO',key,upper(p->>'action'),p);
 return(select to_jsonb(x)from presupuestos_encabezado x where x.id=key);
end$function$;

CREATE OR REPLACE FUNCTION public.budget_match(p_header bigint, p_month date, p_account bigint, p_center bigint, p_project bigint)
 RETURNS bigint
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
 select id from presupuestos_lineas where id_presupuesto_encabezado=p_header and periodo_mes=date_trunc('month',p_month)::date and id_cuenta_contable=p_account
 and(id_centro_costo is null or id_centro_costo=p_center)and(id_proyecto is null or id_proyecto=p_project)
 order by ((id_centro_costo is not null)::int*2+(id_proyecto is not null)::int)desc,id limit 1
$function$;

CREATE OR REPLACE FUNCTION public.budget_options()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare sid bigint:=budget_access('BUDGET_VIEW');begin
 return jsonb_build_object('userId',app_user_id(),'permissions',jsonb_build_object('manage',budget_can('BUDGET_MANAGE'),'approve',budget_can('BUDGET_APPROVE'),'transfer',budget_can('BUDGET_TRANSFER_REQUEST'),'override',budget_can('BUDGET_OVERRIDE_APPROVE')),
 'subsidiary',(select jsonb_build_object('id',s.subsidiary_id,'name',s.name,'currency',c.currency_code)from subsidiaries s join currencies c using(currency_id)where s.subsidiary_id=sid),
 'accounts',coalesce((select jsonb_agg(jsonb_build_object('id',a.account_id,'number',a.account_number,'name',a.account_name,'category',a.category)order by a.account_number)from chart_accounts a where a.category in('Ingreso','Costo','Gasto')and a.accepts_entries and not a.is_inactive and(exists(select 1 from account_subsidiaries x where x.account_id=a.account_id and x.subsidiary_id=sid and x.is_active)or not exists(select 1 from account_subsidiaries where account_id=a.account_id))),'[]'),
 'centers','[]'::jsonb,
 'headers',coalesce((select jsonb_agg(to_jsonb(h)order by anio desc,id desc)from presupuestos_encabezado h where h.id_subsidiaria=sid),'[]'));
end$function$;

CREATE OR REPLACE FUNCTION public.budget_override_action(p jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
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
end$function$;

CREATE OR REPLACE FUNCTION public.budget_report(p jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare sid bigint:=budget_access('BUDGET_VIEW');h presupuestos_encabezado%rowtype;
begin
 select * into h from presupuestos_encabezado where id=(p->>'id')::bigint and id_subsidiaria=sid;
 if h.id is null then raise exception 'Presupuesto no encontrado.';end if;
 return jsonb_build_object('header',to_jsonb(h),'rows',coalesce((select jsonb_agg(to_jsonb(u)||jsonb_build_object('category',a.category,'account',a.account_number,'name',a.account_name,'center',coalesce(cc.name,'General / todas las dimensiones'),'percentage',case when u.initial+u.modifications>0 then round((u.committed+u.executed)/(u.initial+u.modifications)*100,2)else null end,'status',case when a.category='Ingreso'then case when u.available<=0 then 'META_CUMPLIDA'else 'POR_ALCANZAR'end when u.available<0 then 'EXCEDIDO'when u.initial+u.modifications>0 and u.available<=(u.initial+u.modifications)*.1 then 'ALERTA'else 'NORMAL'end)order by u.month,a.account_number,u.center_id)from budget_usage(h.id)u join chart_accounts a on a.account_id=u.account_id left join cost_centers cc on cc.cost_center_id=u.center_id where nullif(p->>'month','')is null or to_char(u.month,'YYYY-MM')=p->>'month'),'[]'),
 'transfers',coalesce((select jsonb_agg(to_jsonb(m)||jsonb_build_object('workflowId',w.id,'workflowStatus',w.status)order by m.id desc)from presupuestos_modificaciones m left join wf_instances w on w.entity_type='BUDGET_TRANSFER'and w.entity_id=m.id where m.id_subsidiaria=sid and(m.id_linea_origen in(select id from presupuestos_lineas where id_presupuesto_encabezado=h.id)or m.id_linea_destino in(select id from presupuestos_lineas where id_presupuesto_encabezado=h.id))),'[]'),
 'overrides',coalesce((select jsonb_agg(to_jsonb(o)-'payload'order by o.id desc)from budget_overrides o where o.subsidiary_id=sid),'[]'),
 'events',coalesce((select jsonb_agg(to_jsonb(e)order by e.id desc)from(select * from budget_events where subsidiary_id=sid order by id desc limit 100)e),'[]'));
end$function$;

CREATE OR REPLACE FUNCTION public.budget_run(p_type text, p_payload jsonb, p_id bigint DEFAULT NULL::bigint)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare receipt_replay jsonb;request_payload jsonb;invoice_payload jsonb;sid bigint:=active_subsidiary_id();before_state jsonb;after_state jsonb;violations jsonb;result jsonb;fingerprint_key text;override_row budget_overrides%rowtype;pending_id bigint;err_detail text;rate numeric;
begin
 if p_type='WORKFLOW_START' and p_payload->>'entityType'='SALES_ORDER' then perform sales_workflow_private.submit_access(p_id);p_payload:=jsonb_build_object('entityType','SALES_ORDER','context',jsonb_build_object('orderFingerprint',sales_workflow_private.fingerprint(p_id)));end if;
 if p_type='ORD_COM' and p_payload->>'type'='RECEIPT' and p_id is null then perform pg_advisory_xact_lock(hashtextextended('budget:'||asset_posting_private.identity(),0));receipt_replay:=purchase_receipt_private.replay(p_payload);if receipt_replay is not null then return receipt_replay;end if;end if;
 if p_type='ORD_COM' then perform purchase_order_private.prepare(p_payload,p_id);elsif p_type='WORKFLOW_START' and p_payload->>'entityType'='PURCHASE_ORDER' then perform purchase_order_private.submit_access(p_id);p_payload:=jsonb_build_object('entityType','PURCHASE_ORDER','context',jsonb_build_object('orderFingerprint',purchase_order_private.fingerprint(p_id)));end if;
 if p_type in('SOL_PAG','SOL_PAG_EXECUTE') and p_id is distinct from nullif(p_payload->>'id','')::bigint then raise exception using errcode='42501',message='El identificador presupuestario debe coincidir con la solicitud.';end if; if p_type='SOL_PAG' then perform payment_request_private.save_access(p_payload);elsif p_type='SOL_PAG_EXECUTE' then perform payment_request_private.execute_access(p_payload);elsif p_type='WORKFLOW_START' and p_payload->>'entityType'='PAYMENT_REQUEST' then perform payment_request_private.submit_access(p_id,(p_payload#>>'{context,requestVersion}')::integer);end if;
 if p_type='FAC_PRO' then perform supplier_invoice_private.assert_write(p_id);end if;
if app_user_id()is null or not exists(select 1 from user_subsidiaries where user_id=app_user_id()and subsidiary_id=sid)then raise exception 'Sin acceso a la subsidiaria.';end if;
 perform pg_advisory_xact_lock(hashtextextended('budget:'||sid,0));if p_type='FAC_PRO' then invoice_payload:=supplier_invoice_private.prepare(p_payload,p_id);end if;
 if p_type='SOL_PAG' then request_payload:=payment_request_private.prepare(p_payload);end if;before_state:=budget_state(sid);
 fingerprint_key:=md5(jsonb_build_object('requester',app_user_id(),'type',p_type,'id',p_id,'payload',p_payload,'versions',(select jsonb_agg(jsonb_build_array(id,revision)order by id)from presupuestos_encabezado where id_subsidiaria=sid and estado='APROBADO'))::text);
 select * into override_row from budget_overrides where subsidiary_id=sid and source_type=p_type and fingerprint=fingerprint_key for update;
 if override_row.status='CONSUMIDO'then raise exception 'Esta autorización ya fue aplicada. Abra el documento generado.';end if;
 begin
  case p_type
  when 'ORD_COM'then result:=purchase_order_private.engine(p_payload,p_id);
  when 'FAC_PRO'then result:=purchase_receipt_private.invoice_engine(invoice_payload,p_id);
  when 'SOL_PAG'then
   result:=payment_request_private.pr_save_without_budget(request_payload);
   if p_payload->>'type'='OTROS'and exists(select 1 from presupuestos_encabezado where id_subsidiaria=sid and estado='APROBADO')and exists(select 1 from solicitudes_pago_lineas l join chart_accounts a on a.account_id=l.id_cuenta_contable where l.id_solicitud=(result->>'id')::bigint and a.category in('Costo','Gasto'))then
    rate:=case when(p_payload->>'currencyId')::bigint=(select currency_id from subsidiaries where subsidiary_id=sid)then 1 else opening_balance_rate((p_payload->>'currencyId')::bigint,(p_payload->>'plannedDate')::date)end;
    update solicitudes_pago set budget_exchange_rate=rate where id=(result->>'id')::bigint;
   end if;
  when 'SOL_PAG_EXECUTE'then result:=payment_request_private.execute_engine(p_payload);
  when 'WORKFLOW_START'then if p_payload->>'entityType'='PAYMENT_REQUEST' then result:=payment_request_private.wf_start_entity_without_budget('PAYMENT_REQUEST',p_id,jsonb_build_object('requestVersion',(select version from public.solicitudes_pago where id=p_id)));elsif p_payload->>'entityType'='PURCHASE_ORDER' then result:=purchase_order_private.submit_engine(p_id);elsif p_payload->>'entityType'='SALES_ORDER' then result:=sales_workflow_private.submit_engine(p_id);else result:=wf_start_entity_without_budget(p_payload->>'entityType',p_id,coalesce(p_payload->'context','{}'));end if;
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
  if p_type='ORD_COM' and p_payload->>'type'='RECEIPT' then receipt_replay:=result||jsonb_build_object('budgetWarnings',violations);update purchase_receipt_private.operations set result=receipt_replay where user_id=public.app_user_id() and subsidiary_id=sid and operation_id=(p_payload->>'operationId')::uuid;end if;return result||jsonb_build_object('budgetWarnings',violations);
 exception when sqlstate 'BZ001'then
  get stacked diagnostics err_detail=PG_EXCEPTION_DETAIL;
 end;
 -- The operational changes above were rolled back; the request remains durable for over-approval.
 insert into budget_overrides(subsidiary_id,source_type,source_id,fingerprint,payload,detail,requested_by)
 values(sid,p_type,p_id,fingerprint_key,p_payload,err_detail::jsonb,app_user_id())
 on conflict(subsidiary_id,source_type,fingerprint)do update set detail=excluded.detail,status='PENDIENTE',approved_by=null,approved_at=null,reason=null returning id into pending_id;
 return jsonb_build_object('budgetPending',true,'budgetRequestId',pending_id,'message','Solicitud guardada pendiente de sobreaprobación presupuestaria. El documento todavía no fue emitido ni contabilizado.');
end$function$;

CREATE OR REPLACE FUNCTION public.budget_save_header(p jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare sid bigint:=budget_access('BUDGET_MANAGE');h presupuestos_encabezado%rowtype;cats text[];result jsonb;
begin
 perform pg_advisory_xact_lock(hashtextextended('budget:'||sid,0));
 result:=budget_save_header_without_categories(p);
 select * into h from presupuestos_encabezado where id=(result->>'id')::bigint;
 if p ? 'categories'then
  if jsonb_typeof(p->'categories')<>'array'then raise exception 'Seleccione las categorías de resultados.';end if;
  select array_agg(distinct value)into cats from jsonb_array_elements_text(p->'categories');
  if cats is null or not(cats <@ array['Ingreso','Costo','Gasto']::text[])then raise exception 'Seleccione al menos una categoría válida: Ingresos, Costos o Gastos.';end if;
  if exists(select 1 from presupuestos_lineas l join chart_accounts a on a.account_id=l.id_cuenta_contable where l.id_presupuesto_encabezado=h.id and not(a.category=any(cats)))then raise exception 'La matriz contiene cuentas de una categoría desmarcada. Conserve esa categoría o retire primero sus filas de la matriz.';end if;
  update presupuestos_encabezado set categorias=cats where id=h.id;
  insert into presupuestos_lineas(id_presupuesto_encabezado,periodo_mes,id_cuenta_contable,monto_presupuestado)
  select h.id,make_date(h.anio,m,1),a.account_id,0 from chart_accounts a cross join generate_series(1,12)m
  where a.category=any(cats)and a.accepts_entries and not a.is_inactive
  and(exists(select 1 from account_subsidiaries x where x.account_id=a.account_id and x.subsidiary_id=sid and x.is_active)or not exists(select 1 from account_subsidiaries where account_id=a.account_id))
  and not exists(select 1 from presupuestos_lineas l where l.id_presupuesto_encabezado=h.id and l.id_cuenta_contable=a.account_id);
 end if;
 return(select to_jsonb(x)from presupuestos_encabezado x where x.id=h.id);
end$function$;

CREATE OR REPLACE FUNCTION public.budget_save_header_without_categories(p jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
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
end$function$;

CREATE OR REPLACE FUNCTION public.budget_save_lines(p jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare sid bigint:=budget_access('BUDGET_MANAGE');h presupuestos_encabezado%rowtype;r jsonb;acc bigint;cc bigint;dt date;amount numeric;
begin
 select * into h from presupuestos_encabezado where id=(p->>'id')::bigint and id_subsidiaria=sid for update;
 if h.id is null or h.estado<>'BORRADOR'then raise exception 'Seleccione una versión en borrador.';end if;
 if h.revision is distinct from(p->>'revision')::int then raise exception 'La versión cambió. Recargue la matriz.';end if;
 if jsonb_typeof(p->'lines')is distinct from 'array'or jsonb_array_length(p->'lines')>12000 then raise exception 'Importe hasta 12.000 líneas.';end if;
 delete from presupuestos_lineas where id_presupuesto_encabezado=h.id;
 for r in select value from jsonb_array_elements(p->'lines')loop
  acc:=nullif(r->>'accountId','')::bigint;cc:=null;
  if nullif(trim(r->>'centerId'),'')is not null or nullif(trim(r->>'projectId'),'')is not null then raise exception 'El presupuesto es general por sociedad. No ingrese centros de costo ni proyectos.';end if;
  if acc is null then select account_id into acc from chart_accounts where account_number=r->>'account';end if;
  if not exists(select 1 from chart_accounts a where a.account_id=acc and a.category=any(h.categorias)and a.accepts_entries and not a.is_inactive and(exists(select 1 from account_subsidiaries x where x.account_id=a.account_id and x.subsidiary_id=sid and x.is_active)or not exists(select 1 from account_subsidiaries where account_id=a.account_id)))then raise exception 'Seleccione una cuenta de resultados seleccionada habilitada para la subsidiaria.';end if;
  if cc is not null and not exists(select 1 from cost_centers where cost_center_id=cc and subsidiary_id=sid and not coalesce(is_inactive,false))then raise exception 'Centro de costo/proyecto inválido.';end if;
  dt:=(r->>'month'||'-01')::date;amount:=(r->>'amount')::numeric;
  if extract(year from dt)<>h.anio then raise exception 'El mes debe pertenecer al año del presupuesto.';end if;
  insert into presupuestos_lineas(id_presupuesto_encabezado,periodo_mes,id_cuenta_contable,id_centro_costo,id_proyecto,monto_presupuestado)values(h.id,dt,acc,cc,cc,amount);
 end loop;
 update presupuestos_encabezado set revision=revision+1,updated_at=now()where id=h.id returning * into h;return to_jsonb(h);
end$function$;

CREATE OR REPLACE FUNCTION public.budget_state(p_sid bigint)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
 select coalesce(jsonb_agg(to_jsonb(u)||jsonb_build_object('headerId',h.id,'revision',h.revision,'control',case when h.estado='CERRADO'then 'HARD_LOCK'else h.tipo_control end,'closed',h.estado='CERRADO','account',a.account_number,'center',coalesce(cc.name,'General'))),'[]')
 from presupuestos_encabezado h cross join lateral budget_usage(h.id)u join chart_accounts a on a.account_id=u.account_id left join cost_centers cc on cc.cost_center_id=u.center_id
 where a.category in('Costo','Gasto')and h.id_subsidiaria=p_sid and h.estado in('APROBADO','CERRADO')
$function$;

CREATE OR REPLACE FUNCTION public.budget_transfer_finish(p_id bigint, p_status text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
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
end$function$;

CREATE OR REPLACE FUNCTION public.budget_transfer_request(p jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
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
end$function$;

CREATE OR REPLACE FUNCTION public.budget_usage(p_header bigint)
 RETURNS TABLE(key text, line_id bigint, account_id bigint, month date, center_id bigint, initial numeric, modifications numeric, committed numeric, executed numeric, available numeric)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
 with h as(select * from presupuestos_encabezado where id=p_header),
 dimension_moves as(select a.account_id,a.month,a.center_id,0::numeric committed,a.amount executed from h cross join lateral budget_actuals(h.id_subsidiaria)a where extract(year from a.month)=h.anio
 union all select c.account_id,c.month,c.center_id,c.amount,0 from h cross join lateral budget_commitments(h.id_subsidiaria)c where extract(year from c.month)=h.anio),
 moves as(select account_id,month,null::bigint center_id,sum(committed)committed,sum(executed)executed from dimension_moves group by account_id,month),
 mapped as(select m.*,budget_match(p_header,m.month,m.account_id,m.center_id,m.center_id)line_id from moves m join chart_accounts ca on ca.account_id=m.account_id where ca.category=any((select categorias from h)::text[])),
 keys as(select 'L:'||l.id key,l.id line_id,l.id_cuenta_contable account_id,l.periodo_mes as "month",l.id_centro_costo center_id,l.monto_presupuestado initial,l.monto_modificaciones modifications from presupuestos_lineas l where l.id_presupuesto_encabezado=p_header
 union all select distinct 'U:'||m.account_id||':'||m.month||':'||coalesce(m.center_id,0),null::bigint,m.account_id,m.month,m.center_id,0,0 from mapped m where m.line_id is null),
 amounts as(select k.*,coalesce(sum(m.committed),0)committed,coalesce(sum(m.executed),0)executed from keys k left join mapped m on
 (k.line_id is not null and m.line_id=k.line_id)or(k.line_id is null and m.line_id is null and m.account_id=k.account_id and m.month=k.month and m.center_id is not distinct from k.center_id)group by k.key,k.line_id,k.account_id,k.month,k.center_id,k.initial,k.modifications)
 select a.*,a.initial+a.modifications-a.committed-a.executed from amounts a
$function$;
