import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  configuredRequestAccessCacheMaxEntries,
  configuredRequestAccessCacheTtlMs,
  PositiveRequestAccessCache,
} from '../dist/modules/auth/services/request-access-cache.js';

test('la configuración usa 27 segundos y limita el TTL al rango seguro', () => {
  assert.equal(configuredRequestAccessCacheTtlMs(undefined), 27_000);
  assert.equal(configuredRequestAccessCacheTtlMs('500'), 10_000);
  assert.equal(configuredRequestAccessCacheTtlMs('60000'), 30_000);
  assert.equal(configuredRequestAccessCacheTtlMs('0'), 0);
  assert.equal(configuredRequestAccessCacheMaxEntries(undefined), 5_000);
  assert.equal(configuredRequestAccessCacheMaxEntries('2'), 100);
});

test('comparte una validación concurrente y reutiliza solo su resultado positivo', async () => {
  let now = 1_000;
  let calls = 0;
  const cache = new PositiveRequestAccessCache({ ttlMs: 100, maxEntries: 10, now: () => now });
  const request = () => cache.getOrValidate({
    key: 'session:device',
    validate: async () => { calls += 1; await new Promise(resolve => setTimeout(resolve, 5)); },
  });
  await Promise.all(Array.from({ length: 20 }, request));
  assert.equal(calls, 1);
  await request();
  assert.equal(calls, 1);
  now += 101;
  await request();
  assert.equal(calls, 2);
});

test('distribuye expiraciones por clave entre 80 % y 100 % sin superar el TTL máximo', async () => {
  let now = 10_000;
  const calls = new Map();
  const cache = new PositiveRequestAccessCache({ ttlMs: 1_000, maxEntries: 200, now: () => now });
  const request = key => cache.getOrValidate({
    key,
    validate: async () => { calls.set(key, (calls.get(key) ?? 0) + 1); },
  });
  const keys = Array.from({ length: 100 }, (_, index) => `session-${index}:device-${index}`);
  await Promise.all(keys.map(request));

  now = 10_799;
  await Promise.all(keys.map(request));
  assert.equal([...calls.values()].reduce((total, value) => total + value, 0), 100, 'ninguna entrada debe expirar antes del 80 %');

  now = 10_900;
  await Promise.all(keys.map(request));
  const callsAtNinetyPercent = [...calls.values()].reduce((total, value) => total + value, 0);
  assert.ok(callsAtNinetyPercent > 100, 'algunas claves deben expirar antes del TTL máximo');
  assert.ok(callsAtNinetyPercent < 200, 'las expiraciones no deben ocurrir todas al mismo instante');

  const maximumCache = new PositiveRequestAccessCache({ ttlMs: 1_000, maxEntries: 200, now: () => now });
  let maximumCalls = 0;
  await Promise.all(keys.map(key => maximumCache.getOrValidate({ key, validate: async () => { maximumCalls += 1; } })));
  now = 11_901;
  await Promise.all(keys.map(key => maximumCache.getOrValidate({ key, validate: async () => { maximumCalls += 1; } })));
  assert.equal(maximumCalls, 200, 'ninguna entrada puede conservarse después del TTL máximo');
});

test('la distribución es determinista para la misma clave en procesos equivalentes', async () => {
  let now = 20_000;
  const keys = Array.from({ length: 40 }, (_, index) => `session-${index}:device-${index}`);
  const expiredByCache = [];
  for (let instance = 0; instance < 2; instance += 1) {
    const calls = new Map();
    const cache = new PositiveRequestAccessCache({ ttlMs: 1_000, maxEntries: 100, now: () => now });
    const request = key => cache.getOrValidate({
      key,
      validate: async () => { calls.set(key, (calls.get(key) ?? 0) + 1); },
    });
    now = 20_000;
    await Promise.all(keys.map(request));
    now = 20_900;
    await Promise.all(keys.map(request));
    expiredByCache.push(keys.filter(key => calls.get(key) === 2));
  }
  assert.deepEqual(expiredByCache[0], expiredByCache[1]);
  assert.ok(expiredByCache[0].length > 0 && expiredByCache[0].length < keys.length);
});

test('no conserva errores de validación', async () => {
  let calls = 0;
  const cache = new PositiveRequestAccessCache({ ttlMs: 100, maxEntries: 10 });
  await assert.rejects(cache.getOrValidate({
    key: 'session:device',
    validate: async () => { calls += 1; throw new Error('denied'); },
  }), /denied/);
  await cache.getOrValidate({ key: 'session:device', validate: async () => { calls += 1; } });
  assert.equal(calls, 2);
});

test('nunca conserva una validación después de la expiración del JWT', async () => {
  let now = 2_000;
  let calls = 0;
  const cache = new PositiveRequestAccessCache({ ttlMs: 30_000, maxEntries: 10, now: () => now });
  const request = () => cache.getOrValidate({
    key: 'session:device',
    validUntil: 2_050,
    validate: async () => { calls += 1; },
  });
  await request();
  now = 2_051;
  await request();
  assert.equal(calls, 2);
});

test('puede invalidar todas las entradas de una sesión al cerrar sesión', async () => {
  let calls = 0;
  const cache = new PositiveRequestAccessCache({ ttlMs: 100, maxEntries: 10 });
  const validate = async () => { calls += 1; };
  await cache.getOrValidate({ key: 'session-a:device-1', validate });
  await cache.getOrValidate({ key: 'session-a:device-2', validate });
  await cache.getOrValidate({ key: 'session-b:device-1', validate });
  assert.equal(cache.size, 3);
  cache.invalidateSession('session-a');
  assert.equal(cache.size, 1);
  await cache.getOrValidate({ key: 'session-a:device-1', validate });
  await cache.getOrValidate({ key: 'session-b:device-1', validate });
  assert.equal(calls, 4);
});

test('un cierre de sesión impide que una validación en curso vuelva a llenar la caché', async () => {
  let resolveValidation;
  let calls = 0;
  const cache = new PositiveRequestAccessCache({ ttlMs: 100, maxEntries: 10 });
  const validate = () => {
    calls += 1;
    return new Promise(resolve => { resolveValidation = resolve; });
  };
  const pending = cache.getOrValidate({ key: 'session-a:device-1', validate });
  await Promise.resolve();
  cache.invalidateSession('session-a');
  await cache.getOrValidate({ key: 'session-a:device-1', validate: async () => { calls += 1; } });
  resolveValidation();
  await pending;
  await cache.getOrValidate({ key: 'session-a:device-1', validate: async () => { calls += 1; } });
  assert.equal(calls, 2);
});
