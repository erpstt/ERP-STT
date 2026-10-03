create index if not exists solicitudes_pago_lineas_cost_center_report_idx
 on public.solicitudes_pago_lineas(id_centro_costo,id_solicitud)
 where id_centro_costo is not null;
create index if not exists solicitudes_pago_lineas_account_report_idx
 on public.solicitudes_pago_lineas(id_cuenta_contable,id_solicitud)
 where id_cuenta_contable is not null;
create index if not exists solicitudes_pago_lineas_customer_report_idx
 on public.solicitudes_pago_lineas(id_cliente,id_solicitud)
 where id_cliente is not null;
create index if not exists solicitudes_pago_lineas_supplier_report_idx
 on public.solicitudes_pago_lineas(id_proveedor,id_solicitud)
 where id_proveedor is not null;
create index if not exists solicitudes_pago_lineas_employee_report_idx
 on public.solicitudes_pago_lineas(id_empleado,id_solicitud)
 where id_empleado is not null;
create index if not exists supplier_invoice_line_payment_request_dimensions_idx
 on public.supplier_invoice_line(invoice_id,department_id,cost_center_id,account_id);

create or replace function public.payment_request_report_options()
returns jsonb
language plpgsql
stable
security definer
set search_path=public,pg_temp
as $$
declare
 sid bigint:=public.pr_access();
 result jsonb;
