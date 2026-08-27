alter table public.customers
  add column if not exists country_id bigint references public.countries(country_id) on delete set null;

create index if not exists customers_country_idx on public.customers(country_id);
