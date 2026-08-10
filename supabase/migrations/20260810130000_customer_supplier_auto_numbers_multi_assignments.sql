create sequence if not exists public.customer_number_seq;
create sequence if not exists public.supplier_number_seq;

do $$
declare customer_max bigint; supplier_max bigint;
begin
  select coalesce(max(substring(customer_number from '^CLI-([0-9]{8})$')::bigint),0) into customer_max from public.customers;
  select coalesce(max(substring(supplier_number from '^PROV-([0-9]{8})$')::bigint),0) into supplier_max from public.suppliers;
  if customer_max=0 then perform setval('public.customer_number_seq',1,false); else perform setval('public.customer_number_seq',customer_max,true); end if;
  if supplier_max=0 then perform setval('public.supplier_number_seq',1,false); else perform setval('public.supplier_number_seq',supplier_max,true); end if;
end $$;

alter table public.customers alter column customer_number set default ('CLI-'||lpad(nextval('public.customer_number_seq')::text,8,'0'));
alter table public.suppliers alter column supplier_number set default ('PROV-'||lpad(nextval('public.supplier_number_seq')::text,8,'0'));

create table if not exists public.customer_currencies(
  id bigint generated always as identity primary key,
  customer_id bigint not null references public.customers(customer_id) on delete cascade,
  currency_id bigint not null references public.currencies(currency_id) on delete restrict,
  is_primary boolean not null default false,
  unique(customer_id,currency_id)
);

create table if not exists public.supplier_currencies(
  id bigint generated always as identity primary key,
  supplier_id bigint not null references public.suppliers(supplier_id) on delete cascade,
  currency_id bigint not null references public.currencies(currency_id) on delete restrict,
  is_primary boolean not null default false,
  unique(supplier_id,currency_id)
);

insert into public.customer_currencies(customer_id,currency_id,is_primary)
select customer_id,currency_id,true from public.customers
on conflict(customer_id,currency_id) do update set is_primary=true;

insert into public.supplier_currencies(supplier_id,currency_id,is_primary)
select supplier_id,currency_id,true from public.suppliers
on conflict(supplier_id,currency_id) do update set is_primary=true;

insert into public.entity_subsidiaries(customer_id,subsidiary_id,is_primary,credit_limit)
select customer_id,primary_subsidiary_id,true,credit_limit from public.customers
on conflict(customer_id,subsidiary_id) where customer_id is not null do update set is_primary=true;

insert into public.entity_subsidiaries(supplier_id,subsidiary_id,is_primary,credit_limit)
select supplier_id,primary_subsidiary_id,true,0 from public.suppliers
on conflict(supplier_id,subsidiary_id) where supplier_id is not null do update set is_primary=true;

alter table public.customer_currencies enable row level security;
alter table public.supplier_currencies enable row level security;

do $$ declare target text;
begin
  foreach target in array array['customer_currencies','supplier_currencies'] loop
    execute format('drop policy if exists "entity_currency_select" on public.%I',target);
    execute format('drop policy if exists "entity_currency_insert" on public.%I',target);
    execute format('drop policy if exists "entity_currency_update" on public.%I',target);
    execute format('drop policy if exists "entity_currency_delete" on public.%I',target);
    execute format('create policy "entity_currency_select" on public.%I for select to authenticated using(true)',target);
    execute format('create policy "entity_currency_insert" on public.%I for insert to authenticated with check(true)',target);
    execute format('create policy "entity_currency_update" on public.%I for update to authenticated using(true) with check(true)',target);
    execute format('create policy "entity_currency_delete" on public.%I for delete to authenticated using(true)',target);
  end loop;
end $$;

create index if not exists customer_currencies_customer_idx on public.customer_currencies(customer_id);
create index if not exists supplier_currencies_supplier_idx on public.supplier_currencies(supplier_id);
