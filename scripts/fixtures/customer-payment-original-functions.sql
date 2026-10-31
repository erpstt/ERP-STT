CREATE OR REPLACE FUNCTION public.validate_customer_payment_application_receivable()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare allowed numeric;used numeric;
begin
 select coalesce(nullif(receivable_amount,0),total_amount)into allowed from invoice where invoice_id=new.invoice_id;
 select coalesce(sum(amount),0)into used from customer_payment_application where invoice_id=new.invoice_id and application_id<>coalesce(new.application_id,-1);
 if used+new.amount>allowed+0.000001 then raise exception 'El cobro supera el saldo pendiente de la factura después de retenciones.';end if;
 return new;
end$function$;

CREATE OR REPLACE FUNCTION public.protect_applied_customer_advance()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$begin if exists(select 1 from customer_advance_application where payment_id=old.payment_id)then raise exception'El cobro aplicó anticipos y no puede modificarse ni eliminarse directamente.';end if;return case when tg_op='DELETE'then old else new end;end$function$;

CREATE OR REPLACE FUNCTION public.customer_payment_advance_detail(p_payment_id bigint)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
select coalesce(jsonb_agg(jsonb_build_object('id',a.application_id,'sourceLineId',a.source_journal_line_id,'number',j.journal_number,'date',j.journal_date,'account',c.account_number||' · '||c.account_name,'amount',a.amount)order by a.application_id),'[]')
from customer_advance_application a join customer_payment p using(payment_id)join "transaction" t using(transaction_id)join journal_line l on l.journal_line_id=a.source_journal_line_id join journal j on j.journal_id=l.journal_id join chart_accounts c on c.account_id=l.account_id where a.payment_id=p_payment_id and t.subsidiary_id=active_subsidiary_id()$function$;

CREATE OR REPLACE FUNCTION public.customer_payment_options()
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
select jsonb_build_object('subsidiary',jsonb_build_object('id',s.subsidiary_id,'name',s.name,'currencyId',s.currency_id),'location',(select jsonb_build_object('id',l.location_id,'name',l.name)from locations l left join location_subsidiaries ls using(location_id)where l.subsidiary_id=s.subsidiary_id or ls.subsidiary_id=s.subsidiary_id order by l.location_id limit 1),'customers',coalesce((select jsonb_agg(jsonb_build_object('id',c.customer_id,'name',c.company_name))from customers c join entity_subsidiaries es using(customer_id)where es.subsidiary_id=s.subsidiary_id),'[]'),'accounts',coalesce((select jsonb_agg(jsonb_build_object('id',ba.bank_account_id,'bank',b.bank_name,'number',ba.account_number,'currencyId',ba.currency_id,'currency',cu.currency_code,'balance',ba.balance))from bank_account ba join banks b using(bank_id)join currencies cu using(currency_id)where ba.subsidiary_id=s.subsidiary_id and not coalesce(ba.is_credit_card,false)),'[]'),'periods',coalesce((select jsonb_agg(jsonb_build_object('id',fiscal_period_id,'name',period_name,'start',start_date,'end',end_date))from fiscal_periods where subsidiary_id=s.subsidiary_id and not is_closed and not coalesce(ar_closed,false)),'[]'),'rates',coalesce((select jsonb_agg(jsonb_build_object('fromCurrencyId',from_currency_id,'toCurrencyId',to_currency_id,'date',effective_date,'rate',spot_rate)order by effective_date desc)from exchange_rates),'[]'),'invoices',coalesce((select jsonb_agg(jsonb_build_object('id',i.invoice_id,'number',i.invoice_number,'customerId',i.customer_id,'date',i.invoice_date,'dueDate',i.due_date,'currencyId',i.currency_id,'currency',cu.currency_code,'total',i.total_amount,'withholdingTotal',i.withholding_total,'receivable',coalesce(nullif(i.receivable_amount,0),i.total_amount),'paid',coalesce(a.paid,0),'balance',greatest(coalesce(nullif(i.receivable_amount,0),i.total_amount)-coalesce(a.paid,0),0)))from invoice i join currencies cu on cu.currency_id=i.currency_id left join lateral(select sum(amount)paid from customer_payment_application where invoice_id=i.invoice_id)a on true where i.subsidiary_id=s.subsidiary_id and coalesce(nullif(i.receivable_amount,0),i.total_amount)>coalesce(a.paid,0)),'[]'))from subsidiaries s where s.subsidiary_id=active_subsidiary_id()$function$;

