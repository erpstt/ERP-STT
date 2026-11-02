-- Show current beneficiary bank instructions without selecting a destination,
-- changing a payment request, or altering the established posting amounts.
set local lock_timeout = '5s';
set local statement_timeout = '60s';

alter table public.solicitudes_pago_lineas
  add column id_otro_nombre bigint references public.other_names(other_name_id);
alter table public.bank_check_line
  add column other_name_id bigint references public.other_names(other_name_id);
alter table public.journal_line
  add column other_name_id bigint references public.other_names(other_name_id);

alter table public.solicitudes_pago_lineas
  drop constraint solicitudes_pago_lineas_tipo_tercero_check,
  drop constraint solicitudes_pago_lineas_single_party_check;
alter table public.solicitudes_pago_lineas
  add constraint solicitudes_pago_lineas_tipo_tercero_check check (
    tipo_tercero in ('Cliente','Proveedor','Empleado','Agencia Tributaria','Otro Nombre')),
  add constraint solicitudes_pago_lineas_single_party_check check (
    num_nonnulls(id_cliente,id_proveedor,id_empleado,id_agencia_tributaria,id_otro_nombre) <= 1),
  add constraint solicitudes_pago_lineas_other_name_type_check check (
    (id_otro_nombre is null and tipo_tercero is distinct from 'Otro Nombre')
    or (id_otro_nombre is not null and tipo_tercero is not distinct from 'Otro Nombre'));
alter table public.journal_line
  drop constraint journal_line_entity_type_allowed;
alter table public.journal_line
  add constraint journal_line_entity_type_allowed check (
    entity_type is null or entity_type in ('Cliente','Proveedor','Empleado','Agencia Tributaria','Otro Nombre')),
  add constraint journal_line_other_name_party_check check (
    (other_name_id is null and entity_type is distinct from 'Otro Nombre')
    or (other_name_id is not null and entity_type is not distinct from 'Otro Nombre'
      and num_nonnulls(customer_id,supplier_id,employee_id,tax_agency_id,other_name_id) = 1));
alter table public.bank_check_line
  add constraint bank_check_line_other_name_party_check check (
    (other_name_id is null and entity_type is distinct from 'Otro Nombre')
    or (other_name_id is not null and entity_type is not distinct from 'Otro Nombre'
      and num_nonnulls(customer_id,supplier_id,employee_id,tax_agency_id,other_name_id) = 1));

create index solicitudes_pago_lineas_other_name_idx
  on public.solicitudes_pago_lineas(id_otro_nombre,id_solicitud) where id_otro_nombre is not null;
create index bank_check_line_other_name_idx
  on public.bank_check_line(other_name_id,check_id) where other_name_id is not null;
create index journal_line_other_name_idx
  on public.journal_line(other_name_id,journal_id) where other_name_id is not null;

-- Pure projection, called only by the already-authorized payment-request RPCs.
create function payment_request_private.beneficiary_bank_dto(kind text, entity_id bigint, entity_name text, active boolean, data jsonb)
returns jsonb language sql stable security invoker
set search_path = pg_catalog, public, pg_temp
as $$
  select jsonb_build_object(
    'entityType',kind,'entityId',entity_id,'name',entity_name,
    'beneficiaryName',nullif(btrim(data->>'payment_beneficiary_name'),''),
    'isActive',active,
    'accounts',coalesce((
      select jsonb_agg(jsonb_build_object(
        'slot',account.slot,'bankId',account.bank_id,'bankName',bank.bank_name,
        'iban',account.iban,'accountNumber',account.account_number,
        'currencyId',account.currency_id,'currencyCode',currency.currency_code
      ) order by account.position)
      from (values
        (1,'primary',nullif(data->>'payment_bank_id','')::bigint,
          nullif(data->>'payment_iban',''),nullif(data->>'payment_account_number',''),
          nullif(data->>'payment_currency_id','')::bigint),
        (2,'secondary',nullif(data->>'secondary_payment_bank_id','')::bigint,
          nullif(data->>'secondary_payment_iban',''),nullif(data->>'secondary_payment_account_number',''),
          nullif(data->>'secondary_payment_currency_id','')::bigint)
      ) account(position,slot,bank_id,iban,account_number,currency_id)
      left join public.banks bank on bank.bank_id=account.bank_id
      left join public.currencies currency on currency.currency_id=account.currency_id
      where account.bank_id is not null or account.iban is not null
        or account.account_number is not null or account.currency_id is not null
    ),'[]'::jsonb))
$$;

