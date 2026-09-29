-- Plantilla editable, por subsidiaria, para el envío manual de facturas de venta.
alter table public.configuraciones_correos
  drop constraint if exists configuraciones_correos_tipo_notificacion_check;

alter table public.configuraciones_correos
  add constraint configuraciones_correos_tipo_notificacion_check
  check(tipo_notificacion in ('PAGO_PROVEEDOR','ESTADO_CUENTA','FACTURA_VENTA'));

insert into public.configuraciones_correos(
  id_subsidiaria,tipo_notificacion,asunto_template,cuerpo_template,activo,updated_by_email
)
select subsidiary_id,'FACTURA_VENTA','Factura {{numero_factura}} · {{empresa_nombre}}',
  '<p>Estimado/a <strong>{{cliente_nombre}}</strong>,</p><p>Adjunto encontrará la factura <strong>{{numero_factura}}</strong>, emitida por {{empresa_nombre}} el {{fecha_factura}}, por un total de {{total_factura}} {{moneda}}.</p><p>Agradecemos su preferencia. Para cualquier consulta, puede responder directamente a este correo.</p>',
  true,'sistema'
from public.subsidiaries
on conflict(id_subsidiaria,tipo_notificacion) do nothing;

create or replace function public.sales_invoice_email_settings(
  p_action text,
  p_payload jsonb default '{}'
) returns jsonb
language plpgsql
security definer
set search_path=public,pg_temp
as $$
declare
  sid bigint:=active_subsidiary_id();
  cfg configuraciones_correos%rowtype;
begin
  if app_user_id() is null or sid is null then
    raise exception 'Debe iniciar sesión y seleccionar una subsidiaria.';
  end if;

  if p_action='save' then
    if not app_is_admin() then
      raise exception 'Solo un administrador puede configurar las notificaciones.';
    end if;
    if length(trim(p_payload->>'subject')) not between 1 and 200
      or p_payload->>'subject' ~ E'[\r\n]'
      or length(p_payload->>'body') not between 1 and 20000 then
      raise exception 'Plantilla inválida.';
    end if;
    insert into public.configuraciones_correos(
      id_subsidiaria,tipo_notificacion,asunto_template,cuerpo_template,activo,updated_by_email
    ) values(
      sid,'FACTURA_VENTA',p_payload->>'subject',p_payload->>'body',
      coalesce((p_payload->>'active')::boolean,false),
      (select email from public.users where user_id=app_user_id())
    )
    on conflict(id_subsidiaria,tipo_notificacion) do update set
      asunto_template=excluded.asunto_template,
      cuerpo_template=excluded.cuerpo_template,
      activo=excluded.activo,
      updated_by_email=excluded.updated_by_email,
      updated_at=now();
  elsif p_action<>'get' then
    raise exception 'Acción inválida.';
  end if;

  insert into public.configuraciones_correos(
    id_subsidiaria,tipo_notificacion,asunto_template,cuerpo_template,activo,updated_by_email
  ) values(
    sid,'FACTURA_VENTA','Factura {{numero_factura}} · {{empresa_nombre}}',
    '<p>Estimado/a <strong>{{cliente_nombre}}</strong>,</p><p>Adjunto encontrará la factura <strong>{{numero_factura}}</strong>, emitida por {{empresa_nombre}} el {{fecha_factura}}, por un total de {{total_factura}} {{moneda}}.</p><p>Agradecemos su preferencia. Para cualquier consulta, puede responder directamente a este correo.</p>',
    true,'sistema'
  ) on conflict(id_subsidiaria,tipo_notificacion) do nothing;

  select * into cfg
  from public.configuraciones_correos
  where id_subsidiaria=sid and tipo_notificacion='FACTURA_VENTA';

  return jsonb_build_object(
    'template',case when cfg.id is null then null else to_jsonb(cfg)||jsonb_build_object(
      'updated_by_email',coalesce(cfg.updated_by_email,to_jsonb(cfg)->>'created_by_email')
    ) end,
    'subsidiary',(select jsonb_build_object('name',name,'logo',logo_url)
                  from public.subsidiaries where subsidiary_id=sid)
  );
end
$$;

create or replace function public.sales_invoice_delivery_snapshot(p_invoice_id bigint)
returns jsonb
language plpgsql
stable
security definer
set search_path=public,pg_temp
as $$
declare
  sid bigint:=active_subsidiary_id();
  result jsonb;
begin
  if app_user_id() is null or sid is null then
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
    'company',jsonb_build_object(
      'name',s.name,
      'address',coalesce(s.address,''),
      'logo',s.logo_url
    ),
    'customer',jsonb_build_object(
      'name',c.company_name,
      'email',coalesce(c.email,''),
      'address',coalesce(c.address,''),
      'taxId',coalesce(c.tax_id,'')
    ),
    'currency',jsonb_build_object(
      'code',cu.currency_code,
      'name',cu.name,
      'symbol',coalesce(cu.symbol,cu.currency_code)
    ),
    'paymentTerm',coalesce(pt.term_name,''),
    'lines',coalesce((
      select jsonb_agg(jsonb_build_object(
        'product',coalesce(p.display_name,'Producto'),
        'description',coalesce(l.note,''),
        'serviceCountry',coalesce(country.name,'—'),
        'quantity',l.quantity,
        'unitPrice',l.unit_price,
        'amount',l.amount,
        'taxRate',l.tax_rate,
        'taxAmount',l.tax_amount,
        'grossAmount',l.gross_amount
      ) order by l.line_id)
      from public.sales_invoice_line l
      left join public.products p using(product_id)
      left join public.countries country on country.country_id=l.service_country_id
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
        'url',js.support_url,
        'fileName',js.file_name,
        'mimeType',js.mime_type,
        'fileSize',js.file_size,
        'fileData',js.file_data
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
  where i.invoice_id=p_invoice_id
    and i.subsidiary_id=sid;

  if result is null then
    raise exception 'La factura no existe en la subsidiaria activa.';
  end if;
  return result;
end
$$;

revoke all on function public.sales_invoice_email_settings(text,jsonb),public.sales_invoice_delivery_snapshot(bigint) from public,anon;
grant execute on function public.sales_invoice_email_settings(text,jsonb),public.sales_invoice_delivery_snapshot(bigint) to authenticated;

notify pgrst,'reload schema';
