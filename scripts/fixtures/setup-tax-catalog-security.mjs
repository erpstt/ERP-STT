import{readFile}from'node:fs/promises';import{setupApprovalInboxSecurity}from'./setup-approval-inbox-security.mjs';
export const migration='20261101141740_secure_tax_catalogs.sql';
export async function setupTaxCatalogSecurity(db){await setupApprovalInboxSecurity(db);const read=p=>readFile(new URL(p,import.meta.url),'utf8');await db.exec(await read('./tax-catalog-tables.sql'));
 await db.exec(`alter table subsidiaries add column if not exists is_active boolean default true;
 do $$declare t text;k text;begin for t,k in select *from(values('tax_agencies','tax_agency_id'),('tax_types','tax_type_id'),('tax_codes','tax_code_id'),('tax_groups','tax_group_id'),('tax_code_subsidiaries','id'),('tax_agency_subsidiaries','id'))x loop
 if not exists(select 1 from pg_attribute where attrelid=('public.'||t)::regclass and attname=k and attidentity<>'')then
 execute format('with numbered as(select ctid,row_number()over()n from public.%I)update public.%I x set %I=n from numbered where x.ctid=numbered.ctid and x.%I is null',t,t,k,k);
 execute format('alter table public.%I alter column %I set not null',t,k);execute format('alter table public.%I alter column %I add generated always as identity(start with 1000)',t,k);end if;
 if not exists(select 1 from pg_constraint where conrelid=('public.'||t)::regclass and contype='p')then execute format('alter table public.%I add primary key(%I)',t,k);end if;execute format('select setval(%L,greatest(1000,coalesce((select max(%I)from public.%I),0)+1),false)',pg_get_serial_sequence('public.'||t,k),k,t);end loop;end$$;
 create table fixture_tax_usage(tax_code_id bigint references tax_codes(tax_code_id));
 alter table tax_codes add constraint fixture_tax_type_fk foreign key(tax_type_id)references tax_types(tax_type_id)not valid;
 alter table tax_codes add constraint fixture_tax_agency_fk foreign key(tax_agency_id)references tax_agencies(tax_agency_id)not valid;
 alter table tax_code_subsidiaries add constraint fixture_tax_code_link_fk foreign key(tax_code_id)references tax_codes(tax_code_id)on delete cascade not valid;
 alter table tax_agency_subsidiaries add constraint fixture_tax_agency_link_fk foreign key(tax_agency_id)references tax_agencies(tax_agency_id)on delete cascade not valid;
 alter table supplier_invoice_line add constraint fixture_supplier_tax_fk foreign key(tax_code_id)references tax_codes(tax_code_id)not valid;
 alter table sales_invoice_line add constraint fixture_customer_tax_fk foreign key(tax_code_id)references tax_codes(tax_code_id)not valid;
 `);
 for(const slug of['tax-agencies','tax-types','tax-codes','tax-groups'])await db.query("insert into role_access_matrix values(1,$1,true,true,true,true),(3,$1,true,false,false,false)",['configuration:'+slug]);
 await db.exec('begin');await db.exec(await read('../../supabase/migrations/'+migration));await db.exec('commit');}