-- No arbitrary bank lookup is exposed. Detail is restricted to parties actually
-- referenced by a request in the active subsidiary; inactive historical parties
-- remain readable only while their current subsidiary assignment still matches.
create function payment_request_private.beneficiary_bank_accounts(request_id bigint default null)
returns jsonb language plpgsql stable security invoker
set search_path = pg_catalog, public, pg_temp
as $$
declare sid bigint:=asset_posting_private.identity(); header_row public.solicitudes_pago; result jsonb;
begin
  if request_id is not null then header_row:=payment_request_private.header(request_id); end if;
  select coalesce(jsonb_agg(party.dto order by party.kind,party.name,party.id),'[]'::jsonb)
  into result
  from (
    select 'Proveedor' kind,supplier.company_name name,supplier.supplier_id id,
      payment_request_private.beneficiary_bank_dto('Proveedor',supplier.supplier_id,
        supplier.company_name,not coalesce((to_jsonb(supplier)->>'is_inactive')::boolean,false),to_jsonb(supplier)) dto
    from public.suppliers supplier
    where (supplier.primary_subsidiary_id=sid or exists(
      select 1 from public.entity_subsidiaries scope
      where scope.supplier_id=supplier.supplier_id and scope.subsidiary_id=sid))
      and ((request_id is null and not coalesce((to_jsonb(supplier)->>'is_inactive')::boolean,false))
        or (request_id is not null and (
          (header_row.tipo_solicitud='CXP' and header_row.id_proveedor=supplier.supplier_id)
          or exists(select 1 from public.solicitudes_pago_lineas line
            where line.id_solicitud=request_id and line.tipo_tercero='Proveedor'
              and line.id_proveedor=supplier.supplier_id))))
    union all
    select 'Empleado',concat_ws(' ',employee.first_name,employee.last_name),employee.employee_id,
      payment_request_private.beneficiary_bank_dto('Empleado',employee.employee_id,
        concat_ws(' ',employee.first_name,employee.last_name),employee.is_active,to_jsonb(employee))
    from public.employees employee
    where employee.subsidiary_id=sid
      and ((request_id is null and employee.is_active)
        or (request_id is not null and exists(select 1 from public.solicitudes_pago_lineas line
          where line.id_solicitud=request_id and line.tipo_tercero='Empleado'
            and line.id_empleado=employee.employee_id)))
    union all
    select 'Otro Nombre',other_name.name,other_name.other_name_id,
      payment_request_private.beneficiary_bank_dto('Otro Nombre',other_name.other_name_id,
        other_name.name,other_name.is_active,to_jsonb(other_name))
    from public.other_names other_name
    where other_name.subsidiary_id=sid
      and ((request_id is null and other_name.is_active)
        or (request_id is not null and exists(select 1 from public.solicitudes_pago_lineas line
          where line.id_solicitud=request_id and line.tipo_tercero='Otro Nombre'
            and line.id_otro_nombre=other_name.other_name_id)))
  ) party;
  return result;
end $$;

revoke all on function payment_request_private.beneficiary_bank_dto(text,bigint,text,boolean,jsonb)
  from public,anon,authenticated,service_role;
revoke all on function payment_request_private.beneficiary_bank_accounts(bigint)
  from public,anon,authenticated,service_role;

-- Temporary guarded patcher retains each existing function's identity, ACL,
-- security mode, guards and posting behavior. A changed upstream body aborts.
create function payment_request_private.patch_beneficiary_definition(target regprocedure, needle text, replacement text, expected integer default 1)
returns void language plpgsql security invoker set search_path = pg_catalog, public, pg_temp
as $$
declare definition text:=replace(pg_get_functiondef(target),E'\r\n',E'\n'); occurrences integer;
begin
  if needle is null or needle='' then raise exception 'Empty beneficiary patch'; end if;
  occurrences:=(length(definition)-length(replace(definition,needle,'')))/length(needle);
  if occurrences<>expected then raise exception 'Unexpected beneficiary patch target %: expected %, found %',target,expected,occurrences; end if;
  execute replace(definition,needle,replacement);
end $$;
revoke all on function payment_request_private.patch_beneficiary_definition(regprocedure,text,text,integer)
  from public,anon,authenticated,service_role;

select payment_request_private.patch_beneficiary_definition(
  'payment_request_private.pr_options()',
  $old$  return result;$old$,
  $new$  return result||jsonb_build_object(
    'otherNames',coalesce((select jsonb_agg(jsonb_build_object(
      'id',other_name_id,'name',name) order by name,other_name_id)
      from public.other_names where subsidiary_id=sid and is_active),'[]'::jsonb),
    'beneficiaryBankAccounts',payment_request_private.beneficiary_bank_accounts());$new$);

