CREATE OR REPLACE FUNCTION public.save_sales_note_without_income_autorent(p_kind text, p_payload jsonb, p_target_id bigint DEFAULT NULL::bigint)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare sid bigint:=active_subsidiary_id();kind text:=upper(p_kind);nid bigint:=p_target_id;iid bigint:=(p_payload->>'invoice_id')::bigint;original invoice%rowtype;tid bigint;jid bigint;tt bigint;status_key bigint;loc bigint;ar bigint;line jsonb;prod products%rowtype;amount numeric;tax numeric;gross numeric;total numeric:=0;number text;tax_account bigint;is_credit boolean:=upper(p_kind)='CREDIT';
begin
 if not exists(select 1 from user_roles ur join role_permissions rp using(role_id) join permissions p using(permission_id) where ur.user_id=app_user_id() and p.code=case when p_target_id is null then 'sales:note:create' else 'sales:note:update' end) then raise exception 'No tiene permiso para crear o modificar notas de clientes.';end if;
 if kind not in('CREDIT','DEBIT') then raise exception 'Tipo de nota no válido.';end if;select * into original from invoice where invoice_id=iid and subsidiary_id=sid;if not found then raise exception 'La factura no pertenece a la subsidiaria activa.';end if;
 if not exists(select 1 from fiscal_periods f where f.fiscal_period_id=(p_payload->>'fiscal_period_id')::bigint and f.subsidiary_id=sid and not f.is_closed and not coalesce(f.ar_closed,false) and (p_payload->>'note_date')::date between f.start_date and f.end_date) then raise exception 'El período de Ventas no está abierto.';end if;
 if jsonb_array_length(coalesce(p_payload->'lines','[]'))<1 then raise exception 'La nota debe contener líneas.';end if;for line in select * from jsonb_array_elements(p_payload->'lines') loop amount:=round((line->>'quantity')::numeric*(line->>'unit_price')::numeric,6);tax:=round(amount*coalesce(nullif(line->>'tax_rate','')::numeric,0)/100,6);total:=total+amount+tax;end loop;if is_credit and total>original.total_amount+.005 then raise exception 'La nota de crédito no puede superar el total de la factura.';end if;
 select transaction_type_id into tt from transaction_types where abbreviation=case when is_credit then 'NC_VEN' else 'ND_VEN' end limit 1;select status_id into status_key from status order by case upper(code) when 'CONTABILIZADO' then 1 when 'APROBADO' then 2 else 3 end limit 1;loc:=original.location_id;select a.account_id into ar from chart_accounts a join account_subsidiaries s using(account_id) where s.subsidiary_id=sid and s.is_active and a.category='Activo' and lower(a.account_name)~'(cuenta.*por cobrar|cliente.*por cobrar)' order by a.account_number limit 1;if ar is null then raise exception 'Configure la cuenta de Cuentas por Cobrar.';end if;
 if nid is null then begin number:=next_transaction_number(tt,sid);exception when others then number:=(case when is_credit then 'NC_VEN-' else 'ND_VEN-' end)||to_char(clock_timestamp(),'YYYYMMDDHH24MISSMS');end;insert into "transaction"(tran_number,tran_date,transaction_type_id,subsidiary_id,currency_id,exchange_rate,fiscal_period_id,total_amount,status_id,customer_id)values(number,(p_payload->>'note_date')::date,tt,sid,(p_payload->>'currency_id')::bigint,(p_payload->>'exchange_rate')::numeric,(p_payload->>'fiscal_period_id')::bigint,total,status_key,original.customer_id)returning transaction_id into tid;insert into journal(journal_number,journal_date,transaction_id,subsidiary_id,currency_id,fiscal_period_id,exchange_rate,memo,journal_type,location_id,total_debit,total_credit,status)values(number,(p_payload->>'note_date')::date,tid,sid,(p_payload->>'currency_id')::bigint,(p_payload->>'fiscal_period_id')::bigint,(p_payload->>'exchange_rate')::numeric,p_payload->>'memo',case when is_credit then 'Nota de Crédito Cliente' else 'Nota de Débito Cliente' end,loc,total,total,'CONTABILIZADO')returning journal_id into jid;if is_credit then insert into credit_note(cn_number,transaction_id,customer_id,invoice_id,amount,note_date,fiscal_period_id,currency_id,exchange_rate,memo,journal_id,location_id)values(number,tid,original.customer_id,iid,total,(p_payload->>'note_date')::date,(p_payload->>'fiscal_period_id')::bigint,(p_payload->>'currency_id')::bigint,(p_payload->>'exchange_rate')::numeric,p_payload->>'memo',jid,loc)returning cn_id into nid;else insert into debit_note(dn_number,transaction_id,customer_id,invoice_id,amount,note_date,fiscal_period_id,currency_id,exchange_rate,memo,journal_id,location_id)values(number,tid,original.customer_id,iid,total,(p_payload->>'note_date')::date,(p_payload->>'fiscal_period_id')::bigint,(p_payload->>'currency_id')::bigint,(p_payload->>'exchange_rate')::numeric,p_payload->>'memo',jid,loc)returning dn_id into nid;end if;else if is_credit then select transaction_id,journal_id into tid,jid from credit_note where cn_id=nid and invoice_id=iid;update credit_note set amount=total,note_date=(p_payload->>'note_date')::date,fiscal_period_id=(p_payload->>'fiscal_period_id')::bigint,currency_id=(p_payload->>'currency_id')::bigint,exchange_rate=(p_payload->>'exchange_rate')::numeric,memo=p_payload->>'memo' where cn_id=nid;else select transaction_id,journal_id into tid,jid from debit_note where dn_id=nid and invoice_id=iid;update debit_note set amount=total,note_date=(p_payload->>'note_date')::date,fiscal_period_id=(p_payload->>'fiscal_period_id')::bigint,currency_id=(p_payload->>'currency_id')::bigint,exchange_rate=(p_payload->>'exchange_rate')::numeric,memo=p_payload->>'memo' where dn_id=nid;end if;delete from journal_line where journal_id=jid;delete from sales_note_line where note_kind=kind and note_id=nid;update "transaction" set tran_date=(p_payload->>'note_date')::date,total_amount=total where transaction_id=tid;update journal set journal_date=(p_payload->>'note_date')::date,total_debit=total,total_credit=total,memo=p_payload->>'memo' where journal_id=jid;end if;
 for line in select * from jsonb_array_elements(p_payload->'lines') loop select * into prod from products where product_id=(line->>'product_id')::bigint;amount:=round((line->>'quantity')::numeric*(line->>'unit_price')::numeric,6);tax:=round(amount*coalesce(nullif(line->>'tax_rate','')::numeric,0)/100,6);gross:=amount+tax;insert into sales_note_line(note_kind,note_id,product_id,account_id,quantity,unit_price,amount,tax_code_id,tax_rate,tax_amount,gross_amount,note,department_id,cost_center_id,class_id)values(kind,nid,prod.product_id,prod.sales_account_id,(line->>'quantity')::numeric,(line->>'unit_price')::numeric,amount,nullif(line->>'tax_code_id','')::bigint,coalesce(nullif(line->>'tax_rate','')::numeric,0),tax,gross,line->>'note',nullif(line->>'department_id','')::bigint,nullif(line->>'cost_center_id','')::bigint,nullif(line->>'class_id','')::bigint);insert into journal_line(journal_id,account_id,debit,credit,debit_fx,credit_fx,tax_code_id,tax_rate,gross_amount,note,entity_type,customer_id,department_id,class_id,location_id,cost_center_id)values(jid,prod.sales_account_id,case when is_credit then amount else 0 end,case when is_credit then 0 else amount end,case when is_credit then amount else 0 end,case when is_credit then 0 else amount end,nullif(line->>'tax_code_id','')::bigint,coalesce(nullif(line->>'tax_rate','')::numeric,0),gross,line->>'note','Cliente',original.customer_id,nullif(line->>'department_id','')::bigint,nullif(line->>'class_id','')::bigint,loc,nullif(line->>'cost_center_id','')::bigint);end loop;insert into journal_line(journal_id,account_id,debit,credit,debit_fx,credit_fx,note,entity_type,customer_id,location_id)values(jid,ar,case when is_credit then 0 else total end,case when is_credit then total else 0 end,case when is_credit then 0 else total end,case when is_credit then total else 0 end,'Cuenta por cobrar','Cliente',original.customer_id,loc);perform sync_journal_gl_impacts(jid);return jsonb_build_object('noteId',nid,'journalId',jid,'transactionNumber',number,'total',total);
