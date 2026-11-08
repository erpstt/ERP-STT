import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { setupSupplierInvoicePerformance, applySupplierInvoicePerformanceMigration } from './fixtures/setup-supplier-invoice-performance.mjs';
import { assertIsolatedTestArgs } from './lib/migration-preview.mjs';

assertIsolatedTestArgs();
const db = new PGlite();
const constraint = 'supplier_invoice_invoice_number_supplier_id_key';
const invoice = {
  invoice_number: 'SYN-DUPLICATE', invoice_type: 'Factura estándar', supplier_id: 10,
  payment_term_id: 1, invoice_date: '2026-10-31', fiscal_period_id: 10,
  currency_id: 1, exchange_rate: 1, location_id: 2, memo: 'Synthetic uniqueness review',
  lines: [{ account_id: 203, quantity: 2, unit_price: 50, tax_code_id: 1, tax_rate: 13, department_id: 21 }],
};
const q = async (sql, params = []) => (await db.query(sql, params)).rows[0]?.d;
const save = (payload = invoice, id = null) => q('select public.save_supplier_invoice($1,$2) d', [payload, id]);

async function assume(user = 1, role = 1, subsidiary = 1) {
  await db.exec('reset role');
  await db.query("insert into user_role_sessions values('fixture',$1,$2) on conflict(session_id) do update set user_id=$1,role_id=$2", [user, role]);
  await db.query("insert into user_company_sessions values('fixture',$1,$2) on conflict(session_id) do update set user_id=$1,subsidiary_id=$2", [user, subsidiary]);
  await db.query("select set_config('request.jwt.claims',$1,false)", [JSON.stringify({ sub: `00000000-0000-0000-0000-${String(user).padStart(12, '0')}`, session_id: 'fixture' })]);
  await db.exec('set role authenticated');
}
async function tx(t) {
  await db.exec('reset role;begin');
  t.after(() => db.exec('rollback;reset role'));
  await assume();
}
async function rejection(payload, id = null, code = '23505') {
  await db.exec('savepoint rejected_save');
  try {
    await assert.rejects(save(payload, id), error => {
      assert.equal(error.code, code);
      if (code === '23505') assert.equal(error.constraint, constraint);
      return true;
    });
  } finally {
    await db.exec('rollback to rejected_save;release rejected_save');
  }
}
async function financialSnapshot() {
  await db.exec('reset role');
  const snapshot = await q(`select jsonb_build_object(
    'invoice',(select coalesce(jsonb_agg(to_jsonb(r) order by invoice_id),'[]') from supplier_invoice r),
    'invoiceLines',(select coalesce(jsonb_agg(to_jsonb(r) order by line_id),'[]') from supplier_invoice_line r),
    'withholding',(select coalesce(jsonb_agg(to_jsonb(r) order by invoice_withholding_id),'[]') from supplier_invoice_withholding r),
    'transactions',(select coalesce(jsonb_agg(to_jsonb(r) order by transaction_id),'[]') from "transaction" r),
    'journal',(select coalesce(jsonb_agg(to_jsonb(r) order by journal_id),'[]') from journal r),
    'journalLines',(select coalesce(jsonb_agg(to_jsonb(r) order by journal_line_id),'[]') from journal_line r),
    'gl',(select coalesce(jsonb_agg(to_jsonb(r) order by gl_impact_id),'[]') from gl_impact r),
    'assetProposals',(select coalesce(jsonb_agg(to_jsonb(r) order by proposal_id),'[]') from activos_fijos_propuestas r),
    'budgetOverrides',(select coalesce(jsonb_agg(to_jsonb(r) order by id),'[]') from budget_overrides r)
  ) d`);
  await assume();
  return snapshot;
}
async function assertBalanced(id) {
  await db.exec('reset role');
  const row = await q('select jsonb_build_array(sum(debit_amount)::text,sum(credit_amount)::text) d from gl_impact where transaction_id=(select transaction_id from supplier_invoice where invoice_id=$1)', [id]);
  assert.equal(Number(row[0]), 113);
  assert.equal(Number(row[1]), 113);
  await assume();
}

before(async () => {
  await setupSupplierInvoicePerformance(db);
  await applySupplierInvoicePerformanceMigration(db);
  // The shared legacy fixture omits this published constraint and deliberately
  // reuses pairs elsewhere. Restore the real schema only for this isolated suite.
  const published = await readFile(new URL('../supabase/migrations/20260807000000_create_purchasing_catalogs.sql', import.meta.url), 'utf8');
  assert.match(published, /unique\(invoice_number,supplier_id\)/i);
  await db.exec(`alter table public.supplier_invoice add constraint ${constraint} unique(invoice_number,supplier_id)`);
});
after(() => db.close());

