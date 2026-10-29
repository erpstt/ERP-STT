import assert from 'node:assert/strict';
import test from 'node:test';
import {
  normalizeRequestRoute,
  recordReadCacheAccess,
  recordSupabasePerformance,
  resetRuntimePerformanceMetrics,
  runtimePerformanceSnapshot,
  withRequestPerformance,
} from '../dist/core/performance/runtime-metrics.js';
import {
  configuredReadCacheMaxEntries,
  configuredReadCacheTtlMs,
  ScopedReadCache,
} from '../dist/core/performance/scoped-read-cache.js';

test.beforeEach(() => resetRuntimePerformanceMetrics());

test('agrega métricas de ruta, Supabase y caché sin exponer parámetros sensibles', async () => {
  await withRequestPerformance({
    method: 'GET',
    url: '/api/organization/subsidiaries/123?access_token=secreto',
    status: () => 200,
  }, async () => {
    recordSupabasePerformance('https://project.supabase.co/rest/v1/subsidiaries?apikey=secreto', 18, 200, 1);
    recordReadCacheAccess('subsidiaries-summary', false);
    recordReadCacheAccess('subsidiaries-summary', true);
  });

  const snapshot = runtimePerformanceSnapshot();
  assert.equal(normalizeRequestRoute('get', '/api/users/42?email=secret@example.com'), 'GET /api/users/:id');
  assert.equal(snapshot.routes[0].label, 'GET /api/organization/subsidiaries/:id');
  assert.equal(snapshot.routes[0].averageUpstreamCalls, 1);
  assert.equal(snapshot.routes[0].cacheHits, 1);
  assert.equal(snapshot.routes[0].cacheMisses, 1);
  assert.equal(snapshot.upstream[0].label, 'table/subsidiaries');
  assert.equal(snapshot.caches[0].hitRatePercent, 50);
  assert.equal(JSON.stringify(snapshot).includes('secreto'), false);
  assert.ok(snapshot.process.rssBytes > 0);
  assert.ok(snapshot.eventLoop.p99Ms >= 0);
});

test('mide la solicitud hasta que la respuesta termina de enviarse', async () => {
  let finish;
  let resolved = false;
  const pending = withRequestPerformance({
    method: 'GET',
    url: '/api/stream',
    status: () => 200,
    completion: () => new Promise(resolve => { finish = resolve; }),
  }, async () => undefined).then(() => { resolved = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(resolved, false);
  finish();
  await pending;
  assert.equal(resolved, true);
  assert.equal(runtimePerformanceSnapshot().routes[0].count, 1);
});

test('la caché resume el alcance, comparte cargas y permite invalidación por espacio', async () => {
  let now = 1_000;
  let loads = 0;
  const cache = new ScopedReadCache({ defaultTtlMs: 2_000, maxEntries: 100, now: () => now });
  const options = {
    namespace: 'role-permissions',
    scope: ['Bearer token-super-secreto', 4],
    loader: async () => { loads += 1; await Promise.resolve(); return { allowed: true, load: loads }; },
  };

  const [first, concurrent] = await Promise.all([cache.getOrLoad(options), cache.getOrLoad(options)]);
  const cached = await cache.getOrLoad(options);
  assert.deepEqual(first, concurrent);
  assert.deepEqual(cached, first);
  assert.equal(loads, 1);
  assert.equal(cache.diagnosticKeys().some(key => key.includes('token-super-secreto')), false);

  cache.invalidate('role-permissions');
  await cache.getOrLoad(options);
  assert.equal(loads, 2);
  now += 2_001;
  await cache.getOrLoad(options);
  assert.equal(loads, 3);
});

test('no conserva errores, limita memoria y admite desactivar el TTL', async () => {
  const cache = new ScopedReadCache({ defaultTtlMs: 30_000, maxEntries: 100 });
  let failures = 0;
  const failing = {
    namespace: 'languages',
    scope: ['all'],
    loader: async () => { failures += 1; throw new Error('falló'); },
  };
  await assert.rejects(cache.getOrLoad(failing), /falló/);
  await assert.rejects(cache.getOrLoad(failing), /falló/);
  assert.equal(failures, 2);

  for (let index = 0; index < 101; index += 1) {
    await cache.getOrLoad({ namespace: 'bounded', scope: [index], loader: async () => index });
  }
  assert.equal(cache.size, 100);

  let disabledLoads = 0;
  const disabled = new ScopedReadCache({ defaultTtlMs: 0 });
  const disabledOptions = { namespace: 'disabled', scope: ['same'], loader: async () => ++disabledLoads };
  await disabled.getOrLoad(disabledOptions);
  await disabled.getOrLoad(disabledOptions);
  assert.equal(disabledLoads, 2);
  assert.equal(disabled.size, 0);
});

test('acota la configuración de caché a rangos operativos seguros', () => {
  assert.equal(configuredReadCacheTtlMs('0'), 0);
  assert.equal(configuredReadCacheTtlMs('1'), 1_000);
  assert.equal(configuredReadCacheTtlMs('900000'), 300_000);
  assert.equal(configuredReadCacheMaxEntries('2'), 100);
  assert.equal(configuredReadCacheMaxEntries('900000'), 100_000);
});
