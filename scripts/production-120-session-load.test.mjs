import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const source = await readFile(new URL('./production-120-session-load.mjs', import.meta.url), 'utf8');

test('la prueba de producción exige confirmación, HTTPS e identidad técnica', () => {
  assert.match(source, /confirm-production-load/);
  assert.match(source, /parsedBaseUrl\.protocol !== 'https:'/);
  assert.match(source, /@example\.invalid/);
  assert.match(source, /is_active=false and auth_user_id is null/);
});

test('cada usuario virtual recibe sesión y dispositivo independientes', () => {
  assert.match(source, /gentia-load-\$\{runId\}-\$\{index\}/);
  assert.match(source, /POST \/api\/auth\/login/);
  assert.match(source, /POST \/api\/auth\/bootstrap/);
  assert.match(source, /bootstrapVersion\) !== 1/);
});

test('la carga posterior al bootstrap representa navegación operativa de solo lectura', () => {
  const workloadStart = source.indexOf('const workloadEndpoints = [');
  const workloadEnd = source.indexOf('const endpointFor', workloadStart);
  const workload = source.slice(workloadStart, workloadEnd);

  for (const path of [
    '/api/sales/invoices',
    '/api/purchasing/supplier-invoices',
    '/api/entities/customers',
    '/api/organization/departments',
    '/api/organization/cost-centers',
    '/api/banking/bank-accounts',
    '/api/banking/bank-statements',
    '/api/fixed-assets/assets',
    '/api/fixed-assets/asset-categories',
    '/api/reports/accounting/options',
  ]) {
    assert.ok(workload.includes(path), `Falta la ruta operativa ${path}.`);
  }

  for (const legacyPath of [
    '/api/core/languages',
    '/api/auth/companies?view=summary',
    '/api/organization/subsidiaries?view=summary',
    '/api/security/my-role-access',
    '/api/auth/roles',
    '/api/auth/language-preference',
  ]) {
    assert.ok(!workload.includes(legacyPath), `La mezcla no debe repetir ${legacyPath} después del bootstrap.`);
  }

  assert.doesNotMatch(workload, /method:\s*'(POST|PUT|PATCH|DELETE)'/);
});

test('el aprovisionamiento respeta el token bucket y reintenta con espera progresiva', () => {
  assert.match(source, /login-interval-ms/);
  assert.match(source, /rate limit\|too many requests/i);
  assert.match(source, /Math\.min\(30_000, 5_000 \* attempt\)/);
  assert.match(source, /loginIntervalMs - \(Date\.now\(\) - batchStartedAt\)/);
});

test('mide percentiles, criterios y telemetría interna', () => {
  for (const marker of ['p50Ms', 'p95Ms', 'p99Ms', 'successRateAtLeast99', 'p95Below1500Ms', '/api/internal/performance']) {
    assert.ok(source.includes(marker), `Falta ${marker}.`);
  }
});

test('la limpieza está en finally y restaura el usuario técnico', () => {
  const finallyIndex = source.indexOf('} finally {');
  const restoreIndex = source.indexOf('await restoreTechnicalUser()', finallyIndex);
  assert.ok(finallyIndex > 0 && restoreIndex > finallyIndex);
  assert.match(source, /DELETE' \}\);/);
  assert.match(source, /\['user_company_sessions', 'user_role_sessions', 'sessions', 'devices'\]/);
  assert.match(source, /delete from public\.login_history where user_id/);
  assert.match(source, /snapshot\.loginHistory/);
  assert.match(source, /auth_user_id=\$4::uuid/);
  assert.match(source, /cleanupResult\.verified/);
});

test('no imprime credenciales ni tokens en el resumen', () => {
  const summary = source.slice(source.lastIndexOf('console.log(JSON.stringify'));
  assert.doesNotMatch(summary, /accessToken|serviceRoleKey|password,/);
  assert.match(source, /JWT REDACTADO/);
});
