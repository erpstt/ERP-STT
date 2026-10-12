import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import pg from 'pg';

process.loadEnvFile('.env');

const projectRef = new URL(process.env.SUPABASE_URL).hostname.split('.')[0];
const client = new pg.Client({
  host: process.env.SUPABASE_DB_HOST || 'aws-0-us-east-1.pooler.supabase.com',
  port: Number(process.env.SUPABASE_DB_PORT || 6543),
  database: process.env.SUPABASE_DB_NAME || 'postgres',
  user: process.env.SUPABASE_DB_USER || `postgres.${projectRef}`,
  password: process.env.SUPABASE_DB_PASSWORD,
  ssl: { rejectUnauthorized: false },
  connectionTimeoutMillis: 15000
});

const migration = fs.readFileSync(
  'supabase/migrations/20261010110000_optimize_chart_account_subsidiaries.sql',
  'utf8'
);

const auditSubjects=new Map();

async function useActor(email,sessionId) {
  const subject=auditSubjects.get(email);
  assert.ok(subject,`No existe una identidad de auditoría para ${email}.`);
  await client.query(
    "select set_config('request.jwt.claims',$1,true)",
    [JSON.stringify({
      email,
      session_id: sessionId,
      role: 'authenticated',
      sub: subject
    })]
  );
}

async function expectDatabaseError(label,callback,pattern) {
  await client.query('savepoint expected_error');
  let received;
  try {
    await callback();
  } catch (cause) {
    received = cause;
  }
  await client.query('rollback to savepoint expected_error');
  await client.query('release savepoint expected_error');
  assert.ok(received,`${label}: se esperaba un error.`);
  assert.match(String(received.message),pattern,`${label}: mensaje inesperado.`);
}

