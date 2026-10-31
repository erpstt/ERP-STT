alter table transaction_types add column name text;
insert into transaction_types values(2,'ASI_DIA','Asiento de Diario General'),(3,'ASI_PEN','Asientos Pendientes de Facturar'),
 (4,'ASI_NOM','Asiento de Nóminas'),(5,'ASI_LIQ','Asiento de Liquidación');
alter table fiscal_periods add column gl_closed boolean default false,add column is_inactive boolean default false;
alter table chart_accounts add column accepts_entries boolean default true;
alter table journal alter column status set default 'CONTABILIZADO';
alter table journal add column location_id bigint;
alter table journal add column reversed_from_journal_id bigint;
alter table gl_impact add column transaction_id bigint,add column fiscal_period_id bigint,add column accounting_book_id bigint,
 add column debit_fx numeric,add column credit_fx numeric;
alter table journal_line add column tax_code_id bigint,add column tax_rate numeric,add column gross_amount numeric,
 add column entity_type text,add column customer_id bigint,add column supplier_id bigint,add column employee_id bigint,
 add column department_id bigint,add column class_id bigint,add column location_id bigint,add column cost_center_id bigint,
 add column financial_creditor_id bigint,add column related_company_id bigint,add column service_country_id bigint,add column service_month text;
create table locations(location_id bigint primary key,name text);
create table location_subsidiaries(location_id bigint,subsidiary_id bigint);
insert into locations values(1,'Synthetic location');insert into location_subsidiaries values(1,1);
create table subsidiary_currencies(subsidiary_id bigint,currency_id bigint);
create table countries(country_id bigint,name text,country_code_iso2 text,country_code_iso3 text);
insert into countries values(1,'Synthetic country','XX','XXX');
create table journal_csv_imports(subsidiary_id bigint,fingerprint text,result jsonb,primary key(subsidiary_id,fingerprint));
create function sync_journal_gl_impacts(bigint) returns void language sql as $$select$$;
create function next_manual_journal_number(text,bigint) returns text language sql as $$select 'ASI_DIA-'||nextval('synthetic_transfer_number')::text$$;
update role_access_matrix set resource_key='accounting:journals';
insert into permissions(code,module) values('accounting:journal:reverse','Contabilidad');
insert into role_permissions select 2,permission_id from permissions where code='accounting:journal:reverse';

-- Minimal trusted callers exercise the migration's compatibility routing only.
create function process_fixed_asset_proposals(p_payload jsonb) returns bigint language plpgsql security definer as $$
begin return public.create_journal_entry(p_payload);end$$;
create function run_fixed_asset_depreciation(p_date date,p_asset_ids jsonb) returns bigint language plpgsql security definer as $$
begin return create_journal_entry(p_asset_ids);end$$;
revoke all on function process_fixed_asset_proposals(jsonb),run_fixed_asset_depreciation(date,jsonb) from public,anon,authenticated;

alter table journal enable row level security;alter table journal_line enable row level security;
grant all on journal,journal_line to authenticated;
create policy old_header_all on journal for all to authenticated using(true) with check(true);
create policy old_header_select on journal for select to authenticated using(subsidiary_id=active_subsidiary_id());
create policy old_line_all on journal_line for all to authenticated using(true) with check(true);
create policy old_line_select on journal_line for select to authenticated using(exists(select 1 from journal j where j.journal_id=journal_line.journal_id));