CREATE OR REPLACE FUNCTION public.customer_payment_detail(p_payment_id bigint)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$select jsonb_build_object('header',to_jsonb(p)||jsonb_build_object('customer',c.company_name,'bank',b.bank_name,'account',ba.account_number,'currency',cu.currency_code,'subsidiary',s.name,'location',l.name),'applications',coalesce((select jsonb_agg(to_jsonb(a)||jsonb_build_object('invoiceNumber',i.invoice_number,'invoiceTotal',i.total_amount))from customer_payment_application a join invoice i using(invoice_id)where a.payment_id=p.payment_id),'[]'),'impact',coalesce((select jsonb_agg(to_jsonb(jl)||jsonb_build_object('accountNumber',ca.account_number,'accountName',ca.account_name))from journal_line jl join chart_accounts ca using(account_id)where jl.journal_id=p.journal_id),'[]'))from customer_payment p join"transaction"t on t.transaction_id=p.transaction_id join customers c on c.customer_id=p.customer_id join bank_account ba on ba.bank_account_id=p.bank_account_id join banks b using(bank_id)join currencies cu on cu.currency_id=ba.currency_id join subsidiaries s on s.subsidiary_id=t.subsidiary_id left join locations l on l.location_id=p.location_id where p.payment_id=p_payment_id and t.subsidiary_id=active_subsidiary_id()$function$;

CREATE OR REPLACE FUNCTION public.save_customer_payment_without_withholding(p_payload jsonb, p_payment_id bigint DEFAULT NULL::bigint)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$declare sid bigint:=active_subsidiary_id();ba bank_account%rowtype;old customer_payment%rowtype;item jsonb;total numeric:=0;outstanding numeric;tt bigint;st bigint;num text;tid bigint;jid bigint;pid bigint;ar bigint;d date:=(p_payload->>'date')::date;rate numeric;period_key bigint:=(p_payload->>'period_id')::bigint;customer_key bigint:=(p_payload->>'customer_id')::bigint;base bigint;
begin select*into ba from bank_account where bank_account_id=(p_payload->>'account_id')::bigint and subsidiary_id=sid for update;if ba.bank_account_id is null then raise exception'Seleccione una cuenta bancaria de la subsidiaria.';end if;select currency_id into base from subsidiaries where subsidiary_id=sid;rate:=case when ba.currency_id=base then 1 else coalesce((select spot_rate from exchange_rates where from_currency_id=ba.currency_id and to_currency_id=base and effective_date<=d order by effective_date desc limit 1),(select 1/spot_rate from exchange_rates where from_currency_id=base and to_currency_id=ba.currency_id and effective_date<=d order by effective_date desc limit 1))end;if rate is null then raise exception'No existe tipo de cambio para la fecha seleccionada.';end if;if not exists(select 1 from fiscal_periods where fiscal_period_id=period_key and subsidiary_id=sid and d between start_date and end_date and not is_closed and not coalesce(ar_closed,false))then raise exception'No existe período de ventas abierto para la fecha.';end if;if not exists(select 1 from entity_subsidiaries where customer_id=customer_key and subsidiary_id=sid)then raise exception'El cliente no pertenece a la subsidiaria.';end if;if nullif(trim(p_payload->>'reference'),'')is null then raise exception'Ingrese la referencia bancaria.';end if;
for item in select value from jsonb_array_elements(coalesce(p_payload->'applications','[]'))loop if(item->>'amount')::numeric<=0 then continue;end if;select greatest(i.total_amount-coalesce((select sum(a.amount)from customer_payment_application a where a.invoice_id=i.invoice_id and(p_payment_id is null or a.payment_id<>p_payment_id)),0),0)into outstanding from invoice i where i.invoice_id=(item->>'invoice_id')::bigint and i.customer_id=customer_key and i.subsidiary_id=sid;if outstanding is null then raise exception'La factura no corresponde al cliente.';end if;if(item->>'amount')::numeric>outstanding then raise exception'El cobro supera el saldo pendiente de %.',round(outstanding,2);end if;total:=total+(item->>'amount')::numeric;end loop;if total<=0 then raise exception'Seleccione al menos una factura e indique el importe a cobrar.';end if;
select ca.account_id into ar from chart_accounts ca where ca.category='Activo'and ca.accepts_entries and not ca.is_inactive and ca.account_name~*'cuenta.*por cobrar|cliente'and(ca.account_id in(select account_id from account_subsidiaries where subsidiary_id=sid and is_active)or not exists(select 1 from account_subsidiaries where subsidiary_id=sid))order by ca.account_id limit 1;if ar is null then raise exception'No se encontró la cuenta contable de clientes.';end if;
if p_payment_id is null then select transaction_type_id into tt from transaction_types where abbreviation='COB_CLI';select status_id into st from status where code='APROBADO'limit 1;begin num:=next_transaction_number(tt,sid);exception when others then num:='COB_CLI-'||to_char(clock_timestamp(),'YYYYMMDDHH24MISSMS');end;insert into"transaction"(tran_number,tran_date,transaction_type_id,subsidiary_id,currency_id,exchange_rate,fiscal_period_id,total_amount,status_id,customer_id)values(num,d,tt,sid,ba.currency_id,rate,period_key,total,st,customer_key)returning transaction_id into tid;insert into journal(journal_number,journal_date,transaction_id,subsidiary_id,currency_id,fiscal_period_id,exchange_rate,memo,journal_type,location_id,total_debit,total_credit,status)values(num,d,tid,sid,ba.currency_id,period_key,rate,p_payload->>'memo','COBRO_CLIENTE',nullif(p_payload->>'location_id','')::bigint,total,total,'CONTABILIZADO')returning journal_id into jid;insert into customer_payment(payment_number,transaction_id,customer_id,bank_account_id,payment_date,amount_received,bank_reference,memo,journal_id,currency_id,exchange_rate,fiscal_period_id,location_id,created_by)values(num,tid,customer_key,ba.bank_account_id,d,total,p_payload->>'reference',p_payload->>'memo',jid,ba.currency_id,rate,period_key,nullif(p_payload->>'location_id','')::bigint,app_user_id())returning payment_id into pid;else select cp.*into old from customer_payment cp join"transaction"t using(transaction_id)where cp.payment_id=p_payment_id and t.subsidiary_id=sid for update;if old.payment_id is null then raise exception'Cobro no encontrado.';end if;pid:=old.payment_id;num:=old.payment_number;tid:=old.transaction_id;jid:=old.journal_id;update bank_account set balance=balance-old.amount_received where bank_account_id=old.bank_account_id;delete from customer_payment_application where payment_id=pid;delete from journal_line where journal_id=jid;update customer_payment set customer_id=customer_key,bank_account_id=ba.bank_account_id,payment_date=d,amount_received=total,bank_reference=p_payload->>'reference',memo=p_payload->>'memo',currency_id=ba.currency_id,exchange_rate=rate,fiscal_period_id=period_key,location_id=nullif(p_payload->>'location_id','')::bigint where payment_id=pid;update"transaction"set tran_date=d,currency_id=ba.currency_id,exchange_rate=rate,fiscal_period_id=period_key,total_amount=total,customer_id=customer_key where transaction_id=tid;update journal set journal_date=d,currency_id=ba.currency_id,exchange_rate=rate,fiscal_period_id=period_key,memo=p_payload->>'memo',total_debit=total,total_credit=total where journal_id=jid;update bank_transaction set tran_date=d,value_date=d,bank_account_id=ba.bank_account_id,amount=total,reference_number=p_payload->>'reference',description=p_payload->>'memo'where transaction_id=tid;end if;
insert into journal_line(journal_id,account_id,debit,credit,debit_fx,credit_fx,location_id,note,entity_type,customer_id)values(jid,ba.account_id,total,0,total*rate,0,nullif(p_payload->>'location_id','')::bigint,p_payload->>'memo','Cliente',customer_key),(jid,ar,0,total,0,total*rate,nullif(p_payload->>'location_id','')::bigint,p_payload->>'memo','Cliente',customer_key);for item in select value from jsonb_array_elements(p_payload->'applications')loop if(item->>'amount')::numeric>0 then insert into customer_payment_application(payment_id,invoice_id,amount,application_date)values(pid,(item->>'invoice_id')::bigint,(item->>'amount')::numeric,d);end if;end loop;if p_payment_id is null then insert into bank_transaction(tran_date,value_date,bank_account_id,transaction_id,amount,tran_type,reference_number,description,beneficiary,reconciliation_status)values(d,d,ba.bank_account_id,tid,total,'COBRO_CLIENTE',p_payload->>'reference',p_payload->>'memo',(select company_name from customers where customer_id=customer_key),'PENDIENTE_EN_TRANSITO');end if;update bank_account set balance=balance+total where bank_account_id=ba.bank_account_id;perform sync_journal_gl_impacts(jid);return jsonb_build_object('id',pid,'number',num,'journalId',jid,'total',total,'rate',rate);end$function$;

