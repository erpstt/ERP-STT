create or replace function public.consolidation_init(p_period varchar)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare hid bigint;usd bigint;rid bigint;open_details jsonb;rate_details jsonb;open_count int;missing_count int;
begin
 if not consolidation_has_permission('ACC_CONSOLIDATION_RUN')then raise exception'No tiene permiso para ejecutar consolidaciones.';end if;
 if p_period!~'^[0-9]{4}-(0[1-9]|1[0-2])$'then raise exception'Período inválido.';end if;
 select subsidiary_id into hid from subsidiaries where lower(trim(name))='stt group latin american'limit 1;
 select currency_id into usd from currencies where currency_code='USD';
 select coalesce(jsonb_agg(jsonb_build_object('id',q.subsidiary_id,'name',q.name,'period',p_period,'status',case when q.fiscal_period_id is null then'PERIODO_NO_CREADO'else'PENDIENTE_DE_CIERRE'end)order by q.name),'[]'::jsonb)into open_details
 from(select s.subsidiary_id,s.name,f.fiscal_period_id from subsidiaries s left join lateral(select fp.fiscal_period_id from fiscal_periods fp where fp.subsidiary_id=s.subsidiary_id and to_char(fp.end_date,'YYYY-MM')=p_period order by fp.fiscal_period_id limit 1)f on true where s.is_active and s.subsidiary_id<>hid and not exists(select 1 from fiscal_periods closed_period where closed_period.subsidiary_id=s.subsidiary_id and to_char(closed_period.end_date,'YYYY-MM')=p_period and closed_period.is_closed))q;
 select coalesce(jsonb_agg(jsonb_build_object('id',q.subsidiary_id,'name',q.name,'period',p_period,'fromCurrency',q.from_currency,'toCurrency','USD','status','TASA_NO_REGISTRADA')order by q.name),'[]'::jsonb)into rate_details
 from(select s.subsidiary_id,s.name,c.currency_code from_currency from subsidiaries s join currencies c using(currency_id)where s.is_active and s.subsidiary_id<>hid and s.currency_id<>usd and not exists(select 1 from consolidated_exchange_rates r where r.holding_subsidiary_id=hid and r.source_subsidiary_id=s.subsidiary_id and r.period=p_period and r.to_currency_id=usd))q;
 open_count:=jsonb_array_length(open_details);missing_count:=jsonb_array_length(rate_details);
 if open_count>0 or missing_count>0 then return jsonb_build_object('ready',false,'openSubsidiaries',open_count,'missingRates',missing_count,'openSubsidiaryDetails',open_details,'missingRateDetails',rate_details);end if;
 insert into consolidation_runs(holding_subsidiary_id,period,presentation_currency_id,status)values(hid,p_period,usd,'VALIDADO')on conflict(holding_subsidiary_id,period)do update set updated_at=now()returning id into rid;
 return jsonb_build_object('ready',true,'id',rid,'status','VALIDADO');
end$$;
grant execute on function public.consolidation_init(varchar)to authenticated,service_role;
notify pgrst,'reload schema';
