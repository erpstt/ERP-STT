import assert from 'node:assert/strict';
import { test } from 'node:test';

// La configuración se lee al cargar el módulo; cada archivo de node:test se
// ejecuta en un proceso aislado, por lo que esta prueba no altera producción.
process.env.SUPABASE_MAX_CONCURRENCY = '4';
const { fetchSupabase, withSupabaseRequestSignal } = await import('../dist/core/database/supabase.client.js');

const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

async function waitFor(predicate, timeoutMs = 1_000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('La condición de la prueba no se alcanzó a tiempo.');
    await delay(5);
  }
}

test('limita las llamadas simultáneas a Supabase y libera la cola', async t => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });

  let active = 0;
  let maximumActive = 0;
  globalThis.fetch = async () => {
    active += 1;
    maximumActive = Math.max(maximumActive, active);
    await delay(25);
    active -= 1;
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
  };

  const responses = await Promise.all(Array.from({ length: 12 }, (_, index) =>
    fetchSupabase(`https://example.invalid/rest/v1/test?id=eq.${index}`, { method: 'POST' })
  ));

  assert.equal(responses.length, 12);
  assert.equal(maximumActive, 4, 'el máximo configurado debe aplicarse aun bajo una ráfaga');
  assert.equal(active, 0, 'todas las plazas deben liberarse al finalizar');
});

test('cancela de inmediato una llamada activa cuando termina la solicitud HTTP', async t => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });

  let upstreamAborted = false;
  globalThis.fetch = async (_input, init) => new Promise((_resolve, reject) => {
    init.signal.addEventListener('abort', () => {
      upstreamAborted = true;
      reject(init.signal.reason);
    }, { once: true });
  });

  const controller = new AbortController();
  const started = performance.now();
  const pending = withSupabaseRequestSignal(controller.signal, () =>
    fetchSupabase('https://example.invalid/rest/v1/active', { method: 'POST' })
  );
  await delay(10);
  controller.abort(new Error('cliente desconectado'));

  await assert.rejects(pending, /cliente desconectado/);
  assert.equal(upstreamAborted, true, 'el AbortSignal debe llegar al fetch en curso');
  assert.ok(performance.now() - started < 500, 'la cancelación no debe esperar el timeout upstream');
});

test('retira de la cola una llamada cancelada sin enviarla a Supabase', async t => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });

  const releases = [];
  let fetchCalls = 0;
  globalThis.fetch = async () => {
    fetchCalls += 1;
    return new Promise(resolve => releases.push(() => resolve(new Response('{}', { status: 200 }))));
  };

  const blockers = Array.from({ length: 4 }, (_, index) =>
    fetchSupabase(`https://example.invalid/rest/v1/blocker?id=eq.${index}`, { method: 'POST' })
  );
  await waitFor(() => releases.length === 4);

  const controller = new AbortController();
  const queued = withSupabaseRequestSignal(controller.signal, () =>
    fetchSupabase('https://example.invalid/rest/v1/queued', { method: 'POST' })
  );
  await delay(20);
  assert.equal(fetchCalls, 4, 'la quinta llamada debe permanecer en la cola');
  controller.abort(new Error('solicitud en cola cancelada'));
  await assert.rejects(queued, /solicitud en cola cancelada/);
  assert.equal(fetchCalls, 4, 'una llamada cancelada en cola nunca debe llegar a Supabase');

  for (const release of releases) release();
  await Promise.all(blockers);
});
