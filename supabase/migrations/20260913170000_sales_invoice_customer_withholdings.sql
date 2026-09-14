alter table public.invoice
  add column if not exists subtotal_amount numeric(24,6) not null default 0,
  add column if not exists tax_total numeric(24,6) not null default 0,
  add column if not exists withholding_total numeric(24,6) not null default 0,
  add column if not exists receivable_amount numeric(24,6) not null default 0;

update public.invoice set receivable_amount=total_amount where receivable_amount=0 and total_amount<>0;

create table if not exists public.sales_invoice_withholding(
  invoice_withholding_id bigint generated always as identity primary key,
  invoice_id bigint not null references public.invoice(invoice_id) on delete cascade,
  entity_rule_id bigint references public.entity_withholding_rules(rule_id),
  tax_code_id bigint not null references public.tax_codes(tax_code_id),
  asset_account_id bigint not null references public.chart_accounts(account_id),
  calculation_base text not null,
  base_amount numeric(24,6) not null,
  rate_percentage numeric(12,6) not null,
  withholding_amount numeric(24,6) not null check(withholding_amount>=0),
  application_moment text not null check(application_moment in('Al registrar la factura','Al aplicar el pago')),
  recognized_at_invoice boolean not null default false,
  created_at timestamptz not null default now(),
  unique(invoice_id,entity_rule_id)
);

create table if not exists public.customer_payment_withholding(
  payment_withholding_id bigint generated always as identity primary key,
  payment_id bigint not null references public.customer_payment(payment_id) on delete cascade,
  invoice_id bigint not null references public.invoice(invoice_id),
  invoice_withholding_id bigint not null references public.sales_invoice_withholding(invoice_withholding_id),
  tax_code_id bigint not null references public.tax_codes(tax_code_id),
  asset_account_id bigint not null references public.chart_accounts(account_id),
  base_applied numeric(24,6) not null,
  withholding_amount numeric(24,6) not null check(withholding_amount>=0),
  created_at timestamptz not null default now(),
  unique(payment_id,invoice_withholding_id)
);

create index if not exists sales_invoice_withholding_invoice_idx on public.sales_invoice_withholding(invoice_id);
create index if not exists customer_payment_withholding_payment_idx on public.customer_payment_withholding(payment_id);
alter table public.sales_invoice_withholding enable row level security;
alter table public.customer_payment_withholding enable row level security;
create policy sales_invoice_withholding_access on public.sales_invoice_withholding for select to authenticated using(exists(select 1 from public.invoice i where i.invoice_id=sales_invoice_withholding.invoice_id and i.subsidiary_id=active_subsidiary_id()));
create policy customer_payment_withholding_access on public.customer_payment_withholding for select to authenticated using(exists(select 1 from public.customer_payment p join public."transaction" t using(transaction_id) where p.payment_id=customer_payment_withholding.payment_id and t.subsidiary_id=active_subsidiary_id()));
grant select on public.sales_invoice_withholding,public.customer_payment_withholding to authenticated;
grant usage,select on sequence public.sales_invoice_withholding_invoice_withholding_id_seq,public.customer_payment_withholding_payment_withholding_id_seq to authenticated;

alter function public.save_sales_invoice(jsonb,bigint) rename to save_sales_invoice_without_withholding;
create function public.save_sales_invoice(payload jsonb,target_invoice_id bigint default null)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare result jsonb;iid bigint;jid bigint;sid bigint:=active_subsidiary_id();customer_key bigint;
 subtotal numeric:=0;taxes numeric:=0;gross numeric:=0;invoice_withheld numeric:=0;all_withheld numeric:=0;
 rule record;calculation_base_amount numeric;calculated_withholding numeric;ar_account bigint;
