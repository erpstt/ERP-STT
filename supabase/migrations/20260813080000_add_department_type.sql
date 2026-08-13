alter table public.departments
  add column if not exists type text;

update public.departments
set type = 'Interno'
where type is null or btrim(type) = '';

alter table public.departments
  alter column type set default 'Interno';

alter table public.departments
  alter column type set not null;

alter table public.departments
  drop constraint if exists departments_type_allowed;

alter table public.departments
  add constraint departments_type_allowed
  check (type in ('Cliente', 'Interno'));
