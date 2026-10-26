import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import pg from 'pg';

process.loadEnvFile?.('.env');

const projectRef = new URL(process.env.SUPABASE_URL).hostname.split('.')[0];
const db = new pg.Client({
  host: process.env.SUPABASE_DB_HOST || 'aws-0-us-east-1.pooler.supabase.com',
  port: Number(process.env.SUPABASE_DB_PORT || 6543),
  database: process.env.SUPABASE_DB_NAME || 'postgres',
  user: process.env.SUPABASE_DB_USER || `postgres.${projectRef}`,
  password: process.env.SUPABASE_DB_PASSWORD || process.env.PGPASSWORD,
  ssl: { rejectUnauthorized: false },
  connectionTimeoutMillis: 15000
});

const targetAccountNumbers = ['422001', '422002', '631002', '632001', '632002'];
const close = (left, right, tolerance = 0.005) =>
  Math.abs(Number(left || 0) - Number(right || 0)) <= tolerance;

function migrationBody(source) {
  const withoutBegin = source.replace(/^\uFEFF?\s*begin\s*;\s*/i, '');
  const body = withoutBegin.replace(
    /\s*commit\s*;\s*notify\s+pgrst\s*,\s*'reload schema'\s*;\s*$/i,
    ''
  );
  assert.notEqual(withoutBegin, source, 'La migraci\u00f3n debe iniciar con BEGIN.');
  assert.notEqual(body, withoutBegin, 'La migraci\u00f3n debe finalizar con COMMIT y NOTIFY.');
  return body;
}

async function ledgerTotals() {
  return (await db.query(`select
    count(*)::text line_count,
    coalesce(sum(debit),0)::text debit,
    coalesce(sum(credit),0)::text credit,
    coalesce(sum(debit_fx),0)::text debit_fx,
    coalesce(sum(credit_fx),0)::text credit_fx
  from public.journal_line`)).rows[0];
}

async function targetLinesWithoutDepartment(extraWhere = '', parameters = []) {
  return (await db.query(`select
    count(*)::integer null_lines,
    coalesce(array_agg(line.journal_line_id order by line.journal_line_id),array[]::bigint[]) line_ids
  from public.journal_line line
  join public.chart_accounts account using(account_id)
  join public.journal journal using(journal_id)
  where account.account_number=any($1::text[])
    and line.department_id is null
    ${extraWhere}`,[targetAccountNumbers,...parameters])).rows[0];
}

async function incomeStatement(subsidiaryId) {
  return (await db.query(
    'select public.run_income_statement_matrix($1::jsonb) value',
    [JSON.stringify({
      subsidiaryIds: [subsidiaryId],
      dateFrom: '2026-10-01',
      dateTo: '2026-10-31',
      columnView: 'DEPARTMENT',
      excludeZero: false
    })]
  )).rows[0].value;
}

const reportRow = (report, accountNumber) =>
  (report.rows || []).find(row => row.account_number === accountNumber);

