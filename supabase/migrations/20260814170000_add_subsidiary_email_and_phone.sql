alter table public.subsidiaries
  add column if not exists email text,
  add column if not exists phone text;

comment on column public.subsidiaries.email is
  'Correo electrónico de contacto de la subsidiaria.';

comment on column public.subsidiaries.phone is
  'Número telefónico de contacto de la subsidiaria.';
