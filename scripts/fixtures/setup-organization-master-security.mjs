import{readFile}from'node:fs/promises';import{setupEmployeeMasterSecurity}from'./setup-employee-master-security.mjs';
export const migration='20261101154021_secure_organization_dimensions.sql';
export async function setupOrganizationMasterSecurity(db){await setupEmployeeMasterSecurity(db);
 await db.exec(`do $$declare t text;k text;begin for t,k in select *from(values('departments','department_id'),('locations','location_id'))v loop
 if not exists(select 1 from pg_attribute where attrelid=('public.'||t)::regclass and attname=k and attidentity<>'')then execute format('alter table public.%I alter column %I add generated always as identity(start with 6000)',t,k);end if;
 if not exists(select 1 from pg_constraint where conrelid=('public.'||t)::regclass and contype='p')then execute format('alter table public.%I add primary key(%I)',t,k);end if;end loop;end$$;
 create unique index fixture_department_sub_unique on department_subsidiaries(department_id,subsidiary_id);create unique index fixture_location_sub_unique on location_subsidiaries(location_id,subsidiary_id);
 alter table department_subsidiaries add constraint fixture_department_link_fk foreign key(department_id)references departments(department_id)on delete cascade not valid;
 alter table location_subsidiaries add constraint fixture_location_link_fk foreign key(location_id)references locations(location_id)on delete cascade not valid;
 alter table employees add constraint fixture_employee_department_fk foreign key(department_id)references departments(department_id)not valid;
 alter table employees add constraint fixture_employee_location_fk foreign key(location_id)references locations(location_id)not valid;
 alter table departments add constraint fixture_department_parent_fk foreign key(parent_id)references departments(department_id)not valid;
 alter table locations add constraint fixture_location_parent_fk foreign key(parent_id)references locations(location_id)not valid;
 create table fixture_dimension_usage(department_id bigint references departments(department_id),location_id bigint references locations(location_id));
 alter table supplier_invoice_line add constraint fixture_invoice_dimension_fk foreign key(department_id)references departments(department_id)not valid;
 alter table supplier_invoice add constraint fixture_invoice_location_fk foreign key(location_id)references locations(location_id)not valid;
 `);for(const k of['departments','locations']){await db.query('delete from role_access_matrix where role_id in(1,3)and resource_key=$1',['organization:'+k]);await db.query('insert into role_access_matrix values(1,$1,true,true,true,true),(3,$1,true,false,false,false)',['organization:'+k]);}
 await db.exec('begin');await db.exec(await readFile(new URL('../../supabase/migrations/'+migration,import.meta.url),'utf8'));await db.exec('commit');}
