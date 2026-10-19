alter table public.invoice
  add column if not exists unificar_lineas_pdf_descripcion text not null
  default 'Bienes y servicios según detalle de la factura';

update public.invoice
set unificar_lineas_pdf_descripcion='Bienes y servicios según detalle de la factura'
where nullif(btrim(unificar_lineas_pdf_descripcion),'') is null;

alter table public.invoice
  drop constraint if exists invoice_unified_pdf_description_length;
alter table public.invoice
  add constraint invoice_unified_pdf_description_length check(
    char_length(btrim(unificar_lineas_pdf_descripcion)) between 1 and 500
  );

comment on column public.invoice.unificar_lineas_pdf_descripcion is
  'Descripción repetida en cada línea consolidada del PDF; no modifica las líneas comerciales.';

do $$
begin
  if to_regprocedure('public.save_sales_invoice_before_pdf_description(jsonb,bigint)') is null then
    alter function public.save_sales_invoice(jsonb,bigint)
      rename to save_sales_invoice_before_pdf_description;
  end if;
end
$$;

revoke all on function public.save_sales_invoice_before_pdf_description(jsonb,bigint)
  from public,anon,authenticated;

create or replace function public.save_sales_invoice(
  payload jsonb,
  target_invoice_id bigint default null
) returns jsonb
language plpgsql
security definer
set search_path=public,pg_temp
as $$
declare
  result jsonb;
  invoice_key bigint;
  description_value text;
begin
  if payload ? 'unificar_lineas_pdf_descripcion' then
    if jsonb_typeof(payload->'unificar_lineas_pdf_descripcion') <> 'string' then
      raise exception 'La descripción de las líneas del PDF debe ser texto.';
    end if;
    description_value:=btrim(payload->>'unificar_lineas_pdf_descripcion');
  elsif target_invoice_id is null then
    description_value:='Bienes y servicios según detalle de la factura';
  else
    select invoice.unificar_lineas_pdf_descripcion
      into description_value
    from public.invoice invoice
    where invoice.invoice_id=target_invoice_id
      and invoice.subsidiary_id=public.active_subsidiary_id();
  end if;

  if description_value is null or char_length(description_value) not between 1 and 500 then
    raise exception 'La descripción de las líneas del PDF debe contener entre 1 y 500 caracteres.';
  end if;

  result:=public.save_sales_invoice_before_pdf_description(payload,target_invoice_id);
  invoice_key:=nullif(result->>'invoiceId','')::bigint;
  if invoice_key is null then
    raise exception 'La factura guardada no devolvió un identificador válido.';
  end if;

  update public.invoice invoice
  set unificar_lineas_pdf_descripcion=description_value
  where invoice.invoice_id=invoice_key
    and invoice.subsidiary_id=public.active_subsidiary_id();
  if not found then
    raise exception 'La factura guardada no pertenece a la subsidiaria activa.';
  end if;

  return result||jsonb_build_object('unifiedLineDescription',description_value);
end
$$;

revoke all on function public.save_sales_invoice(jsonb,bigint) from public,anon;
grant execute on function public.save_sales_invoice(jsonb,bigint) to authenticated;

create or replace function public.set_sales_invoice_pdf_presentation(
  p_invoice_id bigint,
  p_unify boolean,
  p_description text
) returns jsonb
language plpgsql
security definer
set search_path=public,pg_temp
as $$
declare
  sid bigint:=public.active_subsidiary_id();
  invoice_number_value text;
  description_value text:=btrim(p_description);
begin
  if public.app_user_id() is null or sid is null or public.app_active_role_id() is null then
    raise exception using errcode='42501',
      message='Debe iniciar sesión, seleccionar una subsidiaria y un rol activo.';
  end if;
  if p_invoice_id is null or p_invoice_id<=0 then
    raise exception 'La factura de venta no es válida.';
  end if;
  if p_unify is null then
    raise exception 'Indique si las líneas deben unificarse en el PDF.';
  end if;
  if description_value is null or char_length(description_value) not between 1 and 500 then
    raise exception 'La descripción de las líneas del PDF debe contener entre 1 y 500 caracteres.';
  end if;
  if not exists(
    select 1
    from public.role_permissions role_permission
    join public.permissions permission using(permission_id)
    where role_permission.role_id=public.app_active_role_id()
      and permission.code='sales:invoice:update'
  ) then
    raise exception using errcode='42501',
      message='No tiene permiso para modificar la presentación PDF de la factura.';
  end if;

  update public.invoice invoice
  set unificar_lineas_pdf=p_unify,
      unificar_lineas_pdf_descripcion=description_value
  where invoice.invoice_id=p_invoice_id
    and invoice.subsidiary_id=sid
  returning invoice.invoice_number into invoice_number_value;
  if not found then
    raise exception 'La factura no existe en la subsidiaria activa.';
  end if;

  return jsonb_build_object(
    'invoiceId',p_invoice_id,
    'invoiceNumber',invoice_number_value,
    'unifyLinesPdf',p_unify,
    'unifiedLineDescription',description_value
  );
