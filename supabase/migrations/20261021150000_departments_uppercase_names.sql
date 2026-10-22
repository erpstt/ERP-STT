begin;

lock table public.departments in share row exclusive mode;

-- Evita que dos nombres que hoy solo difieren por mayúsculas colisionen al
-- normalizar dentro de la misma subsidiaria.
do $$
begin
  if exists (
    select 1
    from public.departments
    where subsidiary_id is not null
    group by subsidiary_id,upper(btrim(name))
    having count(*)>1
  ) then
    raise exception 'Existen departamentos duplicados que solo difieren por mayúsculas o espacios.';
  end if;
end
$$;

update public.departments
set name=upper(btrim(name))
where name is distinct from upper(btrim(name));

create or replace function public.normalize_department_name_uppercase()
returns trigger
language plpgsql
set search_path=public
as $$
begin
  new.name:=upper(btrim(new.name));
  if new.name='' then
    raise exception 'El nombre del departamento es obligatorio.';
  end if;
  return new;
end
$$;

drop trigger if exists normalize_department_name_uppercase_trigger on public.departments;
create trigger normalize_department_name_uppercase_trigger
before insert or update of name on public.departments
for each row
execute function public.normalize_department_name_uppercase();

alter table public.departments
  drop constraint if exists departments_name_uppercase;

alter table public.departments
  add constraint departments_name_uppercase
  check (name<>'' and name=btrim(name) and name=upper(name));

commit;

notify pgrst,'reload schema';
