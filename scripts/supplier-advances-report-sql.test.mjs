import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import { performance } from 'node:perf_hooks';
import { PGlite } from '@electric-sql/pglite';
import {
  setupSupplierAdvancesReport, applySupplierAdvancesReport, assumeSecurityUser, assumeSqlRole,
  beginIsolatedCase, deniedSql, seedSupplierAdvanceSource, seedSupplierAdvanceApplication,
  seedSupplierAdvanceManualLines, seedSupplierAdvanceOpening, seedUnattributedSupplierAdvance, seedSupplierAdvanceStoredReversal,
} from './fixtures/setup-supplier-advances-report.mjs';
import { assertIsolatedTestArgs } from './lib/migration-preview.mjs';
assertIsolatedTestArgs();
const db = new PGlite();
const filters = { subsidiaryIds: [1], dateTo: '2026-10-31' };
let oldFunctions, oldTables, oldData;
const q = async (sql, params = []) => (await db.query(sql, params)).rows[0]?.d;
const report = (extra = {}) => q('select public.run_supplier_advances_report($1)d', [{ ...filters, ...extra }]);
const functions = () => q("select jsonb_agg(jsonb_build_array(oid,oid::regprocedure::text,proowner,proacl::text,proconfig,prosecdef,provolatile,md5(prosrc))order by oid)d from pg_proc where pronamespace in('public'::regnamespace,'supplier_payment_private'::regnamespace,'supplier_invoice_private'::regnamespace,'report_template_private'::regnamespace)and proname<>'run_supplier_advances_report'");
const tableSecurity = () => q("select jsonb_agg(jsonb_build_array(c.relname,c.relowner,c.relacl::text,c.relrowsecurity,c.relforcerowsecurity)order by c.relname)d from pg_class c where c.relnamespace='public'::regnamespace and c.relkind in('r','p')");
const dataSnapshot = () => q(`select jsonb_build_object(
  'gl',(select md5(coalesce(jsonb_agg(to_jsonb(r)order by gl_impact_id),'[]')::text)from gl_impact r),
  'jl',(select md5(coalesce(jsonb_agg(to_jsonb(r)order by journal_line_id),'[]')::text)from journal_line r),
  'j',(select md5(coalesce(jsonb_agg(to_jsonb(r)order by journal_id),'[]')::text)from journal r),
  't',(select md5(coalesce(jsonb_agg(to_jsonb(r)order by transaction_id),'[]')::text)from "transaction" r),
  'p',(select md5(coalesce(jsonb_agg(to_jsonb(r)order by payment_id),'[]')::text)from supplier_payment r),
  'a',(select md5(coalesce(jsonb_agg(to_jsonb(r)order by application_id),'[]')::text)from supplier_advance_application r),
  'opening',(select md5(coalesce(jsonb_agg(to_jsonb(r)order by id),'[]')::text)from opening_balance_lines r)
)d`);
async function tx(t) { await beginIsolatedCase(db, t); await assumeSecurityUser(db); }
async function ownerRead(run) { await db.exec('reset role'); const value = await run(); await assumeSecurityUser(db); return value; }
const total = (result, supplierId = 10, currencyId = 2) => result.supplierTotals.find(row => row.supplierId === supplierId && row.currencyId === currencyId);

before(async () => {
  await setupSupplierAdvancesReport(db);
  await db.exec('reset role');
  oldFunctions = await functions(); oldTables = await tableSecurity(); oldData = await dataSnapshot();
  await applySupplierAdvancesReport(db);
});
after(() => db.close());

test('the read-only migration preserves all existing writers, permissions and financial records and exposes only one guarded authenticated RPC', async t => {
  await tx(t);
  await db.exec('reset role');
  assert.deepEqual(await functions(), oldFunctions);
  assert.deepEqual(await tableSecurity(), oldTables);
  assert.deepEqual(await dataSnapshot(), oldData);
  assert.deepEqual((await db.query("select n.nspname,p.proname,p.prosecdef,p.proconfig,has_function_privilege('anon',p.oid,'execute')anon,has_function_privilege('authenticated',p.oid,'execute')auth,has_function_privilege('service_role',p.oid,'execute')service from pg_proc p join pg_namespace n on n.oid=p.pronamespace where p.oid in('public.run_supplier_advances_report(jsonb)'::regprocedure,'supplier_advances_report_private.source_rows(bigint,date,bigint)'::regprocedure)order by n.nspname")).rows.map(row => ({ schema: row.nspname, name: row.proname, definer: row.prosecdef, config: row.proconfig, anon: row.anon, auth: row.auth, service: row.service })), [
    { schema: 'public', name: 'run_supplier_advances_report', definer: true, config: ['search_path=pg_catalog, public, pg_temp'], anon: false, auth: true, service: false },
    { schema: 'supplier_advances_report_private', name: 'source_rows', definer: false, config: ['search_path=pg_catalog, public, pg_temp'], anon: false, auth: false, service: false },
  ]);
});

