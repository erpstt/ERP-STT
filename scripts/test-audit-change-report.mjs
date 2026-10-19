import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
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

const migration = (await Promise.all([
  '20261019110000_audit_change_report.sql',
  '20261019120000_optimize_audit_change_report.sql',
  '20261019130000_audit_transaction_change_report.sql'
].map(file => readFile(new URL(`../supabase/migrations/${file}`, import.meta.url), 'utf8')))).join('\n');
const suffix = randomUUID().replaceAll('-', '').slice(0, 14).toUpperCase();
const catalogFixture = `audit_catalog_test_${suffix.toLowerCase()}`;
const documentPrefix = `AUDTRX-${suffix}`;

await db.connect();
try {
  await db.query('begin');
  await db.query("set local lock_timeout='5s'; set local statement_timeout='120s'");
  await db.query(migration);

  const protectedTables = Number((await db.query(`select count(*)::int count from pg_policies
    where schemaname='public' and tablename=any(array['audit_log','change_log','event_log','activity_log','deleted_records'])
      and policyname='audit_select' and coalesce(qual,'')like'%audit_has_direct_read%'`)).rows[0].count);
  assert.equal(protectedTables, 5, 'Las tablas de auditoria deben exigir permisos de lectura por rol.');

  const session = (await db.query(`
    select ucs.session_id,ucs.subsidiary_id,u.email,auth_user.id auth_id,u.user_id
    from public.user_company_sessions ucs
    join public.user_role_sessions urs using(session_id,user_id)
    join public.roles role using(role_id)
    join public.users u using(user_id)
    join auth.users auth_user on lower(auth_user.email)=lower(u.email)
    join public.user_subsidiaries access
      on access.user_id=u.user_id and access.subsidiary_id=ucs.subsidiary_id
    where lower(role.role_name)in('administrador','administrator','admin')and u.is_active
    order by ucs.selected_at desc limit 1
  `)).rows[0];
  assert.ok(session, 'Se requiere una sesion administrativa activa para la prueba.');
  await db.query("select set_config('request.jwt.claims',$1,true)", [JSON.stringify({
    sub: session.auth_id,
    email: session.email,
    session_id: session.session_id,
    role: 'authenticated'
  })]);

  // A catalog-style table proves that non-transaction records never reach the report.
  await db.query(`create table public.${catalogFixture}(
    id bigint primary key,name text not null,password_hash text,updated_at timestamptz default now()
  )`);
  await db.query(`insert into public.${catalogFixture}(id,name,password_hash)values(1,'Catalogo','secreto')`);
  await db.query(`update public.${catalogFixture} set name='Catalogo editado',password_hash='otro',updated_at=now() where id=1`);
  await db.query(`delete from public.${catalogFixture} where id=1`);

  const journalTemplate = (await db.query(`select journal_date,currency_id,fiscal_period_id,
      exchange_rate,journal_type,location_id,status,is_opening_balance
    from public.journal where subsidiary_id=$1 order by journal_id limit 1`, [session.subsidiary_id])).rows[0];
  assert.ok(journalTemplate, 'La subsidiaria de prueba requiere al menos un asiento como plantilla.');

  async function createJournal(number, memo) {
    return (await db.query(`insert into public.journal(
        journal_number,journal_date,subsidiary_id,currency_id,fiscal_period_id,exchange_rate,
        memo,journal_type,location_id,total_debit,total_credit,status,is_opening_balance
      )values($1,$2,$3,$4,$5,$6,$7,$8,$9,0,0,$10,$11)returning journal_id`, [
      number,journalTemplate.journal_date,session.subsidiary_id,journalTemplate.currency_id,
      journalTemplate.fiscal_period_id,journalTemplate.exchange_rate,memo,
      journalTemplate.journal_type,journalTemplate.location_id,journalTemplate.status,
      journalTemplate.is_opening_balance
    ])).rows[0].journal_id;
  }

  async function setAuditTrace(trace) {
    await db.query("select set_config('request.headers',$1,true)", [JSON.stringify({
      'x-audit-execution-context-id': trace
    })]);
  }

  const deletedNumber = `${documentPrefix}-BASE-DEL`;
  const modifiedNumber = `${documentPrefix}-BASE-MOD`;
  const deletedJournal = await createJournal(deletedNumber, 'Concepto inicial eliminado');
  const modifiedJournal = await createJournal(modifiedNumber, 'Concepto inicial modificado');
  const lineAccount = (await db.query(`select account_id from public.chart_accounts
    where not coalesce(is_inactive,false) order by account_id limit 1`)).rows[0];
  assert.ok(lineAccount, 'La prueba requiere una cuenta contable activa.');
  const modifiedLine = (await db.query(`insert into public.journal_line(
      journal_id,account_id,debit,credit
    )values($1,$2,1,0)returning journal_line_id`, [
    modifiedJournal,lineAccount.account_id
  ])).rows[0].journal_line_id;
  await db.query('update public.journal set memo=$1 where journal_id=$2', ['Primer cambio eliminado', deletedJournal]);
  await db.query('update public.journal set memo=$1 where journal_id=$2', ['Segundo cambio eliminado', deletedJournal]);
  await db.query('delete from public.journal where journal_id=$1', [deletedJournal]);
  await db.query('update public.journal set memo=$1 where journal_id=$2', ['Primer cambio vigente', modifiedJournal]);
  await db.query('update public.journal set memo=$1 where journal_id=$2', ['Segundo cambio vigente', modifiedJournal]);
  await db.query('update public.journal_line set debit=2 where journal_line_id=$1', [modifiedLine]);

  // Historical identity must describe the row at the event, not its current
  // number/subsidiary. Access to the destination is removed after the move;
  // the older event must remain visible in its original subsidiary.
  const secondSubsidiary = (await db.query(`select subsidiary_id from public.subsidiaries
    where subsidiary_id<>$1 and is_active order by subsidiary_id limit 1`, [session.subsidiary_id])).rows[0];
  assert.ok(secondSubsidiary, 'La prueba historica requiere una segunda subsidiaria.');
  const historicalOldNumber = `${documentPrefix}-HIST-OLD`;
  const historicalNewNumber = `${documentPrefix}-HIST-NEW`;
  await setAuditTrace(`${documentPrefix}-hist-create`);
  const historicalJournal = await createJournal(historicalOldNumber, 'Identidad historica inicial');
  await setAuditTrace(`${documentPrefix}-hist-old`);
  await db.query('update public.journal set memo=$1 where journal_id=$2', [
    'Cambio atribuible a la subsidiaria original',historicalJournal
  ]);
  await setAuditTrace(`${documentPrefix}-hist-move`);
  await db.query('update public.journal set journal_number=$1,subsidiary_id=$2 where journal_id=$3', [
    historicalNewNumber,secondSubsidiary.subsidiary_id,historicalJournal
  ]);
  await db.query('delete from public.user_subsidiaries where user_id=$1 and subsidiary_id=$2', [
    session.user_id,secondSubsidiary.subsidiary_id
  ]);

  // Two unrelated headers may share a request/batch context. Priority may
  // hide a derived accounting row only when transaction_id/journal_id proves
  // that both events belong to the same document.
  const transactionTemplate = (await db.query(`select transaction_type_id,currency_id,
      exchange_rate,fiscal_period_id,status_id
    from public."transaction" where subsidiary_id=$1 order by transaction_id limit 1`,
  [session.subsidiary_id])).rows[0];
  assert.ok(transactionTemplate, 'La prueba de prioridad requiere una transaccion como plantilla.');
  const priorityJournalNumber = `${documentPrefix}-PRIO-JRN`;
  const priorityTransactionNumber = `${documentPrefix}-PRIO-TRN`;
  await setAuditTrace(`${documentPrefix}-priority-create-journal`);
  const priorityJournal = await createJournal(priorityJournalNumber, 'Documento independiente');
  await setAuditTrace(`${documentPrefix}-priority-create-transaction`);
  const priorityTransaction = (await db.query(`insert into public."transaction"(
      tran_number,tran_date,transaction_type_id,subsidiary_id,currency_id,exchange_rate,
      fiscal_period_id,total_amount,status_id
    )values($1,$2,$3,$4,$5,$6,$7,0,$8)returning transaction_id`, [
    priorityTransactionNumber,journalTemplate.journal_date,transactionTemplate.transaction_type_id,
    session.subsidiary_id,transactionTemplate.currency_id,transactionTemplate.exchange_rate,
    transactionTemplate.fiscal_period_id,transactionTemplate.status_id
  ])).rows[0].transaction_id;
  await setAuditTrace(`${documentPrefix}-shared-batch`);
  await db.query('update public.journal set memo=$1 where journal_id=$2', [
    'Cambio de asiento independiente',priorityJournal
  ]);
  await db.query('update public."transaction" set total_amount=1 where transaction_id=$1', [priorityTransaction]);

  // An audit record without a live row, a delete snapshot or a provable
  // lifecycle has no trustworthy subsidiary and must never be exposed.
  const orphanId = 9223372036854770000n;
  await setAuditTrace(`${documentPrefix}-orphan`);
  const orphanAudit = (await db.query(`insert into public.audit_log(
      user_id,action,module,entity_type,entity_id,entity_key,description,result
    )values($1,'MODIFICACION','public','journal',$2,$3,'Prueba sin origen verificable','EXITOSA')
    returning log_id`, [session.user_id,orphanId.toString(),`journal_id=${orphanId}`])).rows[0].log_id;
  await db.query(`insert into public.change_log(audit_log_id,field_name,old_value,new_value,change_type)
    values($1,'memo','anterior','nuevo','MODIFICACION')`, [orphanAudit]);

  const month = (await db.query(
    "select to_char(current_timestamp at time zone 'America/Costa_Rica','YYYY-MM') value"
  )).rows[0].value;
  const options = (await db.query('select public.audit_change_report_options() value')).rows[0].value;
  assert.equal(options.timeZone, 'America/Costa_Rica');
  assert.equal(options.scope, 'authorized_subsidiaries');
  assert.ok(options.transactionTypes.some(item => item.id === 'journal'));
  assert.ok(options.transactionGroups.some(item => item.id === 'accounting'));
  assert.ok(!options.entityTypes.some(item => item.id === catalogFixture));
  assert.ok(options.subsidiaries.some(item => Number(item.id) === Number(session.subsidiary_id)));

  const allowedSubsidiaries = new Set((await db.query(
    'select subsidiary_id from public.user_subsidiaries where user_id=$1', [session.user_id]
  )).rows.map(row => Number(row.subsidiary_id)));
  assert.ok(options.subsidiaries.every(item => allowedSubsidiaries.has(Number(item.id))));

  const filters = {
    month,
    subsidiaryId: session.subsidiary_id,
    transactionType: 'journal',
    search: `${documentPrefix}-BASE-`,
    page: 1,
    pageSize: 50
  };
  const report = (await db.query(
    'select public.run_audit_change_report($1::jsonb) value', [filters]
  )).rows[0].value;
  assert.equal(report.total, 2, 'Dos documentos distintos deben conservar dos filas.');
  assert.equal(report.summary.rawAuditEventCount, 6, 'Debe contabilizar cinco auditorias de encabezado y el cambio de partida.');
  assert.equal(report.summary.consolidatedEventCount, 4, 'Debe informar cuatro eventos de auditoria consolidados.');
  assert.equal(report.summary.transactionTypeCount, 1);
  assert.equal(report.summary.byTransactionType[0].type, 'journal');
  assert.equal(report.summary.byTransactionType[0].records, 2);

  const modified = report.rows.find(row => row.documentNumber === modifiedNumber);
  const deleted = report.rows.find(row => row.documentNumber === deletedNumber);
  assert.ok(modified && deleted);
  assert.equal(modified.action, 'MODIFICACION');
  assert.equal(deleted.action, 'ELIMINACION');
  assert.equal(modified.consolidatedAuditEvents, 3);
  assert.equal(deleted.consolidatedAuditEvents, 3);
  assert.equal(modified.transactionGroup, 'accounting');
  assert.equal(modified.transactionTypeLabel, 'Asiento de diario');
  assert.equal(Number(modified.subsidiaryId), Number(session.subsidiary_id));
  assert.equal(modified.actor.email.toLowerCase(), session.email.toLowerCase());
  assert.equal(modified.documentCreator.email.toLowerCase(), session.email.toLowerCase());
  assert.equal(modified.changes.find(change => change.field === 'memo')?.occurrences, 2);
  assert.equal(modified.changes.find(change => change.field === 'memo')?.oldValue, 'Concepto inicial modificado');
  assert.equal(modified.changes.find(change => change.field === 'memo')?.newValue, 'Segundo cambio vigente');
  const lineChange = modified.changes.find(change => String(change.field).startsWith('journal_line:'));
  assert.ok(lineChange, 'El cambio de una partida debe quedar dentro del asiento, sin crear otra fila.');
  assert.match(lineChange.fieldLabel, /Partida contable/i);
  assert.equal(lineChange.oldValue, '1.000000');
  assert.equal(lineChange.newValue, '2.000000');
  assert.equal(deleted.deletedSnapshot.journal_number, deletedNumber);
  assert.ok(!Object.keys(deleted.deletedSnapshot).some(field =>
    /password|smtp|updated_at|actor|execution_context|created_by/i.test(field)));

  const historical = (await db.query(
    'select public.run_audit_change_report($1::jsonb) value', [{
      month,subsidiaryId: session.subsidiary_id,transactionType: 'journal',
      search: historicalOldNumber,page: 1,pageSize: 20
    }]
  )).rows[0].value;
  assert.equal(historical.total, 1, 'El evento antiguo debe conservar su subsidiaria original.');
  assert.equal(historical.rows[0].documentNumber, historicalOldNumber);
  assert.equal(Number(historical.rows[0].subsidiaryId), Number(session.subsidiary_id));

  const independentBatch = (await db.query(
    'select public.run_audit_change_report($1::jsonb) value', [{
      month,subsidiaryId: session.subsidiary_id,search: `${documentPrefix}-PRIO-`,page: 1,pageSize: 20
    }]
  )).rows[0].value;
  assert.equal(independentBatch.total, 2,
    'La prioridad no debe ocultar documentos independientes del mismo execution_context.');
  assert.deepEqual(new Set(independentBatch.rows.map(row => row.transactionType)),
    new Set(['journal','transaction']));

  const orphan = (await db.query(
    'select public.run_audit_change_report($1::jsonb) value', [{
      month,search: orphanId.toString(),page: 1,pageSize: 20
    }]
  )).rows[0].value;
  assert.equal(orphan.total, 0, 'Una identidad historica no demostrable debe fallar cerrada.');

  const updates = (await db.query(
    'select public.run_audit_change_report($1::jsonb) value', [{ ...filters, action: 'UPDATE' }]
  )).rows[0].value;
  assert.equal(updates.total, 1);
  assert.equal(updates.rows[0].documentNumber, modifiedNumber);
  const deletions = (await db.query(
    'select public.run_audit_change_report($1::jsonb) value', [{ ...filters, action: 'DELETE' }]
  )).rows[0].value;
  assert.equal(deletions.total, 1);
  assert.equal(deletions.rows[0].documentNumber, deletedNumber);

  // Fail closed: removing the assigned subsidiary immediately removes its documents.
  await db.query('delete from public.user_subsidiaries where user_id=$1 and subsidiary_id=$2', [
    session.user_id,session.subsidiary_id
  ]);
  const outsideScopeFilters = { ...filters };
  delete outsideScopeFilters.subsidiaryId;
  const outsideScope = (await db.query(
    'select public.run_audit_change_report($1::jsonb) value', [outsideScopeFilters]
  )).rows[0].value;
  assert.equal(outsideScope.total, 0);
  await db.query('savepoint forbidden_subsidiary');
  await assert.rejects(
    db.query('select public.run_audit_change_report($1::jsonb)', [filters]),
    /No tiene acceso a la subsidiaria seleccionada/
  );
  await db.query('rollback to savepoint forbidden_subsidiary');

  await db.query('savepoint invalid_month');
  await assert.rejects(
    db.query('select public.run_audit_change_report($1::jsonb)', [{ month: '2026-13' }]),
    /formato AAAA-MM|mes seleccionado no es valido/
  );
  await db.query('rollback to savepoint invalid_month');

  console.log(JSON.stringify({
    passed: true,
    logicalDocuments: report.total,
    rawAuditEvents: report.summary.rawAuditEventCount,
    repeatedHeadersCollapsed: true,
    catalogsExcluded: true,
    transactionGrouping: true,
    historicalIdentity: true,
    unrelatedBatchDocumentsPreserved: true,
    unverifiableHistoryFailsClosed: true,
    documentCreator: true,
    subsidiaryIsolation: true,
    sensitiveValuesHidden: true,
    actionAliases: true,
    protectedAuditTables: protectedTables,
    rollback: true
  }));
} finally {
  await db.query('rollback').catch(() => {});
  await db.end();
}