CREATE OR REPLACE FUNCTION public.customer_payment_report(p_filters jsonb)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$select jsonb_build_object('rows',coalesce(jsonb_agg(jsonb_build_object('id',p.payment_id,'number',p.payment_number,'date',p.payment_date,'customer',c.company_name,'bank',b.bank_name,'account',ba.account_number,'currency',cu.currency_code,'reference',p.bank_reference,'amount',p.amount_received,'status',p.status)order by p.payment_date desc,p.payment_id desc),'[]'))from customer_payment p join"transaction"t on t.transaction_id=p.transaction_id join customers c on c.customer_id=p.customer_id join bank_account ba on ba.bank_account_id=p.bank_account_id join banks b using(bank_id)join currencies cu on cu.currency_id=ba.currency_id where t.subsidiary_id=active_subsidiary_id()and p.payment_date between(p_filters->>'from')::date and(p_filters->>'to')::date$function$;

CREATE OR REPLACE FUNCTION public.save_customer_payment_before_intercompany_receivable(p_payload jsonb, p_payment_id bigint DEFAULT NULL::bigint)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare result jsonb;pid bigint;jid bigint;total numeric;withheld numeric:=0;due numeric;prior_recognized numeric;prior_applied numeric;settlement numeric;current_applied numeric;row record;bank_key bigint;tid bigint;payment_rate numeric;
begin
 result:=save_customer_payment_without_withholding(p_payload,p_payment_id);pid:=(result->>'id')::bigint;jid:=(result->>'journalId')::bigint;total:=(result->>'total')::numeric;payment_rate:=(p_payload->>'rate')::numeric;
 delete from customer_payment_withholding where payment_id=pid;
 for row in select iw.*,a.amount application_amount,i.receivable_amount from customer_payment_application a join invoice i using(invoice_id) join sales_invoice_withholding iw using(invoice_id) where a.payment_id=pid and iw.application_moment='Al aplicar el pago'
 loop
  select coalesce(sum(w.withholding_amount),0)into prior_recognized from customer_payment_withholding w where w.invoice_withholding_id=row.invoice_withholding_id and w.payment_id<>pid;
  select coalesce(sum(a.amount),0)into prior_applied from customer_payment_application a where a.invoice_id=row.invoice_id and a.payment_id<>pid;
  settlement:=greatest(row.receivable_amount,0);current_applied:=row.application_amount;
  due:=case when settlement=0 then 0 when prior_applied+current_applied>=settlement-0.000001 then row.withholding_amount-prior_recognized else least(row.withholding_amount-prior_recognized,round(row.withholding_amount*current_applied/settlement,6))end;
  due:=greatest(due,0);withheld:=withheld+due;
  if due>0 then
   insert into customer_payment_withholding(payment_id,invoice_id,invoice_withholding_id,tax_code_id,asset_account_id,base_applied,withholding_amount)values(pid,row.invoice_id,row.invoice_withholding_id,row.tax_code_id,row.asset_account_id,current_applied,due);
   insert into journal_line(journal_id,account_id,debit,credit,debit_fx,credit_fx,tax_code_id,tax_rate,gross_amount,note,entity_type,customer_id)values(jid,row.asset_account_id,due,0,due*payment_rate,0,row.tax_code_id,row.rate_percentage,row.base_amount,'Retención aplicada durante el cobro','Cliente',(p_payload->>'customer_id')::bigint);
  end if;
 end loop;
 if withheld>total then raise exception 'Las retenciones calculadas superan el importe aplicado.';end if;
 select bank_account_id,transaction_id into bank_key,tid from customer_payment where payment_id=pid;
 if withheld>0 then
  update journal_line set debit=debit-withheld,debit_fx=debit_fx-withheld*payment_rate where journal_id=jid and account_id=(select account_id from bank_account where bank_account_id=bank_key);
  update bank_account set balance=balance-withheld where bank_account_id=bank_key;
  update bank_transaction set amount=amount-withheld where transaction_id=tid;
 end if;
 update customer_payment set amount_received=total-withheld where payment_id=pid;
 perform sync_journal_gl_impacts(jid);
 return result||jsonb_build_object('withholdingTotal',withheld,'cashTotal',total-withheld);
