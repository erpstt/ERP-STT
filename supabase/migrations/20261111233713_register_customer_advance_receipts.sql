begin;
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
 num:=public.next_transaction_number(tt,sid);
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
revoke all on function public.register_customer_advance(jsonb) from public,anon,authenticated,service_role;
grant execute on function public.register_customer_advance(jsonb) to authenticated;
-- Keep the original secured report and enrich receipt rows without changing historic amounts.
alter function public.customer_payment_report(jsonb) rename to customer_payment_report_before_advance_receipts;
revoke all on function public.customer_payment_report_before_advance_receipts(jsonb) from public,anon,authenticated,service_role;
create function public.customer_payment_report(p_filters jsonb) returns jsonb language plpgsql stable security definer set search_path=pg_catalog,public,pg_temp as $$declare r jsonb;begin
 perform customer_payment_private.access('view');r:=public.customer_payment_report_before_advance_receipts(p_filters);
 return r||jsonb_build_object('rows',(select coalesce(jsonb_agg(x||jsonb_build_object('advanceCreatedTotal',coalesce((select p.amount_received from public.customer_payment p join public.journal j using(journal_id) where p.payment_id=(x->>'id')::bigint and j.journal_type='ANTICIPO_CLIENTE'),0))),'[]') from jsonb_array_elements(r->'rows') x));end$$;
revoke all on function public.customer_payment_report(jsonb) from public,anon,authenticated,service_role;grant execute on function public.customer_payment_report(jsonb) to authenticated;
create function customer_payment_private.protect_advance_receipt_edit()returns trigger language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$begin if exists(select 1 from public.journal where journal_id=old.journal_id and journal_type='ANTICIPO_CLIENTE') then raise exception using errcode='55000',message='El anticipo debe eliminarse y registrarse nuevamente si aún no fue aplicado.';end if;return new;end$$;
revoke all on function customer_payment_private.protect_advance_receipt_edit() from public,anon,authenticated,service_role;
create trigger protect_advance_receipt_edit before update on public.customer_payment for each row execute function customer_payment_private.protect_advance_receipt_edit();
create function customer_payment_private.lock_advance_receipt(pid bigint) returns public.customer_payment language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$
declare p public.customer_payment;sid bigint:=asset_posting_private.identity();gross numeric;fee numeric;cash numeric;begin
 select cp.* into p from public.customer_payment cp join public."transaction" t using(transaction_id) where cp.payment_id=pid and t.subsidiary_id=sid;
 if not found then raise exception using errcode='42501',message='Cobro no disponible.';end if;
 perform 1 from public."transaction" where transaction_id=p.transaction_id for update;perform 1 from public.journal where journal_id=p.journal_id for update;select * into p from public.customer_payment where payment_id=pid for update;
 if exists(select 1 from public.customer_advance_application where payment_id=pid) or exists(select 1 from public.bank_deposit where customer_payment_id=pid) or exists(select 1 from public.journal where reversed_from_journal_id=p.journal_id) then raise exception using errcode='55000',message='El cobro tiene anticipos, depósitos o historia protegida.';end if;
 gross:=p.amount_received;
 if exists(select 1 from public.customer_payment_application where payment_id=pid) or exists(select 1 from public.customer_payment_bank_fee where payment_id=pid) or exists(select 1 from public.customer_advance_application a join public.journal_line l on l.journal_line_id=a.source_journal_line_id where l.journal_id=p.journal_id) or coalesce((select sum(l.credit-l.debit) from public.journal_line l join public.chart_accounts c using(account_id) where l.journal_id=p.journal_id and c.account_number='218001' and l.customer_id=p.customer_id),0)<>gross then raise exception using errcode='55000',message='Anticipo aplicado o con origen inconsistente.';end if;
 select coalesce(sum(amount),0) into fee from public.customer_payment_bank_fee where payment_id=pid;cash:=p.amount_received-fee;
 if p.status is distinct from 'APROBADO' or not asset_posting_private.finite(p.amount_received) or p.amount_received<=0 or gross<=0 or not asset_posting_private.finite(fee) or fee<0 or cash<0
 or abs(gross-coalesce((select sum(withholding_amount) from public.customer_payment_withholding where payment_id=pid),0)-p.amount_received)>.000001
 or not exists(select 1 from public.journal j join public."transaction" t on t.transaction_id=p.transaction_id join public.transaction_types tt using(transaction_type_id) join public.bank_account b on b.bank_account_id=p.bank_account_id where j.journal_id=p.journal_id and j.transaction_id=t.transaction_id and tt.abbreviation='COB_CLI' and j.journal_type='ANTICIPO_CLIENTE' and j.status='CONTABILIZADO' and t.subsidiary_id=sid and j.subsidiary_id=sid and b.subsidiary_id=sid and b.currency_id=p.currency_id and t.currency_id=p.currency_id and j.currency_id=p.currency_id and j.journal_date=p.payment_date and t.tran_date=p.payment_date and j.fiscal_period_id=p.fiscal_period_id and t.fiscal_period_id=p.fiscal_period_id and j.exchange_rate=p.exchange_rate and t.exchange_rate=p.exchange_rate and t.total_amount=gross and j.journal_number=p.payment_number and t.tran_number=p.payment_number)
 then raise exception using errcode='55000',message='El origen contable del cobro requiere revisión.';end if;
 perform sales_invoice_private.period(p.fiscal_period_id,p.payment_date);perform customer_payment_private.bank_window(p.bank_account_id,p.payment_date);
 perform 1 from public.bank_transaction where transaction_id=p.transaction_id for update;
 if (select count(*) from public.bank_transaction where transaction_id=p.transaction_id)<>(case when cash>.000001 then 1 else 0 end)
 or exists(select 1 from public.bank_transaction bt where bt.transaction_id=p.transaction_id and(bt.bank_account_id is distinct from p.bank_account_id or bt.tran_type is distinct from 'COBRO_CLIENTE' or abs(bt.amount-cash)>.000001 or bt.tran_date is distinct from p.payment_date or bt.reconciliation_status is distinct from 'PENDIENTE_EN_TRANSITO' or coalesce(bt.is_opening_balance,false) or bt.opening_bank_item_id is not null or bt.opening_balance_line_id is not null))
 or exists(select 1 from public.bank_transaction bt join public.bank_reconciliation_match m using(bank_tran_id) where bt.transaction_id=p.transaction_id)
 or exists(select 1 from public.bank_transaction bt join public.quadratic_reconciliation_matches m using(bank_tran_id) where bt.transaction_id=p.transaction_id)
 or exists(select 1 from public.bank_transaction bt join public.quadratic_reconciliation_items m using(bank_tran_id) where bt.transaction_id=p.transaction_id)
 then raise exception using errcode='55000',message='El movimiento bancario está conciliado, vinculado o requiere revisión.';end if;return p;end$$;

