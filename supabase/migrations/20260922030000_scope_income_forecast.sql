-- Separate subsidiary and consolidation forecasts at the database boundary.
alter function public.income_forecast_options() rename to income_forecast_options_before_scope;
revoke all on function public.income_forecast_options_before_scope() from public,anon,authenticated;

create function public.income_forecast_options(p_consolidated boolean default false)
returns jsonb language plpgsql stable security definer set search_path=public,pg_temp as $$
declare result jsonb;sid bigint:=active_subsidiary_id();begin
 if sid is null then raise exception 'Seleccione una empresa activa.';end if;
 if p_consolidated and not consolidation_has_permission('ACC_CONSOLIDATION_RUN')then raise exception 'No tiene permiso para consultar proyecciones consolidadas.';end if;
 result:=income_forecast_options_before_scope();
 if not p_consolidated then result:=jsonb_set(result,'{subsidiaries}',coalesce((select jsonb_agg(x)from jsonb_array_elements(result->'subsidiaries')x where(x->>'id')::bigint=sid),'[]'));
 end if;
 return result||jsonb_build_object('mode',case when p_consolidated then'CONSOLIDATED'else'SUBSIDIARY'end,'canConsolidate',consolidation_has_permission('ACC_CONSOLIDATION_RUN'),'holding',(select jsonb_build_object('id',subsidiary_id,'name',name)from subsidiaries where lower(trim(name))='stt group latin american'limit 1));
end$$;

alter function public.income_forecast_source(jsonb) rename to income_forecast_source_before_scope;
revoke all on function public.income_forecast_source_before_scope(jsonb) from public,anon,authenticated;
create function public.income_forecast_source(p jsonb)returns jsonb language plpgsql stable security definer set search_path=public,pg_temp as $$
declare scoped jsonb:=coalesce(p,'{}');sid bigint:=active_subsidiary_id();requested bigint[];begin
 if sid is null then raise exception 'Seleccione una empresa activa.';end if;
 if coalesce((scoped->>'consolidated')::boolean,false)then
  if not consolidation_has_permission('ACC_CONSOLIDATION_RUN')then raise exception 'No tiene permiso para consultar proyecciones consolidadas.';end if;
  if nullif(scoped->>'holdingId','')is null then raise exception 'Seleccione la holding de consolidación.';end if;
 else
  select array_agg(value::bigint)into requested from jsonb_array_elements_text(coalesce(scoped->'subsidiaryIds','[]'));
  if cardinality(coalesce(requested,array[]::bigint[]))<>1 or requested[1]<>sid then raise exception 'El Estado de Resultados Proyectado corresponde únicamente a la empresa activa.';end if;
  scoped:=scoped||jsonb_build_object('subsidiaryIds',jsonb_build_array(sid),'consolidated',false,'holdingId',null);
 end if;
 return income_forecast_source_before_scope(scoped);
end$$;

alter function public.income_forecast_save(jsonb) rename to income_forecast_save_before_scope;
revoke all on function public.income_forecast_save_before_scope(jsonb) from public,anon,authenticated;
create function public.income_forecast_save(p jsonb)returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$begin
 perform income_forecast_source(p->'configuration');
 return income_forecast_save_before_scope(p);
end$$;

revoke all on function public.income_forecast_options(boolean),public.income_forecast_source(jsonb),public.income_forecast_save(jsonb)from public,anon,authenticated;
grant execute on function public.income_forecast_options(boolean),public.income_forecast_source(jsonb),public.income_forecast_save(jsonb)to authenticated;
notify pgrst,'reload schema';
