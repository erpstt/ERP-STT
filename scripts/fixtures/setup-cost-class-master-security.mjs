import{readFile}from'node:fs/promises';import{setupOrganizationMasterSecurity}from'./setup-organization-master-security.mjs';
export const migration='20261101160132_secure_classes_cost_centers.sql';
export async function setupCostClassMasterSecurity(db){await setupOrganizationMasterSecurity(db);await db.exec(await readFile(new URL('./cost-class-master-tables.sql',import.meta.url),'utf8'));
 await db.exec(`do $$declare t text;k text;begin for t,k in select *from(values('classes','class_id'),('cost_centers','cost_center_id'))v loop
 if not exists(select 1 from pg_attribute where attrelid=('public.'||t)::regclass and attname=k and attidentity<>'')then execute format('alter table public.%I alter column %I add generated always as identity(start with 7000)',t,k);end if;if not exists(select 1 from pg_constraint where conrelid=('public.'||t)::regclass and contype='p')then execute format('alter table public.%I add primary key(%I)',t,k);end if;end loop;end$$;
 alter table classes alter column is_inactive set default false;alter table cost_centers alter column is_inactive set default false;
 create unique index fixture_class_sub_unique on class_subsidiaries(class_id,subsidiary_id);
 alter table class_subsidiaries add constraint fixture_class_link_fk foreign key(class_id)references classes(class_id)on delete cascade not valid;
 alter table classes add constraint fixture_class_parent_fk foreign key(parent_id)references classes(class_id)not valid;
 alter table cost_centers add constraint fixture_cost_class_fk foreign key(class_id)references classes(class_id)not valid;
 alter table supplier_invoice_line add constraint fixture_invoice_cost_fk foreign key(cost_center_id)references cost_centers(cost_center_id)not valid;
 alter table supplier_invoice_line add constraint fixture_invoice_class_fk foreign key(class_id)references classes(class_id)not valid;
 create table fixture_cost_usage(cost_center_id bigint references cost_centers(cost_center_id));
 create table if not exists role_permissions(role_id bigint,permission_id bigint);create table if not exists permissions(permission_id bigint,code text);
 create table if not exists cost_center_up_approver_audit(id bigint generated always as identity,subsidiary_id bigint,previous_approver_id bigint,new_approver_id bigint,scope text,affected_count int,cost_center_ids jsonb,changed_by bigint);
 `);
 await db.exec('set check_function_bodies=off');await db.exec(await readFile(new URL('./cost-class-original-functions.sql',import.meta.url),'utf8'));await db.exec('set check_function_bodies=on');
 await db.exec(`create trigger fixture_cost_auto_code before insert or update of customer_id,subsidiary_id,cost_center_type,code on cost_centers for each row execute function assign_customer_cost_center_code();
 create trigger fixture_cost_department before insert or update of customer_id,department_id,cost_center_type,subsidiary_id on cost_centers for each row execute function validate_cost_center_department();
 create trigger fixture_cost_class before insert or update of class_id,subsidiary_id on cost_centers for each row execute function validate_cost_center_class();
 create trigger fixture_cost_up before insert or update of cost_center_type,up_approver_id,subsidiary_id on cost_centers for each row execute function validate_up_approver_assignment();
 create trigger fixture_customer_cost_sync after update of department_id on customers for each row execute function sync_customer_cost_center_department();
 insert into permissions(code)values('ORG_UP_APPROVER_MANAGE'),('ORG_UP_APPROVER_VIEW')on conflict(code)do nothing;insert into role_permissions select 1,permission_id from permissions where code in('ORG_UP_APPROVER_MANAGE','ORG_UP_APPROVER_VIEW')on conflict do nothing;
 `);for(const k of['classes','cost-centers']){await db.query('delete from role_access_matrix where role_id in(1,3)and resource_key=$1',['organization:'+k]);await db.query('insert into role_access_matrix values(1,$1,true,true,true,true),(3,$1,true,false,false,false)',['organization:'+k]);}
 await db.exec('begin');await db.exec(await readFile(new URL('../../supabase/migrations/'+migration,import.meta.url),'utf8'));await db.exec('commit');}