revoke all on function customer_payment_private.lock_advance_receipt(bigint) from public,anon,authenticated,service_role;
alter function public.delete_customer_payment(bigint) rename to delete_customer_payment_before_advance_receipts;
revoke all on function public.delete_customer_payment_before_advance_receipts(bigint) from public,anon,authenticated,service_role;
create function public.delete_customer_payment(p_payment_id bigint)returns jsonb language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$declare p public.customer_payment;sid bigint;begin
 sid:=customer_payment_private.access('delete');
 select cp.* into p from public.customer_payment cp join public."transaction" t using(transaction_id) where cp.payment_id=p_payment_id and t.subsidiary_id=sid;
 if not found then raise exception using errcode='42501',message='Cobro no disponible.';end if;
 if not exists(select 1 from public.journal where journal_id=p.journal_id and journal_type='ANTICIPO_CLIENTE') then return public.delete_customer_payment_before_advance_receipts(p_payment_id);end if;
 perform 1 from public.bank_account where bank_account_id=p.bank_account_id for update;
 p:=customer_payment_private.lock_advance_receipt(p_payment_id);
 return customer_payment_private.delete_customer_payment(p_payment_id);
end$$;
revoke all on function public.delete_customer_payment(bigint) from public,anon,authenticated,service_role;grant execute on function public.delete_customer_payment(bigint) to authenticated;

notify pgrst,'reload schema';
commit;