test('real historical FX applications use GL native/local values at posting cutoff rather than current payment rate or applied_at', async t => {
  await tx(t);
  const source = await seedSupplierAdvanceSource(db);
  await seedSupplierAdvanceApplication(db, source);
  await db.exec("reset role;update supplier_advance_application set applied_at='2099-01-01'");
  await assumeSecurityUser(db);
  const before = await report({ dateTo: '2026-10-30' });
  assert.equal(total(before).balanceOriginal, 100); assert.equal(total(before).balanceLocal, 15000);
  const after = await report();
  assert.equal(after.total, 2); assert.equal(total(after).balanceOriginal, 70); assert.equal(total(after).balanceLocal, 10500);
  assert.equal(total(after).creditOriginal, 30); assert.equal(total(after).creditLocal, 4500);
  const payment = after.rows.find(row => row.creditOriginal === 30);
  assert.equal(payment.supplierId, 10); assert.equal(payment.sourceType, 'PAYMENT_APPLICATION');
  assert.equal(payment.runningBalanceOriginal, 70); assert.equal(payment.runningBalanceLocal, 10500);
  assert.equal(after.summary.controlBalanceLocal, 10500); assert.equal(after.summary.differenceLocal, 0);
});

test('cumulative six-decimal historical application credits retain their stored residual and never recalculate each application independently', async t => {
  await tx(t);
  const source = await seedSupplierAdvanceSource(db, { amount: 3, rate: '0.3333333333' });
  await seedSupplierAdvanceApplication(db, source, { amount: 1, paymentRate: 1, invoiceRate: 1, date: '2026-10-15' });
  await seedSupplierAdvanceApplication(db, source, { amount: 1, paymentRate: 1, invoiceRate: 1, date: '2026-10-16' });
  const result = await report();
  assert.deepEqual(result.rows.filter(row => row.creditOriginal).map(row => row.creditLocal), [0.333333, 0.333334]);
  assert.equal(total(result).balanceOriginal, 1); assert.equal(total(result).balanceLocal, 0.333333);
  assert.equal(result.summary.differenceLocal, 0);
});

test('shared opening journals use exact line keys, native currency and historical local values including inactive suppliers', async t => {
  await tx(t);
  const source = await seedSupplierAdvanceOpening(db, { glTransactionNull: false, glCurrencyNull: true });
  const before = await ownerRead(dataSnapshot);
  const result = await report();
  assert.equal(result.total, 3);
  for (const entry of source.entries) {
    const row = result.rows.find(row => row.rowId === entry.glId);
    assert.equal(row.supplierId, entry.supplierId); assert.equal(row.currencyId, entry.currencyId);
    assert.equal(row.debitOriginal, entry.amount); assert.equal(row.debitLocal, entry.amount * entry.rate);
    assert.equal(row.documentNumber, entry.documentNumber); assert.equal(row.sourceType, 'OPENING');
  }
  assert.equal(result.currencyTotals.length, 2); assert.equal(result.summary.differenceLocal, 0);
  assert.deepEqual(await ownerRead(dataSnapshot), before);
});

test('a defensive NULL GL transaction resolves only through its exact opening run and key, while missing or wrong keys remain unattributed', async t => {
  await tx(t);
  const source = await seedSupplierAdvanceOpening(db, { glTransactionNull: true });
  const result = await report();
  assert.deepEqual(result.rows.map(row => row.supplierId), source.entries.map(row => row.supplierId));
  assert.ok(result.rows.every(row => row.transactionId === null && row.journalId === source.journalId));
  await db.exec('reset role');
  await db.query('update gl_impact set opening_balance_line_id=null where gl_impact_id=$1', [source.entries[0].glId]);
  await assumeSecurityUser(db);
  const unknown = (await report()).rows.find(row => row.rowId === source.entries[0].glId);
  assert.equal(unknown.supplierId, null); assert.equal(unknown.journalId, null);
  assert.match(unknown.qualityReason, /proveedor/);
});

