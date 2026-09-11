alter table public.customers
  add column if not exists applies_withholding boolean not null default false,
  add column if not exists withholding_tax_code_id bigint references public.tax_codes(tax_code_id);

alter table public.suppliers
  add column if not exists applies_withholding boolean not null default false,
  add column if not exists withholding_tax_code_id bigint references public.tax_codes(tax_code_id);

update public.customers
set withholding_tax_code_id = null
where applies_withholding = false;

update public.suppliers
set withholding_tax_code_id = null
where applies_withholding = false;

alter table public.customers
  drop constraint if exists customers_withholding_configuration_valid;
alter table public.customers
  add constraint customers_withholding_configuration_valid check (
    (applies_withholding and withholding_tax_code_id is not null)
    or (not applies_withholding and withholding_tax_code_id is null)
  );

alter table public.suppliers
  drop constraint if exists suppliers_withholding_configuration_valid;
alter table public.suppliers
  add constraint suppliers_withholding_configuration_valid check (
    (applies_withholding and withholding_tax_code_id is not null)
    or (not applies_withholding and withholding_tax_code_id is null)
  );

create index if not exists customers_withholding_tax_code_idx
  on public.customers(withholding_tax_code_id)
  where withholding_tax_code_id is not null;

create index if not exists suppliers_withholding_tax_code_idx
  on public.suppliers(withholding_tax_code_id)
  where withholding_tax_code_id is not null;

comment on column public.customers.applies_withholding is 'Indica si al cliente se le aplica una retención.';
comment on column public.customers.withholding_tax_code_id is 'Código de retención de ventas asignado al cliente.';
comment on column public.suppliers.applies_withholding is 'Indica si al proveedor se le aplica una retención.';
comment on column public.suppliers.withholding_tax_code_id is 'Código de retención de compras asignado al proveedor.';

notify pgrst, 'reload schema';
