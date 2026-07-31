create table if not exists public.countries (
  id bigint generated always as identity primary key,
  name text not null unique check (btrim(name) <> '')
);

alter table public.countries enable row level security;

drop policy if exists "Authenticated users can read countries" on public.countries;
create policy "Authenticated users can read countries"
  on public.countries
  for select
  to authenticated
  using (true);

drop policy if exists "Authenticated users can create countries" on public.countries;
create policy "Authenticated users can create countries" on public.countries for insert to authenticated with check (true);

drop policy if exists "Authenticated users can update countries" on public.countries;
create policy "Authenticated users can update countries" on public.countries for update to authenticated using (true) with check (true);

drop policy if exists "Authenticated users can delete countries" on public.countries;
create policy "Authenticated users can delete countries" on public.countries for delete to authenticated using (true);
