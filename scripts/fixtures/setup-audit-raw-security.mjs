import {readFile} from 'node:fs/promises';
export const rawAuditTables=['audit_log','change_log','event_log','activity_log','deleted_records'];
export const rawAuditKeys=['log_id','change_id','event_id','activity_id','deleted_id'];
export const rawAuditResources=['audit:audit-logs','audit:change-logs','audit:event-logs','audit:activity-logs','audit:deleted-records'];
const dir=new URL('../../supabase/migrations/',import.meta.url);
async function source(name){return readFile(new URL(name,dir),'utf8');}
export function functionsIn(sql){return [...sql.matchAll(/create\s+(?:or\s+replace\s+)?function\s+(?:public\.)?([a-z0-9_]+)\s*\([\s\S]*?\$\$[\s\S]*?\$\$\s*;/gi)].map(m=>({name:m[1],sql:m[0]}));}
async function installFunctions(db,file,names){const found=functionsIn(await source(file)).filter(f=>!names||names.includes(f.name));for(const f of found)await db.exec(f.sql);for(const name of names||[])if(!found.some(f=>f.name===name))throw Error('Missing real function '+name);}
export async function assumeAuditUser(db,user=1,role=10){
 await db.exec('reset role');
 await db.query("select set_config('fixture.role',$1,false),set_config('request.jwt.claims',$2,false)",[String(role??''),JSON.stringify(user?{sub:'00000000-0000-4000-8000-'+String(user).padStart(12,'0'),session_id:'fixture-session'}:{})]);
 await db.exec('set role authenticated');
}
export async function setupAuditRawSecurity(db){
 await db.exec(`create role anon;create role authenticated;create role service_role bypassrls;create schema auth;
 create table auth.users(id uuid primary key,email text,raw_app_meta_data jsonb);
 create function auth.jwt()returns jsonb language sql stable as $$select coalesce(nullif(current_setting('request.jwt.claims',true),'')::jsonb,'{}'::jsonb)$$;
 create function auth.uid()returns uuid language sql stable as $$select nullif(auth.jwt()->>'sub','')::uuid$$;
 create table users(user_id bigint primary key,email text,first_name text,last_name text,is_active boolean,auth_user_id uuid);
 create table subsidiaries(subsidiary_id bigint primary key,name text,is_active boolean);
 create table user_subsidiaries(user_id bigint,subsidiary_id bigint);
 create table role_access_matrix(role_id bigint,resource_key text,can_view boolean,can_create boolean,can_edit boolean,can_delete boolean);
 insert into subsidiaries values(1,'Synthetic One',true),(2,'Synthetic Two',true);
 insert into users select n,'synthetic-'||n||'@example.invalid','Synthetic',n::text,true,('00000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid from generate_series(1,5)n;
 insert into auth.users select auth_user_id,email,jsonb_build_object('actor_type','HUMAN','actor_source','Synthetic local fixture')from users;
 insert into user_subsidiaries values(1,1),(2,1),(3,1),(4,2),(5,1),(5,2);
 create function app_user_id()returns bigint language sql stable security definer set search_path=pg_catalog,public as $$select user_id from public.users where auth_user_id=auth.uid()$$;
 create function app_session_id()returns text language sql stable as $$select auth.jwt()->>'session_id'$$;
 create function app_active_role_id()returns bigint language sql stable as $$select nullif(current_setting('fixture.role',true),'')::bigint$$;
 create function app_is_admin()returns boolean language sql stable as $$select public.app_user_id()=2$$;
 create function security_assert_role_access(r text,a text)returns void language plpgsql stable security definer set search_path=pg_catalog,public as $$begin
 if app_is_admin()then return;end if;
 if not exists(select 1 from role_access_matrix where role_id=app_active_role_id()and resource_key=r and can_view and case a when'view'then can_view when'create'then can_create when'edit'then can_edit when'delete'then can_delete else false end)then raise exception using errcode='42501';end if;end$$;`);
 for(const r of rawAuditResources)await db.query('insert into role_access_matrix values(10,$1,true,false,false,false),(20,$1,true,false,false,false),(30,$1,false,false,false,false)',[r]);
 await db.exec("insert into role_access_matrix values(10,'audit:change-report',true,false,false,false),(20,'audit:change-report',false,false,false,false),(30,'audit:change-report',false,false,false,false)");
 await db.exec(await source('20260807080000_create_audit_catalogs.sql'));
 const central=await source('20260826160000_enable_central_auditing.sql');await db.exec(central.slice(0,central.indexOf('create or replace function')));
 await installFunctions(db,'20260826160000_enable_central_auditing.sql',['audit_request_ip','audit_primary_key','install_audit_trigger']);
 await installFunctions(db,'20260913090000_actor_audit_engine.sql',['resolve_audit_actor','stamp_actor_audit','reject_audit_mutation','reject_audit_truncate','install_actor_audit']);
 await installFunctions(db,'20261026113000_redact_audit_secrets.sql',['audit_field_is_sensitive','audit_redact_jsonb','audit_redact_json_text','capture_row_audit','record_system_event']);
 await db.exec(`create table invoice(invoice_id bigint generated always as identity primary key,subsidiary_id bigint not null references subsidiaries,invoice_number text,amount numeric,password_hash text,payload jsonb);
 alter table invoice enable row level security;
 create policy own_company on invoice for all to authenticated using(exists(select 1 from user_subsidiaries us where us.user_id=app_user_id()and us.subsidiary_id=invoice.subsidiary_id))with check(exists(select 1 from user_subsidiaries us where us.user_id=app_user_id()and us.subsidiary_id=invoice.subsidiary_id));
 grant select,insert,update,delete on invoice to authenticated;grant select on users,user_subsidiaries,subsidiaries to authenticated;
 grant usage on schema auth to authenticated;grant execute on function auth.uid(),auth.jwt()to authenticated;
 grant usage on sequence invoice_invoice_id_seq to authenticated;`);
 await db.query("select set_config('request.jwt.claims',$1,false)",[JSON.stringify({sub:'00000000-0000-4000-8000-000000000001',session_id:'fixture-seed'})]);
 for(const t of [...rawAuditTables,'invoice'])await db.query('select install_actor_audit($1::regclass)',[t]);
 await db.exec(`grant select on audit_log,change_log,event_log,activity_log,deleted_records to authenticated,anon,service_role;
 grant usage,select,update on all sequences in schema public to anon,authenticated,service_role;
 grant select(old_value),update(new_value)on change_log to public,anon,authenticated;
 grant select(record_data_json)on deleted_records to public,anon,authenticated;
 grant execute on function record_system_event(text,text,text,text,jsonb)to service_role;
 revoke all on function record_system_event(text,text,text,text,jsonb)from public,anon,authenticated;
 revoke all on function install_actor_audit(regclass),install_audit_trigger(regclass)from public,anon,authenticated,service_role;
 revoke all on function resolve_audit_actor()from public,anon,authenticated;
 revoke all on function audit_field_is_sensitive(text),audit_redact_jsonb(jsonb),audit_redact_json_text(text)from public,anon,authenticated,service_role;`);
 for(const t of rawAuditTables){
  for(const action of ['insert','update','delete'])await db.exec('drop policy audit_'+action+' on '+t);
  if(['audit_log','event_log','activity_log'].includes(t))await db.exec('alter table '+t+' alter column "timestamp" set default \'2026-11-03T10:00:00Z\'::timestamptz');
 }
 await installFunctions(db,'20260913110000_record_actor_audit_view.sql',['record_actor_audit']);
 await db.exec('revoke all on function record_actor_audit(text,text)from public,anon;grant execute on function record_actor_audit(text,text)to authenticated,service_role;');
 // Real report and history bodies; only fixture identity/permission data is synthetic.
 await installFunctions(db,'20261019110000_audit_change_report.sql');
 await installFunctions(db,'20261019130000_audit_transaction_change_report.sql');
 await installFunctions(db,'20261023170000_optimize_audit_report_options.sql');
 for(const t of rawAuditTables)await db.exec("alter policy audit_select on "+t+" using(audit_has_direct_read('"+rawAuditResources[rawAuditTables.indexOf(t)]+"'))");
 for(const f of functionsIn(await source('20261019130000_audit_transaction_change_report.sql')))if(f.name.startsWith('audit_change_')&&!['audit_change_report_options'].includes(f.name))await db.exec('revoke all on function '+await functionSignature(db,f.name)+' from public,anon,authenticated');
 await db.exec(`revoke all on function audit_change_report_options(),run_audit_change_report(jsonb)from public,anon;grant execute on function audit_change_report_options(),run_audit_change_report(jsonb)to authenticated,service_role;
 insert into invoice(subsidiary_id,invoice_number,amount,password_hash,payload)values(1,'SYN-ONE',10,'SYNTHETIC-SECRET-ONE','{"api_key":"SYNTHETIC-SECRET-KEY","safe":"public fixture"}'),(2,'SYN-TWO',20,'SYNTHETIC-SECRET-TWO','{"safe":"fixture"}'),(1,'SYN-DELETED',30,'SYNTHETIC-SECRET-DELETE','{"token":"SYNTHETIC-SECRET-TOKEN"}');
 update invoice set amount=12 where invoice_id=1;
 update invoice set amount=22 where invoice_id=2;
 delete from invoice where invoice_id=3;
 select record_system_event('SYNTHETIC','Fixture','Synthetic event','EXITOSA','{"password":"SYNTHETIC-SECRET-EVENT","safe":true}');
 `);
}
async function functionSignature(db,name){const rows=(await db.query('select oid::regprocedure::text signature from pg_proc where pronamespace=\'public\'::regnamespace and proname=$1',[name])).rows;if(rows.length!==1)throw Error('Ambiguous fixture function '+name);return rows[0].signature;}
