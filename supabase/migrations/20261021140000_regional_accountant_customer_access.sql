begin;

-- Clientes utiliza Países y Monedas para resolver las etiquetas del listado.
-- El rol conserva sus acciones actuales; solo se garantiza la consulta mínima.
insert into public.role_access_matrix(
  role_id,
  resource_key,
  can_view,
  can_create,
  can_edit,
  can_delete,
  updated_at
)
select
  role.role_id,
  resource.resource_key,
  true,
  false,
  false,
  false,
  now()
from public.roles role
cross join (
  values
    ('entities:customers'),
    ('core:countries'),
    ('core:currencies')
) resource(resource_key)
where lower(regexp_replace(trim(role.role_name), '\s+', ' ', 'g')) in (
  'contador regional',
  'regional accountant'
)
on conflict(role_id,resource_key) do update
set can_view=true,
    updated_at=excluded.updated_at;

-- Un cliente multiempresa también debe ser visible desde una subsidiaria
-- secundaria expresamente asignada, sin abrir datos de otras subsidiarias.
drop policy if exists customer_assigned_subsidiary_select on public.customers;
create policy customer_assigned_subsidiary_select
on public.customers
for select
to authenticated
using (
  exists (
    select 1
    from public.entity_subsidiaries assignment
    where assignment.customer_id=customers.customer_id
      and assignment.subsidiary_id=public.active_subsidiary_id_without_report_context()
  )
);

commit;

notify pgrst,'reload schema';
