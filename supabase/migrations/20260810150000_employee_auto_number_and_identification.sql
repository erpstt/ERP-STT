create sequence if not exists public.employee_number_seq;

do $$
declare
  employee_max bigint;
begin
  select coalesce(max(substring(employee_number from '^EMP-([0-9]{8})$')::bigint), 0)
    into employee_max
    from public.employees;

  if employee_max = 0 then
    perform setval('public.employee_number_seq', 1, false);
  else
    perform setval('public.employee_number_seq', employee_max, true);
  end if;
end $$;

alter table public.employees
  alter column employee_number
  set default ('EMP-' || lpad(nextval('public.employee_number_seq')::text, 8, '0'));

alter table public.employees
  add column if not exists identification text;

create unique index if not exists employees_identification_unique_idx
  on public.employees (lower(btrim(identification)))
  where identification is not null and btrim(identification) <> '';
