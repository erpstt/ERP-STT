import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fetchSupabase } from '../dist/core/database/supabase.client.js';

test('una escritura a Supabase libera una solicitud que deja de responder', { timeout: 3_000 }, async t => {
  const originalFetch = globalThis.fetch;
  const originalTimeout = process.env.SUPABASE_REQUEST_TIMEOUT_MS;
  t.after(() => {
    globalThis.fetch = originalFetch;
    if (originalTimeout === undefined) delete process.env.SUPABASE_REQUEST_TIMEOUT_MS;
    else process.env.SUPABASE_REQUEST_TIMEOUT_MS = originalTimeout;
  });

  process.env.SUPABASE_REQUEST_TIMEOUT_MS = '1000';
  let calls = 0;
  globalThis.fetch = async (_input, init) => {
    calls += 1;
    return new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true }));
  };

  const started = performance.now();
  await assert.rejects(fetchSupabase('https://example.invalid/rest/v1/test', { method: 'POST' }), /No fue posible conectar con Supabase/);
  const elapsed = performance.now() - started;
  assert.equal(calls, 1);
  assert.ok(elapsed >= 900 && elapsed < 2_500, `tiempo transcurrido inesperado: ${elapsed} ms`);
});
