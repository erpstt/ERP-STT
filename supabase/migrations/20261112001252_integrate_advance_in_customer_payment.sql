create or replace function public.save_customer_payment_with_new_advance(p_payload jsonb,p_payment_id bigint default null)returns jsonb language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$
declare sid bigint;r jsonb;p public.customer_payment;b public.bank_account;added numeric;fee numeric;cash numeric;account_key bigint;expense_key bigint;n integer;bank_line bigint;gross numeric;
begin
 perform customer_payment_private.access('create');sid:=public.active_subsidiary_id();
 added:=coalesce((p_payload->>'new_advance_amount')::numeric,0);fee:=coalesce((p_payload->>'bank_fee_amount')::numeric,0);
 if p_payment_id is not null or added<=0 or not asset_posting_private.finite(added) or added<>round(added,2) or not asset_posting_private.finite(fee) or fee<0 or fee<>round(fee,2) then raise exception using errcode='22023',message='El anticipo nuevo requiere un cobro nuevo e importes positivos con dos decimales.';end if;
 if exists(select 1 from jsonb_array_elements(coalesce(p_payload->'advances','[]')) x where (x->>'amount')::numeric>0) then raise exception using errcode='22023',message='No combine anticipos utilizados con un anticipo nuevo en el mismo cobro.';end if;
 select count(*),min(a.account_id) into n,account_key from public.chart_accounts a where a.account_number='218001' and a.category='Pasivo' and a.accepts_entries and not coalesce(a.is_inactive,false) and (exists(select 1 from public.account_subsidiaries s where s.account_id=a.account_id and s.subsidiary_id=sid and s.is_active) or not exists(select 1 from public.account_subsidiaries s where s.account_id=a.account_id));
 if n<>1 then raise exception using errcode='55000',message='Configure una única cuenta 218001 de Anticipos de clientes.';end if;perform asset_posting_private.account(account_key);
 if jsonb_array_length(coalesce(p_payload->'applications','[]'))=0 then
 r:=public.register_customer_advance(jsonb_build_object('customer_id',p_payload->'customer_id','account_id',p_payload->'account_id','date',p_payload->'date','period_id',p_payload->'period_id','location_id',p_payload->'location_id','reference',p_payload->'reference','memo',p_payload->'memo','amount',added));
 else
 r:=public.save_customer_payment_with_advances((p_payload-'new_advance_amount'-'supports')||jsonb_build_object('bank_fee_amount',0),null);
 select * into p from public.customer_payment where payment_id=(r->>'id')::bigint;
 select * into b from public.bank_account where bank_account_id=p.bank_account_id and subsidiary_id=sid for update;
 select journal_line_id into bank_line from public.journal_line where journal_id=p.journal_id and account_id=b.account_id and debit>0;
 if bank_line is null then insert into public.journal_line(journal_id,account_id,debit,credit,debit_fx,credit_fx,location_id,entity_type,customer_id,note)values(p.journal_id,b.account_id,added,0,added*p.exchange_rate,0,p.location_id,'Cliente',p.customer_id,'Ingreso por anticipo');
 else update public.journal_line set debit=debit+added,debit_fx=debit_fx+added*p.exchange_rate where journal_line_id=bank_line;end if;
 insert into public.journal_line(journal_id,account_id,debit,credit,debit_fx,credit_fx,location_id,entity_type,customer_id,note)values(p.journal_id,account_key,0,added,0,added*p.exchange_rate,p.location_id,'Cliente',p.customer_id,'Anticipo recibido con el cobro');
 update public.customer_payment set amount_received=amount_received+added where payment_id=p.payment_id;
 update public."transaction" set total_amount=total_amount+added where transaction_id=p.transaction_id;
 update public.journal set total_debit=total_debit+added,total_credit=total_credit+added,journal_type='ANTICIPO_CLIENTE' where journal_id=p.journal_id;
 update public.bank_account set balance=balance+added where bank_account_id=b.bank_account_id;
 update public.bank_transaction set amount=amount+added where transaction_id=p.transaction_id;
 if not found then insert into public.bank_transaction(tran_date,value_date,bank_account_id,transaction_id,amount,tran_type,reference_number,description,beneficiary,reconciliation_status)values(p.payment_date,p.payment_date,b.bank_account_id,p.transaction_id,added,'COBRO_CLIENTE',p.bank_reference,p.memo,(select company_name from public.customers where customer_id=p.customer_id),'PENDIENTE_EN_TRANSITO');end if;
 end if;
 select * into p from public.customer_payment where payment_id=(r->>'id')::bigint;select * into b from public.bank_account where bank_account_id=p.bank_account_id and subsidiary_id=sid for update;
 cash:=p.amount_received;
 if fee>cash then raise exception using errcode='22023',message='La comisión no puede superar el ingreso disponible.';end if;
 if fee>0 then
 expense_key:=bank_fee_private.expense_account(sid);perform asset_posting_private.account(expense_key);
 if not exists(select 1 from public.chart_accounts where account_id=expense_key and category='Gasto') then raise exception using errcode='22023',message='Configure una cuenta de gastos para la comisión bancaria.';end if;
 select journal_line_id into bank_line from public.journal_line where journal_id=p.journal_id and account_id=b.account_id and debit>0;
 if bank_line is null then raise exception using errcode='55000',message='No se encontró el débito bancario.';end if;
 update public.journal_line set debit=debit-fee,debit_fx=debit_fx-fee*p.exchange_rate where journal_line_id=bank_line;
 delete from public.journal_line where journal_line_id=bank_line and debit=0;
 insert into public.journal_line(journal_id,account_id,debit,credit,debit_fx,credit_fx,location_id,note,entity_type,customer_id)values(p.journal_id,expense_key,fee,0,fee*p.exchange_rate,0,p.location_id,'Comisión bancaria del cobro','Cliente',p.customer_id);
 update public.bank_account set balance=balance-fee where bank_account_id=b.bank_account_id;
 update public.bank_transaction set amount=amount-fee where transaction_id=p.transaction_id;delete from public.bank_transaction where transaction_id=p.transaction_id and amount=0;
 insert into public.customer_payment_bank_fee(payment_id,expense_account_id,amount,created_by)values(p.payment_id,expense_key,fee,public.app_user_id());
 end if;
 perform public.sync_journal_gl_impacts(p.journal_id);
 select coalesce(sum(amount),0) into gross from public.customer_payment_application where payment_id=p.payment_id;
 r:=customer_payment_private.check_result(r||jsonb_build_object('grossTotal',gross,'advanceCreatedTotal',added,'advanceTotal',0,'bankFeeTotal',fee,'cashTotal',cash-fee));
 if p_payload?'supports' then perform sales_invoice_private.supports(p.journal_id,p_payload->'supports');end if;return r;
