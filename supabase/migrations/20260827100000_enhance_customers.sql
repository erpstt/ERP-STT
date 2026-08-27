alter table public.customers
  add column if not exists customer_type text not null default 'Empresa',
  add column if not exists email text,
  add column if not exists phone text,
  add column if not exists sales_representative_id bigint references public.employees(employee_id) on delete set null,
  add column if not exists department_id bigint references public.departments(department_id) on delete set null,
  add column if not exists address text,
  add column if not exists comments text;
alter table public.customers drop constraint if exists customers_customer_type_allowed;
alter table public.customers add constraint customers_customer_type_allowed check(customer_type in('Empresa','Personal'));
alter table public.customers drop constraint if exists customers_email_format;
alter table public.customers add constraint customers_email_format check(email is null or email ~* '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$');
create index if not exists customers_sales_representative_idx on public.customers(sales_representative_id);
create index if not exists customers_department_idx on public.customers(department_id);
