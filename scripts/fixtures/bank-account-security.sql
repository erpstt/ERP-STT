-- Synthetic metadata only, extending the transfer fixture.
alter table public.bank_account alter column bank_account_id add generated always as identity(start with 100);
alter table public.bank_account add column country_id bigint default 1,add column iban text;
alter table public.banks add column country_id bigint default 1;
alter table public.subsidiaries add column country_id bigint default 1;
alter table public.chart_accounts add column if not exists currency_id bigint;
alter table public.chart_accounts add column if not exists accepts_entries boolean default true;
insert into public.banks values(2,'Other country bank',2);
alter table public.bank_transaction add foreign key(bank_account_id) references public.bank_account;
alter table public.bank_transfer add foreign key(from_account_id) references public.bank_account,
 add foreign key(to_account_id) references public.bank_account;
create table public.synthetic_opening_account(id bigint,bank_account_id bigint references public.bank_account on delete cascade);
alter table public.bank_account enable row level security;
grant all on public.bank_account to anon,authenticated,service_role;
grant update(balance) on public.bank_account to authenticated;
create policy company_select on public.bank_account for select to authenticated using(subsidiary_id=active_subsidiary_id());
create policy company_insert on public.bank_account for insert to authenticated with check(true);
create policy company_update on public.bank_account for update to authenticated using(true) with check(true);
create policy company_delete on public.bank_account for delete to authenticated using(true);
insert into public.role_access_matrix values
 (1,'banking:bank-accounts',true,true,true,true),(2,'banking:bank-accounts',true,true,false,false),
 (3,'banking:bank-accounts',true,false,false,false);
