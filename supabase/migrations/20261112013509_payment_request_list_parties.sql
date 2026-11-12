create or replace function payment_request_private.pr_report(p jsonb) returns jsonb
language sql stable security definer set search_path=pg_catalog,public,pg_temp as $$
 select coalesce(jsonb_agg(to_jsonb(q) order by q.id desc),'[]') from (
 select h.*,u.email solicitante,s.company_name proveedor,c.currency_code moneda,
 coalesce(parties.items,'[]'::jsonb) terceros
 from public.solicitudes_pago h join public.users u on u.user_id=h.id_solicitante
 left join public.suppliers s on s.supplier_id=h.id_proveedor
 join public.currencies c on c.currency_id=h.id_moneda
 left join lateral (
  select jsonb_agg(jsonb_build_object('entityType',kind,'entityId',entity_id,'name',name) order by name,kind,entity_id) items
  from (
   select 'Proveedor'::text kind,h.id_proveedor entity_id,coalesce(s.company_name,'Proveedor #'||h.id_proveedor) name where h.id_proveedor is not null
   union
   select l.tipo_tercero,
    case l.tipo_tercero when 'Cliente' then l.id_cliente when 'Proveedor' then l.id_proveedor when 'Empleado' then l.id_empleado when 'Agencia Tributaria' then l.id_agencia_tributaria when 'Otro Nombre' then l.id_otro_nombre end,
    coalesce(case l.tipo_tercero when 'Cliente' then customer.company_name when 'Proveedor' then vendor.company_name when 'Empleado' then nullif(trim(concat_ws(' ',employee.first_name,employee.last_name)),'') when 'Agencia Tributaria' then agency.agency_name when 'Otro Nombre' then other_name.name end,'Sin nombre')
   from public.solicitudes_pago_lineas l
   left join public.customers customer on customer.customer_id=l.id_cliente
   left join public.suppliers vendor on vendor.supplier_id=l.id_proveedor
   left join public.employees employee on employee.employee_id=l.id_empleado
   left join public.tax_agencies agency on agency.tax_agency_id=l.id_agencia_tributaria
   left join public.other_names other_name on other_name.other_name_id=l.id_otro_nombre
   where l.id_solicitud=h.id and l.tipo_tercero is not null
  ) names where entity_id is not null
 ) parties on true
 where h.id_subsidiaria=public.pr_access()
 and(case when p->>'dateField'='planned' then h.fecha_pago_programada else h.fecha_solicitud end) between coalesce(nullif(p->>'from','')::date,'1900-01-01') and coalesce(nullif(p->>'to','')::date,'2999-12-31')
 and(nullif(p->>'status','') is null or h.estado=p->>'status')
 and(nullif(p->>'type','') is null or h.tipo_solicitud=p->>'type')
 and(nullif(p->>'requesterId','') is null or h.id_solicitante=(p->>'requesterId')::bigint)
 and(nullif(p->>'supplierId','') is null or parties.items @> jsonb_build_array(jsonb_build_object('entityType','Proveedor','entityId',(p->>'supplierId')::bigint)))
 ) q
$$;
notify pgrst,'reload schema';
