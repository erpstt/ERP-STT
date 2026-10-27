import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import pg from 'pg';

process.loadEnvFile?.('.env');
if(!process.env.SUPABASE_URL)throw new Error('Configure SUPABASE_URL para ejecutar la prueba de base de datos.');

const projectRef=new URL(process.env.SUPABASE_URL).hostname.split('.')[0];
const db=new pg.Client({
  host:process.env.SUPABASE_DB_HOST||'aws-0-us-east-1.pooler.supabase.com',
  port:Number(process.env.SUPABASE_DB_PORT||6543),
  database:process.env.SUPABASE_DB_NAME||'postgres',
  user:process.env.SUPABASE_DB_USER||`postgres.${projectRef}`,
  password:process.env.SUPABASE_DB_PASSWORD||process.env.PGPASSWORD,
  ssl:{rejectUnauthorized:false},
  connectionTimeoutMillis:15_000
});
const migration=await readFile(new URL('../supabase/migrations/20261027170000_bulk_user_subsidiary_assignments.sql',import.meta.url),'utf8');
const useInstalledMigration=process.argv.includes('--live');

async function createIdentity(label,nonce){
  const authId=crypto.randomUUID();
  const email=`subsidiarias-${label.toLowerCase()}-${nonce}@example.test`;
  await db.query(`insert into auth.users(id,email,raw_app_meta_data)values($1,$2,'{}'::jsonb)`,[authId,email]);
  const account=(await db.query(`
    insert into public.users(email,password_hash,auth_user_id,first_name,last_name,is_active)
    values($1,'auth:'||$2,$2::uuid,$3,'Prueba',true)
    returning user_id
  `,[email,authId,label])).rows[0];
  return{authId,email,userId:Number(account.user_id)};
}

async function assume(identity,sessionId){
  await db.query('reset role');
  await db.query(`select set_config('request.jwt.claims',$1,true),set_config('request.headers','{}',true)`,[JSON.stringify({role:'authenticated',email:identity.email,sub:identity.authId,session_id:sessionId})]);
  await db.query('set local role authenticated');
}

async function expectCode(callback,code){
  await db.query('savepoint expected_error');
  try{
    await callback();
    assert.fail(`Se esperaba el error PostgreSQL ${code}.`);
  }catch(error){
    if(error.code==='ERR_ASSERTION')throw error;
    assert.equal(error.code,code,error.message);
  }finally{
    await db.query('rollback to savepoint expected_error');
    await db.query('release savepoint expected_error');
  }
}

