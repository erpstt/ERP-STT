import {readFile} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
import {setupSessionBoundarySecurity,hash,authId,authSession} from './setup-session-boundary-security.mjs';
import {functionsIn} from './setup-audit-raw-security.mjs';

const source=name=>readFile(new URL('../../supabase/migrations/'+name,import.meta.url),'utf8');
export {hash,authId,authSession};

export async function assumeSecurityUser(db,user=1,role=1,company=1,device=user,session=authSession(user)){
 await db.exec('reset role');
 await db.query('insert into user_role_sessions values($1,$2,$3) on conflict(session_id) do update set user_id=excluded.user_id,role_id=excluded.role_id',[session,user,role]);
 await db.query('insert into user_company_sessions values($1,$2,$3) on conflict(session_id) do update set user_id=excluded.user_id,subsidiary_id=excluded.subsidiary_id',[session,user,company]);
 await db.query("select set_config('request.jwt.claims',$1,false),set_config('request.headers',$2,false)",[
  JSON.stringify({sub:authId(user),email:'forged-header@example.invalid',session_id:session,role:'authenticated'}),
  JSON.stringify({'x-erp-device-hash':hash('device-'+device),'x-audit-execution-context-id':'synthetic-security-'+user})
 ]);
 await db.exec('set role authenticated');
}

async function sessionDatabase(){
 const db=new PGlite();
 try{
  await setupSessionBoundarySecurity(db);
  await db.exec("update subsidiaries set name='Synthetic security company '||subsidiary_id");
  return db;
 }catch(error){await db.close();throw error;}
}

export async function isolatedPasswordSecurityDatabase(){
 const db=await sessionDatabase();
 try{
  const tables=await source('20260806110000_create_security_catalogs.sql');
  const history=tables.match(/create table if not exists public\.password_history\s*\([\s\S]*?\n\);/);
  if(!history)throw new Error('Real password-history schema missing');
  await db.exec(history[0]);
  await db.exec('grant select,insert on password_history to authenticated;grant usage,select on sequence password_history_history_id_seq to authenticated;alter table password_history enable row level security');
  const policySource=await source('20261026100000_secure_password_sessions_rls.sql');
  const policies=[...policySource.matchAll(/create policy password_history_[a-z_]+\s[\s\S]*?;/g)];
  if(policies.length!==2)throw new Error('Real password-history policies missing');
  for(const policy of policies)await db.exec(policy[0]);
  const revoke=policySource.match(/revoke update,delete,truncate,references,trigger\s+on table public\.password_history\s+from authenticated;/);
  if(!revoke)throw new Error('Real password-history privilege boundary missing');
  await db.exec(revoke[0]);
  await db.exec('revoke all on password_history from public,anon');
  for(const user of[1,2,3,4])await db.query('insert into password_history(user_id,password_hash) values($1,$2)',[user,'SYNTHETIC-HISTORY-'+user]);
  // No legacy sessions policies are installed. Session access stays behind the
  // current checked catalog/revocation functions and device/Auth identity.
  return db;
 }catch(error){await db.close();throw error;}
}

async function installFunctions(db,file,names){
 const definitions=functionsIn(await source(file));
 for(const name of names){
  const matches=definitions.filter(item=>item.name===name);
  if(matches.length!==1)throw new Error('Expected one real function: '+name);
  await db.exec(matches[0].sql);
 }
}

