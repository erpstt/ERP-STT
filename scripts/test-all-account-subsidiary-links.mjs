import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import pg from 'pg';

process.loadEnvFile?.('.env');
const projectRef=new URL(process.env.SUPABASE_URL).hostname.split('.')[0];
const db=new pg.Client({
  host:process.env.SUPABASE_DB_HOST||'aws-0-us-east-1.pooler.supabase.com',
  port:Number(process.env.SUPABASE_DB_PORT||6543),
  database:'postgres',
  user:process.env.SUPABASE_DB_USER||`postgres.${projectRef}`,
  password:process.env.SUPABASE_DB_PASSWORD,
  ssl:{rejectUnauthorized:false},
  connectionTimeoutMillis:15000
});
const apply=process.argv.includes('--apply');
const one=async(sql,values=[])=>(await db.query(sql,values)).rows[0];

await db.connect();
try{
  await db.query('begin');
  await db.query("set local lock_timeout='15s';set local statement_timeout='120s'");
  await db.query(await readFile(new URL('../supabase/migrations/20260930123000_link_all_accounts_to_all_subsidiaries.sql',import.meta.url),'utf8'));

  const coverage=await one(`
    select
      (select count(*) from public.chart_accounts)::bigint accounts,
      (select count(*) from public.subsidiaries)::bigint subsidiaries,
      count(*) filter(where sa.account_id is null)::bigint missing,
      count(*) filter(where not sa.is_active)::bigint inactive
    from public.chart_accounts a
    cross join public.subsidiaries s
    left join public.account_subsidiaries sa
      on sa.account_id=a.account_id and sa.subsidiary_id=s.subsidiary_id
  `);
  assert.ok(Number(coverage.accounts)>0,'El plan contable no contiene cuentas.');
  assert.ok(Number(coverage.subsidiaries)>0,'No existen subsidiarias.');
  assert.equal(Number(coverage.missing),0,'Todas las cuentas deben estar vinculadas a todas las subsidiarias.');
  assert.equal(Number(coverage.inactive),0,'Todos los vínculos deben quedar activos.');

  const triggers=await one(`
    select count(*)::int total,bool_and(p.prosecdef) security_definer
    from pg_trigger t join pg_proc p on p.oid=t.tgfoid
    where t.tgname in(
      'link_all_accounts_to_new_subsidiary_trigger',
      'link_new_account_to_all_subsidiaries_trigger'
    ) and not t.tgisinternal
  `);
  assert.equal(Number(triggers.total),2,'Deben instalarse los dos triggers de sincronización.');
  assert.equal(triggers.security_definer,true,'Los triggers deben mantener la matriz sin depender del RLS del usuario.');

  await db.query(apply?'commit':'rollback');
  console.log(JSON.stringify({
    passed:true,
    accounts:Number(coverage.accounts),
    subsidiaries:Number(coverage.subsidiaries),
    expectedLinks:Number(coverage.accounts)*Number(coverage.subsidiaries),
    missingLinks:0,
    inactiveLinks:0,
    futureSynchronization:true,
    installed:apply
  }));
}catch(error){
  await db.query('rollback').catch(()=>{});
  throw error;
}finally{
  await db.end();
}
