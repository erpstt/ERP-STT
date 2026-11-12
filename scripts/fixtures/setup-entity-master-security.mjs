import{readFile}from'node:fs/promises';import{setupTaxCatalogSecurity}from'./setup-tax-catalog-security.mjs';
export const migration='20261101150451_secure_entity_masters.sql';
export async function setupEntityMasterSecurity(db){await setupTaxCatalogSecurity(db);const read=p=>readFile(new URL(p,import.meta.url),'utf8');await db.exec(await read('./entity-master-tables.sql'));
 // Reproduce the actual storage checks; function-only validation is insufficient for email regressions.
 await db.exec(`alter table customers drop constraint if exists customers_email_format,drop constraint if exists customer_statement_email_required,
 add constraint customers_email_format check(email is null or email ~* '^[^[:space:]@]+@[^[:space:]@]+[.][^[:space:]@]+$'),
 add constraint customer_statement_email_required check(not envio_estado_cuenta_auto or (email is not null and email ~ '^[^[:space:]@,;<>]+@[^[:space:]@,;<>]+[.][^[:space:]@,;<>]+$'))`);
 await db.exec(`create table if not exists department_subsidiaries(department_id bigint,subsidiary_id bigint);alter table employees add column if not exists is_sales_representative boolean default false,add column if not exists first_name text default 'Synthetic',add column if not exists last_name text default 'Employee';
 create sequence fixture_customer_number_seq start 5000;create sequence fixture_supplier_number_seq start 5000;
 alter table customers alter column customer_number set default 'CLI-SYN-'||nextval('fixture_customer_number_seq');alter table suppliers alter column supplier_number set default 'PROV-SYN-'||nextval('fixture_supplier_number_seq');
 do $$declare t text;k text;begin for t,k in select *from(values('customers','customer_id'),('suppliers','supplier_id'),('entity_subsidiaries','id'),('customer_currencies','id'),('supplier_currencies','id'),('entity_withholding_rules','rule_id'))x loop
 if not exists(select 1 from pg_attribute where attrelid=('public.'||t)::regclass and attname=k and attidentity<>'')then execute format('with numbered as(select ctid,row_number()over()n from public.%I)update public.%I x set %I=n from numbered where x.ctid=numbered.ctid and x.%I is null',t,t,k,k);execute format('alter table public.%I alter column %I set not null',t,k);execute format('alter table public.%I alter column %I add generated always as identity(start with 5000)',t,k);end if;
 if not exists(select 1 from pg_constraint where conrelid=('public.'||t)::regclass and contype='p')then execute format('alter table public.%I add primary key(%I)',t,k);end if;execute format('select setval(%L,greatest(5000,coalesce((select max(%I)from public.%I),0)+1),false)',pg_get_serial_sequence('public.'||t,k),k,t);end loop;end$$;
 alter table entity_subsidiaries add constraint fixture_entity_customer_fk foreign key(customer_id)references customers(customer_id)on delete cascade not valid;
 alter table entity_subsidiaries add constraint fixture_entity_supplier_fk foreign key(supplier_id)references suppliers(supplier_id)on delete cascade not valid;
 alter table customer_currencies add constraint fixture_currency_customer_fk foreign key(customer_id)references customers(customer_id)on delete cascade not valid;
 alter table supplier_currencies add constraint fixture_currency_supplier_fk foreign key(supplier_id)references suppliers(supplier_id)on delete cascade not valid;
 alter table entity_withholding_rules add constraint fixture_rule_customer_fk foreign key(customer_id)references customers(customer_id)on delete cascade not valid;
 alter table entity_withholding_rules add constraint fixture_rule_supplier_fk foreign key(supplier_id)references suppliers(supplier_id)on delete cascade not valid;
 create table fixture_entity_usage(customer_id bigint references customers(customer_id),supplier_id bigint references suppliers(supplier_id));
 alter table invoice add constraint fixture_invoice_customer_fk foreign key(customer_id)references customers(customer_id)not valid;
 alter table supplier_invoice add constraint fixture_invoice_supplier_fk foreign key(supplier_id)references suppliers(supplier_id)not valid;
 `);for(const k of['customers','suppliers']){await db.query('delete from role_access_matrix where role_id in(1,3)and resource_key=$1',['entities:'+k]);await db.query('insert into role_access_matrix values(1,$1,true,true,true,true),(3,$1,true,false,false,false)',['entities:'+k]);}
 await db.exec('set check_function_bodies=off');await db.exec(await read('./entity-master-original-export.sql'));await db.exec('set check_function_bodies=on');await db.exec('begin');await db.exec(await read('../../supabase/migrations/'+migration));await db.exec('commit');}
