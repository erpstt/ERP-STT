create or replace function public.register_customer_advance(p_payload jsonb) returns jsonb
language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$
declare sid bigint; b public.bank_account; amount numeric; rate numeric; d date; customer_key bigint; period_key bigint; loc bigint; advance_account bigint; n integer;tt bigint;st bigint;num text;tid bigint;jid bigint;pid bigint;r jsonb;
begin
 perform customer_payment_private.access('create');sid:=public.active_subsidiary_id();
 if jsonb_typeof(p_payload) is distinct from 'object' or p_payload ?| array['subsidiary_id','transaction_id','journal_id','status','created_by','currency_id','applications','advances'] then raise exception using errcode='22023',message='Datos de anticipo inválidos.';end if;
 amount:=(p_payload->>'amount')::numeric;d:=(p_payload->>'date')::date;customer_key:=(p_payload->>'customer_id')::bigint;period_key:=(p_payload->>'period_id')::bigint;loc:=nullif(p_payload->>'location_id','')::bigint;
 if not asset_posting_private.finite(amount) or amount<=0 or amount<>round(amount,2) or d is null then raise exception using errcode='22023',message='Indique fecha e importe positivo con dos decimales.';end if;
 if nullif(trim(p_payload->>'reference'),'') is null then raise exception using errcode='22023',message='Indique referencia bancaria.';end if;
 if not exists(select 1 from public.customers c join public.entity_subsidiaries e using(customer_id) where c.customer_id=customer_key and e.subsidiary_id=sid and not coalesce((to_jsonb(c)->>'is_inactive')::boolean,false)) then raise exception using errcode='42501',message='Cliente no disponible.';end if;
 select * into b from public.bank_account where bank_account_id=(p_payload->>'account_id')::bigint and subsidiary_id=sid and not coalesce(is_credit_card,false) for update;
 if not found or not exists(select 1 from public.subsidiary_currencies where subsidiary_id=sid and currency_id=b.currency_id) then raise exception using errcode='42501',message='Banco o moneda no disponible.';end if;
 perform asset_posting_private.account(b.account_id);
 if not exists(select 1 from public.chart_accounts where account_id=b.account_id and category='Activo') or not asset_posting_private.finite(b.balance) then raise exception using errcode='55000',message='Cuenta bancaria inválida.';end if;
 if loc is not null and not inventory_balance_private.location(loc) then raise exception using errcode='42501',message='Ubicación no disponible.';end if;
 perform sales_invoice_private.period(period_key,d);perform customer_payment_private.bank_window(b.bank_account_id,d);
 rate:=sales_invoice_private.sales_invoice_official_exchange_rate(b.currency_id,d,sid);
 select count(*),min(a.account_id) into n,advance_account from public.chart_accounts a where a.account_number='218001' and a.category='Pasivo' and a.accepts_entries and not coalesce(a.is_inactive,false) and (exists(select 1 from public.account_subsidiaries s where s.account_id=a.account_id and s.subsidiary_id=sid and s.is_active) or not exists(select 1 from public.account_subsidiaries s where s.account_id=a.account_id));
 if n<>1 then raise exception using errcode='55000',message='Configure una única cuenta 218001 de Anticipos de clientes para la subsidiaria.';end if;
 perform asset_posting_private.account(advance_account);
 select transaction_type_id into tt from public.transaction_types where abbreviation='COB_CLI';select status_id into st from public.status where code='APROBADO' limit 1;
 begin
 num:=public.next_transaction_number(tt,sid);
 exception when raise_exception then
 if sqlerrm<>'No existe una secuencia para el tipo de transacción y subsidiaria seleccionados.' then raise;end if;
 num:='COB_CLI-'||to_char(clock_timestamp(),'YYYYMMDDHH24MISSUS')||'-'||substr(replace(gen_random_uuid()::text,'-',''),1,8);
end;
 insert into public."transaction"(tran_number,tran_date,transaction_type_id,subsidiary_id,currency_id,exchange_rate,fiscal_period_id,total_amount,status_id,customer_id)values(num,d,tt,sid,b.currency_id,rate,period_key,amount,st,customer_key)returning transaction_id into tid;
 insert into public.journal(journal_number,journal_date,transaction_id,subsidiary_id,currency_id,fiscal_period_id,exchange_rate,memo,journal_type,location_id,total_debit,total_credit,status)values(num,d,tid,sid,b.currency_id,period_key,rate,p_payload->>'memo','ANTICIPO_CLIENTE',loc,amount,amount,'CONTABILIZADO')returning journal_id into jid;
 insert into public.customer_payment(payment_number,transaction_id,customer_id,bank_account_id,payment_date,amount_received,bank_reference,memo,journal_id,currency_id,exchange_rate,fiscal_period_id,location_id,created_by)values(num,tid,customer_key,b.bank_account_id,d,amount,p_payload->>'reference',p_payload->>'memo',jid,b.currency_id,rate,period_key,loc,public.app_user_id())returning payment_id into pid;
 insert into public.journal_line(journal_id,account_id,debit,credit,debit_fx,credit_fx,location_id,note,entity_type,customer_id)values(jid,b.account_id,amount,0,amount*rate,0,loc,p_payload->>'memo','Cliente',customer_key),(jid,advance_account,0,amount,0,amount*rate,loc,p_payload->>'memo','Cliente',customer_key);
 insert into public.bank_transaction(tran_date,value_date,bank_account_id,transaction_id,amount,tran_type,reference_number,description,beneficiary,reconciliation_status)values(d,d,b.bank_account_id,tid,amount,'COBRO_CLIENTE',p_payload->>'reference',p_payload->>'memo',(select company_name from public.customers where customer_id=customer_key),'PENDIENTE_EN_TRANSITO');
 update public.bank_account set balance=balance+amount where bank_account_id=b.bank_account_id;
 perform public.sync_journal_gl_impacts(jid);
 r:=customer_payment_private.check_result(jsonb_build_object('id',pid,'number',num,'journalId',jid,'total',amount,'grossTotal',0,'advanceCreatedTotal',amount,'cashTotal',amount,'rate',rate));
 return r;
end$$;

revoke all on function public.register_customer_advance(jsonb) from public,anon,authenticated,service_role;grant execute on function public.register_customer_advance(jsonb) to authenticated;
notify pgrst,'reload schema';
