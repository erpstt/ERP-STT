alter table public.locations
  add column if not exists parent_id bigint
  references public.locations(location_id) on delete set null;

create table if not exists public.location_subsidiaries (
  location_id bigint not null references public.locations(location_id) on delete cascade,
  subsidiary_id bigint not null references public.subsidiaries(subsidiary_id) on delete cascade,
  primary key (location_id, subsidiary_id)
);

insert into public.location_subsidiaries(location_id, subsidiary_id)
select location_id, subsidiary_id
from public.locations
where subsidiary_id is not null
on conflict do nothing;

alter table public.location_subsidiaries enable row level security;

drop policy if exists "organization_select" on public.location_subsidiaries;
drop policy if exists "organization_insert" on public.location_subsidiaries;
drop policy if exists "organization_delete" on public.location_subsidiaries;
create policy "organization_select" on public.location_subsidiaries for select to authenticated using (true);
create policy "organization_insert" on public.location_subsidiaries for insert to authenticated with check (true);
create policy "organization_delete" on public.location_subsidiaries for delete to authenticated using (true);

create index if not exists locations_parent_idx on public.locations(parent_id);
create index if not exists location_subsidiaries_subsidiary_idx
  on public.location_subsidiaries(subsidiary_id);

alter table public.locations drop column if exists location_type;
alter table public.locations drop column if exists address;