end$function$;

CREATE OR REPLACE FUNCTION public.save_customer_payment_with_advances_before_intercompany_receiva(p_payload jsonb, p_payment_id bigint DEFAULT NULL::bigint)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare result jsonb;gross numeric;advances numeric;withheld numeric;
begin
 result:=save_customer_payment_with_advances_without_withholding_total(p_payload,p_payment_id);
 gross:=coalesce((result->>'grossTotal')::numeric,(result->>'total')::numeric,0);
 advances:=coalesce((result->>'advanceTotal')::numeric,0);withheld:=coalesce((result->>'withholdingTotal')::numeric,0);
 return result||jsonb_build_object('cashTotal',greatest(gross-advances-withheld,0));
end$function$;

CREATE OR REPLACE FUNCTION public.customer_payment_edit_options(p_payment_id bigint)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  result jsonb;
  invoice_options jsonb;
  current_payment_is_active boolean;
begin
  select upper(coalesce(p.status,'APROBADO'))not in('ANULADO','CANCELADO')
      and upper(coalesce(st.code,'APROBADO'))not in('ANULADO','CANCELADO')
    into current_payment_is_active
  from customer_payment p
  join "transaction" t using(transaction_id)
  left join status st on st.status_id=t.status_id
  where p.payment_id=p_payment_id
    and t.subsidiary_id=active_subsidiary_id();

  if not found then
    raise exception 'Cobro no encontrado.';
  end if;

  if not current_payment_is_active then
    raise exception 'Un cobro anulado o cancelado no puede editarse.';
  end if;

  result:=public.customer_payment_options();

  with balances as(
    select
      i.invoice_id,i.invoice_number,i.customer_id,i.invoice_date,i.due_date,
      i.currency_id,cu.currency_code,i.total_amount,i.withholding_total,
      coalesce(nullif(i.receivable_amount,0),i.total_amount)receivable,
      coalesce(d.total,0)debit_notes,
      coalesce(n.total,0)credit_notes,
      coalesce(p.total,0)paid,
      coalesce(current_application.total,0)current_applied
    from invoice i
    join currencies cu using(currency_id)
    left join lateral(
      select sum(dn.amount)total
      from debit_note dn
      left join "transaction" t on t.transaction_id=dn.transaction_id
      left join status st on st.status_id=t.status_id
      where dn.invoice_id=i.invoice_id
        and upper(coalesce(st.code,'APROBADO'))not in('ANULADO','CANCELADO')
    )d on true
    left join lateral(
      select sum(cn.amount)total
      from credit_note cn
      left join "transaction" t on t.transaction_id=cn.transaction_id
      left join status st on st.status_id=t.status_id
      where cn.invoice_id=i.invoice_id
        and upper(coalesce(st.code,'APROBADO'))not in('ANULADO','CANCELADO')
    )n on true
    left join lateral(
      select sum(a.amount)total
      from customer_payment_application a
      join customer_payment cp using(payment_id)
      left join "transaction" t on t.transaction_id=cp.transaction_id
      left join status st on st.status_id=t.status_id
      where a.invoice_id=i.invoice_id
        and upper(coalesce(cp.status,'APROBADO'))not in('ANULADO','CANCELADO')
        and upper(coalesce(st.code,'APROBADO'))not in('ANULADO','CANCELADO')
    )p on true
    left join lateral(
      select sum(a.amount)total
      from customer_payment_application a
      where a.invoice_id=i.invoice_id and a.payment_id=p_payment_id
    )current_application on true
    where i.subsidiary_id=active_subsidiary_id()
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'id',invoice_id,
    'number',invoice_number,
    'customerId',customer_id,
    'date',invoice_date,
    'dueDate',due_date,
    'currencyId',currency_id,
    'currency',currency_code,
    'total',total_amount,
    'withholdingTotal',withholding_total,
    'receivable',receivable,
    'debitNotes',debit_notes,
    'creditNotes',credit_notes,
    'paid',paid,
    'currentApplied',current_applied,
    'balance',greatest(receivable+debit_notes-credit_notes-paid,0),
    'editableBalance',greatest(
      receivable+debit_notes-credit_notes-paid
        +case when current_payment_is_active then current_applied else 0 end,
      0
    )
  )order by invoice_date,invoice_id),'[]'::jsonb)
  into invoice_options
  from balances
  where receivable+debit_notes-credit_notes-paid>.000001
     or current_applied>.000001;

  return jsonb_set(result,'{invoices}',invoice_options,true);
