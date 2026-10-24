-- Las opciones del reporte de calidad se cargan antes de escoger el mes.
-- La versión anterior reconstruía la identidad de cada transacción histórica,
-- aunque la interfaz solo necesita catálogos para los filtros. Con decenas de
-- miles de eventos esa preparación llegó a superar el timeout de PostgREST.
--
-- El detalle mensual conserva intacta su validación por documento. Aquí el
-- alcance de usuarios y subsidiarias se obtiene directamente de las relaciones
-- autorizadas, mientras los tipos provienen del catálogo inmutable del reporte.

create or replace function public.audit_change_report_options()
returns jsonb
language plpgsql
stable
security definer
set search_path=public,pg_temp
as $$
declare
  uid bigint:=public.app_user_id();
  result jsonb;
begin
  if uid is null then
    raise exception using errcode='42501',message='La sesion no identifica un usuario.';
  end if;
  perform public.security_assert_role_access('audit:change-report','view');

  with allowed_subsidiaries as materialized(
    select access.subsidiary_id
    from public.user_subsidiaries access
    where access.user_id=uid
  ),user_options as(
    select coalesce(jsonb_agg(jsonb_build_object(
      'id',option.user_id,
      'name',option.display_name,
      'email',option.email,
      'isActive',option.is_active
    )order by option.display_name,option.email),'[]'::jsonb)value
    from(
      select distinct user_row.user_id,
        coalesce(nullif(trim(concat_ws(' ',user_row.first_name,user_row.last_name)),''),user_row.email)display_name,
        user_row.email,user_row.is_active
      from public.users user_row
      join public.user_subsidiaries actor_access
        on actor_access.user_id=user_row.user_id
      join allowed_subsidiaries allowed
        on allowed.subsidiary_id=actor_access.subsidiary_id
    )option
  ),type_catalog as materialized(
    select entity_type,public.audit_change_transaction_meta(entity_type)meta
    from unnest(public.audit_change_transaction_entity_types())entity(entity_type)
  ),group_options as(
    select coalesce(jsonb_agg(jsonb_build_object(
      'id',option.group_code,
      'label',option.group_label
    )order by option.group_label),'[]'::jsonb)value
    from(
      select distinct catalog.meta->>'groupCode'group_code,
        catalog.meta->>'groupLabel'group_label
      from type_catalog catalog
      where catalog.meta is not null
    )option
  ),type_options as(
    select coalesce(jsonb_agg(jsonb_build_object(
      'id',catalog.entity_type,
      'label',catalog.meta->>'typeLabel',
      'group',catalog.meta->>'groupCode',
      'module',catalog.meta->>'groupCode'
    )order by catalog.meta->>'typeLabel',catalog.entity_type),'[]'::jsonb)value
    from type_catalog catalog
    where catalog.meta is not null
  ),audit_bounds as(
    select
      date_trunc('month',min(log."timestamp" at time zone 'America/Costa_Rica'))::date first_month,
      date_trunc('month',max(log."timestamp" at time zone 'America/Costa_Rica'))::date last_month
    from public.audit_log log
    where(
      log.entity_type=any(public.audit_change_transaction_entity_types())
      and log.action in(
        'MODIFICACION','UPDATE','UPDATED','MODIFIED',
        'ELIMINACION','DELETE','DELETED'
      )
    )or(
      log.entity_type=any(public.audit_change_transaction_child_entity_types())
      and log.action in(
        'CREACION','INSERT','CREATED',
        'MODIFICACION','UPDATE','UPDATED','MODIFIED',
        'ELIMINACION','DELETE','DELETED'
      )
    )
  ),month_options as(
    select coalesce(jsonb_agg(jsonb_build_object(
      'id',to_char(month_value,'YYYY-MM'),
      'label',to_char(month_value,'YYYY-MM'),
      'year',extract(year from month_value)::integer,
      'month',extract(month from month_value)::integer
    )order by month_value desc),'[]'::jsonb)value
    from audit_bounds bounds
    cross join lateral generate_series(
      coalesce(bounds.first_month,date_trunc('month',current_timestamp at time zone 'America/Costa_Rica')::date),
      coalesce(bounds.last_month,date_trunc('month',current_timestamp at time zone 'America/Costa_Rica')::date),
      interval '1 month'
    )month_value
  ),subsidiary_options as(
    select coalesce(jsonb_agg(jsonb_build_object(
      'id',subsidiary.subsidiary_id,
      'name',subsidiary.name
    )order by subsidiary.name),'[]'::jsonb)value
    from allowed_subsidiaries allowed
    join public.subsidiaries subsidiary using(subsidiary_id)
    where subsidiary.is_active
  )
  select jsonb_build_object(
    'defaultMonth',to_char(current_timestamp at time zone 'America/Costa_Rica','YYYY-MM'),
    'timeZone','America/Costa_Rica',
    'scope','authorized_subsidiaries',
    'actions',jsonb_build_array(
      jsonb_build_object('id','','label','Todas las acciones'),
      jsonb_build_object('id','UPDATE','label','Modificadas'),
      jsonb_build_object('id','DELETE','label','Eliminadas')
    ),
    'users',user_options.value,
    'subsidiaries',subsidiary_options.value,
    'transactionGroups',group_options.value,
    'transactionTypes',type_options.value,
    'modules',group_options.value,
    'entityTypes',type_options.value,
    'months',month_options.value,
    'pageSizes',jsonb_build_array(25,50,100,200)
  )into result
  from user_options,group_options,type_options,month_options,subsidiary_options;

  return result;
end
$$;

revoke all on function public.audit_change_report_options() from public,anon;
grant execute on function public.audit_change_report_options() to authenticated,service_role;

comment on function public.audit_change_report_options() is
  'Opciones livianas del reporte de cambios; el detalle mensual aplica la autorización documental completa.';
