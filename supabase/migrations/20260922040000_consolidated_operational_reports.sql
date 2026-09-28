-- Consolidated USD views for AR, AP and pending-to-invoice reports.
create function public.operational_usd_closing_rate(p_subsidiary_id bigint,p_cutoff date)
returns numeric language plpgsql stable security definer set search_path=public,pg_temp as $$
declare source_currency bigint;usd_currency bigint;holding_id bigint;month_end date:=(date_trunc('month',p_cutoff)+interval '1 month'-interval '1 day')::date;result numeric;begin
 select currency_id into source_currency from subsidiaries where subsidiary_id=p_subsidiary_id;select currency_id into usd_currency from currencies where currency_code='USD';
 if source_currency is null or usd_currency is null then return null;end if;if source_currency=usd_currency then return 1;end if;
 select subsidiary_id into holding_id from subsidiaries where lower(trim(name))='stt group latin american'limit 1;
 select closing_rate into result from consolidated_exchange_rates where holding_subsidiary_id=holding_id and source_subsidiary_id=p_subsidiary_id and period=to_char(month_end,'YYYY-MM')and to_currency_id=usd_currency;
 if result is null then select spot_rate into result from exchange_rates where from_currency_id=source_currency and to_currency_id=usd_currency and effective_date<=month_end order by effective_date desc,exchange_rate_id desc limit 1;end if;
 if result is null then select 1/nullif(spot_rate,0)into result from exchange_rates where from_currency_id=usd_currency and to_currency_id=source_currency and effective_date<=month_end order by effective_date desc,exchange_rate_id desc limit 1;end if;
 return result;
end$$;

alter function public.run_aging_report(text,jsonb) rename to run_aging_report_before_consolidation;
revoke all on function public.run_aging_report_before_consolidation(text,jsonb) from public,anon,authenticated;

create function public.run_aging_report(p_kind text,p_filters jsonb default '{}'::jsonb)
returns jsonb language plpgsql stable security definer set search_path=public,pg_temp as $$
declare consolidated boolean:=coalesce((p_filters->>'consolidated')::boolean,false);cutoff date:=nullif(p_filters->>'dateTo','')::date;period_key text;holding_id bigint;usd_id bigint;company record;report jsonb;item jsonb;application jsonb;scaled_applications jsonb;all_rows jsonb:='[]';rate numeric;summary jsonb:=jsonb_build_object('subledger',0,'advances',0,'netBalance',0,'controlBalance',0,'difference',0);page_no int:=greatest(coalesce((p_filters->>'page')::int,1),1);page_size int:=least(greatest(coalesce((p_filters->>'pageSize')::int,50),10),250);company_page int;total_rows int;begin
 if not consolidated then return run_aging_report_before_consolidation(p_kind,p_filters);end if;
 if cutoff is null then raise exception 'La fecha de corte es obligatoria.';end if;period_key:=to_char(cutoff,'YYYY-MM');
 select subsidiary_id into holding_id from subsidiaries where lower(trim(name))='stt group latin american'limit 1;select currency_id into usd_id from currencies where currency_code='USD';
 if usd_id is null then raise exception 'Configure la moneda USD para generar el consolidado.';end if;
 for company in select s.subsidiary_id,s.name,s.currency_id from subsidiaries s join user_subsidiaries us using(subsidiary_id)where us.user_id=app_user_id()and s.is_active order by s.name loop
  rate:=operational_usd_closing_rate(company.subsidiary_id,cutoff);if rate is null then raise exception 'Falta la tasa de cierre hacia USD para % en %.',company.name,period_key;end if;
  company_page:=1;
  loop
   report:=run_aging_report_before_consolidation(p_kind,(p_filters-'consolidated')||jsonb_build_object('subsidiaryIds',jsonb_build_array(company.subsidiary_id),'agingCurrencyMode','LOCAL','page',company_page,'pageSize',250));
   for item in select value from jsonb_array_elements(coalesce(report->'rows','[]')) loop
    select coalesce(jsonb_agg(a.value||jsonb_build_object('amount',round(coalesce((a.value->>'amount')::numeric,0)*rate,2))),'[]')into scaled_applications from jsonb_array_elements(coalesce(item->'applications','[]'))a(value);
    all_rows:=all_rows||jsonb_build_array(item||jsonb_build_object('subsidiary_id',company.subsidiary_id,'subsidiary_name',company.name,'presentation_currency','USD','conversion_rate',rate,'original_amount',round(coalesce((item->>'original_amount')::numeric,0)*rate,2),'applied_amount',round(coalesce((item->>'applied_amount')::numeric,0)*rate,2),'pending',round(coalesce((item->>'pending')::numeric,0)*rate,2),'entity_advances',round(coalesce((item->>'entity_advances')::numeric,0)*rate,2),'applications',scaled_applications));
   end loop;
   exit when jsonb_array_length(coalesce(report->'rows','[]'))=0 or company_page*250>=coalesce((report->>'total')::int,0);company_page:=company_page+1;
  end loop;
  summary:=jsonb_build_object('subledger',(summary->>'subledger')::numeric+coalesce((report->'summary'->>'subledger')::numeric,0)*rate,'advances',(summary->>'advances')::numeric+coalesce((report->'summary'->>'advances')::numeric,0)*rate,'netBalance',(summary->>'netBalance')::numeric+coalesce((report->'summary'->>'netBalance')::numeric,0)*rate,'controlBalance',(summary->>'controlBalance')::numeric+coalesce((report->'summary'->>'controlBalance')::numeric,0)*rate,'difference',(summary->>'difference')::numeric+coalesce((report->'summary'->>'difference')::numeric,0)*rate);
 end loop;
 total_rows:=jsonb_array_length(all_rows);
 return jsonb_build_object('rows',coalesce((select jsonb_agg(value)from(select value,row_number()over()n from jsonb_array_elements(all_rows))x where n between(page_no-1)*page_size+1 and page_no*page_size),'[]'),'total',total_rows,'page',page_no,'pageSize',page_size,'summary',summary,'consolidated',true,'currency','USD','companies',(select coalesce(jsonb_agg(jsonb_build_object('id',s.subsidiary_id,'name',s.name)order by s.name),'[]')from subsidiaries s join user_subsidiaries us using(subsidiary_id)where us.user_id=app_user_id()and s.is_active));