end$function$;

CREATE OR REPLACE FUNCTION public.save_customer_payment(p_payload jsonb, p_payment_id bigint DEFAULT NULL::bigint)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
declare
  result jsonb;
  payment_key bigint;
  account_keys jsonb;
begin
  result:=public.save_customer_payment_before_intercompany_receivable(
    p_payload,p_payment_id
  );
  payment_key:=nullif(result->>'id','')::bigint;
  account_keys:=sales_invoice_private.apply_customer_payment_receivable_accounts(
    payment_key,coalesce(nullif(result->>'total','')::numeric,0)
  );
  return result||jsonb_build_object('receivableAccountIds',account_keys);
end
$function$;

CREATE OR REPLACE FUNCTION public.customer_available_advances()
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
with rows as(
 select jl.journal_line_id id,jl.customer_id,t.currency_id,c.currency_code,j.journal_number,j.journal_date,a.account_id,a.account_number,a.account_name,
 jl.credit-jl.debit original,coalesce((select sum(x.amount)from customer_advance_application x where x.source_journal_line_id=jl.journal_line_id),0)used
 from journal_line jl join journal j using(journal_id) join "transaction" t using(transaction_id) join chart_accounts a using(account_id) join currencies c on c.currency_id=t.currency_id
 where t.subsidiary_id=active_subsidiary_id() and a.account_number='218001' and jl.customer_id is not null and jl.credit>jl.debit and j.status='CONTABILIZADO'
 and(a.account_id in(select account_id from account_subsidiaries where subsidiary_id=active_subsidiary_id() and is_active)or not exists(select 1 from account_subsidiaries where account_id=a.account_id)))
select coalesce(jsonb_agg(jsonb_build_object('id',id,'customerId',customer_id,'currencyId',currency_id,'currencyCode',currency_code,'number',journal_number,'date',journal_date,
 'accountId',account_id,'account',account_number||' · '||account_name,'original',original,'used',used,'available',greatest(original-used,0))order by journal_date,id),'[]')from rows where original>used$function$;

CREATE OR REPLACE FUNCTION public.customer_payment_advance_summary()
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
select coalesce(jsonb_agg(jsonb_build_object('paymentId',x.payment_id,'advanceTotal',x.total)),'[]')from(select a.payment_id,sum(a.amount)total from customer_advance_application a join customer_payment p using(payment_id)join "transaction" t using(transaction_id)where t.subsidiary_id=active_subsidiary_id()group by a.payment_id)x$function$;