end
$$;

revoke all on function public.set_sales_invoice_pdf_presentation(bigint,boolean,text)
  from public,anon;
grant execute on function public.set_sales_invoice_pdf_presentation(bigint,boolean,text)
  to authenticated;

create or replace function public.sales_invoice_delivery_snapshot(p_invoice_id bigint)
returns jsonb
language plpgsql
stable
security definer
set search_path=public,pg_temp
as $$
declare
  sid bigint:=public.active_subsidiary_id();
  result jsonb;
begin
  if public.app_user_id() is null or sid is null then
    raise exception 'Debe iniciar sesión y seleccionar una subsidiaria.';
  end if;

  select jsonb_build_object(
    'id',i.invoice_id,
    'number',i.invoice_number,
    'issueDate',i.invoice_date,
    'dueDate',i.due_date,
    'memo',coalesce(i.memo,''),
    'total',i.total_amount,
    'receivable',coalesce(nullif(i.receivable_amount,0),i.total_amount),
    'unifyLinesPdf',coalesce(i.unificar_lineas_pdf,false),
    'unifiedLineDescription',i.unificar_lineas_pdf_descripcion,
    'company',jsonb_build_object(
      'name',s.name,'address',coalesce(s.address,''),'logo',s.logo_url
    ),
    'customer',jsonb_build_object(
      'name',c.company_name,'email',coalesce(c.email,''),
      'address',coalesce(c.address,''),'taxId',coalesce(c.tax_id,'')
    ),
    'currency',jsonb_build_object(
      'code',cu.currency_code,'name',cu.name,
      'symbol',coalesce(cu.symbol,cu.currency_code)
    ),
    'paymentTerm',coalesce(pt.term_name,''),
    'lines',coalesce((
      select jsonb_agg(jsonb_build_object(
        'product',coalesce(p.display_name,'Producto'),
        'description',coalesce(l.note,''),
        'serviceCountry',coalesce(country.name,'—'),
        'quantity',l.quantity,'unitPrice',l.unit_price,'amount',l.amount,
        'taxCodeId',l.tax_code_id,
        'taxCode',coalesce(tax.code_name,'Sin impuesto'),
        'taxRate',l.tax_rate,'taxAmount',l.tax_amount,
        'grossAmount',l.gross_amount
      ) order by l.line_id)
      from public.sales_invoice_line l
      left join public.products p using(product_id)
      left join public.countries country on country.country_id=l.service_country_id
      left join public.tax_codes tax on tax.tax_code_id=l.tax_code_id
      where l.invoice_id=i.invoice_id
    ),'[]'::jsonb),
    'withholdingTotal',coalesce((
      select sum(w.withholding_amount)
      from public.sales_invoice_withholding w
      where w.invoice_id=i.invoice_id
    ),0),
    'supports',coalesce((
      select jsonb_agg(jsonb_build_object(
        'type',case when js.support_type='Archivo' then 'Archivo' else 'Enlace' end,
        'name',coalesce(js.display_name,js.file_name,'Respaldo'),
        'url',js.support_url,'fileName',js.file_name,
        'mimeType',js.mime_type,'fileSize',js.file_size,'fileData',js.file_data
      ) order by js.support_id)
      from public.journal_support js
      where js.journal_id=i.journal_id
    ),'[]'::jsonb)
  ) into result
  from public.invoice i
  join public.subsidiaries s on s.subsidiary_id=i.subsidiary_id
  join public.customers c on c.customer_id=i.customer_id
  join public.currencies cu on cu.currency_id=i.currency_id
  left join public.payment_terms pt on pt.term_id=i.payment_term_id
  where i.invoice_id=p_invoice_id and i.subsidiary_id=sid;

  if result is null then
    raise exception 'La factura no existe en la subsidiaria activa.';
  end if;
  return result;
end
$$;

revoke all on function public.sales_invoice_delivery_snapshot(bigint) from public,anon;
grant execute on function public.sales_invoice_delivery_snapshot(bigint) to authenticated;

notify pgrst,'reload schema';
