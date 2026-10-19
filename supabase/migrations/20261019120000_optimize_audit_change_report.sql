-- Reduce el tiempo de carga del reporte de cambios. La consulta anterior
-- calculaba metadatos y recorría la bitácora de detalle por cada evento.

create index if not exists audit_log_change_options_idx
  on public.audit_log(action,"timestamp" desc)
  include(user_id,entity_type,module,log_id)
  where action in(
    'MODIFICACION','UPDATE','UPDATED','MODIFIED',
    'ELIMINACION','DELETE','DELETED'
  );

create index if not exists change_log_meaningful_event_idx
  on public.change_log(audit_log_id)
  where not public.audit_change_is_technical_field(field_name)
    and not public.audit_change_is_sensitive_field(field_name);

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
    raise exception using errcode='42501',message='La sesión no identifica un usuario.';
  end if;
  perform public.security_assert_role_access('audit:change-report','view');

  with event_base as materialized(
    select
      a.log_id,
      a."timestamp" occurred_at,
      case
        when a.user_id is not null then a.user_id
        else(
          select record.deleted_by_user_id
          from public.deleted_records record
          where record.audit_log_id=a.log_id
          order by record.deleted_id desc
          limit 1
        )
      end actor_user_id,
      a.entity_type,
      a.module raw_module
    from public.audit_log a
    where a.action in(
      'MODIFICACION','UPDATE','UPDATED','MODIFIED',
      'ELIMINACION','DELETE','DELETED'
    )
      and(
        a.action in('ELIMINACION','DELETE','DELETED')
        or exists(
          select 1
          from public.change_log change
          where change.audit_log_id=a.log_id
            and not public.audit_change_is_technical_field(change.field_name)
            and not public.audit_change_is_sensitive_field(change.field_name)
        )
      )
  ),entity_rollup as materialized(
    select event.entity_type,event.raw_module,count(*)::integer record_count
    from event_base event
    group by event.entity_type,event.raw_module
  ),entity_enriched as materialized(
    select rollup.entity_type,rollup.record_count,
      public.audit_change_entity_meta(rollup.entity_type,rollup.raw_module) meta
    from entity_rollup rollup
  ),user_options as(
    select coalesce(jsonb_agg(jsonb_build_object(
      'id',option.user_id,'name',option.display_name,'email',option.email,
      'isActive',option.is_active,'recordCount',option.record_count
    )order by option.display_name,option.email),'[]'::jsonb)value
    from(
      select u.user_id,
        coalesce(nullif(trim(concat_ws(' ',u.first_name,u.last_name)),''),u.email)display_name,
        u.email,u.is_active,count(*)::integer record_count
      from event_base event
      join public.users u on u.user_id=event.actor_user_id
      group by u.user_id,u.first_name,u.last_name,u.email,u.is_active
    )option
  ),module_options as(
    select coalesce(jsonb_agg(jsonb_build_object(
      'id',option.module_code,'label',option.module_label,'recordCount',option.record_count
    )order by option.module_label),'[]'::jsonb)value
    from(
      select event.meta->>'moduleCode'module_code,event.meta->>'moduleLabel'module_label,
        sum(event.record_count)::integer record_count
      from entity_enriched event
      group by event.meta->>'moduleCode',event.meta->>'moduleLabel'
    )option
  ),entity_options as(
    select coalesce(jsonb_agg(jsonb_build_object(
      'id',option.entity_type,'label',option.entity_label,'module',option.module_code,
      'recordCount',option.record_count
    )order by option.entity_label,option.entity_type),'[]'::jsonb)value
    from(
      select event.entity_type,event.meta->>'entityLabel'entity_label,
        event.meta->>'moduleCode'module_code,sum(event.record_count)::integer record_count
      from entity_enriched event
      group by event.entity_type,event.meta->>'entityLabel',event.meta->>'moduleCode'
    )option
  ),month_options as(
    select coalesce(jsonb_agg(jsonb_build_object(
      'id',option.month_id,'year',option.year_value,'month',option.month_value,
      'recordCount',option.record_count
    )order by option.month_id desc),'[]'::jsonb)value
    from(
      select to_char(date_trunc('month',event.occurred_at at time zone 'America/Costa_Rica'),'YYYY-MM')month_id,
        extract(year from event.occurred_at at time zone 'America/Costa_Rica')::integer year_value,
        extract(month from event.occurred_at at time zone 'America/Costa_Rica')::integer month_value,
        count(*)::integer record_count
      from event_base event
      group by 1,2,3
    )option
  )
  select jsonb_build_object(
    'defaultMonth',to_char(current_timestamp at time zone 'America/Costa_Rica','YYYY-MM'),
    'timeZone','America/Costa_Rica',
    'actions',jsonb_build_array(
      jsonb_build_object('id','','label','Todas las acciones'),
      jsonb_build_object('id','UPDATE','label','Modificados'),
      jsonb_build_object('id','DELETE','label','Eliminados')
    ),
    'users',user_options.value,
    'modules',module_options.value,
    'entityTypes',entity_options.value,
    'months',month_options.value,
    'pageSizes',jsonb_build_array(25,50,100,200)
  )into result
  from user_options,module_options,entity_options,month_options;

  return result;
end
$$;

comment on function public.audit_change_report_options() is
  'Filtros autorizados y optimizados para el reporte mensual de registros modificados y eliminados.';

revoke all on function public.audit_change_report_options() from public,anon;
grant execute on function public.audit_change_report_options() to authenticated,service_role;
