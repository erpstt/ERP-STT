create table if not exists public.fiscal_years (
  fiscal_year_id bigint generated always as identity primary key,
  year_name text not null unique,
  start_date date not null,
  end_date date not null,
  is_closed boolean not null default false,
  check (end_date >= start_date)
);
create table if not exists public.fiscal_calendars (
  fiscal_calendar_id bigint generated always as identity primary key,
  calendar_name text not null,
  fiscal_year_id bigint not null references public.fiscal_years(fiscal_year_id) on delete restrict,
  unique(calendar_name, fiscal_year_id)
);
create table if not exists public.subsidiaries (
  subsidiary_id bigint generated always as identity primary key,
  name text not null,
  legal_name text not null,
  parent_id bigint references public.subsidiaries(subsidiary_id) on delete set null,
  country_id bigint not null references public.countries(country_id) on delete restrict,
  currency_id bigint not null references public.currencies(currency_id) on delete restrict,
  fiscal_calendar_id bigint not null references public.fiscal_calendars(fiscal_calendar_id) on delete restrict,
  tax_id text not null unique,
  is_elimination boolean not null default false,
  is_active boolean not null default true
);
create table if not exists public.branches (
  branch_id bigint generated always as identity primary key,
  branch_code text not null,
  name text not null,
  subsidiary_id bigint not null references public.subsidiaries(subsidiary_id) on delete cascade,
  address text,
  unique(subsidiary_id, branch_code)
);
create table if not exists public.departments (
  department_id bigint generated always as identity primary key,
  name text not null,
  parent_id bigint references public.departments(department_id) on delete set null,
  subsidiary_id bigint not null references public.subsidiaries(subsidiary_id) on delete cascade,
  is_inactive boolean not null default false,
  unique(subsidiary_id, name)
);
create table if not exists public.classes (
  class_id bigint generated always as identity primary key,
  name text not null,
  parent_id bigint references public.classes(class_id) on delete set null,
  subsidiary_id bigint not null references public.subsidiaries(subsidiary_id) on delete cascade,
  is_inactive boolean not null default false,
  unique(subsidiary_id, name)
);
create table if not exists public.cost_centers (
  cost_center_id bigint generated always as identity primary key,
  code text not null,
  name text not null,
  parent_id bigint references public.cost_centers(cost_center_id) on delete set null,
  subsidiary_id bigint not null references public.subsidiaries(subsidiary_id) on delete cascade,
  is_inactive boolean not null default false,
  unique(subsidiary_id, code)
);
create table if not exists public.locations (
  location_id bigint generated always as identity primary key,
  name text not null,
  location_type text not null,
  subsidiary_id bigint not null references public.subsidiaries(subsidiary_id) on delete cascade,
  country_id bigint not null references public.countries(country_id) on delete restrict,
  address text
);
create index if not exists fiscal_calendars_year_idx on public.fiscal_calendars(fiscal_year_id);
create index if not exists subsidiaries_parent_idx on public.subsidiaries(parent_id);
create index if not exists branches_subsidiary_idx on public.branches(subsidiary_id);
create index if not exists departments_parent_idx on public.departments(parent_id);
create index if not exists classes_parent_idx on public.classes(parent_id);
create index if not exists cost_centers_parent_idx on public.cost_centers(parent_id);
create index if not exists locations_subsidiary_idx on public.locations(subsidiary_id);
do $$
declare target_table text;
begin
  foreach target_table in array array['fiscal_years','fiscal_calendars','subsidiaries','branches','departments','classes','cost_centers','locations'] loop
    execute format('alter table public.%I enable row level security',target_table);
    execute format('drop policy if exists "organization_select" on public.%I',target_table);
    execute format('drop policy if exists "organization_insert" on public.%I',target_table);
    execute format('drop policy if exists "organization_update" on public.%I',target_table);
    execute format('drop policy if exists "organization_delete" on public.%I',target_table);
    execute format('create policy "organization_select" on public.%I for select to authenticated using (true)',target_table);
    execute format('create policy "organization_insert" on public.%I for insert to authenticated with check (true)',target_table);
    execute format('create policy "organization_update" on public.%I for update to authenticated using (true) with check (true)',target_table);
    execute format('create policy "organization_delete" on public.%I for delete to authenticated using (true)',target_table);
  end loop;
end $$;