await db.connect();
try {
  await db.query('begin');
  await db.query("set local statement_timeout='120s'");

  const subsidiary = (await db.query(`select subsidiary_id,currency_id,name
    from public.subsidiaries
    where upper(btrim(name))='S.T.T. HOLDINGS LIMITED'`)).rows[0];
  assert.ok(subsidiary, 'No se encontr\u00f3 la subsidiaria S.T.T. HOLDINGS LIMITED.');

  const administrative = (await db.query(`select department.department_id,department.subsidiary_id,
      count(scope.subsidiary_id)::integer subsidiary_count
    from public.departments department
    left join public.department_subsidiaries scope using(department_id)
    where upper(btrim(department.name))='ADMINISTRATIVO'
      and not coalesce(department.is_inactive,false)
    group by department.department_id,department.subsidiary_id`)).rows;
  assert.equal(administrative.length, 1, 'El cat\u00e1logo debe tener un \u00fanico departamento ADMINISTRATIVO activo.');
  assert.equal(Number(administrative[0].department_id), 8, 'Cambi\u00f3 el departamento ADMINISTRATIVO esperado.');
  assert.equal(Number(administrative[0].subsidiary_count), 26, 'ADMINISTRATIVO no est\u00e1 asociado a las 26 subsidiarias.');
  const administrativeId = Number(administrative[0].department_id);

  const session = (await db.query(`select users.user_id,users.email,users.auth_user_id,session.session_id
    from public.user_company_sessions session
    join public.users users using(user_id)
    join public.user_subsidiaries access
      on access.user_id=users.user_id and access.subsidiary_id=$1
    order by session.selected_at desc
    limit 1`,[subsidiary.subsidiary_id])).rows[0];
  assert.ok(session, 'Se requiere un usuario con acceso a STT Holdings para validar el informe.');
  await db.query("select set_config('request.jwt.claims',$1,true)",[
    JSON.stringify({
      sub: session.auth_user_id,
      email: session.email,
      session_id: session.session_id
    })
  ]);

  const totalsBefore = await ledgerTotals();
  const historicalBefore = await targetLinesWithoutDepartment();
  const initialUnassignedLines = Number(historicalBefore.null_lines);
  assert.ok(
    initialUnassignedLines===21 || initialUnassignedLines===0,
    'La fotograf\u00eda inicial debe corresponder al estado previo (21 pendientes) o posterior (0 pendientes) al despliegue.'
  );

  const sttBefore = await targetLinesWithoutDepartment(
    "and journal.subsidiary_id=$2 and journal.journal_date between date '2026-10-01' and date '2026-10-31'",
    [subsidiary.subsidiary_id]
  );
  const initialSttUnassignedLines = Number(sttBefore.null_lines);
  assert.ok(
    (initialUnassignedLines===21 && initialSttUnassignedLines===4)
      || (initialUnassignedLines===0 && initialSttUnassignedLines===0),
    'STT octubre debe corresponder al estado previo (4 pendientes) o posterior (0 pendientes) al despliegue.'
  );

  const sttAmountsBefore = (await db.query(`select account.account_number,
      round(sum(case
        when coalesce(account.category,account_group.category)='Ingreso'
          then(line.credit-line.debit)*journal.exchange_rate
        else(line.debit-line.credit)*journal.exchange_rate
      end),2)::numeric report_amount
    from public.journal_line line
    join public.journal journal using(journal_id)
    join public.chart_accounts account using(account_id)
    join public.account_group account_group on account_group.group_id=account.account_group_id
    where journal.subsidiary_id=$1
      and journal.journal_date between date '2026-10-01' and date '2026-10-31'
      and account.account_number=any($2::text[])
    group by account.account_number`,[subsidiary.subsidiary_id,targetAccountNumbers])).rows;
  const sttAmounts = new Map(sttAmountsBefore.map(row => [row.account_number,Number(row.report_amount)]));
  assert.ok(close(sttAmounts.get('631002'),9454.18),'La comisi\u00f3n bancaria hist\u00f3rica de STT cambi\u00f3.');
  assert.ok(close(sttAmounts.get('422001'),42180.04),'La ganancia cambiaria hist\u00f3rica de STT cambi\u00f3.');

  const explicitBefore = (await db.query(`select line.journal_line_id,line.department_id
    from public.journal_line line
    join public.chart_accounts account using(account_id)
    where account.account_number=any($1::text[])
      and line.department_id is not null
    order by line.journal_line_id`,[targetAccountNumbers])).rows;
  const reportBefore = await incomeStatement(subsidiary.subsidiary_id);

  const migrationSource = await readFile(
    new URL('../supabase/migrations/20261026200000_administrative_financial_department.sql',import.meta.url),
    'utf8'
  );
  await db.query(migrationBody(migrationSource));

  const installation = (await db.query(`select
    to_regprocedure('public.administrative_financial_department_id(bigint)') is not null resolver,
    to_regprocedure('public.assign_administrative_financial_department()') is not null trigger_function,
    exists(
      select 1 from pg_trigger
      where tgrelid='public.journal_line'::regclass
        and tgname='journal_line_administrative_financial_department'
        and not tgisinternal and tgenabled<>'D'
    ) trigger_enabled`)).rows[0];
  assert.deepEqual(installation,{resolver:true,trigger_function:true,trigger_enabled:true});

  const resolvedDepartment = Number((await db.query(
    'select public.administrative_financial_department_id($1) department_id',
    [subsidiary.subsidiary_id]
  )).rows[0].department_id);
  assert.equal(resolvedDepartment,administrativeId,'El resolver no devolvi\u00f3 ADMINISTRATIVO para STT Holdings.');

  const historicalAfter = await targetLinesWithoutDepartment();
  assert.equal(Number(historicalAfter.null_lines),0,'El backfill dej\u00f3 l\u00edneas financieras sin departamento.');
  const repaired = (await db.query(`select count(*)::integer repaired
    from public.journal_line
    where journal_line_id=any($1::bigint[])
      and department_id=$2`,[historicalBefore.line_ids,administrativeId])).rows[0];
  const repairedThisExecution = Number(repaired.repaired);
  assert.equal(
    repairedThisExecution,
    initialUnassignedLines,
    'El backfill no asign\u00f3 todas las l\u00edneas que estaban pendientes al iniciar esta ejecuci\u00f3n.'
  );

  const historicalTargetValidation = (await db.query(`select
      count(*)::integer target_lines,
      count(*)filter(where line.department_id is distinct from
        public.administrative_financial_department_id(journal.subsidiary_id))::integer mismatched_lines
    from public.journal_line line
    join public.journal journal using(journal_id)
    join public.chart_accounts account using(account_id)
    where account.account_number=any($1::text[])`,[targetAccountNumbers])).rows[0];
  assert.equal(
    Number(historicalTargetValidation.mismatched_lines),
    0,
    'Existen l\u00edneas financieras hist\u00f3ricas que no quedaron en ADMINISTRATIVO para su subsidiaria.'
  );

  if(explicitBefore.length){
    const explicitIds = explicitBefore.map(row => row.journal_line_id);
    const explicitAfter = (await db.query(`select journal_line_id,department_id
      from public.journal_line
      where journal_line_id=any($1::bigint[])
      order by journal_line_id`,[explicitIds])).rows;
    assert.deepEqual(explicitAfter,explicitBefore,'El backfill sobrescribi\u00f3 departamentos expl\u00edcitos.');
  }

  assert.deepEqual(await ledgerTotals(),totalsBefore,'Asignar la dimensi\u00f3n alter\u00f3 los importes contables.');
  const sttAfter = await targetLinesWithoutDepartment(
    "and journal.subsidiary_id=$2 and journal.journal_date between date '2026-10-01' and date '2026-10-31'",
    [subsidiary.subsidiary_id]
  );
  assert.equal(Number(sttAfter.null_lines),0,'STT todav\u00eda presenta resultados financieros sin departamento en octubre.');
  assert.equal((await db.query(`select count(*)::integer count
    from public.journal_line line
    join public.journal journal using(journal_id)
    join public.chart_accounts account using(account_id)
    where journal.subsidiary_id=$1
      and journal.journal_date between date '2026-10-01' and date '2026-10-31'
      and account.account_number=any($2::text[])
      and line.department_id=$3`,[
        subsidiary.subsidiary_id,targetAccountNumbers,administrativeId
      ])).rows[0].count,4,'Las cuatro l\u00edneas de STT no quedaron en ADMINISTRATIVO.');

  const reportAfter = await incomeStatement(subsidiary.subsidiary_id);
  assert.ok(close(reportAfter.summary?.periodResult,reportBefore.summary?.periodResult),'El resultado del per\u00edodo cambi\u00f3.');
  for(const accountNumber of ['422001','631002']){
    const beforeRow = reportRow(reportBefore,accountNumber);
    const afterRow = reportRow(reportAfter,accountNumber);
    assert.ok(beforeRow && afterRow,`El informe no devolvi\u00f3 la cuenta ${accountNumber}.`);
    const beforeUnassigned = Number(beforeRow.dimensions?.unassigned || 0);
    const beforeAdministrative = Number(beforeRow.dimensions?.[String(administrativeId)] || 0);
    const afterUnassigned = Number(afterRow.dimensions?.unassigned || 0);
    const afterAdministrative = Number(afterRow.dimensions?.[String(administrativeId)] || 0);
    assert.ok(close(afterUnassigned,0),`La cuenta ${accountNumber} contin\u00faa en Sin asignar.`);
    assert.ok(
      close(afterAdministrative,beforeAdministrative+beforeUnassigned),
      `La cuenta ${accountNumber} no se traslad\u00f3 \u00edntegramente a ADMINISTRATIVO.`
    );
    assert.ok(close(afterRow.amount,beforeRow.amount),`El total de la cuenta ${accountNumber} cambi\u00f3.`);
  }

  const period = (await db.query(`select fiscal_period_id
    from public.fiscal_periods
    where subsidiary_id=$1 and date '2026-10-26' between start_date and end_date
    order by fiscal_period_id desc limit 1`,[subsidiary.subsidiary_id])).rows[0];
  assert.ok(period,'No existe el per\u00edodo de octubre 2026 para la prueba del trigger.');
  const accounts = (await db.query(`select account.account_number,account.account_id
    from public.chart_accounts account
    join public.account_subsidiaries scope using(account_id)
    where scope.subsidiary_id=$1 and scope.is_active
      and account.account_number=any(array['631002','113001']::text[])
      and not account.is_inactive
    order by account.account_number,account.account_id`,[subsidiary.subsidiary_id])).rows;
  const targetAccount = accounts.find(row => row.account_number==='631002');
  const ordinaryAccount = accounts.find(row => row.account_number==='113001');
  assert.ok(targetAccount && ordinaryAccount,'Faltan las cuentas 631002/113001 para probar el trigger.');
  const otherDepartment = (await db.query(`select department.department_id
    from public.departments department
    where department.department_id<>$1
      and not coalesce(department.is_inactive,false)
      and(
        department.subsidiary_id=$2
        or exists(select 1 from public.department_subsidiaries scope
          where scope.department_id=department.department_id and scope.subsidiary_id=$2)
      )
    order by department.department_id limit 1`,[administrativeId,subsidiary.subsidiary_id])).rows[0];
  assert.ok(otherDepartment,'Se requiere otro departamento para comprobar la preservaci\u00f3n expl\u00edcita.');

  const journal = (await db.query(`insert into public.journal(
      journal_number,journal_date,subsidiary_id,currency_id,fiscal_period_id,
      exchange_rate,memo,journal_type,total_debit,total_credit,status,created_by
    )values(
      'TEST-ADMIN-FIN-'||txid_current()::text,date '2026-10-26',$1,$2,$3,
      1,'Prueba reversible de departamento financiero','PRUEBA',0.03,0.03,'BORRADOR',$4
    )returning journal_id`,[
      subsidiary.subsidiary_id,subsidiary.currency_id,period.fiscal_period_id,session.user_id
    ])).rows[0];
  const inserted = (await db.query(`insert into public.journal_line(
      journal_id,account_id,debit,credit,debit_fx,credit_fx,department_id,note
    )values
      ($1,$2,0.01,0,0.01,0,null,'Comisi\u00f3n autom\u00e1tica de prueba'),
      ($1,$2,0.02,0,0.02,0,$3,'Departamento expl\u00edcito de prueba'),
      ($1,$4,0,0.03,0,0.03,null,'Cuenta no objetivo de prueba')
    returning journal_line_id,account_id,department_id,note`,[
      journal.journal_id,targetAccount.account_id,otherDepartment.department_id,ordinaryAccount.account_id
    ])).rows;
  assert.equal(
    Number(inserted.find(row => row.note==='Comisi\u00f3n autom\u00e1tica de prueba').department_id),
    administrativeId,
    'El trigger no asign\u00f3 ADMINISTRATIVO a la nueva comisi\u00f3n sin departamento.'
  );
  assert.equal(
    Number(inserted.find(row => row.note==='Departamento expl\u00edcito de prueba').department_id),
    Number(otherDepartment.department_id),
    'El trigger sobrescribi\u00f3 un departamento expl\u00edcito.'
  );
  assert.equal(
    inserted.find(row => row.note==='Cuenta no objetivo de prueba').department_id,
    null,
    'El trigger asign\u00f3 ADMINISTRATIVO a una cuenta que no es financiera objetivo.'
  );

  const ambiguitySubsidiary = (await db.query(`select scope.subsidiary_id
    from public.department_subsidiaries scope
    where scope.department_id=$1
      and not exists(
        select 1 from public.departments duplicate
        where duplicate.subsidiary_id=scope.subsidiary_id
          and upper(btrim(duplicate.name))='ADMINISTRATIVO'
      )
    order by(scope.subsidiary_id=$2)desc,scope.subsidiary_id
    limit 1`,[administrativeId,subsidiary.subsidiary_id])).rows[0];
  assert.ok(ambiguitySubsidiary,'No existe una subsidiaria apta para probar la ambig\u00fcedad.');
  await db.query('savepoint administrative_ambiguity');
  try{
    await db.query(`insert into public.departments(name,type,subsidiary_id,is_inactive)
      values('ADMINISTRATIVO','Interno',$1,false)`,[ambiguitySubsidiary.subsidiary_id]);
    await assert.rejects(
      db.query('select public.administrative_financial_department_id($1)',[
        ambiguitySubsidiary.subsidiary_id
      ]),
      /ADMINISTRATIVO es ambiguo/
    );
  }finally{
    await db.query('rollback to savepoint administrative_ambiguity');
  }

  console.log(JSON.stringify({
    passed: true,
    migrationAppliedOnlyInsideRollback: true,
    initialState: initialUnassignedLines===21 ? 'PRE_DEPLOYMENT' : 'POST_DEPLOYMENT',
    initialUnassignedLines,
    initialSttUnassignedLines,
    repairedThisExecution,
    historicalTargetLinesVerified: Number(historicalTargetValidation.target_lines),
    sttOctoberLines: 4,
    sttBankFees: sttAmounts.get('631002'),
    sttRealizedFxGain: sttAmounts.get('422001'),
    accountingTotalsPreserved: true,
    incomeStatementTotalPreserved: true,
    unassignedRemovedFromDepartmentReport: true,
    insertTriggerAssignedAdministrative: true,
    explicitDepartmentPreserved: true,
    nonTargetAccountPreserved: true,
    ambiguousCatalogRejected: true,
    rollback: true
  }));
  await db.query('rollback');
}catch(error){
  await db.query('rollback').catch(() => {});
  throw error;
}finally{
  await db.end();
}
