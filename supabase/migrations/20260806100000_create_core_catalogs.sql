-- Catálogos definidos en Core.xlsx. Conserva los países existentes.
do $$
begin
  if exists (select 1 from information_schema.columns where table_schema='public' and table_name='countries' and column_name='id')
     and not exists (select 1 from information_schema.columns where table_schema='public' and table_name='countries' and column_name='country_id') then
    alter table public.countries rename column id to country_id;
  end if;
end $$;

alter table public.countries
  add column if not exists country_code_iso2 varchar(2),
  add column if not exists country_code_iso3 varchar(3),
  add column if not exists phone_code varchar(12);
create unique index if not exists countries_iso2_uidx on public.countries (upper(country_code_iso2)) where country_code_iso2 is not null;
create unique index if not exists countries_iso3_uidx on public.countries (upper(country_code_iso3)) where country_code_iso3 is not null;

create table if not exists public.languages (
  language_id bigint generated always as identity primary key,
  code varchar(10) not null unique,
  name text not null,
  is_active boolean not null default true
);
create table if not exists public.timezones (
  timezone_id bigint generated always as identity primary key,
  name text not null unique,
  utc_offset varchar(10) not null,
  is_active boolean not null default true
);
create table if not exists public.currencies (
  currency_id bigint generated always as identity primary key,
  currency_code varchar(3) not null unique,
  name text not null,
  symbol varchar(10) not null,
  fx_rate_precision smallint not null default 6 check (fx_rate_precision between 0 and 12)
);
create table if not exists public.status (
  status_id bigint generated always as identity primary key,
  code varchar(30) not null,
  name text not null,
  module text not null,
  description text,
  unique (code, module)
);
create table if not exists public.number_sequences (
  sequence_id bigint generated always as identity primary key,
  prefix varchar(30),
  suffix varchar(30),
  current_number bigint not null default 0 check (current_number >= 0),
  padding_length smallint not null default 6 check (padding_length between 1 and 20)
);
create table if not exists public.transaction_types (
  transaction_type_id bigint generated always as identity primary key,
  code varchar(30) not null unique,
  name text not null,
  module_category text not null
);
create table if not exists public.parameters (
  parameter_id bigint generated always as identity primary key,
  parameter_key text not null unique,
  parameter_value text,
  description text
);
create table if not exists public.settings (
  setting_id bigint generated always as identity primary key,
  setting_key text not null,
  setting_value text,
  scope text not null default 'global',
  unique (setting_key, scope)
);

do $$
declare table_name text;
begin
  foreach table_name in array array['countries','languages','timezones','currencies','status','number_sequences','transaction_types','parameters','settings'] loop
    execute format('alter table public.%I enable row level security', table_name);
    execute format('drop policy if exists "core_select" on public.%I', table_name);
    execute format('drop policy if exists "core_insert" on public.%I', table_name);
    execute format('drop policy if exists "core_update" on public.%I', table_name);
    execute format('drop policy if exists "core_delete" on public.%I', table_name);
    execute format('create policy "core_select" on public.%I for select to authenticated using (true)', table_name);
    execute format('create policy "core_insert" on public.%I for insert to authenticated with check (true)', table_name);
    execute format('create policy "core_update" on public.%I for update to authenticated using (true) with check (true)', table_name);
    execute format('create policy "core_delete" on public.%I for delete to authenticated using (true)', table_name);
  end loop;
end $$;
