import{readFile}from'node:fs/promises';
import{setupEntityMasterSecurity}from'./setup-entity-master-security.mjs';
export const supplierInvoiceFormOptionsMigration='20261106180744_add_supplier_invoice_form_options.sql';
const read=p=>readFile(new URL(p,import.meta.url),'utf8').then(s=>s.replace(/\r\n/g,'\n'));
export async function setupSupplierInvoiceFormOptions(db){
 await setupEntityMasterSecurity(db);
 await db.exec(await read('./financial-entity-master-tables.sql'));
 await db.exec(`
 create table if not exists class_subsidiaries(class_id bigint,subsidiary_id bigint);
 create table if not exists location_subsidiaries(location_id bigint,subsidiary_id bigint);
 create table if not exists exchange_rates(from_currency_id bigint,to_currency_id bigint,effective_date date,spot_rate numeric);
 alter table subsidiaries add column if not exists fiscal_calendar_id bigint;
 alter table locations add column if not exists subsidiary_id bigint;
 alter table account_group add column if not exists parent_id bigint,add column if not exists group_name text;
 alter table cost_centers add column if not exists cost_center_type text,add column if not exists department_id bigint;
 alter table classes add column if not exists is_inactive boolean default false;
 alter table fiscal_periods add column if not exists period_name text;
 update locations set subsidiary_id=1 where location_id=1;
 update account_group set group_name='Synthetic group'where group_name is null;
 update suppliers set company_name='Synthetic visible supplier',email='private@example.invalid',phone='PRIVATE',tax_id='PRIVATE',payment_iban='PRIVATE'where supplier_id=10;
 insert into role_permissions(role_id,permission_id)select 2,permission_id from permissions where code='purchasing:supplier-invoice:create'on conflict do nothing;
 insert into locations(location_id,name,subsidiary_id)values(501,'Synthetic shared',2),(502,'Synthetic foreign',2);
 insert into location_subsidiaries values(501,1),(502,2);
 insert into class_subsidiaries(class_id,subsidiary_id)select class_id,subsidiary_id from classes;
 insert into financial_creditors(financial_creditor_id,name,subsidiary_id,is_inactive)values(501,'Synthetic creditor',1,false),(502,'Foreign creditor',2,false);
 insert into related_companies(related_company_id,name,subsidiary_id,country_id,is_inactive)values(501,'Synthetic related',1,1,false),(502,'Foreign related',2,1,false);
 insert into exchange_rates values(2,1,'2026-10-01',160),(1,2,'2026-10-01',0.00625),(2,3,'2026-10-01',2);
 `);
}
export async function applySupplierInvoiceFormOptions(db){await db.exec('begin');try{await db.exec(await read('../../supabase/migrations/'+supplierInvoiceFormOptionsMigration));await db.exec('commit');}catch(error){await db.exec('rollback');throw error;}}
