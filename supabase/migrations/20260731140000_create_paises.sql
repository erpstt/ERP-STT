create table if not exists public.paises (
  id bigint generated always as identity primary key,
  nombre text not null unique check (btrim(nombre) <> '')
);

alter table public.paises enable row level security;

drop policy if exists "Authenticated users can read paises" on public.paises;
create policy "Authenticated users can read paises"
  on public.paises
  for select
  to authenticated
  using (true);

insert into public.paises (nombre)
values
  ('Costa Rica'),
  ('México'),
  ('Colombia'),
  ('España'),
  ('Argentina'),
  ('Perú')
on conflict (nombre) do nothing;