end$function$;

CREATE OR REPLACE FUNCTION public.save_sales_note_before_intercompany_receivable(p_kind text, p_payload jsonb, p_target_id bigint DEFAULT NULL::bigint)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  result jsonb;
  normalized_kind text:=upper(p_kind);
  effective_payload jsonb:=p_payload;
  effective_lines jsonb;
  note_key bigint;
  journal_key bigint;
  subsidiary_country_key bigint;
begin
  if normalized_kind not in('CREDIT','DEBIT') then
    raise exception 'Tipo de nota no válido.';
  end if;

  select subsidiary.country_id into subsidiary_country_key
  from public.invoice invoice
  join public.subsidiaries subsidiary using(subsidiary_id)
  where invoice.invoice_id=nullif(p_payload->>'invoice_id','')::bigint
    and invoice.subsidiary_id=public.active_subsidiary_id();

  with supplied as (
    select value item,ordinality
    from jsonb_array_elements(coalesce(p_payload->'lines','[]'::jsonb)) with ordinality
  ), stored as (
    select service_country_id,row_number() over(order by line_id) ordinality
    from public.sales_note_line
    where p_target_id is not null
      and note_kind=normalized_kind and note_id=p_target_id
  ), source as (
    select service_country_id,row_number() over(order by line_id) ordinality
    from public.sales_invoice_line
    where invoice_id=nullif(p_payload->>'invoice_id','')::bigint
  )
  select coalesce(jsonb_agg(
    supplied.item||jsonb_build_object(
      'service_country_id',coalesce(
        case when coalesce(supplied.item->>'service_country_id','') ~ '^[0-9]+$'
          then (supplied.item->>'service_country_id')::bigint end,
        stored.service_country_id,source.service_country_id,subsidiary_country_key
      )
    ) order by supplied.ordinality
  ),'[]'::jsonb)
  into effective_lines
  from supplied
  left join stored using(ordinality)
  left join source using(ordinality);
  effective_payload:=jsonb_set(p_payload,'{lines}',effective_lines,true);

  if exists(
    select 1 from jsonb_array_elements(effective_payload->'lines') item
    where nullif(item->>'service_country_id','') is null
      or coalesce(item->>'service_country_id','') !~ '^[0-9]+$'
      or not exists(
        select 1 from public.countries country
        where country.country_id=(item->>'service_country_id')::bigint
      )
  )then
    raise exception 'Seleccione un País de servicio válido en cada línea de la nota.';
  end if;

  result:=public.save_sales_note_before_service_country_fix(
    p_kind,effective_payload,p_target_id
  );
  note_key:=(result->>'noteId')::bigint;
  journal_key:=(result->>'journalId')::bigint;

  with supplied as (
    select ordinality,(value->>'service_country_id')::bigint service_country_id
    from jsonb_array_elements(effective_payload->'lines') with ordinality
  ), stored as (
    select line_id,row_number() over(order by line_id) ordinality
    from public.sales_note_line
    where note_kind=normalized_kind and note_id=note_key
  )
  update public.sales_note_line line
  set service_country_id=supplied.service_country_id
  from supplied join stored using(ordinality)
  where line.line_id=stored.line_id;

  with commercial as (
    select line.service_country_id,
      row_number() over(order by line.line_id) ordinality
    from public.sales_note_line line
    where line.note_kind=normalized_kind and line.note_id=note_key
  ), accounting as (
    select line.journal_line_id,
      row_number() over(order by line.journal_line_id) ordinality
    from public.journal_line line
    join public.chart_accounts account using(account_id)
    where line.journal_id=journal_key and account.category='Ingreso'
  ), mapped as (
    select accounting.journal_line_id,commercial.service_country_id
    from commercial join accounting using(ordinality)
  )
  update public.journal_line target
  set service_country_id=mapped.service_country_id
  from mapped where target.journal_line_id=mapped.journal_line_id;

  return result;
