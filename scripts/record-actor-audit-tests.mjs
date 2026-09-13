import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
process.loadEnvFile('.env');
const ref = new URL(process.env.SUPABASE_URL).hostname.split('.')[0];
const client = new pg.Client({host:process.env.SUPABASE_DB_HOST||'aws-0-us-east-1.pooler.supabase.com',
  port:Number(process.env.SUPABASE_DB_PORT||6543),database:'postgres',user:process.env.SUPABASE_DB_USER||`postgres.${ref}`,
  password:process.env.SUPABASE_DB_PASSWORD,ssl:{rejectUnauthorized:false},connectionTimeoutMillis:15000});
const q=(sql,params)=>client.query(sql,params),apply=process.argv.includes('--apply');
const fixture=`record_actor_test_${randomUUID().replaceAll('-','')}`;
try {
  await client.connect(); await q('begin');
  await q(await readFile(new URL('../supabase/migrations/20260913110000_record_actor_audit_view.sql',import.meta.url),'utf8'));
  await q('savepoint fixtures');
  await q(`create table public.${fixture}(id integer primary key,visible boolean)`);
  await q(`insert into public.${fixture}(id,visible) values(1,true),(2,false)`);
  await q(`alter table public.${fixture} enable row level security`);
  await q(`grant select on public.${fixture} to authenticated`);
  await q(`create policy visible_record on public.${fixture} for select to authenticated using(visible)`);
  await q('set local role authenticated');
  const visible=(await q('select public.record_actor_audit($1,$2) data',[fixture,'1'])).rows[0].data;
  assert.equal(visible.created_by_email,'database@nexo.local');
  assert.equal(visible.actor_type,'SYSTEM_JOB');
  assert.equal(visible.updated_by_email,null);
  assert.equal(Object.hasOwn(visible,'visible'),false);
  const hidden=(await q('select public.record_actor_audit($1,$2) data',[fixture,'2'])).rows[0].data;
  assert.equal(hidden,null,'RLS must hide the audit of an inaccessible record');
  assert.equal((await q('select public.record_actor_audit($1,$2) data',[fixture,"1' OR '1'='1"])).rows[0].data,null);
  await q('savepoint bad_identifier');
  await assert.rejects(q('select public.record_actor_audit($1,$2)',[fixture+';drop table users','1']));
  await q('rollback to savepoint bad_identifier');
  await q('reset role');
  await q(`revoke select on public.${fixture} from authenticated`);
  await q('set local role authenticated');
  await q('savepoint no_grant');
  await assert.rejects(q('select public.record_actor_audit($1,$2)',[fixture,'1']),/permission denied/);
  await q('rollback to savepoint no_grant');
  await q('rollback to savepoint fixtures');
  await q(apply?'commit':'rollback');
  console.log(JSON.stringify({passed:true,applied:apply,checks:['visible record','RLS isolation','minimal fields','SQL injection','SELECT permissions'],fixturesRolledBack:true}));
} catch(error){await q('rollback').catch(()=>{});console.error(error.message);process.exitCode=1;}
finally {await client.end();}
