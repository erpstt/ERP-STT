alter table public.subsidiaries
  add column if not exists project_approver text,
  add column if not exists administrative_approver text;

-- Expose only display information; source-table RLS still controls visibility.
create or replace view public.subsidiary_approver_options with (security_invoker=true) as
select 'employee:'||employee_id as approver_id,
  concat_ws(' ',first_name,last_name)||' · Empleado · '||coalesce(employee_number,employee_id::text) as name,
  coalesce(is_active,false) as is_active
from public.employees
union all
select 'user:'||user_id,
  concat_ws(' ',first_name,last_name)||' · Usuario · '||email,
  coalesce(is_active,false)
from public.users;
revoke all on public.subsidiary_approver_options from public,anon;
grant select on public.subsidiary_approver_options to authenticated;

create or replace function public.validate_subsidiary_approvers() returns trigger
language plpgsql set search_path=public,pg_temp as $$
declare field text; chosen text; label text;
begin
  foreach field in array array['project_approver','administrative_approver'] loop
    chosen:=to_jsonb(new)->>field;
    if chosen is null then continue; end if;
    if tg_op='UPDATE' then
      if chosen is not distinct from to_jsonb(old)->>field then continue; end if;
    end if;
    label:=case field when 'project_approver' then 'Aprobador Proyectos (UP)' else 'Aprobador Administrativo' end;
    if chosen !~ '^(employee|user):[1-9][0-9]*$' then raise exception '%: seleccione un empleado o usuario válido.',label; end if;
    if not exists(select 1 from subsidiary_approver_options where approver_id=chosen and is_active) then
      raise exception '%: el empleado o usuario no existe, está inactivo o no está disponible.',label;
    end if;
    -- Lock the source row so deleting it cannot race against this assignment.
    if chosen like 'employee:%' then perform 1 from employees where employee_id=split_part(chosen,':',2)::bigint for key share;
    else perform 1 from users where user_id=split_part(chosen,':',2)::bigint for key share; end if;
    if not found then raise exception '%: el registro ya no está disponible.',label; end if;
  end loop;
  return new;
end$$;
drop trigger if exists validate_subsidiary_approvers on public.subsidiaries;
create trigger validate_subsidiary_approvers before insert or update of project_approver,administrative_approver
on public.subsidiaries for each row execute function public.validate_subsidiary_approvers();

create or replace function public.protect_subsidiary_approver() returns trigger
language plpgsql security definer set search_path=public,pg_temp as $$
declare key text;
begin
  key:=case tg_table_name when 'employees' then 'employee:'||(to_jsonb(old)->>'employee_id') else 'user:'||(to_jsonb(old)->>'user_id') end;
  if exists(select 1 from subsidiaries where project_approver=key or administrative_approver=key) then
    raise exception 'El registro está asignado como aprobador de una subsidiaria. Cambie la asignación antes de eliminarlo.';
  end if;
  return old;
end$$;
drop trigger if exists protect_subsidiary_approver on public.employees;
create trigger protect_subsidiary_approver before delete on public.employees for each row execute function public.protect_subsidiary_approver();
drop trigger if exists protect_subsidiary_approver on public.users;
create trigger protect_subsidiary_approver before delete on public.users for each row execute function public.protect_subsidiary_approver();
revoke all on function public.validate_subsidiary_approvers(),public.protect_subsidiary_approver() from public,anon;
notify pgrst,'reload schema';
