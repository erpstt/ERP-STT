import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test, before, after } from 'node:test';
import { PGlite } from '@electric-sql/pglite';

// In-memory PostgreSQL only: no environment loading, credentials, sockets or remote URL.
const db = new PGlite();
const read = name => readFile(new URL(name, import.meta.url), 'utf8');
const scalar = async sql => (await db.query(sql)).rows[0];
before(async () => {
  await db.exec(await read('./fixtures/consolidation-security.sql'));
  await db.exec(await read('../supabase/migrations/20260915110000_financial_consolidation_engine.sql'));
  const holding = await read('../supabase/migrations/20260930153000_flexible_consolidation_holding.sql');
  await db.exec(holding.slice(holding.indexOf('create or replace function public.consolidation_holding_subsidiary_id()'), holding.indexOf('create or replace function public.validate_consolidated_exchange_rate()')));
  await db.exec(`insert into public.role_permissions select 1,permission_id from public.permissions where code='ACC_CONSOLIDATION_RUN';
    insert into public.role_permissions select 2,permission_id from public.permissions where code='ACC_CONSOLIDATION_PUBLISH';
    insert into public.role_permissions select 5,permission_id from public.permissions on conflict do nothing;`);
  await db.exec('begin');
  await db.exec(await read('../supabase/migrations/20261031011728_secure_financial_consolidation.sql'));
  await db.exec('commit');
});
after(async () => db.close());

async function assume(user = 1, role = 1, subsidiary = 1) {
  await db.exec('reset role');
  await db.query(`insert into user_role_sessions values('fixture',$1,$2) on conflict(session_id) do update set user_id=$1,role_id=$2`, [user,role]);
  await db.query(`insert into user_company_sessions values('fixture',$1,$2) on conflict(session_id) do update set user_id=$1,subsidiary_id=$2`, [user,subsidiary]);
  await db.query(`select set_config('request.jwt.claims',$1,false)`, [JSON.stringify({ sub:`00000000-0000-0000-0000-${String(user).padStart(12,'0')}`, session_id:'fixture', role:'authenticated' })]);
  await db.exec('set role authenticated');
}
async function transaction(t) {
  await db.exec('reset role;begin');
  t.after(async () => db.exec('rollback;reset role'));
}
async function denied(sql, code = '42501') {
  await db.exec('savepoint expected_denial');
  try { await assert.rejects(db.query(sql), error => error.code === code); }
  finally { await db.exec('rollback to savepoint expected_denial;release savepoint expected_denial'); }
}
async function seed(status = 'VALIDADO', period = '2026-09', holding = 1) {
  await db.exec('reset role');
  return (await db.query(`insert into consolidation_runs(holding_subsidiary_id,period,presentation_currency_id,status) values($1,$2,1,$3) returning id`,[holding,period,status])).rows[0].id;
}
const rpcs = ['consolidation_options()',"consolidation_init('2026-10')",'consolidation_translate(999)','consolidation_process(999)','consolidation_worksheet_data(999)','consolidation_publish(999)'];

test('anon no ejecuta RPC ni lee tablas; las funciones internas son inaccesibles', async t => {
  await transaction(t); await db.exec('set role anon');
  for (const rpc of rpcs) await denied(`select public.${rpc}`);
  for (const table of ['consolidation_runs','consolidation_worksheet','consolidation_eliminations']) await denied(`select * from public.${table}`);
  await assume(); await denied('select consolidation_private.consolidation_process(999)');
});

test('service_role no sustituye la identidad y permisos de un operador de consolidacion', async t => {
  await transaction(t);await db.exec('set role service_role');
  for(const rpc of rpcs) await denied(`select public.${rpc}`);
});