end$$;
revoke all on function public.save_customer_payment_with_new_advance(jsonb,bigint) from public,anon,authenticated,service_role;grant execute on function public.save_customer_payment_with_new_advance(jsonb,bigint) to authenticated;

create or replace function customer_payment_private.lock_advance_receipt(pid bigint) returns public.customer_payment language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$
declare p public.customer_payment;sid bigint:=asset_posting_private.identity();gross numeric;fee numeric;cash numeric;begin
 select cp.* into p from public.customer_payment cp join public."transaction" t using(transaction_id) where cp.payment_id=pid and t.subsidiary_id=sid;
 if not found then raise exception using errcode='42501',message='Cobro no disponible.';end if;
 perform 1 from public."transaction" where transaction_id=p.transaction_id for update;perform 1 from public.journal where journal_id=p.journal_id for update;select * into p from public.customer_payment where payment_id=pid for update;
 if exists(select 1 from public.customer_advance_application where payment_id=pid) or exists(select 1 from public.bank_deposit where customer_payment_id=pid) or exists(select 1 from public.journal where reversed_from_journal_id=p.journal_id) then raise exception using errcode='55000',message='El cobro tiene anticipos, depósitos o historia protegida.';end if;
 select coalesce(sum(amount),0) into gross from public.customer_payment_application where payment_id=pid;
 gross:=gross+coalesce((select sum(l.credit-l.debit) from public.journal_line l join public.chart_accounts a using(account_id) where l.journal_id=p.journal_id and a.account_number='218001' and l.customer_id=p.customer_id),0);
 if exists(select 1 from public.customer_advance_application a join public.journal_line l on l.journal_line_id=a.source_journal_line_id where l.journal_id=p.journal_id) then raise exception using errcode='55000',message='El anticipo ya fue aplicado.';end if;
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

create or replace function public.customer_payment_report(p_filters jsonb) returns jsonb language plpgsql stable security definer set search_path=pg_catalog,public,pg_temp as $$declare r jsonb;begin
 perform customer_payment_private.access('view');r:=public.customer_payment_report_before_advance_receipts(p_filters);
 return r||jsonb_build_object('rows',(select coalesce(jsonb_agg(x||jsonb_build_object('advanceCreatedTotal',coalesce((select sum(l.credit-l.debit) from public.customer_payment p join public.journal j using(journal_id) join public.journal_line l using(journal_id) join public.chart_accounts a using(account_id) where p.payment_id=(x->>'id')::bigint and j.journal_type='ANTICIPO_CLIENTE' and a.account_number='218001' and l.customer_id=p.customer_id),0))),'[]') from jsonb_array_elements(r->'rows') x));end$$;
revoke all on function public.customer_payment_report(jsonb) from public,anon,authenticated,service_role;grant execute on function public.customer_payment_report(jsonb) to authenticated;

notify pgrst,'reload schema';