CREATE OR REPLACE FUNCTION public.save_customer_payment_with_advances_without_withholding_total(p_payload jsonb, p_payment_id bigint DEFAULT NULL::bigint)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare sid bigint:=active_subsidiary_id();item jsonb;source journal_line%rowtype;sj journal%rowtype;advance_total numeric:=0;gross numeric:=0;available numeric;
 result jsonb;pid bigint;jid bigint;bank_key bigint;payment_rate numeric;
begin
 if p_payment_id is not null and exists(select 1 from customer_advance_application where payment_id=p_payment_id)then raise exception'Un cobro que aplicó anticipos no puede editarse.';end if;
 select coalesce(sum((x->>'amount')::numeric),0)into gross from jsonb_array_elements(coalesce(p_payload->'applications','[]'))x;
 if gross<=0 then raise exception'Seleccione al menos una factura e indique el importe a cobrar.';end if;
 bank_key:=(p_payload->>'account_id')::bigint;payment_rate:=(p_payload->>'rate')::numeric;
 for item in select value from jsonb_array_elements(coalesce(p_payload->'advances','[]'))loop
  if coalesce((item->>'amount')::numeric,0)<=0 then continue;end if;
  select * into source from journal_line where journal_line_id=(item->>'advanceLineId')::bigint for update;
  select j.* into sj from journal j join "transaction" t using(transaction_id)where j.journal_id=source.journal_id and t.subsidiary_id=sid;
  if source.journal_line_id is null or source.customer_id<>(p_payload->>'customer_id')::bigint or sj.currency_id<>(select currency_id from bank_account where bank_account_id=bank_key and subsidiary_id=sid)
   or(select account_number from chart_accounts where account_id=source.account_id)<>'218001' then raise exception'El anticipo no corresponde al cliente, moneda o cuenta 218001.';end if;
  available:=source.credit-source.debit-coalesce((select sum(a.amount)from customer_advance_application a where a.source_journal_line_id=source.journal_line_id),0);
  if(item->>'amount')::numeric>available then raise exception'El anticipo % solo tiene % disponible.',sj.journal_number,round(greatest(available,0),2);end if;
  advance_total:=advance_total+(item->>'amount')::numeric;
 end loop;
 if advance_total>gross then raise exception'Los anticipos no pueden superar el total aplicado a facturas.';end if;
 result:=save_customer_payment(p_payload,p_payment_id);pid:=(result->>'id')::bigint;jid:=(result->>'journalId')::bigint;
 if advance_total>0 then
  update bank_account set balance=balance-advance_total where bank_account_id=bank_key;
  update bank_transaction set amount=amount-advance_total where transaction_id=(select transaction_id from customer_payment where payment_id=pid);
  delete from bank_transaction where transaction_id=(select transaction_id from customer_payment where payment_id=pid)and abs(amount)<.000001;
  if gross=advance_total then delete from journal_line where journal_id=jid and account_id=(select account_id from bank_account where bank_account_id=bank_key);
  else update journal_line set debit=debit-advance_total,debit_fx=greatest(debit_fx-advance_total*payment_rate,0)where journal_id=jid and account_id=(select account_id from bank_account where bank_account_id=bank_key);end if;
  for item in select value from jsonb_array_elements(coalesce(p_payload->'advances','[]'))loop
   if coalesce((item->>'amount')::numeric,0)<=0 then continue;end if;select * into source from journal_line where journal_line_id=(item->>'advanceLineId')::bigint;
   insert into journal_line(journal_id,account_id,debit,credit,debit_fx,credit_fx,note,entity_type,customer_id)values(jid,source.account_id,(item->>'amount')::numeric,0,(item->>'amount')::numeric*payment_rate,0,'Aplicación de anticipo de cliente','Cliente',(p_payload->>'customer_id')::bigint);
   insert into customer_advance_application(payment_id,source_journal_line_id,amount,applied_by)values(pid,source.journal_line_id,(item->>'amount')::numeric,app_user_id());
  end loop;perform sync_journal_gl_impacts(jid);
 end if;
 return result||jsonb_build_object('grossTotal',gross,'advanceTotal',advance_total,'cashTotal',gross-advance_total);
end$function$;

CREATE OR REPLACE FUNCTION public.save_customer_payment_with_advances_before_bank_fee(p_payload jsonb, p_payment_id bigint DEFAULT NULL::bigint)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
declare
  result jsonb;
  payment_key bigint;
  expected_total numeric;
  account_keys jsonb;
begin
  result:=public.save_customer_payment_with_advances_before_intercompany_receivable(
    p_payload,p_payment_id
  );
  payment_key:=nullif(result->>'id','')::bigint;
  expected_total:=coalesce(
    nullif(result->>'grossTotal','')::numeric,
    nullif(result->>'total','')::numeric,
    0
  );
  account_keys:=sales_invoice_private.apply_customer_payment_receivable_accounts(
    payment_key,expected_total
  );
  return result||jsonb_build_object('receivableAccountIds',account_keys);
end
$function$;