test('permiso tecnico usa codigo exacto y rol activo, sin heredar otro rol asignado', async t => {
  await transaction(t); await assume();
  assert.equal((await scalar("select consolidation_has_permission('ACC_CONSOLIDATION_RUN') allowed")).allowed,true);
  for (const code of ['ACC_CONSOLIDATION_PUBLISH','NONEXISTENT']) assert.equal((await scalar(`select consolidation_has_permission('${code}') allowed`)).allowed,false);
  await assume(1,2);
  assert.equal((await scalar("select consolidation_has_permission('ACC_CONSOLIDATION_RUN') allowed")).allowed,false);
  assert.equal((await scalar("select consolidation_has_permission('ACC_CONSOLIDATION_PUBLISH') allowed")).allowed,true);
  await denied("select consolidation_init('2026-10')");
  await assume(2,4);for (const rpc of rpcs) await denied(`select public.${rpc}`);
});

test('holding activa, pertenencia completa y rol asignado son obligatorios incluso para admin', async t => {
  await transaction(t);
  for (const identity of [[1,1,2],[3,1,1],[1,5,1],[2,4,1]]) {
    await assume(...identity); await denied('select consolidation_options()');
  }
  await db.exec('reset role;delete from user_subsidiaries where user_id=4 and subsidiary_id=2');
  await assume(4,5);await denied('select consolidation_options()');
});

test('RLS oculta corridas ajenas y bloquea toda escritura directa de usuarios', async t => {
  await transaction(t);const id=await seed();const other=await seed('VALIDADO','2026-09',4);
  await assume();assert.deepEqual((await db.query('select id from consolidation_runs')).rows,[{id}]);
  await denied(`select consolidation_worksheet_data(${other})`);
  await denied(`select consolidation_worksheet_data(999999)`);
  for (const table of ['consolidation_runs','consolidation_worksheet','consolidation_eliminations']) {
    const column=table==='consolidation_runs'?'holding_subsidiary_id':'run_id';
    await denied(`delete from ${table}`);await denied(`update ${table} set ${column}=${column}`);await denied(`insert into ${table} default values`);
  }
  await assume(3,1);assert.equal((await db.query('select * from consolidation_runs')).rows.length,0);
  await assume(1,3);assert.equal((await db.query('select id from consolidation_runs')).rows.length,1);
  await denied(`select consolidation_process(${id})`);
});

test('flujo legitimo calcula importes, respeta tasas de holding y publica con permiso separado', async t => {
  await transaction(t);
  await db.exec(`delete from consolidated_exchange_rates;
    insert into consolidated_exchange_rates values(4,2,'2026-10',2,1,99,99,99),(1,2,'2026-10',2,1,0.002,0.002,0.002)`);
  await assume();
  const init=(await scalar("select consolidation_init('2026-10') data")).data;assert.equal(init.status,'VALIDADO');
  const id=init.id;
  await denied(`select consolidation_process(${id})`,'55000');
  assert.equal((await scalar(`select consolidation_translate(${id}) data`)).data.status,'CONVERTIDO');
  assert.equal((await scalar(`select consolidation_init('2026-10') data`)).data.status,'CONVERTIDO');
  const processed=(await scalar(`select consolidation_process(${id}) data`)).data;
  assert.equal(processed.assets,0.2);assert.equal(processed.equity,0.2);
  await denied(`select consolidation_translate(${id})`,'55000');
  await denied(`select consolidation_publish(${id})`);
  await assume(1,2);assert.equal((await scalar(`select consolidation_publish(${id}) data`)).data.status,'PUBLICADO');
  assert.equal((await scalar(`select consolidation_worksheet_data(${id}) data`)).data.rows.length,2);
  await assume();
  for (const rpc of [`consolidation_translate(${id})`,`consolidation_process(${id})`,"consolidation_init('2026-10')"]) await denied(`select ${rpc}`,'55000');
});

test('PUBLICADO y ANULADO son inmutables incluso mediante escritura privilegiada', async t => {
  await transaction(t);
  for (const status of ['PUBLICADO','ANULADO']) {
    const id=await seed(status,status==='PUBLICADO'?'2026-08':'2026-07');
    await denied(`update consolidation_runs set status='PROCESADO' where id=${id}`,'55000');
    await denied(`delete from consolidation_runs where id=${id}`,'55000');
    await denied(`insert into consolidation_eliminations(run_id,elimination_type,concept,amount) values(${id},'MANUAL','Fixture',1)`,'55000');
    await assume(); await denied(`select consolidation_process(${id})`,'55000');
  }
});

