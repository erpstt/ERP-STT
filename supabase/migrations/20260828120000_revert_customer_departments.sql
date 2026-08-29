alter table public.departments drop constraint if exists departments_customer_type_check;
drop index if exists public.departments_customer_idx;
alter table public.departments drop column if exists customer_id;
