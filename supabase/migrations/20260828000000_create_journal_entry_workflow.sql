alter table public.journal add column if not exists journal_type text not null default 'Estándar',add column if not exists location_id bigint references public.locations(location_id),add column if not exists total_debit numeric(24,6) not null default 0,add column if not exists total_credit numeric(24,6) not null default 0;
alter table public.journal_line add column if not exists tax_code_id bigint references public.tax_codes(tax_code_id),add column if not exists tax_rate numeric(12,6),add column if not exists gross_amount numeric(24,6),add column if not exists note text,add column if not exists entity_type text,add column if not exists customer_id bigint references public.customers(customer_id),add column if not exists supplier_id bigint references public.suppliers(supplier_id),add column if not exists employee_id bigint references public.employees(employee_id),add column if not exists cost_center_id bigint references public.cost_centers(cost_center_id),add column if not exists financial_creditor_id bigint references public.financial_creditors(financial_creditor_id),add column if not exists related_company_id bigint references public.related_companies(related_company_id);
alter table public.journal_line drop constraint if exists journal_line_entity_type_allowed;
alter table public.journal_line add constraint journal_line_entity_type_allowed check(entity_type is null or entity_type in('Cliente','Proveedor','Empleado'));

create or replace function public.create_journal_entry(payload jsonb) returns bigint language plpgsql security definer set search_path=public,pg_temp as $$
declare sid bigint:=public.active_subsidiary_id();jid bigint;line jsonb;td numeric:=0;tc numeric:=0;loc bigint;number text;tt bigint;
begin
 if sid is null then raise exception 'Debe seleccionar una subsidiaria.';end if;
 if jsonb_array_length(coalesce(payload->'lines','[]'::jsonb))<2 then raise exception 'El asiento debe contener al menos dos líneas.';end if;
 select coalesce(sum(coalesce((x->>'debit')::numeric,0)),0),coalesce(sum(coalesce((x->>'credit')::numeric,0)),0) into td,tc from jsonb_array_elements(payload->'lines')x;
 if td<=0 or abs(td-tc)>0.000001 then raise exception 'El asiento no está balanceado. Débitos: %, Créditos: %.',td,tc;end if;
 select l.location_id into loc from locations l join location_subsidiaries ls on ls.location_id=l.location_id where ls.subsidiary_id=sid order by l.name,l.location_id limit 1;
 select transaction_type_id into tt from transaction_types where abbreviation='ASI_DIA' limit 1;
 begin number:=public.next_transaction_number(tt,sid);exception when others then number:='ASI-'||to_char(clock_timestamp(),'YYYYMMDDHH24MISSMS');end;
 insert into journal(journal_number,journal_date,subsidiary_id,currency_id,fiscal_period_id,exchange_rate,memo,journal_type,location_id,total_debit,total_credit)
 values(number,(payload->>'journal_date')::date,sid,(payload->>'currency_id')::bigint,(payload->>'fiscal_period_id')::bigint,(payload->>'exchange_rate')::numeric,payload->>'memo',coalesce(payload->>'journal_type','Estándar'),loc,td,tc) returning journal_id into jid;
 for line in select * from jsonb_array_elements(payload->'lines') loop
  insert into journal_line(journal_id,account_id,debit,credit,debit_fx,credit_fx,tax_code_id,tax_rate,gross_amount,note,entity_type,customer_id,supplier_id,employee_id,department_id,class_id,location_id,cost_center_id,financial_creditor_id,related_company_id)
  values(jid,(line->>'account_id')::bigint,coalesce((line->>'debit')::numeric,0),coalesce((line->>'credit')::numeric,0),coalesce((line->>'debit')::numeric,0),coalesce((line->>'credit')::numeric,0),nullif(line->>'tax_code_id','')::bigint,nullif(line->>'tax_rate','')::numeric,greatest(coalesce((line->>'debit')::numeric,0),coalesce((line->>'credit')::numeric,0))*(1+case when nullif(line->>'tax_code_id','') is null then 0 else coalesce(nullif(line->>'tax_rate','')::numeric,0)/100 end),line->>'note',nullif(line->>'entity_type',''),case when line->>'entity_type'='Cliente' then nullif(line->>'entity_id','')::bigint end,case when line->>'entity_type'='Proveedor' then nullif(line->>'entity_id','')::bigint end,case when line->>'entity_type'='Empleado' then nullif(line->>'entity_id','')::bigint end,nullif(line->>'department_id','')::bigint,nullif(line->>'class_id','')::bigint,loc,nullif(line->>'cost_center_id','')::bigint,nullif(line->>'financial_creditor_id','')::bigint,nullif(line->>'related_company_id','')::bigint);
 end loop;return jid;
end$$;
grant execute on function public.create_journal_entry(jsonb) to authenticated;