select payment_request_private.patch_beneficiary_definition(
  'public.pr_detail(jsonb)',
  $old$return payment_request_private.pr_detail(p)||jsonb_build_object($old$,
  $new$return payment_request_private.pr_detail(p)||jsonb_build_object('beneficiaryBankAccounts',payment_request_private.beneficiary_bank_accounts(h.id))||jsonb_build_object($new$);

select payment_request_private.patch_beneficiary_definition(
  'payment_request_private.prepare(jsonb)',
  $old$line->>'entityType' not in('Cliente','Proveedor','Empleado','Agencia Tributaria')$old$,
  $new$line->>'entityType' not in('Cliente','Proveedor','Empleado','Agencia Tributaria','Otro Nombre')$new$);
select payment_request_private.patch_beneficiary_definition(
  'payment_request_private.validate_extra(bigint)',
  $old$l.tipo_tercero not in('Cliente','Proveedor','Empleado','Agencia Tributaria')$old$,
  $new$l.tipo_tercero not in('Cliente','Proveedor','Empleado','Agencia Tributaria','Otro Nombre')$new$);
-- The deployed supplier/customer masters have no is_inactive column. Keep the
-- existing inactive-party guards compatible with that schema and installations
-- where the optional flag does exist.
select payment_request_private.patch_beneficiary_definition(
  'payment_request_private.validate_extra(bigint)',
  $old$exists(select 1 from public.suppliers where supplier_id=l.id_proveedor and is_inactive)$old$,
  $new$exists(select 1 from public.suppliers supplier where supplier.supplier_id=l.id_proveedor and coalesce((to_jsonb(supplier)->>'is_inactive')::boolean,false))$new$);
select payment_request_private.patch_beneficiary_definition(
  'payment_request_private.validate_extra(bigint)',
  $old$exists(select 1 from public.suppliers where supplier_id=h.id_proveedor and is_inactive)$old$,
  $new$exists(select 1 from public.suppliers supplier where supplier.supplier_id=h.id_proveedor and coalesce((to_jsonb(supplier)->>'is_inactive')::boolean,false))$new$);
select payment_request_private.patch_beneficiary_definition(
  'payment_request_private.validate_extra(bigint)',
  $old$exists(select 1 from public.customers where customer_id=l.id_cliente and is_inactive)$old$,
  $new$exists(select 1 from public.customers customer where customer.customer_id=l.id_cliente and coalesce((to_jsonb(customer)->>'is_inactive')::boolean,false))$new$);
-- CXP execution enters the existing supplier payment preparation routine.
-- Apply the same optional-column guard without relaxing its scope or permissions.
select payment_request_private.patch_beneficiary_definition(
  'supplier_payment_private.prepare(jsonb,bigint,bigint)',
  $old$and not s.is_inactive$old$,
  $new$and not coalesce((to_jsonb(s)->>'is_inactive')::boolean,false)$new$);

select payment_request_private.patch_beneficiary_definition(
  'payment_request_private.pr_validate(bigint)',
  $old$        or(line_row.tipo_tercero='Empleado'and line_row.id_empleado is null)$old$,
  $new$        or(line_row.tipo_tercero='Empleado'and line_row.id_empleado is null)
        or(line_row.tipo_tercero='Otro Nombre'and line_row.id_otro_nombre is null)$new$);
select payment_request_private.patch_beneficiary_definition(
  'payment_request_private.pr_validate(bigint)',
  $old$      if line_row.id_agencia_tributaria is not null and not exists($old$,
  $new$      if line_row.id_otro_nombre is not null and not exists(
        select 1 from public.other_names other_name
        where other_name.other_name_id=line_row.id_otro_nombre
          and other_name.subsidiary_id=header_row.id_subsidiaria and other_name.is_active
      )then
        raise exception using errcode='42501',message='Otro Nombre fuera de la subsidiaria o inactivo.';
      end if;
      if line_row.id_agencia_tributaria is not null and not exists($new$);

select payment_request_private.patch_beneficiary_definition(
  'payment_request_private.pr_save_without_budget(jsonb)',
  $old$      id_cliente,id_proveedor,id_empleado,id_agencia_tributaria,$old$,
  $new$      id_cliente,id_proveedor,id_empleado,id_agencia_tributaria,id_otro_nombre,$new$);
select payment_request_private.patch_beneficiary_definition(
  'payment_request_private.pr_save_without_budget(jsonb)',
  $old$      case when request_type='OTROS'
        then nullif(line->>'departmentId','')::bigint end,$old$,
  $new$      case when request_type='OTROS'and line->>'entityType'='Otro Nombre'
        then(line->>'entityId')::bigint end,
      case when request_type='OTROS'
        then nullif(line->>'departmentId','')::bigint end,$new$);

select payment_request_private.patch_beneficiary_definition(
  'payment_request_private.pr_detail(jsonb)',
  $old$            agency.agency_name
          ),$old$,
  $new$            agency.agency_name,other_name.name
          ),$new$);
select payment_request_private.patch_beneficiary_definition(
  'payment_request_private.pr_detail(jsonb)',
  $old$      left join public.tax_agencies agency
        on agency.tax_agency_id=line.id_agencia_tributaria$old$,
  $new$      left join public.tax_agencies agency
        on agency.tax_agency_id=line.id_agencia_tributaria
      left join public.other_names other_name
        on other_name.other_name_id=line.id_otro_nombre$new$);

-- Keep the existing atomic payment engine; only carry the new party identity.
select payment_request_private.patch_beneficiary_definition(
  'payment_request_private.pr_execute_without_budget(jsonb)',
  $old$        id_cliente,id_proveedor,id_empleado,id_agencia_tributaria$old$,
  $new$        id_cliente,id_proveedor,id_empleado,id_agencia_tributaria,id_otro_nombre$new$);
select payment_request_private.patch_beneficiary_definition(
  'payment_request_private.pr_execute_without_budget(jsonb)',
  $old$          line.id_agencia_tributaria$old$,
  $new$          line.id_agencia_tributaria,line.id_otro_nombre$new$);
select payment_request_private.patch_beneficiary_definition(
  'payment_request_private.pr_execute_without_budget(jsonb)',
  $old$        agency.agency_name
      ))$old$,
  $new$        agency.agency_name,other_name.name
      ))$new$);
