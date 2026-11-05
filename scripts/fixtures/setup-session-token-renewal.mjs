import{readFile}from'node:fs/promises';
import{setupSessionBoundarySecurity}from'./setup-session-boundary-security.mjs';
export{hash,authId,authSession}from'./setup-session-boundary-security.mjs';
export const sessionTokenRenewalMigration='20261105175823_renew_trusted_erp_session_lease.sql';
export const sessionTokenRenewalFunctions=['public.security_prepare_session_refresh(uuid,uuid,text)','public.security_refresh_session(uuid,uuid,text,text,text,timestamptz)','public.security_logout_session_binding(uuid,uuid,text,text)'];
export async function setupSessionTokenRenewal(db){
 await setupSessionBoundarySecurity(db);
 await db.exec(`insert into user_role_sessions(session_id,user_id,role_id)values('11111111-0000-4000-8000-000000000001',1,2),('11111111-0000-4000-8000-000000000002',2,4),('11111111-0000-4000-8000-000000000004',4,5);
 insert into user_company_sessions(session_id,user_id,subsidiary_id)values('11111111-0000-4000-8000-000000000001',1,2),('11111111-0000-4000-8000-000000000002',2,1),('11111111-0000-4000-8000-000000000004',4,1);`);
}
export async function applySessionTokenRenewal(db){
 const source=(await readFile(new URL('../../supabase/migrations/'+sessionTokenRenewalMigration,import.meta.url),'utf8')).replace(/\r\n/g,'\n');
 await db.exec('begin');try{await db.exec(source);await db.exec('commit');}catch(error){await db.exec('rollback');delete error.query;throw error;}
}
