import assert from 'node:assert/strict';

process.env.SUPABASE_URL = 'https://example.supabase.co';
process.env.SUPABASE_ANON_KEY = 'test-anon-key';

const calls = [];
globalThis.fetch = async (_url, init) => {
  calls.push(JSON.parse(String(init?.body || '{}')));
  return new Response('{}', {
    status: 200,
    headers: { 'Content-Type': 'application/json' }
  });
};

const { runAccountingReport } = await import(
  '../dist/modules/reports/accounting-reports.service.js'
);

await runAccountingReport('Bearer test', 'income-statement', {
  columnView: 'TOTAL',
  accountId: 261
});
assert.equal(calls.at(-1).p_filters.accountId, null);

await runAccountingReport('Bearer test', 'income-statement', {
  columnView: 'DEPARTMENT',
  accountId: 261
});
assert.equal(calls.at(-1).p_filters.accountId, null);

await runAccountingReport('Bearer test', 'general-ledger', {
  columnView: 'TOTAL',
  accountId: 261
});
assert.equal(calls.at(-1).p_filters.accountId, 261);

console.log(JSON.stringify({
  incomeStatementAccountFilterRemoved: true,
  generalLedgerAccountFilterPreserved: true
}));