begin
 if target_invoice_id is not null and exists(select 1 from customer_payment_application where invoice_id=target_invoice_id)then raise exception 'La factura tiene cobros aplicados y sus retenciones ya no pueden recalcularse.';end if;
 result:=save_sales_invoice_without_withholding(payload,target_invoice_id);
 iid:=(result->>'invoiceId')::bigint;jid:=(result->>'journalId')::bigint;customer_key:=(payload->>'customer_id')::bigint;
 select coalesce(sum(amount),0),coalesce(sum(tax_amount),0),coalesce(sum(gross_amount),0) into subtotal,taxes,gross from sales_invoice_line where invoice_id=iid;
 delete from sales_invoice_withholding where invoice_id=iid;
 select jl.account_id into ar_account from journal_line jl join chart_accounts ca using(account_id) where jl.journal_id=jid and jl.debit>0 and ca.category='Activo' and ca.account_name~*'cuenta.*por cobrar|cliente.*por cobrar' order by jl.debit desc limit 1;
 for rule in select r.rule_id,tc.tax_code_id,tc.code_name,tc.rate_percentage,tc.withholding_calculation_base,tc.withholding_application_moment,tt.asset_account_id
  from entity_withholding_rules r join tax_codes tc on tc.tax_code_id=r.tax_code_id join tax_types tt on tt.tax_type_id=tc.tax_type_id
  where r.customer_id=customer_key and r.subsidiary_id=sid and tc.is_withholding and tt.applies_to in('Ventas','Ambos')
 loop
  if rule.asset_account_id is null or not exists(select 1 from account_subsidiaries a where a.account_id=rule.asset_account_id and a.subsidiary_id=sid and a.is_active)then raise exception 'La retención % no tiene una Cuenta Activo vigente para la subsidiaria.',rule.code_name;end if;
  calculation_base_amount:=case rule.withholding_calculation_base when 'Importe de impuestos' then taxes when 'Total de la factura con impuestos' then gross else subtotal end;
  calculated_withholding:=round(calculation_base_amount*rule.rate_percentage/100,6);all_withheld:=all_withheld+calculated_withholding;
  insert into sales_invoice_withholding(invoice_id,entity_rule_id,tax_code_id,asset_account_id,calculation_base,base_amount,rate_percentage,withholding_amount,application_moment,recognized_at_invoice)
  values(iid,rule.rule_id,rule.tax_code_id,rule.asset_account_id,rule.withholding_calculation_base,calculation_base_amount,rule.rate_percentage,calculated_withholding,rule.withholding_application_moment,rule.withholding_application_moment='Al registrar la factura');
  if rule.withholding_application_moment='Al registrar la factura' and calculated_withholding>0 then
   invoice_withheld:=invoice_withheld+calculated_withholding;
   insert into journal_line(journal_id,account_id,debit,credit,debit_fx,credit_fx,tax_code_id,tax_rate,gross_amount,note,entity_type,customer_id)
   values(jid,rule.asset_account_id,calculated_withholding,0,calculated_withholding,0,rule.tax_code_id,rule.rate_percentage,calculation_base_amount,'Retención '||rule.code_name||' al registrar la factura','Cliente',customer_key);
  end if;
 end loop;
 if invoice_withheld>gross then raise exception 'Las retenciones al registrar no pueden superar el total de la factura.';end if;
 if invoice_withheld>0 then update journal_line jl set debit=jl.debit-invoice_withheld,debit_fx=jl.debit_fx-invoice_withheld where jl.journal_id=jid and jl.account_id=ar_account;end if;
 update invoice i set subtotal_amount=subtotal,tax_total=taxes,withholding_total=all_withheld,receivable_amount=gross-invoice_withheld where i.invoice_id=iid;
 perform sync_journal_gl_impacts(jid);
 return result||jsonb_build_object('subtotal',subtotal,'taxTotal',taxes,'withholdingTotal',all_withheld,'withholdingAtInvoice',invoice_withheld,'receivableTotal',gross-invoice_withheld);
end$$;

alter function public.save_customer_payment(jsonb,bigint) rename to save_customer_payment_without_withholding;
create function public.save_customer_payment(p_payload jsonb,p_payment_id bigint default null)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
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
end$$;