test('identical components with different suppliers stay unattributed without multiplying GL rows or taking an arbitrary journal note', async t => {
  await tx(t);
  await seedSupplierAdvanceManualLines(db, { lines: [{ supplierId: 10, debit: 10, note: 'Synthetic A' }, { supplierId: 20, debit: 10, note: 'Synthetic B' }] });
  const result = await report();
  assert.equal(result.total, 2); assert.equal(new Set(result.rows.map(row => row.rowId)).size, 2);
  assert.ok(result.rows.every(row => row.supplierId === null && row.note === null));
  assert.equal(result.summary.unattributedBalanceLocal, 20); assert.equal(result.summary.unknownSupplierRows, 2);
  assert.equal(result.summary.controlBalanceLocal, 20); assert.equal(result.summary.differenceLocal, 0);
});

test('manual credits may produce a negative supplier balance and are not relabeled as linked payment applications', async t => {
  await tx(t);
  await seedSupplierAdvanceManualLines(db, { lines: [{ supplierId: 10, debit: 10 }, { supplierId: 10, credit: 15 }] });
  const result = await report();
  assert.equal(total(result, 10, 1).balanceOriginal, -5); assert.equal(total(result, 10, 1).balanceLocal, -5);
  assert.ok(result.rows.every(row => row.sourceType === 'JOURNAL'));
  assert.equal(result.summary.differenceLocal, 0);
});

test('a persisted reversal is recognized at its own posting date while the now-annulled original remains in earlier cutoffs', async t => {
  await tx(t);
  const source = await seedSupplierAdvanceSource(db, { amount: 10, rate: 1, currencyId: 1 });
  await seedSupplierAdvanceStoredReversal(db, source);
  const before = await report();
  assert.equal(before.total, 1); assert.equal(total(before, 10, 1).balanceLocal, 10);
  const after = await report({ dateTo: '2026-11-30', onlyNonzero: false });
  assert.equal(after.total, 2); assert.equal(total(after, 10, 1).balanceOriginal, 0);
  assert.equal(total(after, 10, 1).balanceLocal, 0); assert.equal(after.rows[1].sourceType, 'REVERSAL');
  assert.equal(after.summary.controlBalanceLocal, 0); assert.equal(after.summary.differenceLocal, 0);
  assert.equal((await report({ dateTo: '2026-11-30' })).total, 0);
});

test('onlyNonzero filters full identified groups but retains unknown supplier/currency groups even when their balances cancel', async t => {
  await tx(t);
  await seedSupplierAdvanceManualLines(db, { lines: [{ supplierId: 10, debit: 10 }, { supplierId: 10, credit: 10 }] });
  assert.equal((await report()).total, 0); assert.equal((await report({ onlyNonzero: false })).total, 2);
  const raw = await seedUnattributedSupplierAdvance(db, { local: 5, native: 7 });
  const raw2 = await seedUnattributedSupplierAdvance(db, { local: -5, native: -7 });
  const result = await report();
  assert.deepEqual(new Set(result.rows.map(row => row.rowId)), new Set([...raw, ...raw2]));
  assert.equal(result.currencyTotals[0].balanceOriginal, null);
  assert.ok(result.rows.every(row => row.runningBalanceOriginal === null));
  assert.deepEqual(result.rows.map(row => row.debitOriginal), [7, 0]);
  assert.equal(result.summary.differenceLocal, 0);
});

test('supplier and original-currency filters run before paging and explicitly disable comparison with the full local account control', async t => {
  await tx(t);
  await seedSupplierAdvanceSource(db, { supplierId: 10, amount: 10, rate: 1, currencyId: 1 });
  await seedSupplierAdvanceSource(db, { supplierId: 20, amount: 20, rate: 150 });
  const result = await report({ supplierId: 20, currencyId: 2, pageSize: 1 });
  assert.equal(result.total, 1); assert.equal(result.summary.controlBalanceLocal, 3010);
  assert.equal(result.summary.reportedBalanceLocal, 3000); assert.equal(result.summary.differenceLocal, null);
  assert.equal(result.summary.reconciliationAvailable, false); assert.equal(result.summary.reconciliationReason, 'FILTERED_SELECTION');
  assert.equal((await report({ supplierId: 99999 })).total, 0);
});