end$$;

alter function public.run_pending_invoice_control_report(jsonb) rename to run_pending_invoice_control_report_before_consolidation;
revoke all on function public.run_pending_invoice_control_report_before_consolidation(jsonb) from public,anon,authenticated;

create function public.run_pending_invoice_control_report(p_filters jsonb default '{}')
returns jsonb language plpgsql stable security definer set search_path=public,pg_temp as $$
declare consolidated boolean:=coalesce((p_filters->>'consolidated')::boolean,false);cutoff date:=coalesce(nullif(p_filters->>'dateTo','')::date,current_date);period_key text:=to_char(cutoff,'YYYY-MM');holding_id bigint;usd_id bigint;company record;report jsonb;item jsonb;reversal jsonb;scaled_reversals jsonb;all_rows jsonb:='[]';rate numeric;initial_total numeric:=0;reversed_total numeric:=0;balance_total numeric:=0;begin
 if not consolidated then return run_pending_invoice_control_report_before_consolidation(p_filters);end if;
 select subsidiary_id into holding_id from subsidiaries where lower(trim(name))='stt group latin american'limit 1;select currency_id into usd_id from currencies where currency_code='USD';
 if usd_id is null then raise exception 'Configure la moneda USD para generar el consolidado.';end if;
 for company in select s.subsidiary_id,s.name,s.currency_id from subsidiaries s join user_subsidiaries us using(subsidiary_id)where us.user_id=app_user_id()and s.is_active order by s.name loop
  rate:=operational_usd_closing_rate(company.subsidiary_id,cutoff);if rate is null then raise exception 'Falta la tasa de cierre hacia USD para % en %.',company.name,period_key;end if;
  report:=run_pending_invoice_control_report_before_consolidation((p_filters-'consolidated')||jsonb_build_object('subsidiaryIds',jsonb_build_array(company.subsidiary_id)));
  for item in select value from jsonb_array_elements(coalesce(report->'rows','[]')) loop
   select coalesce(jsonb_agg(r.value||jsonb_build_object('amount',round(coalesce((r.value->>'amount')::numeric,0)*rate,2))),'[]')into scaled_reversals from jsonb_array_elements(coalesce(item->'reversals','[]'))r(value);
   all_rows:=all_rows||jsonb_build_array(item||jsonb_build_object('subsidiary_id',company.subsidiary_id,'subsidiary_name',company.name,'presentation_currency','USD','conversion_rate',rate,'initial',round(coalesce((item->>'initial')::numeric,0)*rate,2),'reversed',round(coalesce((item->>'reversed')::numeric,0)*rate,2),'balance',round(coalesce((item->>'balance')::numeric,0)*rate,2),'reversals',scaled_reversals));
  end loop;
  initial_total:=initial_total+coalesce((report->'summary'->>'initial')::numeric,0)*rate;reversed_total:=reversed_total+coalesce((report->'summary'->>'reversed')::numeric,0)*rate;balance_total:=balance_total+coalesce((report->'summary'->>'balance')::numeric,0)*rate;
 end loop;
 return jsonb_build_object('rows',all_rows,'total',jsonb_array_length(all_rows),'summary',jsonb_build_object('initial',round(initial_total,2),'reversed',round(reversed_total,2),'balance',round(balance_total,2)),'consolidated',true,'currency','USD','companies',(select coalesce(jsonb_agg(jsonb_build_object('id',s.subsidiary_id,'name',s.name)order by s.name),'[]')from subsidiaries s join user_subsidiaries us using(subsidiary_id)where us.user_id=app_user_id()and s.is_active));
end$$;

revoke all on function public.operational_usd_closing_rate(bigint,date),public.run_aging_report(text,jsonb),public.run_pending_invoice_control_report(jsonb)from public,anon,authenticated;
grant execute on function public.operational_usd_closing_rate(bigint,date),public.run_aging_report(text,jsonb),public.run_pending_invoice_control_report(jsonb)to authenticated;
notify pgrst,'reload schema';