select payment_request_private.patch_beneficiary_definition(
  'payment_request_private.pr_execute_without_budget(jsonb)',
  $old$    left join public.tax_agencies agency
      on agency.tax_agency_id=line.id_agencia_tributaria$old$,
  $new$    left join public.tax_agencies agency
      on agency.tax_agency_id=line.id_agencia_tributaria
    left join public.other_names other_name
      on other_name.other_name_id=line.id_otro_nombre$new$);

select payment_request_private.patch_beneficiary_definition(
  'bank_check_private.save_bank_check_transfer(jsonb,bigint)',
  $old$  result:=bank_check_private.save_bank_check_transfer_without_tax_agency($old$,
  $new$  -- Payment requests have their own authorization; this private writer
  -- still validates the new beneficiary against the active subsidiary.
  if exists(
    select 1 from jsonb_array_elements(coalesce(p_payload->'lines','[]'::jsonb)) item
    where item->>'entity_type'='Otro Nombre' and not exists(
      select 1 from public.other_names other_name
      where other_name.other_name_id=nullif(item->>'entity_id','')::bigint
        and other_name.subsidiary_id=sid and other_name.is_active
    )
  )then
    raise exception using errcode='42501',message='Otro Nombre fuera de la subsidiaria o inactivo.';
  end if;
  result:=bank_check_private.save_bank_check_transfer_without_tax_agency($new$);

select payment_request_private.patch_beneficiary_definition(
  'bank_check_private.save_bank_check_transfer_without_tax_agency(jsonb,bigint)',
  $old$entity_type,customer_id,supplier_id,employee_id,department_id$old$,
  $new$entity_type,customer_id,supplier_id,employee_id,other_name_id,department_id$new$);
select payment_request_private.patch_beneficiary_definition(
  'bank_check_private.save_bank_check_transfer_without_tax_agency(jsonb,bigint)',
  $old$case when entity_kind='Empleado' then entity_key end,nullif(line->>'department_id','')::bigint$old$,
  $new$case when entity_kind='Empleado' then entity_key end,case when entity_kind='Otro Nombre' then entity_key end,nullif(line->>'department_id','')::bigint$new$);
select payment_request_private.patch_beneficiary_definition(
  'bank_check_private.save_bank_check_transfer_without_tax_agency(jsonb,bigint)',
  $old$entity_type,customer_id,supplier_id,employee_id,cost_center_id$old$,
  $new$entity_type,customer_id,supplier_id,employee_id,other_name_id,cost_center_id$new$);
select payment_request_private.patch_beneficiary_definition(
  'bank_check_private.save_bank_check_transfer_without_tax_agency(jsonb,bigint)',
  $old$case when entity_kind='Empleado' then entity_key end,nullif(line->>'cost_center_id','')::bigint$old$,
  $new$case when entity_kind='Empleado' then entity_key end,case when entity_kind='Otro Nombre' then entity_key end,nullif(line->>'cost_center_id','')::bigint$new$);

-- Reports and approval notifications resolve the party's name and identity.
-- They do not receive bank instructions.
select payment_request_private.patch_beneficiary_definition(
  'payment_request_private.payment_request_report_options()',
  $old$    from employees e where e.subsidiary_id=sid$old$,
  $new$    from employees e where e.subsidiary_id=sid
    union all
    select distinct 'Otro Nombre',other_name.other_name_id,other_name.name,other_name.identification
    from public.other_names other_name where other_name.subsidiary_id=sid$new$);

select payment_request_private.patch_beneficiary_definition(
  'payment_request_private.run_payment_request_report(jsonb)',
  $old$filter_party_type not in('Proveedor','Cliente','Empleado','Agencia Tributaria')$old$,
  $new$filter_party_type not in('Proveedor','Cliente','Empleado','Agencia Tributaria','Otro Nombre')$new$);
select payment_request_private.patch_beneficiary_definition(
  'payment_request_private.run_payment_request_report(jsonb)',
  $old$        left join tax_agencies agency on agency.tax_agency_id=sl.id_agencia_tributaria$old$,
  $new$        left join tax_agencies agency on agency.tax_agency_id=sl.id_agencia_tributaria
        left join public.other_names other_name on other_name.other_name_id=sl.id_otro_nombre$new$);
select payment_request_private.patch_beneficiary_definition(
  'payment_request_private.run_payment_request_report(jsonb)',
  $old$pe.first_name,pe.last_name,agency.agency_name,agency.tax_id) ilike$old$,
  $new$pe.first_name,pe.last_name,agency.agency_name,agency.tax_id,other_name.name,other_name.identification) ilike$new$);