CREATE OR REPLACE FUNCTION public.delete_customer_payment_before_bank_fee(p_payment_id bigint)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$declare p customer_payment%rowtype;begin select cp.*into p from customer_payment cp join"transaction"t using(transaction_id)where cp.payment_id=p_payment_id and t.subsidiary_id=active_subsidiary_id()for update;if p.payment_id is null then raise exception'Cobro no encontrado.';end if;update bank_account set balance=balance-p.amount_received where bank_account_id=p.bank_account_id;delete from bank_transaction where transaction_id=p.transaction_id;delete from customer_payment where payment_id=p.payment_id;delete from journal_support where journal_id=p.journal_id;delete from journal_line where journal_id=p.journal_id;delete from gl_impact where transaction_id=p.transaction_id;delete from journal where journal_id=p.journal_id;delete from"transaction"where transaction_id=p.transaction_id;return jsonb_build_object('success',true,'number',p.payment_number);end$function$;

CREATE OR REPLACE FUNCTION public.save_customer_payment_with_advances(p_payload jsonb, p_payment_id bigint DEFAULT NULL::bigint)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  result jsonb;
  payment_row public.customer_payment%rowtype;
  bank_row public.bank_account%rowtype;
  old_fee numeric:=0;
  old_bank_account_id bigint;
  fee numeric:=coalesce(nullif(trim(p_payload->>'bank_fee_amount'),'')::numeric,0);
  available_cash numeric;
  net_cash numeric;
  expense_account_id bigint;
  expense_number text;
  expense_name text;
  bank_line_id bigint;
  bank_line_debit numeric;
  affected integer;
  note_text text;
begin
  if fee<0 then
    raise exception 'La comisión bancaria no puede ser negativa.';
  end if;

  if p_payment_id is not null then
    select coalesce(payment_fee.amount,0),payment.bank_account_id
      into old_fee,old_bank_account_id
    from public.customer_payment payment
    join public."transaction" transaction using(transaction_id)
    left join public.customer_payment_bank_fee payment_fee using(payment_id)
    where payment.payment_id=p_payment_id
      and transaction.subsidiary_id=public.active_subsidiary_id()
    for update of payment;

    -- The legacy save routine reverses amount_received, whose historical
    -- meaning excludes the embedded fee. Restore the prior fee first so an
    -- edit removes exactly the previous net bank movement.
    if coalesce(old_fee,0)>0 then
      update public.bank_account
      set balance=balance+old_fee
      where bank_account_id=old_bank_account_id;
    end if;
  end if;

  result:=public.save_customer_payment_with_advances_before_bank_fee(
    p_payload,p_payment_id
  );

  select payment.* into payment_row
  from public.customer_payment payment
  join public."transaction" transaction using(transaction_id)
  where payment.payment_id=nullif(result->>'id','')::bigint
    and transaction.subsidiary_id=public.active_subsidiary_id()
  for update of payment;

  if payment_row.payment_id is null then
    raise exception 'No fue posible identificar el cobro registrado.';
  end if;

  select * into bank_row
  from public.bank_account
  where bank_account_id=payment_row.bank_account_id
    and subsidiary_id=public.active_subsidiary_id()
  for update;

  if bank_row.bank_account_id is null then
    raise exception 'La cuenta bancaria del cobro no pertenece a la subsidiaria activa.';
  end if;

  available_cash:=coalesce(
    nullif(result->>'cashTotal','')::numeric,
    nullif(result->>'total','')::numeric,
    0
  );

  if fee>available_cash+.000001 then
    raise exception 'La comisión bancaria (%) no puede superar el ingreso bancario disponible (%).',
      round(fee,2),round(greatest(available_cash,0),2);
  end if;

  net_cash:=greatest(available_cash-fee,0);

  if fee>0 then
    expense_account_id:=public.bank_fee_expense_account(public.active_subsidiary_id());
    if expense_account_id is null then
      raise exception 'Configure una cuenta contable activa de Comisiones bancarias o Gastos bancarios para la subsidiaria.';
    end if;

    select account_number,account_name into expense_number,expense_name
    from public.chart_accounts
    where account_id=expense_account_id;

    select line.journal_line_id,line.debit
      into bank_line_id,bank_line_debit
    from public.journal_line line
    where line.journal_id=payment_row.journal_id
      and line.account_id=bank_row.account_id
      and coalesce(line.debit,0)>0
    order by line.journal_line_id
    limit 1
    for update;

    if bank_line_id is null or bank_line_debit+0.000001<fee then
      raise exception 'El débito bancario disponible no permite registrar la comisión indicada.';
    end if;

    if abs(bank_line_debit-fee)<.000001 then
      delete from public.journal_line where journal_line_id=bank_line_id;
    else
      update public.journal_line
      set debit=debit-fee,
          debit_fx=greatest(coalesce(debit_fx,0)-fee*payment_row.exchange_rate,0)
      where journal_line_id=bank_line_id;
    end if;

    note_text:='Comisión bancaria descontada del cobro '||payment_row.payment_number;
    insert into public.journal_line(
      journal_id,account_id,debit,credit,debit_fx,credit_fx,location_id,
      note,entity_type,customer_id
    )values(
      payment_row.journal_id,expense_account_id,fee,0,
      fee*payment_row.exchange_rate,0,payment_row.location_id,
      note_text,'Cliente',payment_row.customer_id
    );

    update public.bank_account
    set balance=balance-fee
    where bank_account_id=bank_row.bank_account_id;

    update public.bank_transaction
    set amount=amount-fee,
        description=coalesce(nullif(payment_row.memo,''),payment_row.payment_number)
          ||' · Comisión bancaria '||to_char(fee,'FM999999999999990.00')
    where transaction_id=payment_row.transaction_id
      and bank_account_id=bank_row.bank_account_id;
    get diagnostics affected=row_count;

    if available_cash>.000001 and affected<>1 then
      raise exception 'No fue posible actualizar el movimiento bancario neto del cobro.';
    end if;

    delete from public.bank_transaction
    where transaction_id=payment_row.transaction_id
      and bank_account_id=bank_row.bank_account_id
      and abs(amount)<.000001;

    insert into public.customer_payment_bank_fee(
      payment_id,expense_account_id,amount,created_by,updated_at
    )values(
      payment_row.payment_id,expense_account_id,fee,public.app_user_id(),now()
    )
    on conflict(payment_id)do update set
      expense_account_id=excluded.expense_account_id,
      amount=excluded.amount,
      updated_at=now();
  else
    delete from public.customer_payment_bank_fee
    where payment_id=payment_row.payment_id;
  end if;

  perform public.sync_journal_gl_impacts(payment_row.journal_id);

  return result||jsonb_build_object(
    'bankFeeTotal',fee,
    'bankFeeAccountId',expense_account_id,
    'bankFeeAccountNumber',expense_number,
    'bankFeeAccountName',expense_name,
    'cashTotal',net_cash
  );
