-- Extends the synthetic identity fixture. Local in-memory PostgreSQL only.
alter table public.users add column first_name text,add column last_name text,add column email text;
alter table public.currencies add column symbol text default '$';
alter table public.fiscal_periods add column start_date date;
alter table public.chart_accounts add column is_inactive boolean default false,add column is_summary boolean default false;
create table public.banks(bank_id bigint primary key,bank_name text);
create table public.account_subsidiaries(account_id bigint,subsidiary_id bigint,is_active boolean default true);
create table public.bank_account(bank_account_id bigint primary key,account_number text,bank_id bigint references banks,
 subsidiary_id bigint,currency_id bigint,account_id bigint,balance numeric,is_credit_card boolean default false);
create table public.exchange_rates(from_currency_id bigint,to_currency_id bigint,effective_date date,spot_rate numeric);
create table public.transaction_types(transaction_type_id bigint primary key,abbreviation text);
create table public.status(status_id bigint primary key,code text,module text);
create sequence public.synthetic_transfer_number;
create function public.next_transaction_number(bigint,bigint) returns text language sql as $$
 select 'SYNTHETIC-TRF-'||nextval('public.synthetic_transfer_number')::text
$$;
create table public."transaction"(transaction_id bigint generated always as identity primary key,tran_number text,tran_date date,
 transaction_type_id bigint,subsidiary_id bigint,currency_id bigint,exchange_rate numeric,fiscal_period_id bigint,total_amount numeric,status_id bigint);
create table public.journal(journal_id bigint generated always as identity primary key,journal_number text,journal_date date,
 transaction_id bigint,subsidiary_id bigint,currency_id bigint,fiscal_period_id bigint,exchange_rate numeric,memo text,journal_type text,
 total_debit numeric,total_credit numeric,status text);
create table public.journal_line(journal_line_id bigint generated always as identity primary key,journal_id bigint,account_id bigint,
 debit numeric,credit numeric,debit_fx numeric,credit_fx numeric,note text);
create table public.bank_transaction(bank_transaction_id bigint generated always as identity primary key,tran_date date,value_date date,
 bank_account_id bigint,transaction_id bigint,amount numeric,tran_type text,reference_number text,description text,reconciliation_status text);
create table public.bank_transfer(transfer_id bigint generated always as identity primary key,transfer_number text,from_account_id bigint,
 to_account_id bigint,transaction_id bigint,amount numeric,transfer_date date);

update public.role_access_matrix set resource_key='banking:bank-transfers';
insert into public.banks values(1,'Synthetic bank');
insert into public.chart_accounts(account_id,account_number,account_name,category) values
 (101,'101','Synthetic bank A','Activo'),(102,'102','Synthetic bank B','Activo'),
 (103,'103','Comisión sintética','Gasto'),(104,'104','Comisión ajena','Gasto');
insert into public.account_subsidiaries values(101,1,true),(102,1,true),(103,1,true),(104,2,true);
insert into public.bank_account values
 (1,'DEMO-A',1,1,1,101,1000,false),(2,'DEMO-B',1,1,1,102,1000,false),
 (3,'DEMO-FOREIGN',1,2,2,104,1000,false),(4,'DEMO-BAD-LEDGER',1,1,1,104,1000,false);
insert into public.fiscal_periods values(10,1,'2026-10-31',false,'2026-10-01');
insert into public.transaction_types values(1,'TRF_BAN');
insert into public.status values(1,'APROBADO','Transacciones');