select payment_request_private.patch_beneficiary_definition(
  'payment_request_private.run_payment_request_report(jsonb)',
  $old$coalesce(l.id_cliente,l.id_proveedor,l.id_empleado,l.id_agencia_tributaria) end party_id$old$,
  $new$coalesce(l.id_cliente,l.id_proveedor,l.id_empleado,l.id_agencia_tributaria,l.id_otro_nombre) end party_id$new$);
select payment_request_private.patch_beneficiary_definition(
  'payment_request_private.run_payment_request_report(jsonb)',
  $old$agency.agency_name) end party_name$old$,
  $new$agency.agency_name,other_name.name) end party_name$new$);
select payment_request_private.patch_beneficiary_definition(
  'payment_request_private.run_payment_request_report(jsonb)',
  $old$coalesce(pc.tax_id,ps.tax_id,pe.identification,agency.tax_id) end party_tax_id$old$,
  $new$coalesce(pc.tax_id,ps.tax_id,pe.identification,agency.tax_id,other_name.identification) end party_tax_id$new$);
select payment_request_private.patch_beneficiary_definition(
  'payment_request_private.run_payment_request_report(jsonb)',
  $old$  left join tax_agencies agency on agency.tax_agency_id=l.id_agencia_tributaria$old$,
  $new$  left join tax_agencies agency on agency.tax_agency_id=l.id_agencia_tributaria
  left join public.other_names other_name on other_name.other_name_id=l.id_otro_nombre$new$);

select payment_request_private.patch_beneficiary_definition(
  'public.expense_approval_email_snapshot(bigint,bigint,bigint)',
  $old$agency.agency_name,'Sin tercero') party_name$old$,
  $new$agency.agency_name,other_name.name,'Sin tercero') party_name$new$);
select payment_request_private.patch_beneficiary_definition(
  'public.expense_approval_email_snapshot(bigint,bigint,bigint)',
  $old$      left join public.tax_agencies agency on agency.tax_agency_id=l.id_agencia_tributaria$old$,
  $new$      left join public.tax_agencies agency on agency.tax_agency_id=l.id_agencia_tributaria
      left join public.other_names other_name on other_name.other_name_id=l.id_otro_nombre$new$);

drop function payment_request_private.patch_beneficiary_definition(regprocedure,text,text,integer);

comment on column public.solicitudes_pago_lineas.id_otro_nombre is
  'Tercero de Otros Nombres para pagos directos; sin vínculo con facturas.';
comment on function payment_request_private.beneficiary_bank_accounts(bigint) is
  'Cuentas actuales de terceros autorizados o referenciados por una solicitud de la subsidiaria activa. Solo consulta.';
notify pgrst,'reload schema';
