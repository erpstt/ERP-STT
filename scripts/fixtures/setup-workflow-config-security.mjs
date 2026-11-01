import{readFile}from'node:fs/promises';import{setupBudgetSecurity}from'./setup-budget-security.mjs';
export const migration='20261101130023_secure_workflow_configuration.sql';
export async function setupWorkflowConfigSecurity(db){await setupBudgetSecurity(db);const read=p=>readFile(new URL(p,import.meta.url),'utf8');await db.exec(await read('./workflow-config-tables.sql'));
 await db.exec(`alter table users add column if not exists first_name text default 'Synthetic',add column if not exists last_name text default 'User';alter table departments add column if not exists is_inactive boolean default false;
 insert into role_access_matrix values(3,'workflow:approval-workflows',true,false,false,false),(2,'workflow:approval-workflows',true,true,true,true);
 `);await db.exec('set check_function_bodies=off');await db.exec(await read('./workflow-config-original-functions.sql'));await db.exec('set check_function_bodies=on');await db.exec('begin');await db.exec(await read('../../supabase/migrations/'+migration));await db.exec('commit');}
