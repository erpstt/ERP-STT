alter table public.employees
  add column if not exists is_sales_representative boolean not null default false;

create index if not exists employees_sales_representative_idx
  on public.employees(is_sales_representative)
  where is_sales_representative;