end
$function$;

CREATE OR REPLACE FUNCTION public.delete_customer_payment(p_payment_id bigint)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  result jsonb;
  fee numeric:=0;
  bank_account_key bigint;
begin
  select coalesce(payment_fee.amount,0),payment.bank_account_id
    into fee,bank_account_key
  from public.customer_payment payment
  join public."transaction" transaction using(transaction_id)
  left join public.customer_payment_bank_fee payment_fee using(payment_id)
  where payment.payment_id=p_payment_id
    and transaction.subsidiary_id=public.active_subsidiary_id()
  for update of payment;

  if coalesce(fee,0)>0 then
    update public.bank_account set balance=balance+fee
    where bank_account_id=bank_account_key;
  end if;

  result:=public.delete_customer_payment_before_bank_fee(p_payment_id);
  return result||jsonb_build_object('bankFeeTotal',coalesce(fee,0));
end
$function$;

CREATE OR REPLACE FUNCTION public.customer_payment_bank_fee_summary()
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  select coalesce(jsonb_agg(jsonb_build_object(
    'paymentId',fee.payment_id,
    'amount',fee.amount,
    'expenseAccountId',fee.expense_account_id,
    'expenseAccountNumber',account.account_number,
    'expenseAccountName',account.account_name
  )order by fee.payment_id),'[]'::jsonb)
  from public.customer_payment_bank_fee fee
  join public.customer_payment payment using(payment_id)
  join public."transaction" transaction using(transaction_id)
  join public.chart_accounts account on account.account_id=fee.expense_account_id
  where transaction.subsidiary_id=public.active_subsidiary_id()
$function$;

CREATE OR REPLACE FUNCTION public.customer_payment_bank_fee_detail(p_payment_id bigint)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  select coalesce((
    select jsonb_build_object(
      'paymentId',fee.payment_id,
      'amount',fee.amount,
      'expenseAccountId',fee.expense_account_id,
      'expenseAccountNumber',account.account_number,
      'expenseAccountName',account.account_name
    )
    from public.customer_payment_bank_fee fee
    join public.customer_payment payment using(payment_id)
    join public."transaction" transaction using(transaction_id)
    join public.chart_accounts account on account.account_id=fee.expense_account_id
    where fee.payment_id=p_payment_id
      and transaction.subsidiary_id=public.active_subsidiary_id()
  ),'{}'::jsonb)
$function$;

CREATE OR REPLACE FUNCTION public.customer_payment_realized_fx_account(p_subsidiary_id bigint, p_gain boolean)
 RETURNS bigint
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  account_key bigint;
  required_number text:=case when p_gain then '422001' else '632001' end;
begin
  select account.account_id
    into account_key
  from public.chart_accounts account
  join public.account_subsidiaries assignment using(account_id)
  where account.account_number=required_number
    and assignment.subsidiary_id=p_subsidiary_id
    and assignment.is_active
    and account.accepts_entries
    and not account.is_inactive
  order by account.account_id
  limit 1;

  if account_key is null then
    raise exception 'Configure la cuenta % de diferencia cambiaria realizada para la subsidiaria.',
      required_number;
  end if;
  return account_key;
end
$function$;
