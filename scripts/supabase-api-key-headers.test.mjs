import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fetchSupabase, supabaseApiHeaders } from '../dist/core/database/supabase.client.js';

test('las claves modernas autentican tareas del servidor sin sustituir JWT de usuarios', async t => {
  const previous = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const originalFetch = globalThis.fetch;
  t.after(() => {
    if (previous === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    else process.env.SUPABASE_SERVICE_ROLE_KEY = previous;
    globalThis.fetch = originalFetch;
  });
  const key = 'sb_secret_test-fixture';
  process.env.SUPABASE_SERVICE_ROLE_KEY = key;
  let captured;
  globalThis.fetch = async (_input, init) => {
    captured = new Headers(init.headers);
    return new Response('{}');
  };
  await fetchSupabase('https://example.invalid/rest/v1/currencies', {
    headers: { apikey: 'public-key', Authorization: `Bearer ${key}`, Prefer: 'return=minimal' },
  });
  assert.equal(captured.get('apikey'), key);
  assert.equal(captured.has('authorization'), false);
  assert.equal(captured.get('prefer'), 'return=minimal');

  const actor = supabaseApiHeaders({ apikey: key, Authorization: 'Bearer user-jwt' });
  assert.equal(actor.get('authorization'), 'Bearer user-jwt');
  const foreign = supabaseApiHeaders({ apikey: 'public-key', Authorization: 'Bearer sb_secret_untrusted' });
  assert.equal(foreign.get('apikey'), 'public-key');
  assert.equal(foreign.get('authorization'), 'Bearer sb_secret_untrusted');
  const publicOnly = supabaseApiHeaders({ apikey: 'sb_publishable_test-fixture' });
  assert.equal(publicOnly.get('apikey'), 'sb_publishable_test-fixture');
  assert.equal(publicOnly.has('authorization'), false);

  process.env.SUPABASE_SERVICE_ROLE_KEY = 'legacy-service-jwt';
  const legacy = supabaseApiHeaders({ apikey: 'legacy-service-jwt', Authorization: 'Bearer legacy-service-jwt' });
  assert.equal(legacy.get('authorization'), 'Bearer legacy-service-jwt');
});
