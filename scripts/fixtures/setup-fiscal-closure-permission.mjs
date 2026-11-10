import {readFile} from 'node:fs/promises';
import {isolatedRoleTemplateDatabase,assumeSecurityUser,assumeSqlRole,deniedSql,authId} from './isolated-role-template-security.mjs';
import {functionsIn} from './setup-audit-raw-security.mjs';
export {assumeSecurityUser,assumeSqlRole,deniedSql,authId};
export const migration='20261110015758_configure_active_role_fiscal_closure_permission.sql';
export const hardeningMigration='20261110031615_isolate_fiscal_closure_permission_authority.sql';
const source=async name=>(await readFile(new URL('../../supabase/migrations/'+name,import.meta.url),'utf8')).replaceAll('\r\n','\n');
async function functions(db,file,names){const all=functionsIn(await source(file));for(const name of names){const matches=all.filter(f=>f.name===name);if(matches.length!==1)throw Error('Expected one published function '+name);await db.exec(matches[0].sql);}}
export async function applyFiscalClosurePermission(db){await db.exec(await source(migration));}
export async function applyFiscalClosurePermissionHardening(db){await db.exec(await source(hardeningMigration));}
export async function setupFiscalClosurePermission({apply=true,permission=true,hardened=true}={}){
 const db=await isolatedRoleTemplateDatabase();
 try{
  // These published identity bodies predate the abbreviated schema fixture.
  // Install their exact canonical LF definitions; never weaken migration guards.
  await functions(db,'20261026112000_harden_user_catalog_rls.sql',['app_active_role_id','active_subsidiary_id']);
  const access=await source('20261101184932_secure_access_administration.sql');
  for(const name of ['actor','access']){const marker='create function access_admin_private.'+name+'(',start=access.indexOf(marker),end=access.indexOf('end$$;',start);if(start<0||end<0||access.indexOf(marker,start+marker.length)!==-1)throw Error('Published access definition missing');await db.exec(access.slice(start,end+7).replace('create function','create or replace function'));}
  await db.exec("update roles set role_name='Administrador',is_system_role=true where role_id=1");
  await db.exec("alter table auth.users add column raw_app_meta_data jsonb default '{\"actor_type\":\"HUMAN\",\"actor_source\":\"Synthetic permission fixture\"}';alter table activity_log add column activity_id bigint generated always as identity primary key");
  const audit=await source('20260807080000_create_audit_catalogs.sql');await db.exec(audit.slice(0,audit.indexOf('\ndo $$')));
  const central=await source('20260826160000_enable_central_auditing.sql');await db.exec(central.slice(0,central.indexOf('create or replace function')));
  await functions(db,'20260826160000_enable_central_auditing.sql',['audit_request_ip','audit_primary_key','install_audit_trigger']);
  await functions(db,'20260913090000_actor_audit_engine.sql',['resolve_audit_actor','stamp_actor_audit','reject_audit_mutation','reject_audit_truncate','install_actor_audit']);
  await functions(db,'20261026113000_redact_audit_secrets.sql',['audit_field_is_sensitive','audit_redact_jsonb','audit_redact_json_text','capture_row_audit']);
  for(const table of ['audit_log','change_log','event_log','activity_log','deleted_records','role_permissions'])await db.query('select install_actor_audit($1::regclass)',[table]);
  await db.exec("revoke all on audit_log,change_log,event_log,activity_log,deleted_records from public,anon,authenticated;revoke all on function resolve_audit_actor(),stamp_actor_audit(),capture_row_audit(),install_actor_audit(regclass) from public,anon,authenticated,service_role");
  if(permission)await db.exec("insert into permissions(code,module,description,is_operational)values('CONF_PERIODOS_FISCALES_CERRAR','Synthetic configuration','Synthetic fiscal closure',false)");
  await db.exec("insert into role_permissions(role_id,permission_id)select 1,permission_id from permissions where code='SYNTHETIC_OPERATION_1';insert into role_permissions(role_id,permission_id)select 3,permission_id from permissions where code='SYNTHETIC_OPERATION_2';insert into role_access_matrix(role_id,resource_key,can_view,can_create,can_edit,can_delete)values(1,'organization:accounting-periods',true,false,true,false)on conflict(role_id,resource_key)do nothing");
  const before=await fiscalPermissionState(db);if(apply){await applyFiscalClosurePermission(db);if(hardened)await applyFiscalClosurePermissionHardening(db);}const after=await fiscalPermissionState(db);
  await assumeSecurityUser(db);return{db,before,after};
 }catch(error){await db.close();delete error.query;throw error;}
}
export async function fiscalPermissionState(db){return(await db.query(`select jsonb_build_object(
 'matrix',(select coalesce(jsonb_agg(to_jsonb(x)order by role_id,resource_key),'[]')from role_access_matrix x),
 'grants',(select coalesce(jsonb_agg(to_jsonb(x)order by role_id,permission_id),'[]')from role_permissions x),
 'permissions',(select coalesce(jsonb_agg(to_jsonb(x)order by permission_id),'[]')from permissions x),
 'periods',(select coalesce(jsonb_agg(to_jsonb(x)order by fiscal_period_id),'[]')from fiscal_periods x),
 'gl',(select coalesce(jsonb_agg(to_jsonb(x)order by subsidiary_id,account_id,posting_date),'[]')from gl_impact x),
 'audit',(select coalesce(jsonb_agg(to_jsonb(x)order by log_id),'[]')from audit_log x))data`)).rows[0].data;}