await db.connect();
try{
  await db.query('begin');
  await db.query("set local lock_timeout='5s';set local statement_timeout='90s'");
  if(!useInstalledMigration)await db.query(migration);

  const nonce=crypto.randomUUID();
  const subsidiaries=(await db.query(`select subsidiary_id,name from public.subsidiaries order by subsidiary_id limit 3`)).rows;
  assert.ok(subsidiaries.length>=2,'La prueba requiere por lo menos dos subsidiarias.');
  const firstSid=Number(subsidiaries[0].subsidiary_id),secondSid=Number(subsidiaries[1].subsidiary_id);
  const adminRole=(await db.query(`select role_id from public.roles where lower(btrim(role_name))in('administrador','administrator','admin') order by role_id limit 1`)).rows[0];
  assert.ok(adminRole,'La prueba requiere el rol Administrador.');
  const delegatedRole=(await db.query(`insert into public.roles(role_name,description,is_system_role)values($1,'Prueba de asignación masiva',false)returning role_id`,[`TEST-SUBS-${nonce}`])).rows[0];
  const blockedRole=(await db.query(`insert into public.roles(role_name,description,is_system_role)values($1,'Sin permiso de empresas',false)returning role_id`,[`TEST-SUBS-BLOCKED-${nonce}`])).rows[0];
  await db.query(`insert into public.role_access_matrix(role_id,resource_key,can_view,can_create,can_edit,can_delete)values($1,'security:user-subsidiaries',true,false,true,false)`,[delegatedRole.role_id]);

  const administrator=await createIdentity('Administrador',nonce);
  const delegated=await createIdentity('Delegado',nonce);
  const blocked=await createIdentity('Bloqueado',nonce);
  const target=await createIdentity('Objetivo',nonce);
  await db.query(`insert into public.user_roles(user_id,role_id)values($1,$2),($3,$4),($5,$6)`,[
    administrator.userId,adminRole.role_id,
    delegated.userId,delegatedRole.role_id,
    blocked.userId,blockedRole.role_id
  ]);
  const adminSession=`subs-admin-${nonce}`,delegatedSession=`subs-delegated-${nonce}`,blockedSession=`subs-blocked-${nonce}`;
  await db.query(`insert into public.user_role_sessions(session_id,user_id,role_id)values($1,$2,$3),($4,$5,$6),($7,$8,$9)`,[
    adminSession,administrator.userId,adminRole.role_id,
    delegatedSession,delegated.userId,delegatedRole.role_id,
    blockedSession,blocked.userId,blockedRole.role_id
  ]);
  await db.query(`insert into public.user_subsidiaries(user_id,subsidiary_id)values($1,$2),($1,$3),($4,$2)`,[administrator.userId,firstSid,secondSid,delegated.userId]);
  await db.query(`insert into public.user_company_sessions(session_id,user_id,subsidiary_id)values($1,$2,$3),($4,$5,$3)`,[adminSession,administrator.userId,firstSid,delegatedSession,delegated.userId]);

  await assume(administrator,adminSession);
  const initialRows=(await db.query(`select public.security_user_subsidiary_assignments() data`)).rows[0].data;
  const targetInitial=initialRows.find(row=>Number(row.user_id)===target.userId);
  assert.ok(targetInitial,'El listado debe incluir usuarios sin asignaciones.');
  assert.deepEqual(targetInitial.subsidiary_ids,[]);
  const options=(await db.query(`select public.security_user_subsidiary_options() data`)).rows[0].data;
  const totalSubsidiaries=Number((await db.query(`select count(*) total from public.subsidiaries`)).rows[0].total);
  assert.equal(options.length,totalSubsidiaries,'La RPC de opciones debe devolver todas las subsidiarias, no solo las del actor.');

  const synced=(await db.query(`select public.security_sync_user_subsidiaries($1,$2::bigint[]) data`,[target.userId,[secondSid,firstSid,secondSid]])).rows[0].data;
  assert.deepEqual(synced.subsidiary_ids.map(Number).sort((a,b)=>a-b),[firstSid,secondSid].sort((a,b)=>a-b));
  assert.equal(Number((await db.query(`select count(*) total from public.user_subsidiaries where user_id=$1`,[target.userId])).rows[0].total),2,'La sincronización debe deduplicar las selecciones.');

  const staleSession=`subs-stale-${nonce}`;
  await db.query('reset role');
  await db.query(`insert into public.user_company_sessions(session_id,user_id,subsidiary_id)values($1,$2,$3)`,[staleSession,target.userId,secondSid]);
  await assume(administrator,adminSession);
  await db.query(`select public.security_sync_user_subsidiaries($1,$2::bigint[])`,[target.userId,[firstSid]]);
  await db.query('reset role');
  assert.equal(Number((await db.query(`select count(*) total from public.user_company_sessions where session_id=$1`,[staleSession])).rows[0].total),0,'Debe retirar el contexto de una empresa que ya no está autorizada.');
  await assume(administrator,adminSession);
  await expectCode(()=>db.query(`select public.security_sync_user_subsidiaries($1,array[999999999999]::bigint[])`,[target.userId]),'22023');
  await expectCode(()=>db.query(`select public.security_sync_user_subsidiaries($1,'{}'::bigint[])`,[target.userId]),'22023');
  await expectCode(()=>db.query(`select public.security_sync_user_subsidiaries($1,null::bigint[])`,[target.userId]),'22023');
  await expectCode(()=>db.query(`select public.security_sync_user_subsidiaries($1,'{}'::bigint[])`,[administrator.userId]),'22023');
  await expectCode(()=>db.query(`select public.security_sync_user_subsidiaries($1,$2::bigint[])`,[administrator.userId,[secondSid]]),'22023');

  await assume(delegated,delegatedSession);
  const delegatedOptions=(await db.query(`select public.security_user_subsidiary_options() data`)).rows[0].data;
  assert.equal(delegatedOptions.length,totalSubsidiaries,'Un rol delegado con view debe recibir la lista completa.');
  await db.query(`select public.security_sync_user_subsidiaries($1,$2::bigint[])`,[target.userId,[firstSid,secondSid]]);
  await expectCode(()=>db.query(`insert into public.user_subsidiaries(user_id,subsidiary_id)values($1,$2)`,[blocked.userId,secondSid]),'42501');
  await expectCode(()=>db.query(`select public.security_sync_user_subsidiaries($1,$2::bigint[])`,[administrator.userId,[firstSid,secondSid]]),'42501');
  await expectCode(()=>db.query(`select public.security_sync_user_subsidiaries($1,$2::bigint[])`,[delegated.userId,[firstSid,secondSid]]),'42501');

  await assume(blocked,blockedSession);
  await expectCode(()=>db.query(`select public.security_user_subsidiary_options()`),'42501');
  await expectCode(()=>db.query(`select public.security_sync_user_subsidiaries($1,$2::bigint[])`,[target.userId,[firstSid]]),'42501');

  await db.query('reset role');
  const grants=(await db.query(`select
    has_function_privilege('authenticated','public.security_user_subsidiary_assignments()','execute') assignments_authenticated,
    has_function_privilege('authenticated','public.security_user_subsidiary_options()','execute') options_authenticated,
    has_function_privilege('authenticated','public.security_sync_user_subsidiaries(bigint,bigint[])','execute') sync_authenticated,
    has_function_privilege('anon','public.security_sync_user_subsidiaries(bigint,bigint[])','execute') sync_anon,
    has_table_privilege('authenticated','public.user_subsidiaries','select') table_select_authenticated,
    has_table_privilege('authenticated','public.user_subsidiaries','insert') table_insert_authenticated,
    has_table_privilege('authenticated','public.user_subsidiaries','update') table_update_authenticated,
    has_table_privilege('authenticated','public.user_subsidiaries','delete') table_delete_authenticated,
    has_table_privilege('authenticated','public.user_subsidiaries','truncate') table_truncate_authenticated,
    has_table_privilege('authenticated','public.user_subsidiaries','references') table_references_authenticated,
    has_table_privilege('authenticated','public.user_subsidiaries','trigger') table_trigger_authenticated,
    has_sequence_privilege('authenticated','public.user_subsidiaries_id_seq','usage') sequence_usage_authenticated,
    has_sequence_privilege('authenticated','public.user_subsidiaries_id_seq','update') sequence_update_authenticated,
    has_table_privilege('anon','public.user_subsidiaries','insert') table_insert_anon,
    has_table_privilege('anon','public.user_subsidiaries','update') table_update_anon,
    has_table_privilege('anon','public.user_subsidiaries','delete') table_delete_anon,
    has_table_privilege('anon','public.user_subsidiaries','truncate') table_truncate_anon,
    has_table_privilege('anon','public.user_subsidiaries','references') table_references_anon,
    has_table_privilege('anon','public.user_subsidiaries','trigger') table_trigger_anon,
    has_sequence_privilege('anon','public.user_subsidiaries_id_seq','usage') sequence_usage_anon,
    has_sequence_privilege('anon','public.user_subsidiaries_id_seq','update') sequence_update_anon
  `)).rows[0];
  assert.equal(grants.assignments_authenticated,true);
  assert.equal(grants.options_authenticated,true);
  assert.equal(grants.sync_authenticated,true);
  assert.equal(grants.sync_anon,false);
  assert.equal(grants.table_select_authenticated,true);
  assert.equal(grants.table_insert_authenticated,false);
  assert.equal(grants.table_update_authenticated,false);
  assert.equal(grants.table_delete_authenticated,false);
  assert.equal(grants.table_truncate_authenticated,false);
  assert.equal(grants.table_references_authenticated,false);
  assert.equal(grants.table_trigger_authenticated,false);
  assert.equal(grants.sequence_usage_authenticated,false);
  assert.equal(grants.sequence_update_authenticated,false);
  assert.equal(grants.table_insert_anon,false);
  assert.equal(grants.table_update_anon,false);
  assert.equal(grants.table_delete_anon,false);
  assert.equal(grants.table_truncate_anon,false);
  assert.equal(grants.table_references_anon,false);
  assert.equal(grants.table_trigger_anon,false);
  assert.equal(grants.sequence_usage_anon,false);
  assert.equal(grants.sequence_update_anon,false);

  await db.query('rollback');
  console.log(JSON.stringify({installedMigration:useInstalledMigration,allUsersListed:true,allSubsidiariesListed:true,atomicSync:true,staleContextRemoved:true,selfLockoutPrevented:true,delegatedPermissions:true,rollback:true}));
}catch(error){
  await db.query('rollback').catch(()=>{});
  throw error;
}finally{
  await db.end();
}
