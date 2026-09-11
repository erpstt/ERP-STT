create table if not exists public.entity_withholding_rules (
  rule_id bigint generated always as identity primary key,
  customer_id bigint references public.customers(customer_id) on delete cascade,
  supplier_id bigint references public.suppliers(supplier_id) on delete cascade,
  subsidiary_id bigint not null references public.subsidiaries(subsidiary_id) on delete cascade,
  tax_code_id bigint not null references public.tax_codes(tax_code_id),
  created_at timestamptz not null default now(),
  constraint entity_withholding_rules_owner_valid check (
    (customer_id is not null)::integer + (supplier_id is not null)::integer = 1
  )
);

create unique index if not exists entity_withholding_customer_rule_uidx
  on public.entity_withholding_rules(customer_id, subsidiary_id, tax_code_id)
  where customer_id is not null;

create unique index if not exists entity_withholding_supplier_rule_uidx
  on public.entity_withholding_rules(supplier_id, subsidiary_id, tax_code_id)
  where supplier_id is not null;

create or replace function public.validate_entity_withholding_rule()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  applies_to_value text;
begin
  if new.customer_id is not null then
    if not exists (
      select 1 from public.entity_subsidiaries
      where customer_id = new.customer_id and subsidiary_id = new.subsidiary_id
    ) then
      raise exception 'El cliente no pertenece a la subsidiaria seleccionada.';
    end if;
  else
    if not exists (
      select 1 from public.entity_subsidiaries
      where supplier_id = new.supplier_id and subsidiary_id = new.subsidiary_id
    ) then
      raise exception 'El proveedor no pertenece a la subsidiaria seleccionada.';
    end if;
  end if;

  select tt.applies_to
  into applies_to_value
  from public.tax_codes tc
  join public.tax_types tt on tt.tax_type_id = tc.tax_type_id
  join public.tax_code_subsidiaries tcs on tcs.tax_code_id = tc.tax_code_id
  where tc.tax_code_id = new.tax_code_id
    and tc.is_withholding = true
    and tcs.subsidiary_id = new.subsidiary_id;

  if applies_to_value is null then
    raise exception 'El código no es una retención habilitada para la subsidiaria seleccionada.';
  end if;
  if new.customer_id is not null and applies_to_value not in ('Ventas', 'Ambos') then
    raise exception 'La retención del cliente debe aplicar para Ventas o Ambos.';
  end if;
  if new.supplier_id is not null and applies_to_value not in ('Compras', 'Ambos') then
    raise exception 'La retención del proveedor debe aplicar para Compras o Ambos.';
  end if;
  return new;
end;
$$;

drop trigger if exists entity_withholding_rule_validation on public.entity_withholding_rules;
create trigger entity_withholding_rule_validation
before insert or update on public.entity_withholding_rules
for each row execute function public.validate_entity_withholding_rule();

insert into public.entity_withholding_rules(customer_id, subsidiary_id, tax_code_id)
select c.customer_id, es.subsidiary_id, c.withholding_tax_code_id
from public.customers c
join public.entity_subsidiaries es on es.customer_id = c.customer_id
join public.tax_code_subsidiaries tcs
  on tcs.tax_code_id = c.withholding_tax_code_id and tcs.subsidiary_id = es.subsidiary_id
join public.tax_codes tc on tc.tax_code_id = c.withholding_tax_code_id and tc.is_withholding
join public.tax_types tt on tt.tax_type_id = tc.tax_type_id and tt.applies_to in ('Ventas', 'Ambos')
where c.applies_withholding and c.withholding_tax_code_id is not null
on conflict do nothing;

insert into public.entity_withholding_rules(supplier_id, subsidiary_id, tax_code_id)
select s.supplier_id, es.subsidiary_id, s.withholding_tax_code_id
from public.suppliers s
join public.entity_subsidiaries es on es.supplier_id = s.supplier_id
join public.tax_code_subsidiaries tcs
  on tcs.tax_code_id = s.withholding_tax_code_id and tcs.subsidiary_id = es.subsidiary_id
join public.tax_codes tc on tc.tax_code_id = s.withholding_tax_code_id and tc.is_withholding
join public.tax_types tt on tt.tax_type_id = tc.tax_type_id and tt.applies_to in ('Compras', 'Ambos')
where s.applies_withholding and s.withholding_tax_code_id is not null
on conflict do nothing;

update public.customers c
set applies_withholding = false
where applies_withholding
  and not exists (select 1 from public.entity_withholding_rules r where r.customer_id = c.customer_id);

update public.suppliers s
set applies_withholding = false
where applies_withholding
  and not exists (select 1 from public.entity_withholding_rules r where r.supplier_id = s.supplier_id);

alter table public.customers drop constraint if exists customers_withholding_configuration_valid;
alter table public.suppliers drop constraint if exists suppliers_withholding_configuration_valid;
alter table public.customers drop column if exists withholding_tax_code_id;
alter table public.suppliers drop column if exists withholding_tax_code_id;

alter table public.entity_withholding_rules enable row level security;
drop policy if exists entity_withholding_rules_select on public.entity_withholding_rules;
drop policy if exists entity_withholding_rules_insert on public.entity_withholding_rules;
drop policy if exists entity_withholding_rules_update on public.entity_withholding_rules;
drop policy if exists entity_withholding_rules_delete on public.entity_withholding_rules;
create policy entity_withholding_rules_select on public.entity_withholding_rules for select to authenticated using (true);
create policy entity_withholding_rules_insert on public.entity_withholding_rules for insert to authenticated with check (true);
create policy entity_withholding_rules_update on public.entity_withholding_rules for update to authenticated using (true) with check (true);
create policy entity_withholding_rules_delete on public.entity_withholding_rules for delete to authenticated using (true);

grant select, insert, update, delete on public.entity_withholding_rules to authenticated;
grant usage, select on sequence public.entity_withholding_rules_rule_id_seq to authenticated;

comment on table public.entity_withholding_rules is 'Retenciones asignadas a clientes y proveedores por subsidiaria y país.';
notify pgrst, 'reload schema';