begin
 select jsonb_build_object(
  'subsidiary',jsonb_build_object(
   'id',s.subsidiary_id,'name',s.name,'legalName',s.legal_name,'taxId',s.tax_id,
   'logoUrl',s.logo_url,'baseCurrencyId',c.currency_id,'baseCurrencyCode',c.currency_code,
   'baseCurrencySymbol',c.symbol
  ),
  'requestTypes',jsonb_build_array(
   jsonb_build_object('id','CXP','name','Pago de CxP'),
   jsonb_build_object('id','OTROS','name','Otros pagos')
  ),
  'types',jsonb_build_array(
   jsonb_build_object('value','CXP','label','Pago de CxP'),
   jsonb_build_object('value','OTROS','label','Otros pagos')
  ),
  'statuses',jsonb_build_array(
   jsonb_build_object('id','BORRADOR','value','BORRADOR','name','Borrador','label','Borrador'),
   jsonb_build_object('id','PENDIENTE_APROBACION','value','PENDIENTE_APROBACION','name','Pendiente de aprobación','label','Pendiente de aprobación'),
   jsonb_build_object('id','APROBADO','value','APROBADO','name','Aprobado · pendiente de pago','label','Aprobado · pendiente de pago'),
   jsonb_build_object('id','APLICADO','value','APLICADO','name','Pagado / aplicado','label','Pagado / aplicado'),
   jsonb_build_object('id','RECHAZADO','value','RECHAZADO','name','Rechazado','label','Rechazado'),
   jsonb_build_object('id','ANULADO','value','ANULADO','name','Anulado','label','Anulado')
  ),
  'currencies',coalesce((
   select jsonb_agg(jsonb_build_object('id',x.currency_id,'code',x.currency_code,'name',x.name,'symbol',x.symbol) order by x.currency_code)
   from(
    select distinct cu.currency_id,cu.currency_code,cu.name,cu.symbol
    from currencies cu
    where cu.currency_id=s.currency_id
       or exists(select 1 from subsidiary_currencies sc where sc.subsidiary_id=sid and sc.currency_id=cu.currency_id)
       or exists(select 1 from solicitudes_pago pr where pr.id_subsidiaria=sid and pr.id_moneda=cu.currency_id)
   )x
  ),'[]'::jsonb),
  'requesters',coalesce((
   select jsonb_agg(jsonb_build_object('id',x.user_id,'name',x.display_name,'email',x.email) order by x.display_name,x.email)
   from(
    select distinct u.user_id,coalesce(nullif(trim(concat_ws(' ',u.first_name,u.last_name)),''),u.email) display_name,u.email
    from users u
    where exists(select 1 from solicitudes_pago pr where pr.id_subsidiaria=sid and pr.id_solicitante=u.user_id)
       or exists(select 1 from user_subsidiaries us where us.subsidiary_id=sid and us.user_id=u.user_id and u.is_active)
   )x
  ),'[]'::jsonb),
  'approvers',coalesce((
   select jsonb_agg(jsonb_build_object('id',x.user_id,'name',x.display_name,'email',x.email) order by x.display_name,x.email)
   from(
    select distinct u.user_id,coalesce(nullif(trim(concat_ws(' ',u.first_name,u.last_name)),''),u.email) display_name,u.email
    from users u
    where exists(select 1 from solicitudes_pago pr where pr.id_subsidiaria=sid and pr.aprobado_por=u.user_id)
       or exists(select 1 from wf_instances wi join wf_instance_steps ws on ws.instance_id=wi.id join wf_step_decisions wd on wd.step_id=ws.id where wi.subsidiaria_id=sid and wi.entity_type='PAYMENT_REQUEST' and wd.usuario_id=u.user_id)
       or exists(select 1 from user_subsidiaries us where us.subsidiary_id=sid and us.user_id=u.user_id and u.is_active)
   )x
  ),'[]'::jsonb),
  'thirdParties',coalesce((
   select jsonb_agg(jsonb_build_object('key',x.party_type||':'||x.party_id,'id',x.party_id,'type',x.party_type,'name',x.party_name,'taxId',x.tax_id) order by x.party_type,x.party_name)
   from(
    select distinct 'Proveedor'::text party_type,sp.supplier_id party_id,sp.company_name party_name,sp.tax_id
    from suppliers sp where sp.primary_subsidiary_id=sid or exists(select 1 from entity_subsidiaries es where es.subsidiary_id=sid and es.supplier_id=sp.supplier_id)
    union all
    select distinct 'Cliente',cu.customer_id,cu.company_name,cu.tax_id
    from customers cu where cu.primary_subsidiary_id=sid or exists(select 1 from entity_subsidiaries es where es.subsidiary_id=sid and es.customer_id=cu.customer_id)
    union all
    select distinct 'Empleado',e.employee_id,trim(concat_ws(' ',e.first_name,e.last_name)),e.identification
    from employees e where e.subsidiary_id=sid
   )x
  ),'[]'::jsonb),
  'departments',coalesce((
   select jsonb_agg(jsonb_build_object('id',x.department_id,'name',x.name,'type',x.type) order by x.name)
   from(
    select distinct d.department_id,d.name,d.type
    from departments d
    where d.subsidiary_id=sid or exists(select 1 from department_subsidiaries ds where ds.department_id=d.department_id and ds.subsidiary_id=sid)
   )x
  ),'[]'::jsonb),
  'costCenters',coalesce((
   select jsonb_agg(jsonb_build_object('id',cc.cost_center_id,'code',cc.code,'name',cc.name,'departmentId',cu.department_id) order by cc.code,cc.name)
   from cost_centers cc left join customers cu on cu.customer_id=cc.customer_id
   where cc.subsidiary_id=sid
  ),'[]'::jsonb),
  'accounts',coalesce((
   select jsonb_agg(jsonb_build_object('id',a.account_id,'number',a.account_number,'name',a.account_name,'category',a.category) order by a.account_number)
   from chart_accounts a
   where a.account_id in(
    select l.id_cuenta_contable from solicitudes_pago_lineas l join solicitudes_pago pr on pr.id=l.id_solicitud where pr.id_subsidiaria=sid and l.id_cuenta_contable is not null
    union
    select sil.account_id from solicitudes_pago_lineas l join solicitudes_pago pr on pr.id=l.id_solicitud join supplier_invoice_line sil on sil.invoice_id=l.id_factura_proveedor where pr.id_subsidiaria=sid
   )
  ),'[]'::jsonb),
  'methods',jsonb_build_array(
   jsonb_build_object('value','TRANSFERENCIA','label','Transferencia'),
   jsonb_build_object('value','CHEQUE','label','Cheque'),
   jsonb_build_object('value','SINPE','label','SINPE')
  ),
  'dateRange',jsonb_build_object(
   'from',(select min(fecha_solicitud) from solicitudes_pago where id_subsidiaria=sid),
   'to',(select max(greatest(fecha_solicitud,fecha_pago_programada,coalesce(aplicado_at::date,fecha_solicitud))) from solicitudes_pago where id_subsidiaria=sid)
  )
 ) into result
 from subsidiaries s join currencies c on c.currency_id=s.currency_id
 where s.subsidiary_id=sid;
 return result;
