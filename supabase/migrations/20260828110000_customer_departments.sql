alter table public.departments add column if not exists customer_id bigint references public.customers(customer_id) on delete restrict;
alter table public.departments drop constraint if exists departments_customer_type_check;
alter table public.departments add constraint departments_customer_type_check check ((type='Cliente' and customer_id is not null) or (type<>'Cliente' and customer_id is null)) not valid;
create index if not exists departments_customer_idx on public.departments(customer_id);