test('an optional book selects historical rows exactly and null includes all ledger books without deactivating account or vendor history', async t => {
  await tx(t);
  const source = await seedSupplierAdvanceSource(db, { amount: 10, rate: 1, currencyId: 1, supplierId: 30 });
  await db.exec('reset role');
  await db.query(`insert into gl_impact(transaction_id,account_id,subsidiary_id,fiscal_period_id,accounting_book_id,debit_amount,credit_amount,debit_fx,credit_fx,posting_date,original_currency_id)
    select transaction_id,account_id,subsidiary_id,fiscal_period_id,10,debit_amount,credit_amount,debit_fx,credit_fx,posting_date,original_currency_id
    from gl_impact where transaction_id=$1 and account_id=601`, [source.transactionId]);
  await db.exec('update accounting_books set is_active=false where accounting_book_id=10;update chart_accounts set is_inactive=true where account_id=601');
  await assumeSecurityUser(db);
  const all = await report(); const book = await report({ bookId: 10 });
  assert.equal(all.total, 2); assert.equal(all.summary.controlBalanceLocal, 20);
  assert.equal(book.total, 1); assert.equal(book.summary.controlBalanceLocal, 10);
  assert.equal(book.rows[0].bookId, 10); assert.equal(book.rows[0].supplierId, 30);
  assert.equal(book.summary.differenceLocal, 0);
});

test('corrupt foreign transaction links keep the active company GL amount but never expose the other source metadata', async t => {
  await tx(t);
  const source = await seedSupplierAdvanceSource(db, { amount: 10, rate: 1, currencyId: 1 });
  await db.exec('reset role');
  await db.query('update "transaction" set subsidiary_id=2 where transaction_id=$1', [source.transactionId]);
  await assumeSecurityUser(db);
  const result = await report();
  assert.equal(result.total, 1); assert.equal(result.summary.controlBalanceLocal, 10);
  assert.equal(result.rows[0].journalId, null); assert.equal(result.rows[0].journalNumber, null);
  assert.equal(result.rows[0].documentNumber, null); assert.equal(result.rows[0].supplierId, null);
  assert.equal(result.rows[0].supplierName, null); assert.equal(result.rows[0].note, null);
  assert.equal(result.summary.differenceLocal, 0);
});

test('running balances and currency/supplier totals cover the whole group before pagination, including an empty out-of-range page', async t => {
  await tx(t);
  await seedSupplierAdvanceManualLines(db, { lines: Array.from({ length: 55 }, () => ({ supplierId: 10, debit: 1 })) });
  const result = await report({ page: 2, pageSize: 50 });
  assert.equal(result.total, 55); assert.equal(result.rows.length, 5);
  assert.equal(result.rows[0].runningBalanceOriginal, 51); assert.equal(result.rows[4].runningBalanceLocal, 55);
  assert.equal(result.currencyTotals[0].balanceOriginal, 55); assert.equal(result.supplierTotals[0].movementCount, 55);
  const empty = await report({ page: 999, pageSize: 50 });
  assert.equal(empty.rows.length, 0); assert.equal(empty.total, 55); assert.deepEqual(empty.currencyTotals, result.currencyTotals);
});

test('the full-selection fingerprint is stable across pages and changes for notes or offsetting amounts even when totals remain identical', async t => {
  await tx(t);
  const source = await seedSupplierAdvanceManualLines(db, { lines: [{ supplierId: 10, debit: 10, note: 'Synthetic first note' }, { supplierId: 10, debit: 20, note: 'Synthetic second note' }] });
  const first = await report({ page: 1, pageSize: 1 }); const second = await report({ page: 2, pageSize: 1 });
  assert.match(first.dataFingerprint, /^[0-9a-f]{32}$/);
  assert.equal(first.dataFingerprint, second.dataFingerprint);
  assert.equal(first.dataFingerprint, (await report({ page: 999, pageSize: 1 })).dataFingerprint);
  await db.exec('reset role');
  const previous = await q("select current_setting('nexo.defer_journal_gl_sync',true)d");
  await db.query("select set_config('nexo.defer_journal_gl_sync','on',true)");
  try { await db.query("update journal_line set note='Synthetic edited note'where journal_line_id=$1", [source.sourceLines[0].journal_line_id]); }
  finally { await db.query("select set_config('nexo.defer_journal_gl_sync',$1,true)", [previous ?? '']); }
  await assumeSecurityUser(db);
  const noteChanged = await report({ pageSize: 1 });
  assert.notEqual(noteChanged.dataFingerprint, first.dataFingerprint);
  assert.deepEqual(noteChanged.currencyTotals, first.currencyTotals); assert.deepEqual(noteChanged.supplierTotals, first.supplierTotals);
  assert.equal(noteChanged.rows[0].rowId, first.rows[0].rowId, 'A note change is detected without replacing a GL identity');
  await db.exec('reset role');
  await db.query("select set_config('nexo.defer_journal_gl_sync','on',true)");
  try {
    await db.query('update journal_line set debit=case when debit=10 then 11 else 19 end,debit_fx=case when debit=10 then 11 else 19 end where journal_id=$1 and account_id=601', [source.journalId]);
    await db.query('update gl_impact set debit_amount=case when debit_amount=10 then 11 else 19 end,debit_fx=case when debit_amount=10 then 11 else 19 end where transaction_id=$1 and account_id=601', [source.transactionId]);
  } finally { await db.query("select set_config('nexo.defer_journal_gl_sync',$1,true)", [previous ?? '']); }
  await assumeSecurityUser(db);
  const amountsChanged = await report({ pageSize: 1 });
  assert.notEqual(amountsChanged.dataFingerprint, noteChanged.dataFingerprint);
  assert.deepEqual(amountsChanged.currencyTotals, first.currencyTotals); assert.deepEqual(amountsChanged.supplierTotals, first.supplierTotals);
  assert.deepEqual(amountsChanged.summary, first.summary);
});