test('the published database constraint is authoritative across subsidiary and invoice type without changing the shared fixture', async t => {
  await tx(t);
  const definition = await q('select pg_get_constraintdef(oid) d from pg_constraint where conrelid=\'public.supplier_invoice\'::regclass and conname=$1', [constraint]);
  assert.equal(definition, 'UNIQUE (invoice_number, supplier_id)');
});

test('a repeated create and its ordinary trimmed variant fail on the exact constraint without a second invoice, journal or GL impact', async t => {
  await tx(t);
  const first = await save();
  await assertBalanced(first.invoiceId);
  const before = await financialSnapshot();
  await rejection(invoice);
  await rejection({ ...invoice, invoice_number: '  ' + invoice.invoice_number + '  ' });
  assert.deepEqual(await financialSnapshot(), before);
  // PostgreSQL sequences are intentionally not compared: nextval is not rolled back.
});

test('changing the invoice type never makes the same supplier and number a new document', async t => {
  await tx(t);
  await save();
  const before = await financialSnapshot();
  for (const type of ['Factura Expense', 'Factura Tarjeta', 'Factura Caja Chica', 'Factura Activos Fijos']) {
    const payload = { ...invoice, invoice_type: type };
    if (type === 'Factura Activos Fijos') payload.lines = [{ ...invoice.lines[0], account_id: 201, department_id: null, es_activo_fijo: true }];
    await rejection(payload);
  }
  assert.deepEqual(await financialSnapshot(), before);
});

test('editing the same document and renaming to an unused number work while renaming onto another document rolls back every accounting row', async t => {
  await tx(t);
  const first = await save();
  assert.equal((await save({ ...invoice, memo: 'Synthetic own-record edit' }, first.invoiceId)).invoiceId, first.invoiceId);
  const renamed = { ...invoice, invoice_number: 'SYN-UNUSED' };
  assert.equal((await save(renamed, first.invoiceId)).invoiceId, first.invoiceId);
  await save({ ...invoice, invoice_number: 'SYN-OTHER' });
  const before = await financialSnapshot();
  await rejection({ ...renamed, invoice_number: 'SYN-OTHER', memo: 'Must not persist', lines: [{ ...invoice.lines[0], unit_price: 70 }] }, first.invoiceId);
  assert.deepEqual(await financialSnapshot(), before);
  await assertBalanced(first.invoiceId);
});

test('another supplier may reuse a number but an edit cannot move onto that supplier and number', async t => {
  await tx(t);
  await db.exec("reset role;insert into suppliers(supplier_id,company_name,is_inactive) values(20,'Synthetic second supplier',false);insert into entity_subsidiaries(supplier_id,subsidiary_id)values(20,1)");
  await assume();
  const first = await save();
  const second = await save({ ...invoice, supplier_id: 20 });
  assert.notEqual(first.invoiceId, second.invoiceId);
  await assertBalanced(first.invoiceId);
  await assertBalanced(second.invoiceId);
  const before = await financialSnapshot();
  await rejection({ ...invoice, supplier_id: 20 }, first.invoiceId);
  assert.deepEqual(await financialSnapshot(), before);
});

test('the existing global pair also protects a stored opening invoice in another subsidiary without changing its history', async t => {
  await tx(t);
  await db.exec('reset role');
  await db.query('insert into supplier_invoice(invoice_number,supplier_id,subsidiary_id,is_opening_balance,total_amount)values($1,10,2,true,113)', [invoice.invoice_number]);
  await assume();
  const before = await financialSnapshot();
  await rejection(invoice);
  assert.deepEqual(await financialSnapshot(), before);
});

test('case, leading zero and hyphen conventions are preserved rather than introducing new number normalization', async t => {
  await tx(t);
  const ids = [];
  for (const invoice_number of ['INV-1', 'inv-1', 'INV-01', 'INV1']) ids.push((await save({ ...invoice, invoice_number })).invoiceId);
  assert.equal(new Set(ids).size, 4);
  for (const id of ids) await assertBalanced(id);
});

test('reader and foreign subsidiary checks still deny the writer before exposing duplicate details', async t => {
  await tx(t);
  await save();
  const before = await financialSnapshot();
  await assume(1, 3);
  await rejection(invoice, null, '42501');
  await assume(1, 1, 2);
  await rejection(invoice, null, '42501');
  assert.deepEqual(await financialSnapshot(), before);
});

// PGlite serializes this connection. These tests exercise the real UNIQUE index
// and real financial writers; they do not claim a two-connection MVCC race test.
