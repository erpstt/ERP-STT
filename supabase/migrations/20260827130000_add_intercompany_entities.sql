alter table public.customers add column if not exists is_intercompany boolean not null default false;
alter table public.suppliers add column if not exists is_intercompany boolean not null default false;
create index if not exists customers_intercompany_idx on public.customers(is_intercompany) where is_intercompany;
create index if not exists suppliers_intercompany_idx on public.suppliers(is_intercompany) where is_intercompany;
