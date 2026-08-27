alter table public.products add column if not exists product_usage text not null default 'Venta', add column if not exists account_id bigint references public.chart_accounts(account_id) on delete restrict;
alter table public.products drop constraint if exists products_usage_allowed;
alter table public.products add constraint products_usage_allowed check(product_usage in('Compra','Venta'));
create index if not exists products_account_idx on public.products(account_id);