end
$$;

create or replace function public.run_payment_request_report(p_filters jsonb default '{}'::jsonb)
returns jsonb
language plpgsql
stable
security definer
set search_path=public,pg_temp
as $$
declare
 sid bigint:=coalesce(nullif(p_filters->>'subsidiaryId','')::bigint,active_subsidiary_id());
 date_field text:=upper(coalesce(nullif(p_filters->>'dateField',''),'REQUEST'));
 date_from date:=coalesce(nullif(p_filters->>'dateFrom','')::date,date_trunc('year',current_date)::date);
 date_to date:=coalesce(nullif(p_filters->>'dateTo','')::date,current_date);
 page_number integer:=greatest(coalesce(nullif(p_filters->>'page','')::integer,1),1);
 page_size integer:=least(greatest(coalesce(nullif(p_filters->>'pageSize','')::integer,50),1),5000);
 search_text text:=nullif(trim(left(coalesce(p_filters->>'search',''),150)),'');
 filter_party_type text:=nullif(coalesce(p_filters->>'thirdPartyType',split_part(coalesce(p_filters->>'thirdPartyKey',''),':',1)),'');
 filter_party_id bigint:=coalesce(nullif(p_filters->>'thirdPartyId','')::bigint,nullif(split_part(coalesce(p_filters->>'thirdPartyKey',''),':',2),'')::bigint);
 filter_department_id bigint:=nullif(p_filters->>'departmentId','')::bigint;
 filter_cost_center_id bigint:=nullif(p_filters->>'costCenterId','')::bigint;
 filter_account_id bigint:=nullif(p_filters->>'accountId','')::bigint;
 filter_currency_id bigint:=nullif(p_filters->>'currencyId','')::bigint;
 filter_requester_id bigint:=nullif(p_filters->>'requesterId','')::bigint;
 filter_approver_id bigint:=nullif(p_filters->>'approverId','')::bigint;
 filter_payment_method text:=nullif(upper(p_filters->>'method'),'');
 result jsonb;
