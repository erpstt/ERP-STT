import assert from 'node:assert/strict';
import test from 'node:test';

process.env.SUPABASE_URL = 'https://audit-test.supabase.co';
process.env.SUPABASE_ANON_KEY = 'test-anon-key';

const { recordActorAudit, RecordActorAuditError } = await import('../dist/modules/audit-catalogs/record-actor-audit.service.js');

test('la consulta de autoría distingue autorización, errores internos y fallos de red sin exponer el token', async () => {
  const originalFetch = globalThis.fetch;
  const originalConsoleError = console.error;
  const diagnostics = [];
  console.error = (...values) => diagnostics.push(values);

  try {
    globalThis.fetch = async (_url, init) => {
      assert.equal(new Headers(init.headers).get('Authorization'), 'Bearer audit-secret-token');
      return new Response(JSON.stringify({ created_by_name: 'Danny Valderrama' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    };
    assert.deepEqual(
      await recordActorAudit('Bearer audit-secret-token', 'users', '4'),
      { created_by_name: 'Danny Valderrama' }
    );

    globalThis.fetch = async () => new Response(JSON.stringify({
      code: '42501',
      message: 'permission denied for table users'
    }), { status: 403, headers: { 'Content-Type': 'application/json' } });
    await assert.rejects(
      recordActorAudit('Bearer audit-secret-token', 'users', '4'),
      error => error instanceof RecordActorAuditError
        && error.status === 403
        && error.message === 'No tiene permiso para consultar la autoría de este registro.'
    );

    globalThis.fetch = async () => new Response(JSON.stringify({
      code: 'XX000',
      message: 'internal SQL diagnostic that must not reach the browser'
    }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    await assert.rejects(
      recordActorAudit('Bearer audit-secret-token', 'users', '4'),
      error => error instanceof RecordActorAuditError
        && error.status === 502
        && error.message === 'No fue posible consultar la autoría por un error del servicio. Intente nuevamente.'
        && !error.message.includes('SQL')
    );

    globalThis.fetch = async () => { throw new Error('connection refused'); };
    await assert.rejects(
      recordActorAudit('Bearer audit-secret-token', 'users', '4'),
      error => error instanceof RecordActorAuditError
        && error.status === 503
        && error.message === 'No fue posible consultar la autoría en este momento. Intente nuevamente.'
    );

    const serializedDiagnostics = JSON.stringify(diagnostics);
    assert.match(serializedDiagnostics, /42501/);
    assert.match(serializedDiagnostics, /XX000/);
    assert.match(serializedDiagnostics, /connection refused/);
    assert.doesNotMatch(serializedDiagnostics, /audit-secret-token/);
  } finally {
    globalThis.fetch = originalFetch;
    console.error = originalConsoleError;
  }
});