test('filiales historicas y hoja almacenada requieren pertenencia, sin devolver totales parciales', async t => {
  await transaction(t);const id=await seed();
  await db.exec(`insert into consolidation_worksheet(run_id,subsidiary_id,account_id,original_balance,original_currency_id,rate_type,applied_rate,translated_balance,final_balance)
    values(${id},3,1,1,1,'IDENTIDAD',1,1,1)`);
  await assume();await denied(`select consolidation_worksheet_data(${id})`);
  assert.equal((await db.query('select * from consolidation_worksheet')).rows.length,0);
  await db.exec("reset role;insert into gl_impact values(3,1,'2026-10-01',10,0)");
  await assume();await denied("select consolidation_init('2026-10')");
});

test('los triggers protegen tambien cambios y borrados de hijos, y traslados entre corridas', async t => {
  await transaction(t);const id=await seed();const target=await seed('VALIDADO','2026-06');
  await db.exec(`insert into consolidation_eliminations(run_id,elimination_type,concept,amount) values(${id},'MANUAL','Fixture',1);
    insert into consolidation_worksheet(run_id,subsidiary_id,account_id,original_balance,original_currency_id,rate_type,applied_rate,translated_balance,final_balance)
      values(${id},2,1,1,1,'IDENTIDAD',1,1,1);
    update consolidation_runs set status='PUBLICADO' where id=${id}`);
  for(const table of ['consolidation_eliminations','consolidation_worksheet']) {
    await denied(`update ${table} set run_id=${target} where run_id=${id}`,'55000');
    await denied(`delete from ${table} where run_id=${id}`,'55000');
  }
});

test('los prerrequisitos y periodos invalidos no crean corridas y la revocacion de usuario es inmediata', async t => {
  await transaction(t);await assume();
  for(const period of ['2026-13','',null]) await denied(`select consolidation_init(${period===null?'null':`'${period}'`})`,'22023');
  await db.exec('reset role;update fiscal_periods set is_closed=false');await assume();
  const missing=(await scalar("select consolidation_init('2026-10') data")).data;
  assert.equal(missing.ready,false);assert.equal(missing.openSubsidiaries,1);
  assert.equal((await db.query('select * from consolidation_runs')).rows.length,0);
  await db.exec('reset role;update users set is_active=false where user_id=1');await assume();
  await denied('select consolidation_options()');
});

test('auditoria local de catalogos: solo SELECT con RLS y sin ejecucion anonima o interna',async t=>{
  await transaction(t);
  const rows=(await db.query(`select c.relname,c.relrowsecurity,
    has_table_privilege('authenticated',c.oid,'SELECT') readable,
    has_table_privilege('authenticated',c.oid,'INSERT,UPDATE,DELETE,TRUNCATE') writable
    from pg_class c join pg_namespace n on n.oid=c.relnamespace
    where n.nspname='public' and c.relname in ('consolidation_runs','consolidation_worksheet','consolidation_eliminations')`)).rows;
  assert.equal(rows.length,3);
  for(const row of rows){assert.equal(row.relrowsecurity,true);assert.equal(row.readable,true);assert.equal(row.writable,false);}
  const anon=(await db.query(`select p.proname from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname in ('public','consolidation_private') and p.proname in ('consolidation_options','consolidation_init',
    'consolidation_translate','consolidation_process','consolidation_publish','consolidation_worksheet_data','consolidation_has_permission')
    and has_function_privilege('anon',p.oid,'EXECUTE')`)).rows;
  assert.equal(anon.length,0);
  const policies=(await db.query(`select cmd,qual from pg_policies where schemaname='public'
    and tablename in ('consolidation_runs','consolidation_worksheet','consolidation_eliminations')`)).rows;
  assert.equal(policies.length,3);for(const p of policies){assert.equal(p.cmd,'SELECT');assert.match(p.qual,/can_read_run/);}
});
