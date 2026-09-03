create or replace function public.bank_deposit_report(p_filters jsonb default '{}'::jsonb)
returns jsonb language sql stable security definer set search_path=public as $$
  select jsonb_build_object(
    'rows',coalesce(jsonb_agg(jsonb_build_object(
      'depositId',d.deposit_id,'number',d.deposit_number,'bankReference',d.bank_reference,
      'date',d.deposit_date,'bank',b.bank_name,'account',ba.account_number,
      'currency',c.currency_code,'exchangeRate',d.exchange_rate,'total',d.total_amount,
      'memo',d.memo,'journalId',d.journal_id,'createdAt',d.created_at
    ) order by d.deposit_date desc,d.deposit_id desc),'[]'::jsonb),
    'total',coalesce(sum(d.total_amount*d.exchange_rate),0),'baseCurrency',max(base.currency_code)
  )
  from bank_deposit d
  join bank_account ba on ba.bank_account_id=d.bank_account_id
  join banks b on b.bank_id=ba.bank_id
  join currencies c on c.currency_id=d.currency_id
  join subsidiaries s on s.subsidiary_id=d.subsidiary_id
  join currencies base on base.currency_id=s.currency_id
  where d.subsidiary_id=active_subsidiary_id()
    and d.deposit_date>=coalesce(nullif(p_filters->>'dateFrom','')::date,date_trunc('month',current_date)::date)
    and d.deposit_date<=coalesce(nullif(p_filters->>'dateTo','')::date,current_date)
    and (nullif(p_filters->>'bankAccountId','') is null or d.bank_account_id=(p_filters->>'bankAccountId')::bigint)
    and (nullif(trim(p_filters->>'search'),'') is null or concat_ws(' ',d.deposit_number,d.bank_reference,d.memo,b.bank_name,ba.account_number) ilike '%'||trim(p_filters->>'search')||'%')
$$;

create or replace function public.bank_deposit_detail(p_deposit_id bigint)
returns jsonb language plpgsql stable security definer set search_path=public as $$
declare result jsonb;
begin
 select jsonb_build_object(
  'deposit',to_jsonb(d)||jsonb_build_object('bankName',b.bank_name,'accountNumber',ba.account_number,'currencyCode',c.currency_code,'currencyName',c.name,'subsidiaryName',s.name,'locationName',l.name),
  'lines',coalesce((select jsonb_agg(to_jsonb(dl) order by dl.line_number) from bank_deposit_line dl where dl.deposit_id=d.deposit_id),'[]'::jsonb),
  'impact',coalesce((select jsonb_agg(to_jsonb(jl)||jsonb_build_object('accountNumber',ca.account_number,'accountName',ca.account_name) order by jl.journal_line_id) from journal_line jl join chart_accounts ca on ca.account_id=jl.account_id where jl.journal_id=d.journal_id),'[]'::jsonb)
 ) into result
 from bank_deposit d join bank_account ba on ba.bank_account_id=d.bank_account_id join banks b on b.bank_id=ba.bank_id join currencies c on c.currency_id=d.currency_id join subsidiaries s on s.subsidiary_id=d.subsidiary_id left join locations l on l.location_id=d.location_id
 where d.deposit_id=p_deposit_id and d.subsidiary_id=active_subsidiary_id();
 if result is null then raise exception 'No se encontró el depósito en la subsidiaria activa.'; end if;
 return result;
end$$;

