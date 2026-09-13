import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withAuditExecution, auditRequestHeaders } from '../src/core/database/audit-context.ts';

test('concurrent executions keep separate traces across asynchronous work', async () => {
  const traces = await Promise.all(Array.from({length:20}, () => withAuditExecution(async () => {
    const first = auditRequestHeaders().get('x-audit-execution-context-id');
    await new Promise(resolve => setImmediate(resolve));
    const second = auditRequestHeaders().get('x-audit-execution-context-id');
    assert.equal(first, second);
    return first;
  })));
  assert.equal(new Set(traces).size, 20);
});

test('untrusted actor headers are removed without changing authentication', () => {
  const headers = auditRequestHeaders({Authorization:'Bearer test', 'X-Audit-Actor-Type':'AI_AGENT',
    'X-Audit-Email':'forged@example.com', 'X-Audit-Execution-Context-Id':'forged'});
  assert.equal(headers.get('authorization'), 'Bearer test');
  assert.equal(headers.has('x-audit-actor-type'), false);
  assert.equal(headers.has('x-audit-email'), false);
  assert.notEqual(headers.get('x-audit-execution-context-id'), 'forged');
});

test('a failed write is never retried, preventing duplicate committed operations', async () => {
  const { fetchSupabase } = await import('../dist/core/database/supabase.client.js');
  const previous = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls++; throw new Error('connection lost after commit'); };
  try {
    await assert.rejects(fetchSupabase('https://example.invalid/rest/v1/test', { method:'POST', body:'{}' }));
    assert.equal(calls, 1);
  } finally { globalThis.fetch = previous; }
});