await client.connect();
try {
  await client.query('begin');
  await client.query("set local lock_timeout='10s'; set local statement_timeout='120s'");
  await client.query(migration);

  const subsidiaries = (await client.query(
    'select subsidiary_id from public.subsidiaries order by subsidiary_id'
  )).rows.map(row=>Number(row.subsidiary_id));
  const accountCount = Number((await client.query(
    'select count(*) count from public.chart_accounts'
  )).rows[0].count);
  assert.ok(subsidiaries.length>=2,'La prueba requiere al menos dos subsidiarias.');
  assert.ok(accountCount>0,'La prueba requiere al menos una cuenta contable.');
  const referencingForeignKeys=Number((await client.query(`
    select count(*) count
      from pg_constraint
     where contype='f'
       and confrelid='public.account_subsidiaries'::regclass
  `)).rows[0].count);
  assert.equal(referencingForeignKeys,0,'No es seguro eliminar asignaciones: otra tabla referencia sus filas.');

  const allLinked = Number((await client.query(`
    select count(*) count
      from public.chart_accounts account
     cross join public.subsidiaries subsidiary
     where exists(
       select 1 from public.account_subsidiaries assignment
        where assignment.account_id=account.account_id
          and assignment.subsidiary_id=subsidiary.subsidiary_id
          and assignment.is_active
     )
  `)).rows[0].count);
  assert.equal(allLinked,accountCount*subsidiaries.length,'El backfill no cubrió toda la matriz.');

  const adminRole = (await client.query(`
    select role_id from public.roles
     where lower(role_name) in('administrador','administrator','admin')
     order by role_id limit 1
  `)).rows[0];
  assert.ok(adminRole,'No existe un rol administrador para probar la autorización.');

  const suffix=`${Date.now()}-${Math.floor(Math.random()*1e6)}`;
  const fullEmail=`coa-full-${suffix}@example.test`;
  const scopedEmail=`coa-scoped-${suffix}@example.test`;
  const basicEmail=`coa-basic-${suffix}@example.test`;
  const fullSession=`coa-full-${suffix}`;
  const scopedSession=`coa-scoped-${suffix}`;
  const basicSession=`coa-basic-${suffix}`;

  for(const email of[fullEmail,scopedEmail,basicEmail]){
    const subject=randomUUID();
    auditSubjects.set(email,subject);
    await client.query(
      'insert into auth.users(id,email,raw_app_meta_data) values($1,$2,$3::jsonb)',
      [subject,email,JSON.stringify({actor_type:'HUMAN',actor_name:'Prueba Plan de Cuentas',actor_source:'Prueba con rollback'})]
    );
  }

  const users = (await client.query(`
    insert into public.users(email,password_hash,first_name,last_name,is_active)
    values
      ($1,'test:rollback','Prueba','Administrador total',true),
      ($2,'test:rollback','Prueba','Administrador limitado',true),
      ($3,'test:rollback','Prueba','Usuario estándar',true)
    returning user_id,email
  `,[fullEmail,scopedEmail,basicEmail])).rows;
  const idFor=email=>Number(users.find(user=>user.email===email).user_id);
  const fullUser=idFor(fullEmail),scopedUser=idFor(scopedEmail),basicUser=idFor(basicEmail);

  const basicRole = Number((await client.query(`
    insert into public.roles(role_name,description,is_system_role)
    values($1,'Rol temporal para prueba con rollback',false)
    returning role_id
  `,[`Consulta plan ${suffix}`])).rows[0].role_id);

  await client.query(`
    insert into public.user_roles(user_id,role_id)
    values($1,$4),($2,$4),($3,$5)
  `,[fullUser,scopedUser,basicUser,adminRole.role_id,basicRole]);
  await client.query(`
    insert into public.user_role_sessions(session_id,user_id,role_id)
    values($1,$2,$3),($4,$5,$3),($6,$7,$8)
  `,[fullSession,fullUser,adminRole.role_id,scopedSession,scopedUser,basicSession,basicUser,basicRole]);
  await client.query(`
    insert into public.user_subsidiaries(user_id,subsidiary_id)
    select $1::bigint,subsidiary_id from public.subsidiaries
    union all select $2::bigint,$4::bigint
    union all select $3::bigint,$4::bigint
  `,[fullUser,scopedUser,basicUser,subsidiaries[0]]);

  await client.query('set local role authenticated');
  await useActor(fullEmail,fullSession);

  const started=performance.now();
  const catalog=(await client.query('select public.chart_accounts_catalog() result')).rows[0].result;
  const catalogMilliseconds=performance.now()-started;
  assert.ok(Array.isArray(catalog),'El RPC debe devolver un arreglo JSON directo.');
  assert.equal(catalog.length,accountCount,'El RPC no devolvió todas las cuentas.');
  assert.ok(catalog.every(account=>account.subsidiary_ids.length===subsidiaries.length),'Faltan subsidiarias en el catálogo inicial.');
  assert.ok(catalogMilliseconds<1000,`El catálogo tardó ${catalogMilliseconds.toFixed(1)} ms.`);

  const source=catalog[0];
  const writePolicySource=catalog.find(account=>Number(account.account_id)!==Number(source.account_id));
  assert.ok(writePolicySource,'La prueba requiere una segunda cuenta para verificar RLS de escritura.');
  const payload={
    account_group_id:source.account_group_id,
    account_name:source.account_name,
    accepts_entries:true,
    payment_request_enabled:Boolean(source.payment_request_enabled),
    is_inactive:Boolean(source.is_inactive)
  };
  const selected=subsidiaries.slice(0,2);
  const updated=(await client.query(
    'select public.save_chart_account_catalog($1,$2::jsonb,$3::bigint[]) result',
    [source.account_id,JSON.stringify(payload),selected]
  )).rows[0].result;
  assert.deepEqual(updated.subsidiary_ids.map(Number),selected,'La edición no sincronizó el subconjunto.');
  for(const field of['nature','financial_statement','category','full_ifrs_only','pending_fx_revaluation','cash_flow_activity']){
    assert.deepEqual(updated[field],source[field],`La edición de subsidiarias alteró ${field}.`);
  }

  const activeAfterUpdate=(await client.query(`
    select subsidiary_id from public.account_subsidiaries
     where account_id=$1 and is_active order by subsidiary_id
  `,[source.account_id])).rows.map(row=>Number(row.subsidiary_id));
  assert.deepEqual(activeAfterUpdate,selected,'Persistieron asignaciones activas no seleccionadas.');
  const assignmentsAfterUpdate=(await client.query(`
    select subsidiary_id,is_active from public.account_subsidiaries
     where account_id=$1 order by subsidiary_id
  `,[source.account_id])).rows;
  assert.equal(assignmentsAfterUpdate.length,selected.length,'Las subsidiarias desmarcadas deben eliminarse físicamente.');
  assert.ok(assignmentsAfterUpdate.every(row=>row.is_active),'No deben persistir asignaciones inactivas.');
  const legacyVisible=Number((await client.query(`
    select count(*) count
      from public.account_subsidiaries
     where account_id=$1 and subsidiary_id<>all($2::bigint[])
  `,[source.account_id,selected])).rows[0].count);
  assert.equal(legacyVisible,0,'Una consulta histórica sin filtro is_active todavía ve subsidiarias desmarcadas.');

  // Reaplicar el archivo no debe reconstruir la matriz completa ni reactivar
  // subsidiarias que el administrador ya desmarcó.
  await client.query('reset role');
  await client.query(migration);
  await client.query('set local role authenticated');
  await useActor(fullEmail,fullSession);
  const assignmentsAfterRerun=(await client.query(`
    select subsidiary_id,is_active from public.account_subsidiaries
     where account_id=$1 order by subsidiary_id
  `,[source.account_id])).rows;
  assert.deepEqual(
    assignmentsAfterRerun.map(row=>Number(row.subsidiary_id)),
    selected,
    'Reejecutar la migración reactivó subsidiarias que ya estaban desmarcadas.'
  );
  assert.ok(assignmentsAfterRerun.every(row=>row.is_active),'La reejecución dejó asignaciones inactivas.');

  const beforeInvalid=Number((await client.query('select count(*) count from public.chart_accounts')).rows[0].count);
  await expectDatabaseError('Alta sin subsidiarias',()=>client.query(
    'select public.save_chart_account_catalog(null,$1::jsonb,$2::bigint[])',
    [JSON.stringify({...payload,account_name:'Cuenta inválida'}),[]]
  ),/Seleccione al menos una subsidiaria/i);
  const afterInvalid=Number((await client.query('select count(*) count from public.chart_accounts')).rows[0].count);
  assert.equal(afterInvalid,beforeInvalid,'El alta fallida dejó una cuenta parcial.');

  const created=(await client.query(
    'select public.save_chart_account_catalog(null,$1::jsonb,$2::bigint[]) result',
    [JSON.stringify({...payload,account_name:`Cuenta prueba rollback ${suffix}`}),selected]
  )).rows[0].result;
  assert.ok(created.account_id,'El alta atómica no devolvió la cuenta.');
  assert.deepEqual(created.subsidiary_ids.map(Number),selected,'El alta atómica no guardó el alcance seleccionado.');

  // El trigger contable debe rechazar tanto altas como cambios hacia una
  // cuenta que no esté asignada a la subsidiaria del asiento.
  await client.query('reset role');
  const postingTarget=(await client.query(`
    select line.journal_line_id,line.account_id,entry.journal_id,
           entry.transaction_id,entry.subsidiary_id,entry.currency_id,
           entry.fiscal_period_id,entry.exchange_rate
      from public.journal_line line
      join public.journal entry using(journal_id)
     where entry.transaction_id is not null
     order by line.journal_line_id
     limit 1
  `)).rows[0];
  assert.ok(postingTarget,'La prueba requiere al menos una línea contable existente.');
  await client.query('set local role authenticated');
  await useActor(fullEmail,fullSession);
  const alternateSubsidiary=subsidiaries.find(id=>id!==Number(postingTarget.subsidiary_id));
  assert.ok(alternateSubsidiary,'La prueba requiere una subsidiaria distinta a la del asiento.');
  await client.query(
    'select public.save_chart_account_subsidiaries($1,$2::bigint[])',
    [created.account_id,[alternateSubsidiary]]
  );
  await client.query('reset role');
  await expectDatabaseError('INSERT contable con cuenta desasignada',()=>client.query(`
    insert into public.journal_line(
      journal_id,account_id,debit,credit,debit_fx,credit_fx,note
    ) values($1,$2,1,0,1,0,'Prueba de alcance con rollback')
  `,[postingTarget.journal_id,created.account_id]),/no está activa y habilitada/i);
  await expectDatabaseError('UPDATE contable con cuenta desasignada',()=>client.query(`
    update public.journal_line
       set account_id=$1
     where journal_line_id=$2
  `,[created.account_id,postingTarget.journal_line_id]),/no está activa y habilitada/i);

  const impactTarget=(await client.query(`
    select impact.gl_impact_id,impact.accounting_book_id
      from public.gl_impact impact
     where impact.transaction_id=$1
       and impact.subsidiary_id=$2
     order by impact.gl_impact_id
     limit 1
  `,[postingTarget.transaction_id,postingTarget.subsidiary_id])).rows[0];
  assert.ok(impactTarget,'La prueba requiere un impacto contable existente.');
  await expectDatabaseError('INSERT directo en GL con cuenta desasignada',()=>client.query(`
    insert into public.gl_impact(
      transaction_id,account_id,subsidiary_id,fiscal_period_id,
      accounting_book_id,debit_amount,credit_amount,debit_fx,credit_fx,posting_date
    ) values($1,$2,$3,$4,$5,1,0,1,0,current_date)
  `,[postingTarget.transaction_id,created.account_id,postingTarget.subsidiary_id,
      postingTarget.fiscal_period_id,impactTarget.accounting_book_id]),/no está activa y habilitada/i);
  await expectDatabaseError('UPDATE directo en GL con cuenta desasignada',()=>client.query(`
    update public.gl_impact
       set account_id=$1
     where gl_impact_id=$2
  `,[created.account_id,impactTarget.gl_impact_id]),/no está activa y habilitada/i);

  // Una reversión enlazada conserva el derecho a usar una cuenta que estaba
  // vigente en el asiento original, aunque se desasigne posteriormente.
  await client.query('set local role authenticated');
  await useActor(fullEmail,fullSession);
  await client.query(
    'select public.save_chart_account_subsidiaries($1,$2::bigint[])',
    [created.account_id,[Number(postingTarget.subsidiary_id),alternateSubsidiary]]
  );
  await client.query('reset role');
  const originalTransaction=Number((await client.query(`
    insert into public."transaction"(
      tran_number,tran_date,transaction_type_id,subsidiary_id,currency_id,
      exchange_rate,fiscal_period_id,total_amount,status_id
    )
    select $1,current_date,transaction_type_id,subsidiary_id,currency_id,
           exchange_rate,fiscal_period_id,1,status_id
      from public."transaction"
     where transaction_id=$2
    returning transaction_id
  `,[`COA-ORIG-${suffix}`,postingTarget.transaction_id])).rows[0].transaction_id);
  const originalJournal=Number((await client.query(`
    insert into public.journal(
      journal_number,journal_date,transaction_id,subsidiary_id,currency_id,
      fiscal_period_id,exchange_rate,memo,journal_type,total_debit,total_credit,status
    ) values($1,current_date,$2,$3,$4,$5,$6,'Prueba original con rollback',
             'Estándar',1,1,'CONTABILIZADO')
    returning journal_id
  `,[`ASI-COA-ORIG-${suffix}`,originalTransaction,postingTarget.subsidiary_id,
      postingTarget.currency_id,postingTarget.fiscal_period_id,postingTarget.exchange_rate])).rows[0].journal_id);
  await client.query(`
    insert into public.journal_line(
      journal_id,account_id,debit,credit,debit_fx,credit_fx,note
    ) values($1,$2,1,0,1,0,'Movimiento original de prueba')
  `,[originalJournal,created.account_id]);
  const originalImpactCount=Number((await client.query(`
    select count(*) count from public.gl_impact
     where transaction_id=$1 and account_id=$2
  `,[originalTransaction,created.account_id])).rows[0].count);
  assert.ok(originalImpactCount>0,'El asiento original no generó su impacto contable.');

  const reversalTransaction=Number((await client.query(`
    insert into public."transaction"(
      tran_number,tran_date,transaction_type_id,subsidiary_id,currency_id,
      exchange_rate,fiscal_period_id,total_amount,status_id
    )
    select $1,current_date,transaction_type_id,subsidiary_id,currency_id,
           exchange_rate,fiscal_period_id,1,status_id
      from public."transaction"
     where transaction_id=$2
    returning transaction_id
  `,[`COA-REV-${suffix}`,originalTransaction])).rows[0].transaction_id);
  const reversalJournal=Number((await client.query(`
    insert into public.journal(
      journal_number,journal_date,transaction_id,subsidiary_id,currency_id,
      fiscal_period_id,exchange_rate,memo,journal_type,total_debit,total_credit,
      status,reversed_from_journal_id
    ) values($1,current_date,$2,$3,$4,$5,$6,'Reversión de prueba con rollback',
             'Reversión',1,1,'CONTABILIZADO',$7)
    returning journal_id
  `,[`ASI-COA-REV-${suffix}`,reversalTransaction,postingTarget.subsidiary_id,
      postingTarget.currency_id,postingTarget.fiscal_period_id,
      postingTarget.exchange_rate,originalJournal])).rows[0].journal_id);

  await client.query('set local role authenticated');
  await useActor(fullEmail,fullSession);
  await client.query(
    'select public.save_chart_account_subsidiaries($1,$2::bigint[])',
    [created.account_id,[alternateSubsidiary]]
  );
  await client.query('reset role');
  await client.query(`
    insert into public.journal_line(
      journal_id,account_id,debit,credit,debit_fx,credit_fx,note
    ) values($1,$2,0,1,0,1,'Reversión histórica permitida')
  `,[reversalJournal,created.account_id]);
  const reversalImpactCount=Number((await client.query(`
    select count(*) count from public.gl_impact
     where transaction_id=$1 and account_id=$2
  `,[reversalTransaction,created.account_id])).rows[0].count);
  assert.ok(reversalImpactCount>0,'La reversión enlazada no generó su impacto contable.');
  await client.query(`
    insert into public.gl_impact(
      transaction_id,account_id,subsidiary_id,fiscal_period_id,
      accounting_book_id,debit_amount,credit_amount,debit_fx,credit_fx,posting_date
    ) values($1,$2,$3,$4,$5,0,1,0,1,current_date)
  `,[reversalTransaction,created.account_id,postingTarget.subsidiary_id,
      postingTarget.fiscal_period_id,impactTarget.accounting_book_id]);

  const unrelatedAccount=Number((await client.query(`
    select account_id from public.chart_accounts
     where account_id<>$1
     order by account_id desc limit 1
  `,[created.account_id])).rows[0].account_id);
  await client.query('set local role authenticated');
  await useActor(fullEmail,fullSession);
  await client.query(
    'select public.save_chart_account_subsidiaries($1,$2::bigint[])',
    [unrelatedAccount,[alternateSubsidiary]]
  );
  await client.query('reset role');
  await expectDatabaseError('Línea de reversión con cuenta ajena al origen',()=>client.query(`
    insert into public.journal_line(
      journal_id,account_id,debit,credit,debit_fx,credit_fx,note
    ) values($1,$2,0,1,0,1,'Cuenta ajena al asiento original')
  `,[reversalJournal,unrelatedAccount]),/no está activa y habilitada/i);
  await expectDatabaseError('Reversión con cuenta ajena al origen',()=>client.query(`
    insert into public.gl_impact(
      transaction_id,account_id,subsidiary_id,fiscal_period_id,
      accounting_book_id,debit_amount,credit_amount,debit_fx,credit_fx,posting_date
    ) values($1,$2,$3,$4,$5,0,1,0,1,current_date)
  `,[reversalTransaction,unrelatedAccount,postingTarget.subsidiary_id,
      postingTarget.fiscal_period_id,impactTarget.accounting_book_id]),/no está activa y habilitada/i);
  await client.query('set local role authenticated');
  await useActor(fullEmail,fullSession);

  await useActor(scopedEmail,scopedSession);
  const scopedIdentity=(await client.query('select public.app_user_id() user_id,public.app_session_id() session_id')).rows[0];
  assert.equal(Number(scopedIdentity.user_id),scopedUser,'No se activó el usuario administrador limitado.');
  assert.equal(scopedIdentity.session_id,scopedSession,'No se activó la sesión del administrador limitado.');
  const scopedCatalog=(await client.query('select public.chart_accounts_catalog() result')).rows[0].result;
  assert.equal(scopedCatalog.length,accountCount+1,'La lectura global de cuentas se restringió indebidamente.');
  const scopedSource=scopedCatalog.find(account=>Number(account.account_id)===Number(source.account_id));
  assert.deepEqual(scopedSource.subsidiary_ids.map(Number),selected,'El selector administrador y el RPC no comparten el mismo alcance global.');
  const scopedSave=(await client.query(
    'select public.save_chart_account_subsidiaries($1,$2::bigint[])',
    [source.account_id,[subsidiaries[1]]]
  )).rows[0].save_chart_account_subsidiaries;
  assert.deepEqual(scopedSave.map(Number),[subsidiaries[1]],'El administrador no pudo gestionar una subsidiaria visible en el selector.');
  const nameBeforeUnauthorized=(await client.query(
    'select account_name from public.chart_accounts where account_id=$1',
    [source.account_id]
  )).rows[0].account_name;
  const nonexistentSubsidiary=Math.max(...subsidiaries)+999999;
  await expectDatabaseError('Guardado atómico con subsidiaria inexistente',()=>client.query(
    'select public.save_chart_account_catalog($1,$2::jsonb,$3::bigint[])',
    [source.account_id,JSON.stringify({...payload,account_name:'Cambio que debe revertirse'}),[nonexistentSubsidiary]]
  ),/no existen/i);
  const nameAfterUnauthorized=(await client.query(
    'select account_name from public.chart_accounts where account_id=$1',
    [source.account_id]
  )).rows[0].account_name;
  assert.equal(nameAfterUnauthorized,nameBeforeUnauthorized,'El rechazo por alcance dejó cambios parciales en la cuenta.');

  await useActor(basicEmail,basicSession);
  const basicCatalog=(await client.query('select public.chart_accounts_catalog() result')).rows[0].result;
  assert.equal(basicCatalog.length,accountCount+1,'El usuario no administrador no pudo leer el catálogo global.');
  assert.ok(basicCatalog.every(account=>account.subsidiary_ids.every(id=>Number(id)===subsidiaries[0])),'El catálogo expuso asignaciones fuera del vector del usuario no administrador.');
  assert.ok(basicCatalog.some(account=>account.subsidiary_ids.map(Number).includes(subsidiaries[0])),'El catálogo ocultó las asignaciones autorizadas del usuario.');
  await expectDatabaseError('Usuario sin rol administrador',()=>client.query(
    'select public.save_chart_account_subsidiaries($1,$2::bigint[])',
    [source.account_id,[subsidiaries[0]]]
  ),/Solo un administrador/i);
  const blockedUpdate=await client.query(`
    update public.account_subsidiaries set is_active=is_active
     where account_id=$1 and subsidiary_id=$2
     returning id
  `,[writePolicySource.account_id,subsidiaries[0]]);
  assert.equal(blockedUpdate.rowCount,0,'RLS permitió escribir a un usuario no administrador.');
  const blockedAccountUpdate=await client.query(`
    update public.chart_accounts set account_name=account_name
     where account_id=$1
     returning account_id
  `,[source.account_id]);
  assert.equal(blockedAccountUpdate.rowCount,0,'RLS permitió modificar una cuenta a un usuario no administrador.');

  await useActor(fullEmail,fullSession);
  const blockedDirectAssignment=await client.query(`
    update public.account_subsidiaries set is_active=is_active
     where account_id=$1 and subsidiary_id=$2
     returning id
  `,[writePolicySource.account_id,subsidiaries[0]]);
  assert.equal(blockedDirectAssignment.rowCount,0,'La matriz permitió una escritura directa fuera del RPC.');

  const assignmentPolicies=(await client.query(`
    select policyname,cmd from pg_policies
     where schemaname='public' and tablename='account_subsidiaries'
     order by policyname
  `)).rows;
  assert.deepEqual(assignmentPolicies,[{policyname:'account_subsidiaries_select',cmd:'SELECT'}],'La matriz solo debe permitir lectura directa; las escrituras pasan por RPC.');
  const accountPolicies=(await client.query(`
    select policyname,cmd from pg_policies
     where schemaname='public' and tablename='chart_accounts'
     order by policyname
  `)).rows;
  assert.deepEqual(accountPolicies.map(row=>row.cmd).sort(),['DELETE','INSERT','SELECT','UPDATE'],'El Plan de Cuentas debe tener una política por operación.');

  console.log(JSON.stringify({
    migration:true,
    fullMatrix:true,
    accounts:accountCount,
    subsidiaries:subsidiaries.length,
    assignments:allLinked,
    associationRowsNotReferenced:true,
    catalogMilliseconds:Number(catalogMilliseconds.toFixed(1)),
    directJsonArray:true,
    atomicCreateUpdate:true,
    migrationRerunPreservesScope:true,
    journalLineScopeTrigger:true,
    glImpactScopeTrigger:true,
    linkedHistoricalReversalAllowed:true,
    unrelatedReversalAccountRejected:true,
    unselectedAssignmentsDeleted:true,
    legacyQueriesRespectScope:true,
    emptyRejected:true,
    nonexistentSubsidiaryRejected:true,
    adminSelectorScopeConsistent:true,
    nonAdminAssignmentScope:true,
    nonAdminWriteRejected:true,
    directAssignmentWritesBlocked:true,
    assignmentRlsPolicies:assignmentPolicies.length,
    accountRlsPolicies:accountPolicies.length,
    rollback:true
  }));
} finally {
  await client.query('rollback').catch(()=>{});
  await client.end();
}