export async function isolatedUserAuditDatabase(){
 const db=await sessionDatabase();
 try{
  await db.exec("alter table auth.users add column raw_app_meta_data jsonb default '{\"actor_type\":\"HUMAN\",\"actor_source\":\"Synthetic isolated database\"}';alter table users add column created_at timestamptz default now();alter table activity_log add column activity_id bigint generated always as identity primary key");
  const catalogs=await source('20260807080000_create_audit_catalogs.sql');
  const boundary=catalogs.indexOf('\ndo $$');
  if(boundary<0)throw new Error('Audit schema boundary missing');
  await db.exec(catalogs.slice(0,boundary)); // Schema only, without historical permissive policies.
  const central=await source('20260826160000_enable_central_auditing.sql');
  await db.exec(central.slice(0,central.indexOf('create or replace function')));
  await installFunctions(db,'20260826160000_enable_central_auditing.sql',['audit_request_ip','audit_primary_key','install_audit_trigger']);
  await installFunctions(db,'20260913090000_actor_audit_engine.sql',['resolve_audit_actor','stamp_actor_audit','reject_audit_mutation','reject_audit_truncate','install_actor_audit']);
  await installFunctions(db,'20261026113000_redact_audit_secrets.sql',['audit_field_is_sensitive','audit_redact_jsonb','audit_redact_json_text','capture_row_audit']);
  for(const table of['audit_log','change_log','event_log','activity_log','deleted_records','users'])await db.query('select install_actor_audit($1::regclass)',[table]);
  await db.exec(await source('20260913110000_record_actor_audit_view.sql'));
  const hardening=await source('20261026112000_harden_user_catalog_rls.sql');
  const safeGrant=hardening.match(/grant select\([\s\S]*?\) on table public\.users to authenticated;/);
  if(!safeGrant)throw new Error('Real safe user column grant missing');
  await db.exec('revoke select on users from public,anon,authenticated');
  await db.exec(safeGrant[0]);
  await db.exec(await source('20261026114000_fix_user_record_audit_grants.sql'));
  // Model the approved P81 service baseline: table CRUD and sequence
  // USAGE/SELECT/UPDATE are preserved. Only browser/public raw access closes.
  const rawTables=['audit_log','change_log','event_log','activity_log','deleted_records'];
  const rawSequences=['audit_log_log_id_seq','change_log_change_id_seq','event_log_event_id_seq','activity_log_activity_id_seq','deleted_records_deleted_id_seq'];
  await db.exec('grant select,insert,update,delete on '+rawTables.join(',')+' to service_role;grant usage,select,update on sequence '+rawSequences.join(',')+' to service_role;revoke all on '+rawTables.join(',')+' from public,anon,authenticated;revoke all on sequence '+rawSequences.join(',')+' from public,anon,authenticated');
  for(const table of rawTables)await db.exec('alter table '+table+' enable row level security;create policy audit_select on '+table+' for select to authenticated using(false)');
  // Match the migration restrictions for internal helpers; no extra service
  // function privileges are assumed or tested by this user-metadata fixture.
  await db.exec('revoke all on function install_actor_audit(regclass),install_audit_trigger(regclass),audit_field_is_sensitive(text),audit_redact_jsonb(jsonb),audit_redact_json_text(text) from public,anon,authenticated,service_role;revoke all on function resolve_audit_actor() from public,anon,authenticated');
  await db.exec("insert into role_access_matrix(role_id,resource_key,can_view,can_create,can_edit,can_delete) values(3,'security:users',true,false,false,false)");
  // Create the two audit targets through the actual central-admin RPC; the
  // real stamp/capture triggers establish human provenance from auth.users.
  for(const user of[100,101]){
   const email='synthetic-audit-'+user+'@example.invalid';
   await db.query('insert into auth.users(id,email) values($1,$2)',[authId(user),email]);
   await assumeSecurityUser(db,4,5);
   const created=(await db.query('select security_create_user($1,$2,$3,$4,null,true) value',[email,authId(user),'Synthetic','Audit '+user])).rows[0].value;
   if(created.user_id!==user)throw new Error('Unexpected synthetic user identity');
   await db.exec('reset role');
   await db.query('insert into user_roles(user_id,role_id) values($1,1)',[user]);
   await db.query('insert into user_subsidiaries(user_id,subsidiary_id) values($1,$2)',[user,user===100?1:2]);
   await db.query('insert into auth.sessions(id,user_id) values($1,$2)',[authSession(user),authId(user)]);
   await db.exec('set role service_role');
   await db.query("select security_register_login($1,$2,$3,$4,'Synthetic audit owner',now()+interval '1 hour',null)",[authId(user),authSession(user),hash('jwt-'+user),hash('device-'+user)]);
   await db.exec('reset role');
  }
  return db;
 }catch(error){await db.close();throw error;}
}