end
$function$;

CREATE OR REPLACE FUNCTION public.save_sales_note(p_kind text, p_payload jsonb, p_target_id bigint DEFAULT NULL::bigint)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  result jsonb;
  normalized_kind text:=upper(p_kind);
  note_key bigint;
  invoice_key bigint;
  journal_key bigint;
  customer_key bigint;
  subsidiary_key bigint;
  account_key bigint;
  affected integer;
begin
  if normalized_kind not in('CREDIT','DEBIT') then
    raise exception 'Tipo de nota no válido.';
  end if;

  result:=public.save_sales_note_before_intercompany_receivable(
    p_kind,p_payload,p_target_id
  );
  note_key:=nullif(result->>'noteId','')::bigint;

  if normalized_kind='CREDIT' then
    select note.invoice_id,note.journal_id,note.customer_id,invoice.subsidiary_id,
      invoice.receivable_account_id
      into invoice_key,journal_key,customer_key,subsidiary_key,account_key
    from public.credit_note note
    join public.invoice invoice using(invoice_id)
    where note.cn_id=note_key
      and invoice.subsidiary_id=public.active_subsidiary_id();
  else
    select note.invoice_id,note.journal_id,note.customer_id,invoice.subsidiary_id,
      invoice.receivable_account_id
      into invoice_key,journal_key,customer_key,subsidiary_key,account_key
    from public.debit_note note
    join public.invoice invoice using(invoice_id)
    where note.dn_id=note_key
      and invoice.subsidiary_id=public.active_subsidiary_id();
  end if;

  if not found then
    raise exception 'La nota guardada no pertenece a la subsidiaria activa.';
  end if;

  if account_key is null then
    account_key:=public.resolve_customer_receivable_account(
      subsidiary_key,customer_key
    );
    update public.invoice
    set receivable_account_id=account_key
    where invoice_id=invoice_key;
  end if;

  update public.journal_line line
  set account_id=account_key
  where line.journal_id=journal_key
    and line.customer_id=customer_key
    and line.entity_type='Cliente'
    and lower(coalesce(line.note,'')) like 'cuenta por cobrar%';
  get diagnostics affected=row_count;

  if affected<>1 then
    raise exception 'No fue posible identificar una única línea de cuenta por cobrar en la nota.';
  end if;

  perform public.sync_journal_gl_impacts(journal_key);

  return result||jsonb_build_object('receivableAccountId',account_key);
