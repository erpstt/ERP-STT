alter table public.languages add column if not exists iso_code varchar(10);
create unique index if not exists languages_iso_code_uidx on public.languages(lower(iso_code)) where iso_code is not null;