test('bank-free supplier payments and other advance accounts never leak into the exact account 115004 report', async t => {
  await tx(t);
  await seedSupplierAdvanceSource(db, { amount: 30, accountId: 602 });
  assert.equal((await report()).total, 0);
  await seedSupplierAdvanceSource(db, { amount: 40 });
  assert.equal((await report()).total, 1);
});

test('all current authorization boundaries, active company and book scope are enforced before business filters', async t => {
  await tx(t);
  await seedSupplierAdvanceSource(db);
  for (const role of ['anon', 'service_role']) {
    await assumeSqlRole(db, role);
    await deniedSql(db, 'select public.run_supplier_advances_report($1)', [filters]);
  }
  await assumeSecurityUser(db, 1, 2, 1);
  await deniedSql(db, 'select public.run_supplier_advances_report($1)', [{ invalid: true }]);
  await assumeSecurityUser(db);
  await deniedSql(db, 'select supplier_advances_report_private.source_rows(1,current_date,null)');
  await deniedSql(db, 'select public.run_supplier_advances_report($1)', [{ ...filters, subsidiaryIds: [2] }]);
  await deniedSql(db, 'select public.run_supplier_advances_report($1)', [{ ...filters, bookId: 2 }]);
  await assumeSecurityUser(db, 1, 3, 1);
  assert.equal((await report()).total, 1, 'A report reader does not need supplier-payment write permissions');
});

test('invalid or expanded filters fail closed and repeated read requests preserve every stored financial source', async t => {
  await tx(t);
  await seedSupplierAdvanceSource(db);
  const before = await ownerRead(dataSnapshot);
  for (const extra of [{ subsidiaryIds: [1, 2] }, { dateTo: '2026-02-30' }, { dateTo: '2026-13-01' }, { onlyNonzero: 'false' }, { onlyNonzero: null }, { supplierId: 0 }, { page: 0 }, { pageSize: 251 }, { page: 2147483648 }, { consolidated: true }, { accountId: 101 }]) {
    await deniedSql(db, 'select public.run_supplier_advances_report($1)', [{ ...filters, ...extra }], '22023');
  }
  for (const extra of [{}, { onlyNonzero: false }, { page: 2 }, { currencyId: 1 }]) await report(extra);
  assert.deepEqual(await ownerRead(dataSnapshot), before);
});

test('a bounded orphan-ledger sample returns global totals once without foreign-unit sums or unbounded page payloads', async t => {
  await tx(t);
  await seedUnattributedSupplierAdvance(db, { local: 1, native: 1, currencyId: 2, count: 1000 });
  const start = performance.now(); const result = await report({ pageSize: 10 }); const durationMs = performance.now() - start;
  assert.equal(result.rows.length, 10); assert.equal(result.total, 1000); assert.equal(result.currencyTotals[0].balanceLocal, 1000);
  assert.equal(result.summary.unknownSupplierRows, 1000); assert.equal(result.summary.differenceLocal, 0);
  t.diagnostic('Synthetic one-connection report of 1000 GL rows: ' + durationMs.toFixed(1) + ' ms; not a production concurrency benchmark.');
});