end
$function$;

CREATE OR REPLACE FUNCTION public.save_sales_note_before_service_month_fix(p_kind text, p_payload jsonb, p_target_id bigint DEFAULT NULL::bigint)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  result jsonb;
  normalized_kind text:=upper(p_kind);
  note_key bigint;
  journal_key bigint;
  invoice_key bigint:=(p_payload->>'invoice_id')::bigint;
  source_currency_key bigint;
  source_exchange_rate numeric;
  location_key bigint;
  applied_rate numeric:=0;
  taxable_base numeric:=0;
  autorent_amount numeric:=0;
  original_autorent numeric:=0;
  prior_note_journal_key bigint;
  source_invoice_journal_key bigint;
  subsidiary_key bigint;
  country_key bigint;
  configured boolean;
  configured_rate numeric;
  configured_active_account_key bigint;
  configured_passive_account_key bigint;
  active_account_key bigint;
  passive_account_key bigint;
  original_base numeric:=0;
  credited_autorent numeric:=0;
  credited_base numeric:=0;
  available_autorent numeric:=0;
  available_base numeric:=0;
begin
  if normalized_kind not in('CREDIT','DEBIT') then
    raise exception 'Tipo de nota no valido.';
  end if;

  select i.currency_id,i.exchange_rate into source_currency_key,source_exchange_rate
  from public.invoice i
  where i.invoice_id=invoice_key and i.subsidiary_id=public.active_subsidiary_id();
  if not found then
    raise exception 'La factura no pertenece a la subsidiaria activa.';
  end if;
  if nullif(p_payload->>'currency_id','')::bigint is distinct from source_currency_key then
    raise exception 'La nota debe utilizar la misma moneda de la factura original.';
  end if;
  if normalized_kind='CREDIT'
    and nullif(p_payload->>'exchange_rate','')::numeric is distinct from source_exchange_rate then
    raise exception 'La nota de credito debe utilizar el mismo tipo de cambio de la factura original para reversar exactamente su autorretencion.';
  end if;

  if p_target_id is not null then
    if normalized_kind='CREDIT' then
      select n.autorent_percentage_applied,n.journal_id,n.invoice_id
        into applied_rate,prior_note_journal_key,invoice_key
      from public.credit_note n join public.invoice i using(invoice_id)
      where n.cn_id=p_target_id and i.subsidiary_id=public.active_subsidiary_id();
    else
      select n.autorent_percentage_applied,n.journal_id,n.invoice_id
        into applied_rate,prior_note_journal_key,invoice_key
      from public.debit_note n join public.invoice i using(invoice_id)
      where n.dn_id=p_target_id and i.subsidiary_id=public.active_subsidiary_id();
    end if;
    if found and applied_rate>0 then
      select l.account_id into active_account_key
      from public.journal_line l where l.journal_id=prior_note_journal_key
        and l.note='Autorretencion de renta - anticipo'
        and(case when normalized_kind='CREDIT' then l.credit else l.debit end)>0
      order by l.journal_line_id limit 1;
      select l.account_id into passive_account_key
      from public.journal_line l where l.journal_id=prior_note_journal_key
        and l.note='Autorretencion de renta - por pagar'
        and(case when normalized_kind='CREDIT' then l.debit else l.credit end)>0
      order by l.journal_line_id limit 1;
    end if;
  else
    select i.subsidiary_id,i.autorent_percentage_applied,i.autorent_base_amount,
      i.autorent_total_amount,i.journal_id
      into subsidiary_key,applied_rate,original_base,original_autorent,source_invoice_journal_key
    from public.invoice i
    where i.invoice_id=invoice_key and i.subsidiary_id=public.active_subsidiary_id();
    if not found then
      raise exception 'La factura no pertenece a la subsidiaria activa.';
    end if;
    if normalized_kind='DEBIT' then
      select s.country_id,s.applies_income_autorent,s.autorent_percentage,
        s.autorent_active_account_id,s.autorent_passive_account_id
      into country_key,configured,configured_rate,
        configured_active_account_key,configured_passive_account_key
      from public.subsidiaries s where s.subsidiary_id=subsidiary_key;
      if configured then
        perform public.validate_income_autorent_configuration(
          subsidiary_key,country_key,configured,configured_active_account_key,
          configured_passive_account_key,configured_rate
        );
        applied_rate:=configured_rate;
        active_account_key:=configured_active_account_key;
        passive_account_key:=configured_passive_account_key;
      else
        applied_rate:=0;
      end if;
    elsif applied_rate>0 then
      select l.account_id into active_account_key
      from public.journal_line l where l.journal_id=source_invoice_journal_key
        and l.note='Autorretencion de renta - anticipo' and l.debit>0
      order by l.journal_line_id limit 1;
      select l.account_id into passive_account_key
      from public.journal_line l where l.journal_id=source_invoice_journal_key
        and l.note='Autorretencion de renta - por pagar' and l.credit>0
      order by l.journal_line_id limit 1;
    end if;
  end if;

  result:=public.save_sales_note_without_income_autorent(p_kind,p_payload,p_target_id);
  note_key:=(result->>'noteId')::bigint;
  journal_key:=(result->>'journalId')::bigint;

  if normalized_kind='CREDIT' then
    select n.invoice_id,n.location_id into invoice_key,location_key
    from public.credit_note n where n.cn_id=note_key;
  else
    select n.invoice_id,n.location_id into invoice_key,location_key
    from public.debit_note n where n.dn_id=note_key;
  end if;

  if p_target_id is not null then
    select i.subsidiary_id,i.autorent_base_amount,i.autorent_total_amount,i.journal_id
      into subsidiary_key,original_base,original_autorent,source_invoice_journal_key
    from public.invoice i where i.invoice_id=invoice_key;
  end if;

  if applied_rate>0 then
    if active_account_key is null and normalized_kind='CREDIT' then
      select l.account_id into active_account_key
      from public.journal_line l where l.journal_id=source_invoice_journal_key
        and l.note='Autorretencion de renta - anticipo' and l.debit>0
      order by l.journal_line_id limit 1;
    end if;
    if passive_account_key is null and normalized_kind='CREDIT' then
      select l.account_id into passive_account_key
      from public.journal_line l where l.journal_id=source_invoice_journal_key
        and l.note='Autorretencion de renta - por pagar' and l.credit>0
      order by l.journal_line_id limit 1;
    end if;
    if(active_account_key is null or passive_account_key is null)and normalized_kind='DEBIT' then
      select s.country_id,s.applies_income_autorent,s.autorent_percentage,
        s.autorent_active_account_id,s.autorent_passive_account_id
      into country_key,configured,configured_rate,
        configured_active_account_key,configured_passive_account_key
      from public.subsidiaries s where s.subsidiary_id=subsidiary_key;
      if configured then
        perform public.validate_income_autorent_configuration(
          subsidiary_key,country_key,configured,configured_active_account_key,
          configured_passive_account_key,configured_rate
        );
        active_account_key:=configured_active_account_key;
        passive_account_key:=configured_passive_account_key;
      end if;
    end if;
    if active_account_key is null or passive_account_key is null then
      raise exception 'No fue posible recuperar las cuentas historicas de autorretencion de la factura original.';
    end if;

    select round(coalesce(sum(l.amount),0),4)
      into taxable_base
    from public.sales_note_line l
    join public.chart_accounts a using(account_id)
    where l.note_kind=normalized_kind and l.note_id=note_key and a.category='Ingreso';
    autorent_amount:=round(taxable_base*applied_rate,4);
  end if;

  if normalized_kind='CREDIT' then
    select coalesce(sum(n.autorent_base_amount),0),coalesce(sum(n.autorent_total_amount),0)
      into credited_base,credited_autorent
    from public.credit_note n
    where n.invoice_id=invoice_key and n.cn_id<>note_key;
    available_base:=greatest(original_base-credited_base,0);
    available_autorent:=greatest(original_autorent-credited_autorent,0);
    if taxable_base>available_base+0.0001 or autorent_amount>available_autorent+0.0001 then
      raise exception 'La autorretencion reversada por notas de credito no puede superar la autorretencion de la factura original.';
    end if;
    update public.credit_note set
      autorent_base_amount=taxable_base,
      autorent_percentage_applied=applied_rate,
      autorent_total_amount=autorent_amount
    where cn_id=note_key;
  else
    update public.debit_note set
      autorent_base_amount=taxable_base,
      autorent_percentage_applied=applied_rate,
      autorent_total_amount=autorent_amount
    where dn_id=note_key;
  end if;

  delete from public.journal_line
  where journal_id=journal_key
    and note in('Autorretencion de renta - anticipo','Autorretencion de renta - por pagar');

  if autorent_amount>0 and normalized_kind='CREDIT' then
    insert into public.journal_line(
      journal_id,account_id,debit,credit,debit_fx,credit_fx,location_id,note
    )values
      (journal_key,passive_account_key,autorent_amount,0,autorent_amount,0,location_key,
       'Autorretencion de renta - por pagar'),
      (journal_key,active_account_key,0,autorent_amount,0,autorent_amount,location_key,
       'Autorretencion de renta - anticipo');
  elsif autorent_amount>0 then
    insert into public.journal_line(
      journal_id,account_id,debit,credit,debit_fx,credit_fx,location_id,note
    )values
      (journal_key,active_account_key,autorent_amount,0,autorent_amount,0,location_key,
       'Autorretencion de renta - anticipo'),
      (journal_key,passive_account_key,0,autorent_amount,0,autorent_amount,location_key,
       'Autorretencion de renta - por pagar');
  end if;

  update public.journal set
    total_debit=(result->>'total')::numeric+autorent_amount,
    total_credit=(result->>'total')::numeric+autorent_amount
  where journal_id=journal_key;
  update public."transaction" t set total_amount=(result->>'total')::numeric
  from public.journal j
  where j.journal_id=journal_key and t.transaction_id=j.transaction_id;
  perform public.sync_journal_gl_impacts(journal_key);

  return result||jsonb_build_object(
    'autorentBase',taxable_base,
    'autorentPercentageApplied',applied_rate,
    'autorentTotal',autorent_amount
  );
