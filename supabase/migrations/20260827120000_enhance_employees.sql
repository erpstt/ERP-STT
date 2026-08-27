alter table public.employees
  add column if not exists job_title text,
  add column if not exists email text,
  add column if not exists phone text;

alter table public.employees drop constraint if exists employees_email_format;
alter table public.employees add constraint employees_email_format
  check (email is null or email ~* '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$');

create index if not exists employees_email_idx on public.employees(lower(email)) where email is not null;
