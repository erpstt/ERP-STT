import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import pg from 'pg';

process.loadEnvFile?.('.env');

const projectRef=new URL(process.env.SUPABASE_URL).hostname.split('.')[0];
const db=new pg.Client({
  host:process.env.SUPABASE_DB_HOST||'aws-0-us-east-1.pooler.supabase.com',
  port:Number(process.env.SUPABASE_DB_PORT||6543),
  database:process.env.SUPABASE_DB_NAME||'postgres',
  user:process.env.SUPABASE_DB_USER||`postgres.${projectRef}`,
  password:process.env.SUPABASE_DB_PASSWORD||process.env.PGPASSWORD,
  ssl:{rejectUnauthorized:false},
  connectionTimeoutMillis:15000
});

const targetAccounts=['422001','422002','631002','632001','632002'];
const visibleAccounts=['422001','631002'];
const close=(left,right,tolerance=.000001)=>
  Math.abs(Number(left)-Number(right))<=tolerance;

const accountingTotals=async()=>{
  const {rows:[totals]}=await db.query(`select
      count(*)::int line_count,
      coalesce(sum(debit),0) debit,
      coalesce(sum(credit),0) credit,
      coalesce(sum(debit_fx),0) debit_fx,
      coalesce(sum(credit_fx),0) credit_fx
    from public.journal_line`);
  return totals;
};

const sttOctoberBreakdown=async()=>{
  const {rows}=await db.query(`select
      account.account_number,
      count(*)::int line_count,
      coalesce(sum(line.debit-line.credit),0) signed_amount,
      count(*)filter(where line.department_id is null)::int unassigned_count,
      coalesce(sum(line.debit-line.credit)
        filter(where upper(btrim(department.name))='ADMINISTRATIVO'),0)
        administrative_amount
    from public.journal_line line
    join public.journal journal using(journal_id)
    join public.chart_accounts account using(account_id)
    join public.subsidiaries subsidiary using(subsidiary_id)
    left join public.departments department using(department_id)
    where upper(subsidiary.name)=upper('S.T.T. HOLDINGS LIMITED')
      and journal.journal_date between date '2026-10-01' and date '2026-10-31'
      and account.account_number=any($1::text[])
    group by account.account_number
    order by account.account_number`,[visibleAccounts]);
  return new Map(rows.map(row=>[row.account_number,row]));
};

await db.connect();
try{
  await db.query('begin');
  await db.query("set local statement_timeout='120s'");

  const beforeTotals=await accountingTotals();
  const beforeBreakdown=await sttOctoberBreakdown();
  for(const accountNumber of visibleAccounts){
    assert.ok(
      beforeBreakdown.has(accountNumber),
      `No hay movimientos de octubre de S.T.T. HOLDINGS para ${accountNumber}.`
    );
  }

  const migrationUrl=new URL(
    '../supabase/migrations/20261026200000_administrative_financial_department.sql',
    import.meta.url
  );
  const migration=(await readFile(migrationUrl,'utf8'))
    .replace(/^\s*begin\s*;\s*/i,'')
    .replace(/\s*commit\s*;\s*notify\s+pgrst\s*,\s*'reload schema'\s*;\s*$/i,'');
  assert.ok(!/^\s*begin\s*;/i.test(migration),'La migracion conserva un BEGIN interno.');
  assert.ok(!/\bcommit\s*;/i.test(migration),'La migracion conserva un COMMIT interno.');
  assert.ok(!/\bnotify\s+pgrst\b/i.test(migration),'La migracion conserva un NOTIFY interno.');
  await db.query(migration);

  const {rows:[installation]}=await db.query(`select
      to_regprocedure(
        'public.administrative_financial_department_id(bigint)'
      )is not null resolver,
      to_regprocedure(
        'public.assign_administrative_financial_department()'
      )is not null trigger_function,
      exists(
        select 1
        from pg_trigger trigger_row
        where trigger_row.tgrelid='public.journal_line'::regclass
          and trigger_row.tgname='journal_line_administrative_financial_department'
          and not trigger_row.tgisinternal
          and trigger_row.tgenabled<>'D'
      ) trigger_enabled`);
  assert.ok(
    Object.values(installation).every(value=>value===true),
    `Instalacion incompleta: ${JSON.stringify(installation)}`
  );

  const {rows:[catalog]}=await db.query(`select
      count(distinct department.department_id)::int department_count,
      count(distinct assignment.subsidiary_id)::int subsidiary_count
    from public.departments department
    join public.department_subsidiaries assignment using(department_id)
    where upper(btrim(department.name))='ADMINISTRATIVO'
      and not department.is_inactive`);
  assert.equal(catalog.department_count,1,'ADMINISTRATIVO no es unico.');
  assert.ok(catalog.subsidiary_count>0,'ADMINISTRATIVO no tiene subsidiarias asignadas.');

  const {rows:[remaining]}=await db.query(`select count(*)::int count
    from public.journal_line line
    join public.chart_accounts account using(account_id)
    where line.department_id is null
      and account.account_number=any($1::text[])`,[targetAccounts]);
  assert.equal(remaining.count,0,'Quedaron lineas financieras sin departamento.');

  const afterTotals=await accountingTotals();
  for(const key of ['line_count','debit','credit','debit_fx','credit_fx']){
    assert.ok(
      close(afterTotals[key],beforeTotals[key]),
      `Cambio el total ${key}: antes=${beforeTotals[key]}, despues=${afterTotals[key]}.`
    );
  }

  const afterBreakdown=await sttOctoberBreakdown();
  for(const accountNumber of visibleAccounts){
    const before=beforeBreakdown.get(accountNumber);
    const after=afterBreakdown.get(accountNumber);
    assert.ok(after,`Desaparecieron los movimientos de ${accountNumber}.`);
    assert.equal(after.line_count,before.line_count,`Cambio el numero de lineas ${accountNumber}.`);
    assert.ok(
      close(after.signed_amount,before.signed_amount),
      `Cambio el importe de ${accountNumber}.`
    );
    assert.equal(after.unassigned_count,0,`${accountNumber} continua sin departamento.`);
    assert.ok(
      close(after.administrative_amount,after.signed_amount),
      `${accountNumber} no quedo completamente en ADMINISTRATIVO.`
    );
  }

  await db.query("notify pgrst,'reload schema'");
  await db.query('commit');
  console.log(JSON.stringify({
    applied:true,
    department:'ADMINISTRATIVO',
    targetAccounts,
    subsidiaryAssignments:catalog.subsidiary_count,
    accountingTotalsPreserved:true,
    sttOctober:Object.fromEntries(
      [...afterBreakdown].map(([account,row])=>[account,{
        lines:row.line_count,
        amount:Number(row.signed_amount),
        department:'ADMINISTRATIVO'
      }])
    ),
    ...installation
  }));
}catch(error){
  await db.query('rollback').catch(()=>{});
  throw error;
}finally{
  await db.end();
}
