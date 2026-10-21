-- Exportacion segura de los catalogos del modulo Entidades.
-- El alcance siempre se obtiene de la subsidiaria activa de la sesion.

create index if not exists entity_subsidiaries_subsidiary_idx
  on public.entity_subsidiaries(subsidiary_id);

create index if not exists employees_subsidiary_idx
  on public.employees(subsidiary_id);

create or replace function public.entity_catalog_export_data(
  p_catalog text,
  p_search text default ''
) returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  sid bigint := public.active_subsidiary_id();
  uid bigint := public.app_user_id();
  catalog_name text := lower(btrim(coalesce(p_catalog, '')));
  search_term text := btrim(coalesce(p_search, ''));
  normalized_search text := translate(lower(btrim(coalesce(p_search, ''))), 'áéíóúüñ', 'aeiouun');
  subsidiary_row public.subsidiaries%rowtype;
  result_rows jsonb := '[]'::jsonb;
begin
  if catalog_name not in ('customers', 'suppliers', 'employees', 'entity-subsidiaries') then
    raise exception 'El catalogo solicitado no admite exportacion.' using errcode = '22023';
  end if;

  if length(search_term) > 200 then
    raise exception 'La busqueda no puede superar 200 caracteres.' using errcode = '22023';
  end if;

  -- Defense in depth: direct PostgREST calls must honor the active role too.
  perform public.security_assert_role_access('entities:' || catalog_name, 'view');

  if sid is null or uid is null or not exists (
    select 1
      from public.user_subsidiaries access_link
     where access_link.user_id = uid
       and access_link.subsidiary_id = sid
  ) then
    raise exception 'No tiene una subsidiaria autorizada activa.' using errcode = '42501';
  end if;

  select subsidiary.*
    into subsidiary_row
    from public.subsidiaries subsidiary
   where subsidiary.subsidiary_id = sid
     and subsidiary.is_active
   limit 1;

  if subsidiary_row.subsidiary_id is null then
    raise exception 'La subsidiaria activa no esta disponible.' using errcode = '42501';
  end if;

  if catalog_name = 'customers' then
    select coalesce(jsonb_agg(source_row.payload order by source_row.sort_name, source_row.sort_code), '[]'::jsonb)
      into result_rows
      from (
        select
          lower(customer.company_name) as sort_name,
          customer.customer_number as sort_code,
          jsonb_build_object(
            'id', customer.customer_id,
            'subsidiary', subsidiary_row.name,
            'code', customer.customer_number,
            'name', customer.company_name,
            'entityType', customer.customer_type,
            'taxId', customer.tax_id,
            'country', coalesce(country.name, ''),
            'email', coalesce(customer.email, ''),
            'phone', coalesce(customer.phone, ''),
            'address', coalesce(customer.address, ''),
            'department', coalesce(department.name, ''),
            'salesRepresentative', coalesce(nullif(btrim(concat_ws(' ', sales_rep.first_name, sales_rep.last_name)), ''), ''),
            'paymentTerm', coalesce(payment_term.term_name, ''),
            'currencies', coalesce((
              select string_agg(currency.currency_code, ', ' order by customer_currency.is_primary desc, currency.currency_code)
                from public.customer_currencies customer_currency
                join public.currencies currency using (currency_id)
               where customer_currency.customer_id = customer.customer_id
            ), ''),
            'creditLimit', entity_link.credit_limit,
            'isPrimary', entity_link.is_primary,
            'isIntercompany', customer.is_intercompany,
            'appliesWithholding', customer.applies_withholding,
            'automaticStatement', customer.envio_estado_cuenta_auto,
            'comments', coalesce(customer.comments, '')
          ) as payload
        from public.entity_subsidiaries entity_link
        join public.customers customer using (customer_id)
        left join public.countries country on country.country_id = customer.country_id
        left join public.departments department
          on department.department_id = customer.department_id
         and (
           department.subsidiary_id = sid
           or exists (
             select 1
               from public.department_subsidiaries department_scope
              where department_scope.department_id = department.department_id
                and department_scope.subsidiary_id = sid
           )
         )
        left join public.employees sales_rep
          on sales_rep.employee_id = customer.sales_representative_id
         and sales_rep.subsidiary_id = sid
        left join public.payment_terms payment_term on payment_term.term_id = customer.payment_term_id
        where entity_link.subsidiary_id = sid
          and entity_link.customer_id is not null
          and (
            search_term = '' or position(normalized_search in translate(lower(concat_ws(' ',
              subsidiary_row.name,
              customer.customer_number, customer.company_name, customer.customer_type,
              customer.tax_id, country.name, customer.email, customer.phone,
              customer.address, customer.comments,
              department.name, sales_rep.first_name, sales_rep.last_name,
              payment_term.term_name, entity_link.credit_limit::text,
              case when entity_link.is_primary then 'si true principal' else 'no false' end,
              case when customer.is_intercompany then 'si true intercompany' else 'no false' end,
              case when customer.applies_withholding then 'si true retencion' else 'no false' end,
              case when customer.envio_estado_cuenta_auto then 'si true automatico' else 'no false' end
            )), 'áéíóúüñ', 'aeiouun')) > 0
            or exists (
              select 1
                from public.customer_currencies customer_currency
                join public.currencies currency using (currency_id)
               where customer_currency.customer_id = customer.customer_id
                 and position(normalized_search in translate(lower(currency.currency_code), 'áéíóúüñ', 'aeiouun')) > 0
            )
          )
      ) source_row;

  elsif catalog_name = 'suppliers' then
    select coalesce(jsonb_agg(source_row.payload order by source_row.sort_name, source_row.sort_code), '[]'::jsonb)
      into result_rows
      from (
        select
          lower(supplier.company_name) as sort_name,
          supplier.supplier_number as sort_code,
          jsonb_build_object(
            'id', supplier.supplier_id,
            'subsidiary', subsidiary_row.name,
            'code', supplier.supplier_number,
            'name', supplier.company_name,
            'entityType', supplier.supplier_type,
            'category', coalesce(supplier.supplier_category, ''),
            'taxId', supplier.tax_id,
            'email', coalesce(supplier.email, ''),
            'phone', coalesce(supplier.phone, ''),
            'address', coalesce(supplier.address, ''),
            'paymentTerm', coalesce(payment_term.term_name, ''),
            'currencies', coalesce((
              select string_agg(currency.currency_code, ', ' order by supplier_currency.is_primary desc, currency.currency_code)
                from public.supplier_currencies supplier_currency
                join public.currencies currency using (currency_id)
               where supplier_currency.supplier_id = supplier.supplier_id
            ), ''),
            'isPrimary', entity_link.is_primary,
            'isIntercompany', supplier.is_intercompany,
            'appliesWithholding', supplier.applies_withholding,
            'beneficiary', coalesce(supplier.payment_beneficiary_name, ''),
            'bank', coalesce(bank.bank_name, ''),
            'iban', coalesce(supplier.payment_iban, ''),
            'comments', coalesce(supplier.comments, '')
          ) as payload
        from public.entity_subsidiaries entity_link
        join public.suppliers supplier using (supplier_id)
        left join public.payment_terms payment_term on payment_term.term_id = supplier.payment_term_id
        left join public.banks bank on bank.bank_id = supplier.payment_bank_id
        where entity_link.subsidiary_id = sid
          and entity_link.supplier_id is not null
          and (
            search_term = '' or position(normalized_search in translate(lower(concat_ws(' ',
              subsidiary_row.name,
              supplier.supplier_number, supplier.company_name, supplier.supplier_type,
              supplier.supplier_category, supplier.tax_id, supplier.email, supplier.phone,
              supplier.address, supplier.comments,
              payment_term.term_name, supplier.payment_beneficiary_name, bank.bank_name,
              supplier.payment_iban,
              case when entity_link.is_primary then 'si true principal' else 'no false' end,
              case when supplier.is_intercompany then 'si true intercompany' else 'no false' end,
              case when supplier.applies_withholding then 'si true retencion' else 'no false' end
            )), 'áéíóúüñ', 'aeiouun')) > 0
            or exists (
              select 1
                from public.supplier_currencies supplier_currency
                join public.currencies currency using (currency_id)
               where supplier_currency.supplier_id = supplier.supplier_id
                 and position(normalized_search in translate(lower(currency.currency_code), 'áéíóúüñ', 'aeiouun')) > 0
            )
          )
      ) source_row;

  elsif catalog_name = 'employees' then
    select coalesce(jsonb_agg(source_row.payload order by source_row.sort_name, source_row.sort_code), '[]'::jsonb)
      into result_rows
      from (
        select
          lower(concat_ws(' ', employee.first_name, employee.last_name)) as sort_name,
          employee.employee_number as sort_code,
          jsonb_build_object(
            'id', employee.employee_id,
            'subsidiary', subsidiary_row.name,
            'code', employee.employee_number,
            'identification', coalesce(employee.identification, ''),
            'name', btrim(concat_ws(' ', employee.first_name, employee.last_name)),
            'jobTitle', coalesce(employee.job_title, ''),
            'email', coalesce(employee.email, ''),
            'phone', coalesce(employee.phone, ''),
            'department', coalesce(department.name, ''),
            'location', coalesce(location.name, ''),
            'linkedUser', case when linked_user.user_id is null then '' else concat_ws(' - ',
              nullif(btrim(concat_ws(' ', linked_user.first_name, linked_user.last_name)), ''),
              linked_user.email
            ) end,
            'isSalesRepresentative', employee.is_sales_representative,
            'isActive', employee.is_active
          ) as payload
        from public.employees employee
        left join public.departments department
          on department.department_id = employee.department_id
         and (
           department.subsidiary_id = sid
           or exists (
             select 1
               from public.department_subsidiaries department_scope
              where department_scope.department_id = department.department_id
                and department_scope.subsidiary_id = sid
           )
         )
        left join public.locations location
          on location.location_id = employee.location_id
         and (
           location.subsidiary_id = sid
           or exists (
             select 1
               from public.location_subsidiaries location_scope
              where location_scope.location_id = location.location_id
                and location_scope.subsidiary_id = sid
           )
         )
        left join public.users linked_user on linked_user.user_id = employee.user_id
        where employee.subsidiary_id = sid
          and (
            search_term = '' or position(normalized_search in translate(lower(concat_ws(' ',
              subsidiary_row.name,
              employee.employee_number, employee.identification, employee.first_name,
              employee.last_name, employee.job_title, employee.email, employee.phone,
              department.name, location.name, linked_user.first_name, linked_user.last_name,
              linked_user.email,
              case when employee.is_sales_representative then 'si true representante ventas' else 'no false' end,
              case when employee.is_active then 'si true activo' else 'no false inactivo' end
            )), 'áéíóúüñ', 'aeiouun')) > 0
          )
      ) source_row;

  else
    select coalesce(jsonb_agg(source_row.payload order by source_row.sort_type, source_row.sort_name, source_row.sort_code), '[]'::jsonb)
      into result_rows
      from (
        select
          case when entity_link.customer_id is not null then 'Cliente' else 'Proveedor' end as sort_type,
          lower(coalesce(customer.company_name, supplier.company_name, '')) as sort_name,
          coalesce(customer.customer_number, supplier.supplier_number, '') as sort_code,
          jsonb_build_object(
            'id', entity_link.id,
            'subsidiary', subsidiary_row.name,
            'entityKind', case when entity_link.customer_id is not null then 'Cliente' else 'Proveedor' end,
            'code', coalesce(customer.customer_number, supplier.supplier_number, ''),
            'name', coalesce(customer.company_name, supplier.company_name, ''),
            'taxId', coalesce(customer.tax_id, supplier.tax_id, ''),
            'email', coalesce(customer.email, supplier.email, ''),
            'phone', coalesce(customer.phone, supplier.phone, ''),
            'currencies', case
              when entity_link.customer_id is not null then coalesce((
                select string_agg(currency.currency_code, ', ' order by customer_currency.is_primary desc, currency.currency_code)
                  from public.customer_currencies customer_currency
                  join public.currencies currency using (currency_id)
                 where customer_currency.customer_id = entity_link.customer_id
              ), '')
              else coalesce((
                select string_agg(currency.currency_code, ', ' order by supplier_currency.is_primary desc, currency.currency_code)
                  from public.supplier_currencies supplier_currency
                  join public.currencies currency using (currency_id)
                 where supplier_currency.supplier_id = entity_link.supplier_id
              ), '')
            end,
            'isPrimary', entity_link.is_primary,
            'creditLimit', entity_link.credit_limit
          ) as payload
        from public.entity_subsidiaries entity_link
        left join public.customers customer on customer.customer_id = entity_link.customer_id
        left join public.suppliers supplier on supplier.supplier_id = entity_link.supplier_id
        where entity_link.subsidiary_id = sid
          and (
            search_term = '' or position(normalized_search in translate(lower(concat_ws(' ',
              subsidiary_row.name,
              case when entity_link.customer_id is not null then 'cliente' else 'proveedor' end,
              customer.customer_number, supplier.supplier_number,
              customer.company_name, supplier.company_name,
              customer.tax_id, supplier.tax_id,
              customer.email, supplier.email,
              customer.phone, supplier.phone,
              entity_link.credit_limit::text,
              case when entity_link.is_primary then 'si true principal' else 'no false' end
            )), 'áéíóúüñ', 'aeiouun')) > 0
            or exists (
              select 1
                from public.customer_currencies customer_currency
                join public.currencies currency using (currency_id)
               where customer_currency.customer_id = entity_link.customer_id
                 and position(normalized_search in translate(lower(currency.currency_code), 'áéíóúüñ', 'aeiouun')) > 0
            )
            or exists (
              select 1
                from public.supplier_currencies supplier_currency
                join public.currencies currency using (currency_id)
               where supplier_currency.supplier_id = entity_link.supplier_id
                 and position(normalized_search in translate(lower(currency.currency_code), 'áéíóúüñ', 'aeiouun')) > 0
            )
          )
      ) source_row;
  end if;

  return jsonb_build_object(
    'header', jsonb_build_object(
      'catalog', catalog_name,
      'subsidiaryId', subsidiary_row.subsidiary_id,
      'subsidiary', subsidiary_row.name,
      'legalName', subsidiary_row.legal_name,
      'taxId', subsidiary_row.tax_id,
      'search', search_term,
      'generatedAt', now()
    ),
    'rows', result_rows,
    'total', jsonb_array_length(result_rows)
  );
end;
$$;

revoke all on function public.entity_catalog_export_data(text, text) from public;
revoke all on function public.entity_catalog_export_data(text, text) from anon;
grant execute on function public.entity_catalog_export_data(text, text) to authenticated;

comment on function public.entity_catalog_export_data(text, text) is
  'Devuelve un catalogo exportable de Entidades limitado a la subsidiaria activa y autorizada.';

notify pgrst, 'reload schema';
