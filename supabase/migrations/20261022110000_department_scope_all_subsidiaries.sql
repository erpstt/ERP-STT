begin transaction read write;

-- REGIONALES, SHARED/SHARE SERVICES y GASTOS ADMINISTRATIVOS son
-- estructuras corporativas: sus raices y todos sus descendientes deben estar
-- disponibles en cada subsidiaria. La asignacion principal historica de
-- departments.subsidiary_id se conserva sin cambios.
lock table public.departments in share mode;
lock table public.subsidiaries in share mode;
lock table public.department_subsidiaries in share row exclusive mode;

create temporary table migration_department_roots on commit drop as
select
  department.department_id,
  case
    when normalized.name in ('REGIONAL','REGIONALES') then 'REGIONALES'
    when normalized.name in ('SHARE SERVICES','SHARED SERVICES') then 'SHARED SERVICES'
    when normalized.name in ('GASTOS ADMINISTRATIVOS','ASTOS ADMINISTRATIVOS') then 'GASTOS ADMINISTRATIVOS'
  end as root_group
from public.departments department
cross join lateral (
  select regexp_replace(
    translate(upper(trim(department.name)),'ÁÉÍÓÚÜÑ','AEIOUUN'),
    '\s+',' ','g'
  ) as name
) normalized
where normalized.name in (
  'REGIONAL','REGIONALES',
  'SHARE SERVICES','SHARED SERVICES',
  'GASTOS ADMINISTRATIVOS','ASTOS ADMINISTRATIVOS'
);

do $$
declare missing_groups text;
begin
  select string_agg(expected.root_group,', ' order by expected.root_group)
    into missing_groups
  from (values
    ('GASTOS ADMINISTRATIVOS'),
    ('REGIONALES'),
    ('SHARED SERVICES')
  ) expected(root_group)
  where not exists (
    select 1
    from migration_department_roots root
    where root.root_group=expected.root_group
  );

  if missing_groups is not null then
    raise exception 'No se encontraron las raices de departamentos: %.',missing_groups;
  end if;
end
$$;

create temporary table migration_department_scope_targets on commit drop as
with recursive department_tree(department_id) as (
  select root.department_id
  from migration_department_roots root

  union

  select child.department_id
  from department_tree parent
  join public.departments child on child.parent_id=parent.department_id
)
select distinct department_id
from department_tree;

alter table migration_department_scope_targets
  add primary key(department_id);

-- Estas fotografias permiten verificar que no se elimino ningun vinculo
-- existente y que la subsidiaria principal de cada departamento no cambio.
create temporary table migration_existing_department_links on commit drop as
select department_id,subsidiary_id
from public.department_subsidiaries;

alter table migration_existing_department_links
  add primary key(department_id,subsidiary_id);

create temporary table migration_department_primary_owners on commit drop as
select department_id,subsidiary_id
from public.departments;

alter table migration_department_primary_owners
  add primary key(department_id);

insert into public.department_subsidiaries(department_id,subsidiary_id)
select target.department_id,subsidiary.subsidiary_id
from migration_department_scope_targets target
cross join public.subsidiaries subsidiary
on conflict(department_id,subsidiary_id) do nothing;

do $$
declare
  target_count bigint;
  subsidiary_count bigint;
  resulting_link_count bigint;
begin
  if exists (
    select 1
    from migration_existing_department_links previous
    left join public.department_subsidiaries current
      on current.department_id=previous.department_id
     and current.subsidiary_id=previous.subsidiary_id
    where current.department_id is null
  ) then
    raise exception 'La asignacion elimino uno o mas vinculos de subsidiarias preexistentes.';
  end if;

  if exists (
    select 1
    from migration_department_primary_owners previous
    join public.departments current using(department_id)
    where current.subsidiary_id is distinct from previous.subsidiary_id
  ) then
    raise exception 'La asignacion modifico la subsidiaria principal de uno o mas departamentos.';
  end if;

  if exists (
    select 1
    from migration_department_scope_targets target
    cross join public.subsidiaries subsidiary
    left join public.department_subsidiaries assignment
      on assignment.department_id=target.department_id
     and assignment.subsidiary_id=subsidiary.subsidiary_id
    where assignment.department_id is null
  ) then
    raise exception 'Uno o mas departamentos corporativos no quedaron vinculados a todas las subsidiarias.';
  end if;

  select count(*) into target_count
  from migration_department_scope_targets;

  select count(*) into subsidiary_count
  from public.subsidiaries;

  select count(*) into resulting_link_count
  from public.department_subsidiaries assignment
  join migration_department_scope_targets target using(department_id);

  if resulting_link_count<>target_count*subsidiary_count then
    raise exception
      'La matriz de departamentos corporativos no esta completa: % vinculos de % esperados.',
      resulting_link_count,target_count*subsidiary_count;
  end if;
end
$$;

commit;

notify pgrst,'reload schema';
