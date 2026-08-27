alter table public.products
  add column if not exists sales_account_id bigint references public.chart_accounts(account_id) on delete restrict,
  add column if not exists purchase_account_id bigint references public.chart_accounts(account_id) on delete restrict;

update public.products set sales_account_id=account_id
 where product_usage='Venta' and account_id is not null and sales_account_id is null;
update public.products set purchase_account_id=account_id
 where product_usage='Compra' and account_id is not null and purchase_account_id is null;

alter table public.products drop constraint if exists products_usage_allowed;
alter table public.products add constraint products_usage_allowed check(product_usage in('Compra','Venta','Ambas'));
create index if not exists products_sales_account_idx on public.products(sales_account_id);
create index if not exists products_purchase_account_idx on public.products(purchase_account_id);
