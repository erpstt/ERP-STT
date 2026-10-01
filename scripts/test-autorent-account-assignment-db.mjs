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
const one=async(sql,values=[])=>(await db.query(sql,values)).rows[0];
const apply=process.argv.includes('--apply');

await db.connect();
try {
  await db.query('begin');
  await db.query("set local lock_timeout='15s';set local statement_timeout='120s'");
  await db.query(await readFile(
    new URL('../supabase/migrations/20260930120000_autorent_account_assignment.sql',import.meta.url),
    'utf8'
  ));

  const trigger=await one(`
    select count(*) total,bool_and(p.prosecdef) security_definer
    from pg_trigger t
    join pg_proc p on p.oid=t.tgfoid
    where t.tgname='ensure_subsidiary_income_autorent_accounts_trigger'
      and not t.tgisinternal
  `);
  assert.equal(Number(trigger?.total),1,'Debe instalarse el trigger de asignación de autorretención.');
  assert.equal(trigger?.security_definer,true,'El trigger debe ejecutar la asignación con seguridad definida.');

  await db.query('savepoint assignment_test');
  const target=await one(`
    select s.subsidiary_id
    from public.subsidiaries s
    join public.countries c using(country_id)
    where not s.applies_income_autorent and s.is_active
      and(
        upper(coalesce(c.country_code_iso2,''))='CO'
        or upper(coalesce(c.country_code_iso3,''))='COL'
        or lower(btrim(c.name))='colombia'
      )
      and not exists(
        select 1 from public.account_subsidiaries sa
        join public.chart_accounts a using(account_id)
        where sa.subsidiary_id=s.subsidiary_id and sa.is_active
          and a.category in('Activo','Pasivo')
          and a.financial_statement='Balance General'
          and a.accepts_entries and not a.is_inactive
      )
    order by s.subsidiary_id limit 1
  `);
  assert.ok(target,'Se requiere una subsidiaria colombiana activa sin cuentas de balance asignadas para la prueba.');

  const accounts=await one(`
    select
      (select account_id from public.chart_accounts
       where category='Activo' and nature='Deudora'
         and financial_statement='Balance General' and level=4
         and accepts_entries and not is_inactive order by account_id limit 1) active_id,
      (select account_id from public.chart_accounts
       where category='Pasivo' and nature='Acreedora'
         and financial_statement='Balance General' and level=4
         and accepts_entries and not is_inactive order by account_id limit 1) passive_id,
      (select account_id from public.chart_accounts
       where category='Activo' and nature<>'Deudora'
         and financial_statement='Balance General' and level=4
         and accepts_entries and not is_inactive order by account_id limit 1) invalid_active_id
  `);
  assert.ok(accounts?.active_id&&accounts?.passive_id&&accounts?.invalid_active_id,'Faltan cuentas para validar la asignación.');

  await db.query('savepoint invalid_account');
  try {
    await db.query(`
      update public.subsidiaries set applies_income_autorent=true,
        autorent_active_account_id=$2,autorent_passive_account_id=$3,
        autorent_percentage=.0110
      where subsidiary_id=$1
    `,[target.subsidiary_id,accounts.invalid_active_id,accounts.passive_id]);
    assert.fail('La cuenta activa de naturaleza incorrecta debió ser rechazada.');
  } catch(error) {
    await db.query('rollback to savepoint invalid_account');
    assert.match(String(error.message),/Activo.*naturaleza deudora/i);
  }
  await db.query('release savepoint invalid_account');

  await db.query(`delete from public.account_subsidiaries where subsidiary_id=$1 and account_id in($2,$3)`,[target.subsidiary_id,accounts.active_id,accounts.passive_id]);

  await db.query(`
    update public.subsidiaries set applies_income_autorent=true,
      autorent_active_account_id=$2,autorent_passive_account_id=$3,
      autorent_percentage=.0110
    where subsidiary_id=$1
  `,[target.subsidiary_id,accounts.active_id,accounts.passive_id]);

  const result=await one(`
    select s.applies_income_autorent,
      count(*) filter(where sa.account_id=$2 and sa.is_active) active_links,
      count(*) filter(where sa.account_id=$3 and sa.is_active) passive_links
    from public.subsidiaries s
    left join public.account_subsidiaries sa using(subsidiary_id)
    where s.subsidiary_id=$1
    group by s.subsidiary_id,s.applies_income_autorent
  `,[target.subsidiary_id,accounts.active_id,accounts.passive_id]);
  assert.equal(result.applies_income_autorent,true);
  assert.equal(Number(result.active_links),1,'Debe vincular la cuenta activa a la subsidiaria.');
  assert.equal(Number(result.passive_links),1,'Debe vincular la cuenta pasiva a la subsidiaria.');

  await db.query('rollback to savepoint assignment_test');
  await db.query('release savepoint assignment_test');
  await db.query(apply?'commit':'rollback');
  console.log(JSON.stringify({passed:true,onlySelectedAccountsAssigned:true,atomicAssignment:true,invalidNatureRejected:true,installed:apply}));
} catch(error) {
  await db.query('rollback').catch(()=>{});
  throw error;
} finally {
  await db.end();
}
