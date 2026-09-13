import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import pg from 'pg';

const local = process.argv.includes('--local');
if (!local) process.loadEnvFile('.env');
if (!local && !process.env.SUPABASE_DB_PASSWORD) throw new Error('Falta SUPABASE_DB_PASSWORD en .env.');
const ref = local ? '' : new URL(process.env.SUPABASE_URL).hostname.split('.')[0];
const client = local ? new (await import('../.tmp/actor-audit-validation/node_modules/@electric-sql/pglite/dist/index.js')).PGlite() : new pg.Client({
  host: process.env.SUPABASE_DB_HOST || 'aws-0-us-east-1.pooler.supabase.com',
  port: Number(process.env.SUPABASE_DB_PORT || 6543), database: 'postgres',
  user: process.env.SUPABASE_DB_USER || `postgres.${ref}`,
  password: process.env.SUPABASE_DB_PASSWORD,
  ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 15000
});
const migration = await readFile(new URL('../supabase/migrations/20260913090000_actor_audit_engine.sql', import.meta.url), 'utf8');
const apply = process.argv.includes('--apply');
if (local && apply) throw new Error('--apply requiere la base configurada en .env.');
const fixture = `actor_audit_test_${randomUUID().replaceAll('-', '')}`;
const q = (sql, params) => client.query(sql, params);
async function rejects(sql, pattern) {
  await q('savepoint expected_error');
  try { await assert.rejects(q(sql), pattern); }
  finally { await q('rollback to savepoint expected_error'); }
}
try {
  if (!local) await client.connect();
  else {
    await client.exec(`create role anon; create role authenticated; create role service_role;
      create schema auth;
      create table auth.users(id uuid primary key,email text,raw_app_meta_data jsonb);
      create table public.users(user_id bigint generated always as identity primary key,email text,first_name text,last_name text);
      create function auth.jwt() returns jsonb language sql stable as $$select coalesce(nullif(current_setting('request.jwt.claims',true),'')::jsonb,'{}')$$;
      create function public.app_user_id() returns bigint language sql stable as $$select user_id from public.users where email=auth.jwt()->>'email' limit 1$$;
      create function public.app_session_id() returns text language sql stable as $$select auth.jwt()->>'session_id'$$;`);
    for (const file of ['20260807080000_create_audit_catalogs.sql','20260826160000_enable_central_auditing.sql']) {
      await client.exec(await readFile(new URL(`../supabase/migrations/${file}`,import.meta.url),'utf8'));
    }
  }
  await q('begin');
  await q("set local lock_timeout='10s'");
  await q("set local statement_timeout='120s'");
  if (local) await client.exec(migration); else await q(migration);
  console.log('Migration compiled; checking coverage and behavior.');
  const coverage = await q(`select count(*)::int total,
    count(*) filter(where exists(select 1 from pg_trigger t where t.tgrelid=c.oid and t.tgname='zzzz_actor_stamp' and t.tgenabled='O'))::int covered
    from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind in ('r','p')`);
  assert.equal(coverage.rows[0].total, coverage.rows[0].covered);
  await q('savepoint fixtures');
  await q(`create table public.${fixture}(id bigint generated always as identity primary key, value text)`);
  await q(`create table public.${fixture}_partitioned(id integer primary key) partition by range(id)`);
  await q(`create table public.${fixture}_partition partition of public.${fixture}_partitioned for values from (0) to (10)`);
  const partitionRow=(await q(`insert into public.${fixture}_partitioned(id) values(1) returning *`)).rows[0];
  assert.equal(partitionRow.actor_type,'SYSTEM_JOB');
  await rejects(`truncate public.${fixture}_partition`, /TRUNCATE/);
  const inserted = (await q(`insert into public.${fixture}(value,created_by_email,actor_type) values('before','spoof@example.com','HUMAN') returning *`)).rows[0];
  assert.equal(inserted.actor_type, 'SYSTEM_JOB');
  assert.equal(inserted.created_by_email, 'database@nexo.local');
  await rejects(`update public.${fixture} set created_by_email='spoof@example.com'`, /inmutable/);
  await q(`select set_config('request.headers',$1,true)`, [JSON.stringify({'x-audit-execution-context-id':'update-trace'})]);
  const updated = (await q(`update public.${fixture} set value='after',updated_by_email='spoof@example.com' returning *`)).rows[0];
  assert.equal(updated.created_by_email, inserted.created_by_email);
  assert.equal(updated.execution_context_id, inserted.execution_context_id);
  assert.equal(updated.updated_by_email, 'database@nexo.local');
  assert.equal(updated.updated_execution_context_id, 'update-trace');
  await rejects(`truncate public.${fixture}`, /TRUNCATE/);
  await q(`delete from public.${fixture}`);
  const logs = (await q('select * from public.audit_log where entity_type=$1 order by log_id', [fixture])).rows;
  assert.equal(logs.length, 3);
  assert.deepEqual(logs.map(x=>x.action), ['CREACION','MODIFICACION','ELIMINACION']);
  assert.equal(logs[2].execution_context_id, 'update-trace');
  await rejects(`update public.audit_log set description='tamper' where log_id=${logs[0].log_id}`, /inmutable/);
  await rejects(`delete from public.audit_log where log_id=${logs[0].log_id}`, /inmutable/);
  await rejects('truncate public.audit_log cascade', /TRUNCATE/);
  // Test all registered actor types using temporary auth identities, rolled back below.
  let humanRecordId;
  for (const kind of ['HUMAN','AI_AGENT','SYSTEM_JOB','EXTERNAL_API']) {
    const id = randomUUID();
    const email = `${id}@audit-test.invalid`;
    await q(`insert into auth.users(id,email,raw_app_meta_data) values($1,$2,$3)`, [id,email,JSON.stringify({actor_type:kind,actor_name:`Test ${kind}`,actor_source:'Audit test'})]);
    await q(`select set_config('request.jwt.claims',$1,true)`, [JSON.stringify({sub:id,email,role:'authenticated'})]);
    await q(`select set_config('request.headers',$1,true)`, [JSON.stringify({'x-audit-actor-type':'SYSTEM_JOB','x-audit-email':'spoof@example.com','x-audit-execution-context-id':kind})]);
    const row=(await q(`insert into public.${fixture}(value) values('actor') returning *`)).rows[0];
    if (kind === 'HUMAN') humanRecordId = row.id;
    assert.equal(row.created_by_id,id); assert.equal(row.created_by_email,email);
    assert.equal(row.actor_type,kind); assert.equal(row.actor_source,'Audit test');
    assert.equal(row.execution_context_id,kind);
    const changed=(await q(`update public.${fixture} set value='changed by next actor' where id=$1 returning *`,[row.id])).rows[0];
    assert.equal(changed.updated_by_id,id);
    assert.equal(changed.updated_actor_type,kind);
  }
  await q(`select set_config('request.jwt.claims','{"role":"service_role"}',true)`);
  const serviceRow=(await q(`insert into public.${fixture}(value) values('scheduled job') returning *`)).rows[0];
  assert.equal(serviceRow.actor_type,'SYSTEM_JOB');
  assert.equal(serviceRow.created_by_email,'system@nexo.local');
  const oldCreator=(await q(`update public.${fixture} set value='modified by system' where id=$1 returning *`,[humanRecordId])).rows[0];
  assert.equal(oldCreator.actor_type,'HUMAN');
  assert.equal(oldCreator.updated_actor_type,'SYSTEM_JOB');
  await q('savepoint atomic_write');
  const countBefore=(await q('select count(*)::int n from public.audit_log where entity_type=$1',[fixture])).rows[0].n;
  await q(`insert into public.${fixture}(value) values('rollback test')`);
  await q('rollback to savepoint atomic_write');
  assert.equal((await q('select count(*)::int n from public.audit_log where entity_type=$1',[fixture])).rows[0].n,countBefore);
  await q(`select set_config('request.jwt.claims','{"role":"anon"}',true)`);
  await rejects(`insert into public.${fixture}(value) values('anonymous')`, /actor autenticado/);
  await q(`select set_config('request.jwt.claims','{}',true)`);
  await rejects(`create table public.${fixture}_copy as select 1 as id`, /CREATE TABLE/);
  await q('rollback to savepoint fixtures');
  await q(apply ? 'commit' : 'rollback');
  console.log(JSON.stringify({ passed:true, applied:apply, ...coverage.rows[0], fixturesRolledBack:true }));
} catch (error) {
  await q('rollback').catch(()=>{});
  console.error(error.message);
  process.exitCode=1;
} finally { if (local) await client.close(); else await client.end(); }
