import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
import {setupSessionBoundarySecurity} from './setup-session-boundary-security.mjs';
import {isolatedUserAuditDatabase,assumeSecurityUser,authId,authSession,hash} from './isolated-security-user-db-test.mjs';
import {installSelfRoleAssignment} from './role-assignment-self-migration.mjs';

export {assumeSecurityUser,authId,authSession,hash};
const source=name=>readFile(new URL('../../supabase/migrations/'+name,import.meta.url),'utf8');
function required(sql,pattern,label){const match=sql.match(pattern);if(!match)throw Error('Missing real SQL fixture boundary: '+label);return match[0];}

// Synthetic identity/storage schemas; real current access/session functions.
// Selected older DDL adds constraints and invitation ACLs, never user policies
// or a historical function that could replace a strengthened public wrapper.
export async function isolatedUserAccessDatabase({audit=false,invitations=false}={}){
 const db=audit?await isolatedUserAuditDatabase():new PGlite();
 try{
  if(!audit)await setupSessionBoundarySecurity(db);
  await db.exec("update subsidiaries set name='Synthetic user access company '||subsidiary_id");
  const invitation=await source('20261026110000_secure_user_auth_invitations.sql');
  for(const index of ['users_email_lower_uidx','users_auth_user_id_uidx'])await db.exec(required(invitation,new RegExp('create unique index if not exists '+index+'[\\s\\S]*?;'),'identity index'));
  const hardening=await source('20261026112000_harden_user_catalog_rls.sql');
  await db.exec(required(hardening,/alter table public\.users\s+add constraint users_email_canonical_check\s+check\(email=lower\(btrim\(email\)\)\);/,'canonical email constraint'));
  const bulk=await source('20261027170000_bulk_user_subsidiary_assignments.sql');
  await db.exec(required(bulk,/revoke usage,select,update on sequence public\.user_subsidiaries_id_seq from public,anon,authenticated;/,'subsidiary sequence boundary'));
  await installSelfRoleAssignment(db);
  if(invitations){
   await db.exec("create function auth.role() returns text language sql stable as $$select auth.jwt()->>'role'$$");
   const start=invitation.indexOf('create table if not exists public.user_invitation_grants('),end=invitation.indexOf('comment on column public.users.auth_user_id');
   if(start<0||end<=start)throw Error('Missing real invitation grant schema/function boundary');
   await db.exec(invitation.slice(start,end));
  }
  return db;
 }catch(error){await db.close();throw error;}
}
export async function beginIsolatedCase(db,t){await db.exec('reset role;begin');t.after(()=>db.exec('reset role;rollback'));}
export async function deniedSql(db,statement,params=[],code='42501'){
 await db.exec('savepoint expected_denial');
 try{await assert.rejects(()=>db.query(statement,params),error=>error?.code===code);}
 finally{await db.exec('rollback to expected_denial;release expected_denial');}
}
export async function assumeSqlRole(db,role,claims={}){
 assert.ok(['anon','authenticated','service_role'].includes(role));
 await db.exec('reset role');
 await db.query("select set_config('request.jwt.claims',$1,false),set_config('request.headers','{}',false)",[JSON.stringify({role,...claims})]);
 await db.exec('set role '+role);
}
