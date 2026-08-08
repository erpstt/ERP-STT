alter table public.tax_agencies alter column tax_id drop not null;

create table if not exists public.tax_agency_subsidiaries(
  id bigint generated always as identity primary key,
  tax_agency_id bigint not null references public.tax_agencies(tax_agency_id) on delete cascade,
  subsidiary_id bigint not null references public.subsidiaries(subsidiary_id) on delete cascade,
  unique(tax_agency_id,subsidiary_id)
);

insert into public.tax_agency_subsidiaries(tax_agency_id,subsidiary_id)
select tax_agency_id,subsidiary_id from public.tax_agencies where subsidiary_id is not null
on conflict(tax_agency_id,subsidiary_id) do nothing;

alter table public.tax_agency_subsidiaries enable row level security;
drop policy if exists "tax_agency_subsidiaries_select" on public.tax_agency_subsidiaries;
drop policy if exists "tax_agency_subsidiaries_insert" on public.tax_agency_subsidiaries;
drop policy if exists "tax_agency_subsidiaries_update" on public.tax_agency_subsidiaries;
drop policy if exists "tax_agency_subsidiaries_delete" on public.tax_agency_subsidiaries;
create policy "tax_agency_subsidiaries_select" on public.tax_agency_subsidiaries for select to authenticated using(true);
create policy "tax_agency_subsidiaries_insert" on public.tax_agency_subsidiaries for insert to authenticated with check(true);
create policy "tax_agency_subsidiaries_update" on public.tax_agency_subsidiaries for update to authenticated using(true) with check(true);
create policy "tax_agency_subsidiaries_delete" on public.tax_agency_subsidiaries for delete to authenticated using(true);

with source(agency_name,country_name) as (values
('AFIP / ARCA (Agencia de Recaudación y Control Aduanero)','Argentina'),
('SII (Servicio de Impuestos Internos)','Chile'),
('DIAN (Dirección de Impuestos y Aduanas Nacionales)','Colombia'),
('DGT (Dirección General de Tributación)','Costa Rica'),
('SRI (Servicio de Rentas Internas)','Ecuador'),
('DGII (Dirección General de Impuestos Internos)','El Salvador'),
('SAT (Superintendencia de Administración Tributaria)','Guatemala'),
('SAR (Servicio de Administración de Rentas)','Honduras'),
('TAJ (Tax Administration Jamaica)','Jamaica'),
('SAT (Servicio de Administración Tributaria)','México'),
('DGI (Dirección General de Ingresos)','Nicaragua'),
('DGI (Dirección General de Ingresos - MEF)','Panamá'),
('SUNAT (Superintendencia Nacional de Aduanas y de Administración Tributaria)','Perú'),
('Departamento de Hacienda de Puerto Rico','Puerto Rico'),
('DGII (Dirección General de Impuestos Internos)','República Dominicana')
)
insert into public.tax_agencies(agency_name,country_id,subsidiary_id,tax_id)
select source.agency_name,countries.country_id,null,null
from source join public.countries on countries.name=source.country_name
where not exists(select 1 from public.tax_agencies existing where existing.country_id=countries.country_id and existing.agency_name=source.agency_name);

create index if not exists tax_agency_subsidiaries_agency_idx on public.tax_agency_subsidiaries(tax_agency_id);
create index if not exists tax_agency_subsidiaries_subsidiary_idx on public.tax_agency_subsidiaries(subsidiary_id);
