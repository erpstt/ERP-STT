insert into transaction_types(abbreviation,name,module_category,description)
values('COM_BAN','Comisiones Bancarias','Bancos y Tesorería','Comisiones y gastos cobrados por entidades bancarias.')
on conflict(abbreviation) do update set name=excluded.name,module_category=excluded.module_category,description=excluded.description;

create table if not exists bank_fee(
 fee_id bigint generated always as identity primary key,fee_number text not null unique,fee_date date not null,
 bank_account_id bigint not null references bank_account,expense_account_id bigint not null references chart_accounts,
 reference text,amount numeric(24,6) not null check(amount>0),currency_id bigint not null references currencies,
 exchange_rate numeric(24,10) not null,subsidiary_id bigint not null references subsidiaries,
 fiscal_period_id bigint not null references fiscal_periods,location_id bigint references locations,memo text not null,
 journal_id bigint references journal,transaction_id bigint references "transaction",created_by bigint references users,
 created_at timestamptz not null default now()
);
create index if not exists bank_fee_report_idx on bank_fee(subsidiary_id,fee_date,bank_account_id);
alter table bank_fee enable row level security;
drop policy if exists bank_fee_access on bank_fee;
create policy bank_fee_access on bank_fee for select to authenticated using(subsidiary_id=active_subsidiary_id());

create or replace function bank_fee_expense_account(p_sid bigint)returns bigint language sql stable set search_path=public as $$
 select ca.account_id from chart_accounts ca join account_subsidiaries aus using(account_id)
 where aus.subsidiary_id=p_sid and aus.is_active and ca.accepts_entries and not ca.is_inactive
 and(lower(ca.account_name)like'%comisi%bancar%'or lower(ca.account_name)like'%gasto%bancar%')
 order by case when lower(ca.account_name)like'%comisi%'then 0 else 1 end,ca.account_number limit 1
$$;
create or replace function bank_fee_options()returns jsonb language sql stable security definer set search_path=public as $$
 select jsonb_build_object(
  'subsidiary',jsonb_build_object('id',s.subsidiary_id,'name',s.name),
  'expenseAccount',(select jsonb_build_object('id',ca.account_id,'number',ca.account_number,'name',ca.account_name)from chart_accounts ca where ca.account_id=bank_fee_expense_account(s.subsidiary_id)),
  'accounts',coalesce((select jsonb_agg(jsonb_build_object('id',ba.bank_account_id,'bankId',b.bank_id,'bankName',b.bank_name,'number',ba.account_number,'currencyId',ba.currency_id,'currencyCode',c.currency_code,'ledgerNumber',ca.account_number,'ledgerName',ca.account_name)order by b.bank_name,ba.account_number)from bank_account ba join banks b using(bank_id)join currencies c using(currency_id)join chart_accounts ca on ca.account_id=ba.account_id where ba.subsidiary_id=s.subsidiary_id and not coalesce(ba.is_credit_card,false)),'[]'),
  'periods',coalesce((select jsonb_agg(jsonb_build_object('id',fp.fiscal_period_id,'name',fp.period_name,'start',fp.start_date,'end',fp.end_date))from fiscal_periods fp where fp.subsidiary_id=s.subsidiary_id and not fp.is_closed),'[]')
 )from subsidiaries s where s.subsidiary_id=active_subsidiary_id()