create or replace function public.update_bank_deposit(p_deposit_id bigint,p_payload jsonb)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare old bank_deposit%rowtype;ba bank_account%rowtype;line jsonb;line_no int:=0;total numeric:=0;entity_kind text;entity_key bigint;d date:=(p_payload->>'deposit_date')::date;currency_key bigint:=(p_payload->>'currency_id')::bigint;rate numeric:=(p_payload->>'exchange_rate')::numeric;period_key bigint:=(p_payload->>'fiscal_period_id')::bigint;location_key bigint:=nullif(p_payload->>'location_id','')::bigint;
begin
 select * into old from bank_deposit where deposit_id=p_deposit_id and subsidiary_id=active_subsidiary_id() for update;
 if old.deposit_id is null then raise exception 'No se encontró el depósito.';end if;
 select * into ba from bank_account where bank_account_id=(p_payload->>'bank_account_id')::bigint and subsidiary_id=active_subsidiary_id() for update;
 if ba.bank_account_id is null or ba.currency_id<>currency_key then raise exception 'La cuenta bancaria o su moneda no son válidas.';end if;
 if not exists(select 1 from fiscal_periods where fiscal_period_id=period_key and subsidiary_id=active_subsidiary_id() and d between start_date and end_date and not is_closed) then raise exception 'Seleccione un período contable abierto.';end if;
 for line in select value from jsonb_array_elements(coalesce(p_payload->'lines','[]'::jsonb)) loop if coalesce((line->>'amount')::numeric,0)<=0 or nullif(line->>'account_id','') is null then raise exception 'Cada línea requiere importe y cuenta.';end if;total:=total+(line->>'amount')::numeric;end loop;
 if total<=0 then raise exception 'Agregue al menos una línea.';end if;
 update bank_account set balance=balance-old.total_amount where bank_account_id=old.bank_account_id;
 update bank_account set balance=balance+total where bank_account_id=ba.bank_account_id;
 update "transaction" set tran_date=d,currency_id=currency_key,exchange_rate=rate,fiscal_period_id=period_key,total_amount=total where transaction_id=(select transaction_id from journal where journal_id=old.journal_id);
 update journal set journal_date=d,currency_id=currency_key,fiscal_period_id=period_key,exchange_rate=rate,memo=nullif(p_payload->>'memo',''),location_id=location_key,total_debit=total,total_credit=total where journal_id=old.journal_id;
 update bank_deposit set bank_reference=nullif(p_payload->>'bank_reference',''),bank_account_id=ba.bank_account_id,deposit_date=d,total_amount=total,currency_id=currency_key,exchange_rate=rate,fiscal_period_id=period_key,location_id=location_key,memo=nullif(p_payload->>'memo','') where deposit_id=p_deposit_id;
 delete from bank_deposit_line where deposit_id=p_deposit_id; delete from journal_line where journal_id=old.journal_id;
 insert into journal_line(journal_id,account_id,debit,credit,debit_fx,credit_fx,location_id,note) values(old.journal_id,ba.account_id,total,0,total*rate,0,location_key,coalesce(nullif(p_payload->>'memo',''),'Depósito bancario'));
 for line in select value from jsonb_array_elements(p_payload->'lines') loop line_no:=line_no+1;entity_kind:=nullif(line->>'entity_type','');entity_key:=nullif(line->>'entity_id','')::bigint;
  insert into bank_deposit_line(deposit_id,line_number,amount,account_id,payment_method_id,entity_type,customer_id,supplier_id,employee_id,department_id,cost_center_id,class_id,financial_creditor_id,related_company_id,note) values(p_deposit_id,line_no,(line->>'amount')::numeric,(line->>'account_id')::bigint,nullif(line->>'payment_method_id','')::bigint,entity_kind,case when entity_kind='Cliente' then entity_key end,case when entity_kind='Proveedor' then entity_key end,case when entity_kind='Empleado' then entity_key end,nullif(line->>'department_id','')::bigint,nullif(line->>'cost_center_id','')::bigint,nullif(line->>'class_id','')::bigint,nullif(line->>'financial_creditor_id','')::bigint,nullif(line->>'related_company_id','')::bigint,nullif(line->>'note',''));
  insert into journal_line(journal_id,account_id,debit,credit,debit_fx,credit_fx,department_id,class_id,location_id,note,entity_type,customer_id,supplier_id,employee_id,cost_center_id,financial_creditor_id,related_company_id) values(old.journal_id,(line->>'account_id')::bigint,0,(line->>'amount')::numeric,0,(line->>'amount')::numeric*rate,nullif(line->>'department_id','')::bigint,nullif(line->>'class_id','')::bigint,location_key,nullif(line->>'note',''),entity_kind,case when entity_kind='Cliente' then entity_key end,case when entity_kind='Proveedor' then entity_key end,case when entity_kind='Empleado' then entity_key end,nullif(line->>'cost_center_id','')::bigint,nullif(line->>'financial_creditor_id','')::bigint,nullif(line->>'related_company_id','')::bigint);
 end loop;
 update bank_transaction set tran_date=d,value_date=d,bank_account_id=ba.bank_account_id,amount=total,description=coalesce(nullif(p_payload->>'memo',''),'Depósito bancario') where transaction_id=(select transaction_id from journal where journal_id=old.journal_id) and tran_type='DEP_BAN';
 return jsonb_build_object('depositId',p_deposit_id,'transactionNumber',old.deposit_number,'journalId',old.journal_id,'total',total);
end$$;

create or replace function public.delete_bank_deposit(p_deposit_id bigint)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare d bank_deposit%rowtype;tid bigint;
begin
 select * into d from bank_deposit where deposit_id=p_deposit_id and subsidiary_id=active_subsidiary_id() for update;
 if d.deposit_id is null then raise exception 'No se encontró el depósito.';end if;
 select transaction_id into tid from journal where journal_id=d.journal_id;
 update bank_account set balance=balance-d.total_amount where bank_account_id=d.bank_account_id;
 delete from bank_transaction where transaction_id=tid and tran_type='DEP_BAN';
 delete from bank_deposit_line where deposit_id=d.deposit_id; delete from bank_deposit where deposit_id=d.deposit_id;
 delete from journal_support where journal_id=d.journal_id; delete from journal_line where journal_id=d.journal_id; delete from journal where journal_id=d.journal_id; delete from "transaction" where transaction_id=tid;
 return jsonb_build_object('success',true,'number',d.deposit_number);
end$$;

revoke all on function public.bank_deposit_report(jsonb),public.bank_deposit_detail(bigint),public.update_bank_deposit(bigint,jsonb),public.delete_bank_deposit(bigint) from public,anon;
grant execute on function public.bank_deposit_report(jsonb),public.bank_deposit_detail(bigint),public.update_bank_deposit(bigint,jsonb),public.delete_bank_deposit(bigint) to authenticated;
notify pgrst,'reload schema';