create or replace function public.customer_payment_options()returns jsonb language sql stable security definer set search_path=public as $$
select jsonb_build_object('subsidiary',jsonb_build_object('id',s.subsidiary_id,'name',s.name,'currencyId',s.currency_id),'location',(select jsonb_build_object('id',l.location_id,'name',l.name)from locations l left join location_subsidiaries ls using(location_id)where l.subsidiary_id=s.subsidiary_id or ls.subsidiary_id=s.subsidiary_id order by l.location_id limit 1),'customers',coalesce((select jsonb_agg(jsonb_build_object('id',c.customer_id,'name',c.company_name))from customers c join entity_subsidiaries es using(customer_id)where es.subsidiary_id=s.subsidiary_id),'[]'),'accounts',coalesce((select jsonb_agg(jsonb_build_object('id',ba.bank_account_id,'bank',b.bank_name,'number',ba.account_number,'currencyId',ba.currency_id,'currency',cu.currency_code,'balance',ba.balance))from bank_account ba join banks b using(bank_id)join currencies cu using(currency_id)where ba.subsidiary_id=s.subsidiary_id and not coalesce(ba.is_credit_card,false)),'[]'),'periods',coalesce((select jsonb_agg(jsonb_build_object('id',fiscal_period_id,'name',period_name,'start',start_date,'end',end_date))from fiscal_periods where subsidiary_id=s.subsidiary_id and not is_closed and not coalesce(ar_closed,false)),'[]'),'rates',coalesce((select jsonb_agg(jsonb_build_object('fromCurrencyId',from_currency_id,'toCurrencyId',to_currency_id,'date',effective_date,'rate',spot_rate)order by effective_date desc)from exchange_rates),'[]'),'invoices',coalesce((select jsonb_agg(jsonb_build_object('id',i.invoice_id,'number',i.invoice_number,'customerId',i.customer_id,'date',i.invoice_date,'dueDate',i.due_date,'currencyId',i.currency_id,'currency',cu.currency_code,'total',i.total_amount,'withholdingTotal',i.withholding_total,'receivable',coalesce(nullif(i.receivable_amount,0),i.total_amount),'paid',coalesce(a.paid,0),'balance',greatest(coalesce(nullif(i.receivable_amount,0),i.total_amount)-coalesce(a.paid,0),0)))from invoice i join currencies cu on cu.currency_id=i.currency_id left join lateral(select sum(amount)paid from customer_payment_application where invoice_id=i.invoice_id)a on true where i.subsidiary_id=s.subsidiary_id and coalesce(nullif(i.receivable_amount,0),i.total_amount)>coalesce(a.paid,0)),'[]'))from subsidiaries s where s.subsidiary_id=active_subsidiary_id()$$;

create or replace function public.validate_customer_payment_application_receivable()returns trigger language plpgsql set search_path=public,pg_temp as $$
declare allowed numeric;used numeric;
begin
 select coalesce(nullif(receivable_amount,0),total_amount)into allowed from invoice where invoice_id=new.invoice_id;
 select coalesce(sum(amount),0)into used from customer_payment_application where invoice_id=new.invoice_id and application_id<>coalesce(new.application_id,-1);
 if used+new.amount>allowed+0.000001 then raise exception 'El cobro supera el saldo pendiente de la factura después de retenciones.';end if;
 return new;
end$$;
drop trigger if exists customer_payment_application_receivable_guard on public.customer_payment_application;
create trigger customer_payment_application_receivable_guard before insert or update on public.customer_payment_application for each row execute function public.validate_customer_payment_application_receivable();

alter function public.save_customer_payment_with_advances(jsonb,bigint) rename to save_customer_payment_with_advances_without_withholding_total;
create function public.save_customer_payment_with_advances(p_payload jsonb,p_payment_id bigint default null)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare result jsonb;gross numeric;advances numeric;withheld numeric;
begin
 result:=save_customer_payment_with_advances_without_withholding_total(p_payload,p_payment_id);
 gross:=coalesce((result->>'grossTotal')::numeric,(result->>'total')::numeric,0);
 advances:=coalesce((result->>'advanceTotal')::numeric,0);withheld:=coalesce((result->>'withholdingTotal')::numeric,0);
 return result||jsonb_build_object('cashTotal',greatest(gross-advances-withheld,0));
end$$;

revoke all on function public.save_sales_invoice(jsonb,bigint),public.save_customer_payment(jsonb,bigint),public.save_customer_payment_with_advances(jsonb,bigint) from public,anon;
grant execute on function public.save_sales_invoice(jsonb,bigint),public.save_customer_payment(jsonb,bigint),public.save_customer_payment_with_advances(jsonb,bigint) to authenticated;
notify pgrst,'reload schema';