$$;
create or replace function save_bank_fee(p_payload jsonb)returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare sid bigint:=active_subsidiary_id();uid bigint:=app_user_id();ba bank_account%rowtype;expense bigint;
d date:=nullif(p_payload->>'fee_date','')::date;amt numeric:=nullif(p_payload->>'amount','')::numeric;
fp bigint;loc bigint;rate numeric:=1;tt bigint;st bigint;num text;tid bigint;jid bigint;fid bigint;note text;sname text;
begin
 if d is null or coalesce(amt,0)<=0 then raise exception 'Fecha e importe son obligatorios.';end if;
 select*into ba from bank_account where bank_account_id=(p_payload->>'bank_account_id')::bigint and subsidiary_id=sid for update;
 if ba.bank_account_id is null then raise exception 'Seleccione una cuenta bancaria autorizada.';end if;
 if ba.balance<amt then raise exception 'Saldo insuficiente. Disponible: %, requerido: %.',ba.balance,amt;end if;
 select name into sname from subsidiaries where subsidiary_id=sid;expense:=bank_fee_expense_account(sid);
 if expense is null then raise exception 'Configure una cuenta contable de Comisiones bancarias o Gastos bancarios para la subsidiaria.';end if;
 select fiscal_period_id into fp from fiscal_periods where subsidiary_id=sid and d between start_date and end_date and not is_closed limit 1;
 if fp is null then raise exception 'No existe período contable abierto para la fecha.';end if;
 select l.location_id into loc from locations l left join location_subsidiaries ls using(location_id)where l.subsidiary_id=sid or ls.subsidiary_id=sid order by l.location_id limit 1;
 select transaction_type_id into tt from transaction_types where abbreviation='COM_BAN';
 select status_id into st from status where code='APROBADO'and module='Transacciones'limit 1;
 if ba.currency_id<>(select currency_id from subsidiaries where subsidiary_id=sid)then select spot_rate into rate from exchange_rates where from_currency_id=ba.currency_id and to_currency_id=(select currency_id from subsidiaries where subsidiary_id=sid)and effective_date<=d order by effective_date desc limit 1;if rate is null then raise exception 'No existe tipo de cambio para la fecha.';end if;end if;
 begin num:=next_transaction_number(tt,sid);exception when others then num:='COM_BAN-'||to_char(clock_timestamp(),'YYYYMMDDHH24MISSMS');end;note:='Comisiones bancarias - '||sname;
 insert into "transaction"(tran_number,tran_date,transaction_type_id,subsidiary_id,currency_id,exchange_rate,fiscal_period_id,total_amount,status_id)values(num,d,tt,sid,ba.currency_id,rate,fp,amt,st)returning transaction_id into tid;
 insert into journal(journal_number,journal_date,transaction_id,subsidiary_id,currency_id,fiscal_period_id,exchange_rate,memo,journal_type,location_id,total_debit,total_credit,status)values(num,d,tid,sid,ba.currency_id,fp,rate,note,'Comisiones bancarias',loc,amt,amt,'CONTABILIZADO')returning journal_id into jid;
 update "transaction"set transaction_type_id=tt where transaction_id=tid;
 insert into journal_line(journal_id,account_id,debit,credit,debit_fx,credit_fx,location_id,note)values(jid,expense,amt,0,amt*rate,0,loc,note),(jid,ba.account_id,0,amt,0,amt*rate,loc,note);
 insert into bank_fee(fee_number,fee_date,bank_account_id,expense_account_id,reference,amount,currency_id,exchange_rate,subsidiary_id,fiscal_period_id,location_id,memo,journal_id,transaction_id,created_by)values(num,d,ba.bank_account_id,expense,nullif(trim(p_payload->>'reference'),''),amt,ba.currency_id,rate,sid,fp,loc,note,jid,tid,uid)returning fee_id into fid;
 insert into bank_transaction(tran_date,value_date,bank_account_id,transaction_id,amount,tran_type,reference_number,description,reconciliation_status)values(d,d,ba.bank_account_id,tid,-amt,'COM_BAN',p_payload->>'reference',note,'PENDIENTE_EN_TRANSITO');
 update bank_account set balance=balance-amt where bank_account_id=ba.bank_account_id;
 return jsonb_build_object('id',fid,'number',num,'journalId',jid);
end$$;
create or replace function import_bank_fees(p_payload jsonb)returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$declare r jsonb;baid bigint;n int:=0;begin for r in select value from jsonb_array_elements(coalesce(p_payload->'rows','[]'))loop select bank_account_id into baid from bank_account where subsidiary_id=active_subsidiary_id()and account_number=r->>'account'limit 1;if baid is null then raise exception 'No se encontró la cuenta bancaria %.',r->>'account';end if;perform save_bank_fee(jsonb_build_object('bank_account_id',baid,'fee_date',r->>'date','reference',r->>'reference','amount',r->>'amount'));n:=n+1;end loop;if n=0 then raise exception 'El archivo no contiene comisiones.';end if;return jsonb_build_object('created',n);end$$;
create or replace function bank_fee_report(p_filters jsonb default '{}')returns jsonb language sql stable security definer set search_path=public as $$select jsonb_build_object('rows',coalesce(jsonb_agg(jsonb_build_object('id',f.fee_id,'number',f.fee_number,'date',f.fee_date,'reference',f.reference,'bank',b.bank_name,'account',ba.account_number,'currency',c.currency_code,'expenseAccount',ca.account_number||' · '||ca.account_name,'memo',f.memo,'amount',f.amount)order by f.fee_date desc,f.fee_id desc),'[]'))from bank_fee f join bank_account ba using(bank_account_id)join banks b using(bank_id)join currencies c on c.currency_id=f.currency_id join chart_accounts ca on ca.account_id=f.expense_account_id where f.subsidiary_id=active_subsidiary_id()and f.fee_date between coalesce(nullif(p_filters->>'dateFrom','')::date,date_trunc('month',current_date)::date)and coalesce(nullif(p_filters->>'dateTo','')::date,current_date)and(nullif(p_filters->>'accountId','')is null or f.bank_account_id=(p_filters->>'accountId')::bigint)and(nullif(trim(p_filters->>'search'),'')is null or concat_ws(' ',f.fee_number,f.reference,f.memo,b.bank_name,ba.account_number)ilike'%'||trim(p_filters->>'search')||'%')$$;
revoke all on function bank_fee_options(),save_bank_fee(jsonb),import_bank_fees(jsonb),bank_fee_report(jsonb)from public,anon;
grant execute on function bank_fee_options(),save_bank_fee(jsonb),import_bank_fees(jsonb),bank_fee_report(jsonb)to authenticated;
notify pgrst,'reload schema';