begin
 if app_user_id() is null or not exists(select 1 from users where user_id=app_user_id() and is_active)
    or sid is null or not exists(select 1 from user_subsidiaries where user_id=app_user_id() and subsidiary_id=sid) then
  raise exception using errcode='42501',message='No tiene acceso a la subsidiaria seleccionada.';
 end if;
 if date_field not in('REQUEST','PLANNED','APPLIED') then raise exception 'El campo de fecha seleccionado no es válido.'; end if;
 if date_from>date_to or date_to-date_from>3660 then raise exception 'El rango de fechas no es válido o supera diez años.'; end if;
 if filter_party_type is not null and filter_party_type not in('Proveedor','Cliente','Empleado') then raise exception 'El tipo de tercero no es válido.'; end if;
 if filter_payment_method is not null and filter_payment_method not in('TRANSFERENCIA','CHEQUE','SINPE') then raise exception 'El método de pago no es válido.'; end if;

 with headers as(
  select h.*,c.currency_code,c.symbol,
   coalesce(nullif(trim(concat_ws(' ',rq.first_name,rq.last_name)),''),rq.email) requester_name,rq.email requester_email,
   coalesce(nullif(trim(concat_ws(' ',legacy_approver.first_name,legacy_approver.last_name)),''),legacy_approver.email) legacy_approver_name,
   coalesce(nullif(trim(concat_ws(' ',applier.first_name,applier.last_name)),''),applier.email) applier_name,
   header_supplier.company_name supplier_name,header_supplier.tax_id supplier_tax_id,
   wf.id workflow_id,wf.status workflow_status,wf.current_level,
   coalesce(wf_approval.user_id,h.aprobado_por) effective_approver_id,
   coalesce(wf_approval.approver_name,coalesce(nullif(trim(concat_ws(' ',legacy_approver.first_name,legacy_approver.last_name)),''),legacy_approver.email)) effective_approver_name,
   coalesce(wf_approval.approved_at,h.aprobado_at) effective_approved_at,
   case date_field when 'PLANNED' then h.fecha_pago_programada when 'APPLIED' then h.aplicado_at::date else h.fecha_solicitud end selected_date
  from solicitudes_pago h
  join currencies c on c.currency_id=h.id_moneda
  join users rq on rq.user_id=h.id_solicitante
  left join users legacy_approver on legacy_approver.user_id=h.aprobado_por
  left join users applier on applier.user_id=h.aplicado_por
  left join suppliers header_supplier on header_supplier.supplier_id=h.id_proveedor
  left join wf_instances wf on wf.entity_type='PAYMENT_REQUEST' and wf.entity_id=h.id and wf.subsidiaria_id=h.id_subsidiaria
  left join lateral(
   select wd.usuario_id user_id,coalesce(nullif(trim(concat_ws(' ',wu.first_name,wu.last_name)),''),wu.email) approver_name,wd.fecha_hora approved_at
   from wf_instance_steps wis join wf_step_decisions wd on wd.step_id=wis.id join users wu on wu.user_id=wd.usuario_id
   where wis.instance_id=wf.id and wd.accion='APROBAR' order by wd.fecha_hora desc,wd.id desc limit 1
  )wf_approval on true
  where h.id_subsidiaria=sid
   and(case date_field when 'PLANNED' then h.fecha_pago_programada when 'APPLIED' then h.aplicado_at::date else h.fecha_solicitud end) between date_from and date_to
   and(filter_currency_id is null or h.id_moneda=filter_currency_id)
   and(filter_requester_id is null or h.id_solicitante=filter_requester_id)
   and(filter_approver_id is null or h.aprobado_por=filter_approver_id or exists(
    select 1 from wf_instance_steps ais join wf_step_decisions ad on ad.step_id=ais.id where ais.instance_id=wf.id and ad.usuario_id=filter_approver_id and ad.accion='APROBAR'
   ))
   and(filter_payment_method is null or h.metodo_pago=filter_payment_method)
   and(
    coalesce(jsonb_array_length(case when jsonb_typeof(p_filters->'types')='array' then p_filters->'types' else '[]'::jsonb end),0)=0
    and nullif(p_filters->>'type','') is null
    or h.tipo_solicitud=coalesce(nullif(p_filters->>'type',''),h.tipo_solicitud)
    and(coalesce(jsonb_array_length(case when jsonb_typeof(p_filters->'types')='array' then p_filters->'types' else '[]'::jsonb end),0)=0
        or h.tipo_solicitud in(select jsonb_array_elements_text(p_filters->'types')))
   )
   and(
    coalesce(jsonb_array_length(case when jsonb_typeof(p_filters->'statuses')='array' then p_filters->'statuses' else '[]'::jsonb end),0)=0
    and nullif(p_filters->>'status','') is null
    or h.estado=coalesce(nullif(p_filters->>'status',''),h.estado)
    and(coalesce(jsonb_array_length(case when jsonb_typeof(p_filters->'statuses')='array' then p_filters->'statuses' else '[]'::jsonb end),0)=0
        or h.estado in(select jsonb_array_elements_text(p_filters->'statuses')))
   )
   and(search_text is null or h.numero ilike '%'||search_text||'%' or h.concepto ilike '%'||search_text||'%'
       or header_supplier.company_name ilike '%'||search_text||'%'
       or exists(select 1 from solicitudes_pago_lineas sl
        left join supplier_invoice si on si.invoice_id=sl.id_factura_proveedor
        left join chart_accounts ca on ca.account_id=sl.id_cuenta_contable
        left join customers pc on pc.customer_id=sl.id_cliente
        left join suppliers ps on ps.supplier_id=sl.id_proveedor
        left join employees pe on pe.employee_id=sl.id_empleado
        where sl.id_solicitud=h.id and(concat_ws(' ',sl.concepto,si.invoice_number,ca.account_number,ca.account_name,pc.company_name,ps.company_name,pe.first_name,pe.last_name) ilike '%'||search_text||'%')))
 ),
 line_base as(
  select h.id request_id,h.tipo_solicitud request_type,l.id line_id,l.monto line_amount,l.concepto line_concept,
   l.id_factura_proveedor invoice_id,inv.invoice_number,inv.invoice_date,inv.due_date invoice_due_date,
   case when h.tipo_solicitud='CXP' then 'Proveedor' else l.tipo_tercero end party_type,
   case when h.tipo_solicitud='CXP' then h.id_proveedor else coalesce(l.id_cliente,l.id_proveedor,l.id_empleado) end party_id,
   case when h.tipo_solicitud='CXP' then h.supplier_name else coalesce(pc.company_name,ps.company_name,trim(concat_ws(' ',pe.first_name,pe.last_name))) end party_name,
   case when h.tipo_solicitud='CXP' then h.supplier_tax_id else coalesce(pc.tax_id,ps.tax_id,pe.identification) end party_tax_id,
   l.id_centro_costo direct_cost_center_id,l.id_cuenta_contable direct_account_id,
   coalesce(pe.department_id,pc.department_id,cc_customer.department_id) direct_department_id
  from headers h join solicitudes_pago_lineas l on l.id_solicitud=h.id
  left join supplier_invoice inv on inv.invoice_id=l.id_factura_proveedor
  left join customers pc on pc.customer_id=l.id_cliente
  left join suppliers ps on ps.supplier_id=l.id_proveedor
  left join employees pe on pe.employee_id=l.id_empleado
  left join cost_centers cc on cc.cost_center_id=l.id_centro_costo
  left join customers cc_customer on cc_customer.customer_id=cc.customer_id
 ),
 line_departments as(
  select distinct lb.request_id,lb.line_id,sil.department_id
  from line_base lb join supplier_invoice_line sil on lb.request_type='CXP' and sil.invoice_id=lb.invoice_id where sil.department_id is not null
  union
  select distinct request_id,line_id,direct_department_id from line_base where request_type='OTROS' and direct_department_id is not null
 ),
 line_cost_centers as(
  select distinct lb.request_id,lb.line_id,sil.cost_center_id
  from line_base lb join supplier_invoice_line sil on lb.request_type='CXP' and sil.invoice_id=lb.invoice_id where sil.cost_center_id is not null
  union
  select distinct request_id,line_id,direct_cost_center_id from line_base where request_type='OTROS' and direct_cost_center_id is not null
 ),
 line_accounts as(
  select distinct lb.request_id,lb.line_id,sil.account_id
  from line_base lb join supplier_invoice_line sil on lb.request_type='CXP' and sil.invoice_id=lb.invoice_id
  union
  select distinct request_id,line_id,direct_account_id from line_base where request_type='OTROS' and direct_account_id is not null
 ),
 filtered_lines as(
  select lb.*
  from line_base lb
  where(filter_party_type is null or lb.party_type=filter_party_type)
   and(filter_party_id is null or lb.party_id=filter_party_id)
   and(filter_department_id is null or exists(select 1 from line_departments ld where ld.request_id=lb.request_id and ld.line_id=lb.line_id and ld.department_id=filter_department_id))
   and(filter_cost_center_id is null or exists(select 1 from line_cost_centers lc where lc.request_id=lb.request_id and lc.line_id=lb.line_id and lc.cost_center_id=filter_cost_center_id))
   and(filter_account_id is null or exists(select 1 from line_accounts la where la.request_id=lb.request_id and la.line_id=lb.line_id and la.account_id=filter_account_id))
 ),
 filtered_enriched as(
  select fl.*,jsonb_build_object(
   'id',fl.line_id,'lineId',fl.line_id,'amount',fl.line_amount,'concept',fl.line_concept,
   'partyType',fl.party_type,'partyId',fl.party_id,'partyKey',case when fl.party_id is null then null else fl.party_type||':'||fl.party_id end,
   'partyName',fl.party_name,'partyTaxId',fl.party_tax_id,
   'invoiceId',fl.invoice_id,'invoiceNumber',fl.invoice_number,'invoiceDate',fl.invoice_date,'invoiceDueDate',fl.invoice_due_date,
   'accountId',case when fl.request_type='OTROS' then fl.direct_account_id end,
   'accountNumber',(select string_agg(distinct a.account_number,', ' order by a.account_number) from line_accounts la join chart_accounts a on a.account_id=la.account_id where la.request_id=fl.request_id and la.line_id=fl.line_id),
   'accountName',(select string_agg(distinct a.account_name,', ' order by a.account_name) from line_accounts la join chart_accounts a on a.account_id=la.account_id where la.request_id=fl.request_id and la.line_id=fl.line_id),
   'accounts',coalesce((select jsonb_agg(jsonb_build_object('id',x.account_id,'number',x.account_number,'name',x.account_name,'category',x.category) order by x.account_number) from(
     select distinct a.account_id,a.account_number,a.account_name,a.category from line_accounts la join chart_accounts a on a.account_id=la.account_id where la.request_id=fl.request_id and la.line_id=fl.line_id
    )x),'[]'::jsonb),
   'departments',coalesce((select jsonb_agg(jsonb_build_object('id',x.department_id,'name',x.name,'type',x.type) order by x.name) from(
     select distinct d.department_id,d.name,d.type from line_departments ld join departments d on d.department_id=ld.department_id where ld.request_id=fl.request_id and ld.line_id=fl.line_id
    )x),'[]'::jsonb),
   'costCenters',coalesce((select jsonb_agg(jsonb_build_object('id',x.cost_center_id,'code',x.code,'name',x.name) order by x.code,x.name) from(
     select distinct cc.cost_center_id,cc.code,cc.name from line_cost_centers lc join cost_centers cc on cc.cost_center_id=lc.cost_center_id where lc.request_id=fl.request_id and lc.line_id=fl.line_id
    )x),'[]'::jsonb),
   'dimensionSource',case when fl.request_type='CXP' then 'Factura de proveedor' else 'Solicitud de pago' end
  )line_json
  from filtered_lines fl
 ),
 matched as(
  select request_id,count(*) matched_line_count,sum(line_amount) analyzed_amount,jsonb_agg(line_json order by line_id) lines
  from filtered_enriched group by request_id
 ),
 report_rows as(
  select h.*,m.matched_line_count,m.analyzed_amount,m.lines,
   coalesce((select jsonb_agg(jsonb_build_object('type',x.party_type,'id',x.party_id,'key',x.party_type||':'||x.party_id,'name',x.party_name,'taxId',x.party_tax_id) order by x.party_type,x.party_name) from(
    select distinct party_type,party_id,party_name,party_tax_id from filtered_lines where request_id=h.id and party_id is not null
   )x),'[]'::jsonb) third_parties,
   coalesce((select jsonb_agg(jsonb_build_object('id',x.department_id,'name',x.name,'type',x.type) order by x.name) from(
    select distinct d.department_id,d.name,d.type from line_departments ld join filtered_lines fl on fl.request_id=ld.request_id and fl.line_id=ld.line_id join departments d on d.department_id=ld.department_id where ld.request_id=h.id
   )x),'[]'::jsonb) departments,
   coalesce((select jsonb_agg(jsonb_build_object('id',x.cost_center_id,'code',x.code,'name',x.name) order by x.code,x.name) from(
    select distinct cc.cost_center_id,cc.code,cc.name from line_cost_centers lc join filtered_lines fl on fl.request_id=lc.request_id and fl.line_id=lc.line_id join cost_centers cc on cc.cost_center_id=lc.cost_center_id where lc.request_id=h.id
   )x),'[]'::jsonb) cost_centers,
   coalesce((select jsonb_agg(jsonb_build_object('id',x.account_id,'number',x.account_number,'name',x.account_name,'category',x.category) order by x.account_number) from(
    select distinct a.account_id,a.account_number,a.account_name,a.category from line_accounts la join filtered_lines fl on fl.request_id=la.request_id and fl.line_id=la.line_id join chart_accounts a on a.account_id=la.account_id where la.request_id=h.id
   )x),'[]'::jsonb) accounts,
   coalesce((select jsonb_agg(jsonb_build_object('invoiceId',x.invoice_id,'number',x.invoice_number,'date',x.invoice_date,'dueDate',x.due_date,'requestedAmount',x.requested_amount) order by x.invoice_date,x.invoice_number) from(
    select lb.invoice_id,lb.invoice_number,lb.invoice_date,lb.invoice_due_date due_date,sum(lb.line_amount) requested_amount from filtered_lines lb where lb.request_id=h.id and lb.invoice_id is not null group by 1,2,3,4
   )x),'[]'::jsonb) source_documents,
   coalesce((select jsonb_agg(jsonb_build_object('id',r.id,'type',r.tipo,'name',r.nombre_visible,'url',r.enlace,'fileName',r.nombre_archivo,'mimeType',r.tipo_mime,'fileSize',r.tamano_archivo,'createdAt',r.created_at) order by r.id) from solicitudes_pago_respaldos r where r.id_solicitud=h.id),'[]'::jsonb) supports,
   (select count(*) from solicitudes_pago_respaldos r where r.id_solicitud=h.id) support_count
  from headers h join matched m on m.request_id=h.id
 ),
 page_rows as(
  select * from report_rows order by selected_date desc,id desc offset(page_number-1)*page_size limit page_size
 ),
 totals_currency as(
  select id_moneda,currency_code,symbol,count(*) request_count,sum(total) request_amount,sum(analyzed_amount) analyzed_amount
  from report_rows group by id_moneda,currency_code,symbol
 ),
 totals_type as(
  select tipo_solicitud,currency_code,symbol,count(*) request_count,sum(total) amount
  from report_rows group by tipo_solicitud,currency_code,symbol
 ),
 totals_status as(
  select estado,currency_code,symbol,count(*) request_count,sum(total) amount
  from report_rows group by estado,currency_code,symbol
 )
 select jsonb_build_object(
  'header',jsonb_build_object(
   'subsidiaryId',s.subsidiary_id,'subsidiaryName',s.name,'legalName',s.legal_name,'taxId',s.tax_id,'logoUrl',s.logo_url,
   'baseCurrencyCode',bc.currency_code,'baseCurrencySymbol',bc.symbol,
   'dateFrom',date_from,'dateTo',date_to,'dateField',date_field,'generatedAt',clock_timestamp(),
   'groupBy',coalesce(nullif(upper(p_filters->>'groupBy'),''),'TYPE')
  ),
  'summary',jsonb_build_object(
   'requestCount',(select count(*) from report_rows),
   'lineCount',coalesce((select sum(matched_line_count) from report_rows),0),
   'supportCount',coalesce((select sum(support_count) from report_rows),0),
   'cxpCount',(select count(*) from report_rows where tipo_solicitud='CXP'),
   'otherCount',(select count(*) from report_rows where tipo_solicitud='OTROS'),
   'draftCount',(select count(*) from report_rows where estado='BORRADOR'),
   'pendingApprovalCount',(select count(*) from report_rows where estado='PENDIENTE_APROBACION'),
   'approvedCount',(select count(*) from report_rows where estado='APROBADO'),
   'appliedCount',(select count(*) from report_rows where estado='APLICADO'),
   'rejectedCount',(select count(*) from report_rows where estado='RECHAZADO'),
   'cancelledCount',(select count(*) from report_rows where estado='ANULADO'),
   'totalsByCurrency',coalesce((select jsonb_agg(jsonb_build_object('currencyId',id_moneda,'currency',currency_code,'currencyCode',currency_code,'symbol',symbol,'requestCount',request_count,'amount',request_amount,'requestAmount',request_amount,'analyzedAmount',analyzed_amount) order by currency_code) from totals_currency),'[]'::jsonb),
   'byCurrency',coalesce((select jsonb_agg(jsonb_build_object('currencyId',id_moneda,'currency',currency_code,'currencyCode',currency_code,'symbol',symbol,'requestCount',request_count,'amount',request_amount,'requestAmount',request_amount,'analyzedAmount',analyzed_amount) order by currency_code) from totals_currency),'[]'::jsonb),
   'byType',coalesce((select jsonb_agg(jsonb_build_object('type',tt.tipo_solicitud,'label',case tt.tipo_solicitud when 'CXP' then 'Pago de CxP' else 'Otros pagos' end,'count',(select sum(request_count) from totals_type x where x.tipo_solicitud=tt.tipo_solicitud),'totalsByCurrency',(select jsonb_agg(jsonb_build_object('currency',x.currency_code,'symbol',x.symbol,'count',x.request_count,'amount',x.amount) order by x.currency_code) from totals_type x where x.tipo_solicitud=tt.tipo_solicitud)) order by tt.tipo_solicitud) from(select distinct tipo_solicitud from totals_type)tt),'[]'::jsonb),
   'byStatus',coalesce((select jsonb_agg(jsonb_build_object('status',st.estado,'label',case st.estado when 'BORRADOR' then 'Borrador' when 'PENDIENTE_APROBACION' then 'Pendiente de aprobación' when 'APROBADO' then 'Aprobado · pendiente de pago' when 'APLICADO' then 'Pagado / aplicado' when 'RECHAZADO' then 'Rechazado' else 'Anulado' end,'count',(select sum(request_count) from totals_status x where x.estado=st.estado),'totalsByCurrency',(select jsonb_agg(jsonb_build_object('currency',x.currency_code,'symbol',x.symbol,'count',x.request_count,'amount',x.amount) order by x.currency_code) from totals_status x where x.estado=st.estado)) order by st.estado) from(select distinct estado from totals_status)st),'[]'::jsonb)
  ),
  'rows',coalesce((select jsonb_agg(jsonb_build_object(
   'id',r.id,'requestId',r.id,'number',r.numero,'type',r.tipo_solicitud,
   'typeLabel',case r.tipo_solicitud when 'CXP' then 'Pago de CxP' else 'Otros pagos' end,
   'status',r.estado,'statusLabel',case r.estado when 'BORRADOR' then 'Borrador' when 'PENDIENTE_APROBACION' then 'Pendiente de aprobación' when 'APROBADO' then 'Aprobado · pendiente de pago' when 'APLICADO' then 'Pagado / aplicado' when 'RECHAZADO' then 'Rechazado' else 'Anulado' end,
   'requestDate',r.fecha_solicitud,'plannedDate',r.fecha_pago_programada,'appliedDate',r.aplicado_at::date,
   'selectedDate',r.selected_date,'concept',r.concepto,'total',r.total,'analyzedAmount',r.analyzed_amount,
   'currencyId',r.id_moneda,'currencyCode',r.currency_code,'currency',jsonb_build_object('id',r.id_moneda,'code',r.currency_code,'symbol',r.symbol),'symbol',r.symbol,
   'requesterName',r.requester_name,'requester',jsonb_build_object('id',r.id_solicitante,'name',r.requester_name,'email',r.requester_email),
   'approver',case when r.effective_approver_id is null then null else jsonb_build_object('id',r.effective_approver_id,'name',r.effective_approver_name,'approvedAt',r.effective_approved_at) end,
   'approverName',r.effective_approver_name,'applierName',r.applier_name,
   'supplier',case when r.id_proveedor is null then null else jsonb_build_object('id',r.id_proveedor,'name',r.supplier_name,'taxId',r.supplier_tax_id) end,
   'thirdParties',r.third_parties,'departments',r.departments,'costCenters',r.cost_centers,'accounts',r.accounts,'sourceDocuments',r.source_documents,
   'method',r.metodo_pago,'reference',r.referencia_bancaria,'paymentId',r.payment_id,'checkId',r.check_id,'journalId',r.journal_id,
   'payment',jsonb_build_object('method',r.metodo_pago,'reference',r.referencia_bancaria,'appliedAt',r.aplicado_at,'appliedBy',r.applier_name,'journalId',r.journal_id,'paymentId',r.payment_id,'checkId',r.check_id),
   'approval',jsonb_build_object('approvedAt',r.effective_approved_at,'approvedBy',r.effective_approver_name,'workflowStatus',r.workflow_status,'currentLevel',r.current_level),
   'supports',r.supports,'supportCount',r.support_count,'lines',r.lines
  ) order by r.selected_date desc,r.id desc) from page_rows r),'[]'::jsonb),
  'total',(select count(*) from report_rows),'page',page_number,'pageSize',page_size
 ) into result
 from subsidiaries s join currencies bc on bc.currency_id=s.currency_id where s.subsidiary_id=sid;
 return result;
end
$$;

revoke all on function public.payment_request_report_options(),public.run_payment_request_report(jsonb) from public,anon;
grant execute on function public.payment_request_report_options(),public.run_payment_request_report(jsonb) to authenticated;
notify pgrst,'reload schema';