end
$function$;

CREATE OR REPLACE FUNCTION public.save_sales_note_before_service_country_fix(p_kind text, p_payload jsonb, p_target_id bigint DEFAULT NULL::bigint)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  result jsonb;
  normalized_kind text:=upper(p_kind);
  effective_payload jsonb:=p_payload;
  effective_lines jsonb;
  note_key bigint;
  journal_key bigint;
begin
  if normalized_kind not in('CREDIT','DEBIT') then
    raise exception 'Tipo de nota no válido.';
  end if;

  -- Preserve saved months when an older client edits without sending the key.
  if p_target_id is not null then
    with supplied as (
      select value item,ordinality
      from jsonb_array_elements(coalesce(p_payload->'lines','[]'::jsonb)) with ordinality
    ), stored as (
      select service_month,row_number() over(order by line_id) ordinality
      from public.sales_note_line
      where note_kind=normalized_kind and note_id=p_target_id
    )
    select coalesce(jsonb_agg(
      case when supplied.item ? 'service_month' then supplied.item
           else supplied.item||jsonb_build_object('service_month',stored.service_month)
      end order by supplied.ordinality
    ),'[]'::jsonb)
    into effective_lines
    from supplied left join stored using(ordinality);
    effective_payload:=jsonb_set(p_payload,'{lines}',effective_lines,true);
  end if;

  if exists(
    select 1 from jsonb_array_elements(coalesce(effective_payload->'lines','[]'::jsonb)) item
    where nullif(btrim(item->>'service_month'),'') is not null
      and item->>'service_month' !~ '^[0-9]{4}-(0[1-9]|1[0-2])$'
  )then
    raise exception 'Mes de servicio inválido. Utilice el formato AAAA-MM.';
  end if;

  result:=public.save_sales_note_before_service_month_fix(
    p_kind,effective_payload,p_target_id
  );
  note_key:=(result->>'noteId')::bigint;
  journal_key:=(result->>'journalId')::bigint;

  with supplied as (
    select ordinality,nullif(btrim(value->>'service_month'),'') service_month
    from jsonb_array_elements(effective_payload->'lines') with ordinality
  ), stored as (
    select line_id,row_number() over(order by line_id) ordinality
    from public.sales_note_line
    where note_kind=normalized_kind and note_id=note_key
  )
  update public.sales_note_line line
  set service_month=supplied.service_month
  from supplied join stored using(ordinality)
  where line.line_id=stored.line_id;

  with commercial as (
    select line.service_month,row_number() over(order by line.line_id) ordinality
    from public.sales_note_line line
    where line.note_kind=normalized_kind and line.note_id=note_key
  ), accounting as (
    select line.journal_line_id,
      row_number() over(order by line.journal_line_id) ordinality
    from public.journal_line line
    join public.chart_accounts account using(account_id)
    where line.journal_id=journal_key and account.category='Ingreso'
  ), mapped as (
    select accounting.journal_line_id,commercial.service_month
    from commercial join accounting using(ordinality)
  )
  update public.journal_line target
  set service_month=mapped.service_month
  from mapped where target.journal_line_id=mapped.journal_line_id;

  return result;
end
$function$;
