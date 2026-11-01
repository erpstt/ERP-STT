import{readFile}from'node:fs/promises';import{setupEntityMasterSecurity}from'./setup-entity-master-security.mjs';
export const migration='20261101152112_secure_employee_master.sql';
export async function setupEmployeeMasterSecurity(db){
 await setupEntityMasterSecurity(db);await db.exec(await readFile(new URL('./employee-master-tables.sql',import.meta.url),'utf8'));
 await db.exec(`alter table users add column if not exists first_name text default 'Synthetic',add column if not exists last_name text default 'User';
 alter table employees alter column is_active set default true,alter column is_sales_representative set default false;
 create sequence fixture_employee_number_seq start 5000;alter table employees alter column employee_number set default 'EMP-SYN-'||nextval('fixture_employee_number_seq');
 do $$begin if not exists(select 1 from pg_attribute where attrelid='public.employees'::regclass and attname='employee_id'and attidentity<>'')then alter table employees alter column employee_id add generated always as identity(start with 5000);end if;end$$;
 create table fixture_employee_usage(employee_id bigint references employees(employee_id));
 alter table customers add constraint fixture_customer_rep_fk foreign key(sales_representative_id)references employees(employee_id)not valid;
 insert into departments(department_id,name,subsidiary_id,is_inactive,type)values(501,'Synthetic internal',1,false,'Interno'),(502,'Synthetic client',1,false,'Cliente'),(503,'Synthetic other',2,false,'Interno'),(504,'Synthetic shared',2,false,'Interno');
 insert into department_subsidiaries(department_id,subsidiary_id)values(504,1);
 insert into locations(location_id,name,subsidiary_id)values(501,'Synthetic local',1),(502,'Synthetic foreign',2),(503,'Synthetic shared',2);insert into location_subsidiaries(location_id,subsidiary_id)values(503,1);
 `);
 for(const role of[1,3])await db.query("delete from role_access_matrix where role_id=$1 and resource_key='entities:employees'",[role]);
 await db.exec("insert into role_access_matrix values(1,'entities:employees',true,true,true,true),(3,'entities:employees',true,false,false,false)");
 await db.exec('begin');await db.exec(await readFile(new URL('../../supabase/migrations/'+migration,import.meta.url),'utf8'));await db.exec('commit');
}
