create table if not exists public.customer_advance_application(
 application_id bigint generated always as identity primary key,
 payment_id bigint not null references customer_payment(payment_id) on delete cascade,
 source_journal_line_id bigint not null references journal_line(journal_line_id),
 amount numeric(24,6) not null check(amount>0),applied_by bigint references users(user_id),
 applied_at timestamptz not null default now(),unique(payment_id,source_journal_line_id));
create index if not exists customer_advance_source_idx on customer_advance_application(source_journal_line_id);
alter table customer_advance_application enable row level security;
drop policy if exists customer_advance_application_read on customer_advance_application;
create policy customer_advance_application_read on customer_advance_application for select to authenticated using(
 exists(select 1 from customer_payment p join "transaction" t using(transaction_id) where p.payment_id=customer_advance_application.payment_id and t.subsidiary_id=active_subsidiary_id()));
revoke all on customer_advance_application from public,anon,authenticated;grant select on customer_advance_application to authenticated;

create or replace function customer_available_advances() returns jsonb language sql stable security definer set search_path=public,pg_temp as $$
with rows as(
 select jl.journal_line_id id,jl.customer_id,t.currency_id,c.currency_code,j.journal_number,j.journal_date,a.account_id,a.account_number,a.account_name,
 jl.credit-jl.debit original,coalesce((select sum(x.amount)from customer_advance_application x where x.source_journal_line_id=jl.journal_line_id),0)used
 from journal_line jl join journal j using(journal_id) join "transaction" t using(transaction_id) join chart_accounts a using(account_id) join currencies c on c.currency_id=t.currency_id
 where t.subsidiary_id=active_subsidiary_id() and a.account_number='218001' and jl.customer_id is not null and jl.credit>jl.debit and j.status='CONTABILIZADO'
 and(a.account_id in(select account_id from account_subsidiaries where subsidiary_id=active_subsidiary_id() and is_active)or not exists(select 1 from account_subsidiaries where account_id=a.account_id)))
select coalesce(jsonb_agg(jsonb_build_object('id',id,'customerId',customer_id,'currencyId',currency_id,'currencyCode',currency_code,'number',journal_number,'date',journal_date,
 'accountId',account_id,'account',account_number||' · '||account_name,'original',original,'used',used,'available',greatest(original-used,0))order by journal_date,id),'[]')from rows where original>used$$;

create or replace function save_customer_payment_with_advances(p_payload jsonb,p_payment_id bigint default null)returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
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
end$$;

create or replace function customer_payment_advance_summary()returns jsonb language sql stable security definer set search_path=public,pg_temp as $$
select coalesce(jsonb_agg(jsonb_build_object('paymentId',x.payment_id,'advanceTotal',x.total)),'[]')from(select a.payment_id,sum(a.amount)total from customer_advance_application a join customer_payment p using(payment_id)join "transaction" t using(transaction_id)where t.subsidiary_id=active_subsidiary_id()group by a.payment_id)x$$;
create or replace function customer_payment_advance_detail(p_payment_id bigint)returns jsonb language sql stable security definer set search_path=public,pg_temp as $$
select coalesce(jsonb_agg(jsonb_build_object('id',a.application_id,'sourceLineId',a.source_journal_line_id,'number',j.journal_number,'date',j.journal_date,'account',c.account_number||' · '||c.account_name,'amount',a.amount)order by a.application_id),'[]')
from customer_advance_application a join customer_payment p using(payment_id)join "transaction" t using(transaction_id)join journal_line l on l.journal_line_id=a.source_journal_line_id join journal j on j.journal_id=l.journal_id join chart_accounts c on c.account_id=l.account_id where a.payment_id=p_payment_id and t.subsidiary_id=active_subsidiary_id()$$;
create or replace function protect_applied_customer_advance()returns trigger language plpgsql security definer set search_path=public,pg_temp as $$begin if exists(select 1 from customer_advance_application where payment_id=old.payment_id)then raise exception'El cobro aplicó anticipos y no puede modificarse ni eliminarse directamente.';end if;return case when tg_op='DELETE'then old else new end;end$$;
drop trigger if exists protect_applied_customer_advance on customer_payment;
create trigger protect_applied_customer_advance before update or delete on customer_payment for each row execute function protect_applied_customer_advance();
revoke all on function customer_available_advances(),save_customer_payment_with_advances(jsonb,bigint),customer_payment_advance_summary(),customer_payment_advance_detail(bigint),protect_applied_customer_advance()from public,anon;
grant execute on function customer_available_advances(),save_customer_payment_with_advances(jsonb,bigint),customer_payment_advance_summary(),customer_payment_advance_detail(bigint)to authenticated;
notify pgrst,'reload schema';

