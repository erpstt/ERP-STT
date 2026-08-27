create or replace function public.update_journal_entry(target_journal_id bigint,payload jsonb) returns bigint language plpgsql security definer set search_path=public,pg_temp as $$
declare sid bigint:=public.active_subsidiary_id();line jsonb;td numeric:=0;tc numeric:=0;loc bigint;
begin
 if not exists(select 1 from journal where journal_id=target_journal_id and subsidiary_id=sid) then raise exception 'El asiento no existe o no pertenece a la subsidiaria activa.';end if;
 if jsonb_array_length(coalesce(payload->'lines','[]'::jsonb))<2 then raise exception 'El asiento debe contener al menos dos líneas.';end if;
 select coalesce(sum(coalesce((x->>'debit')::numeric,0)),0),coalesce(sum(coalesce((x->>'credit')::numeric,0)),0) into td,tc from jsonb_array_elements(payload->'lines')x;
 if td<=0 or abs(td-tc)>0.000001 then raise exception 'El asiento no está balanceado. Débitos: %, Créditos: %.',td,tc;end if;
 select l.location_id into loc from locations l join location_subsidiaries ls on ls.location_id=l.location_id where ls.subsidiary_id=sid order by l.name,l.location_id limit 1;
 update journal set journal_date=(payload->>'journal_date')::date,currency_id=(payload->>'currency_id')::bigint,fiscal_period_id=(payload->>'fiscal_period_id')::bigint,exchange_rate=(payload->>'exchange_rate')::numeric,memo=payload->>'memo',journal_type=coalesce(payload->>'journal_type','Estándar'),location_id=loc,total_debit=td,total_credit=tc where journal_id=target_journal_id;
 delete from journal_line where journal_id=target_journal_id;
 for line in select * from jsonb_array_elements(payload->'lines') loop
  insert into journal_line(journal_id,account_id,debit,credit,debit_fx,credit_fx,tax_code_id,tax_rate,gross_amount,note,entity_type,customer_id,supplier_id,employee_id,department_id,class_id,location_id,cost_center_id,financial_creditor_id,related_company_id)
  values(target_journal_id,(line->>'account_id')::bigint,coalesce((line->>'debit')::numeric,0),coalesce((line->>'credit')::numeric,0),coalesce((line->>'debit')::numeric,0),coalesce((line->>'credit')::numeric,0),nullif(line->>'tax_code_id','')::bigint,nullif(line->>'tax_rate','')::numeric,greatest(coalesce((line->>'debit')::numeric,0),coalesce((line->>'credit')::numeric,0))*(1+case when nullif(line->>'tax_code_id','') is null then 0 else coalesce(nullif(line->>'tax_rate','')::numeric,0)/100 end),line->>'note',nullif(line->>'entity_type',''),case when line->>'entity_type'='Cliente' then nullif(line->>'entity_id','')::bigint end,case when line->>'entity_type'='Proveedor' then nullif(line->>'entity_id','')::bigint end,case when line->>'entity_type'='Empleado' then nullif(line->>'entity_id','')::bigint end,nullif(line->>'department_id','')::bigint,nullif(line->>'class_id','')::bigint,loc,nullif(line->>'cost_center_id','')::bigint,nullif(line->>'financial_creditor_id','')::bigint,nullif(line->>'related_company_id','')::bigint);
 end loop;return target_journal_id;
end$$;
grant execute on function public.update_journal_entry(bigint,jsonb) to authenticated;
