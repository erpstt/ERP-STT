alter table public.suppliers
  add column if not exists supplier_type text not null default 'Empresa',
  add column if not exists email text,
  add column if not exists phone text,
  add column if not exists address text,
  add column if not exists comments text;

alter table public.suppliers drop constraint if exists suppliers_supplier_type_allowed;
alter table public.suppliers add constraint suppliers_supplier_type_allowed
  check (supplier_type in ('Empresa','Personal'));

alter table public.suppliers drop constraint if exists suppliers_email_format;
alter table public.suppliers add constraint suppliers_email_format
  check (email is null or email ~* '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$');
