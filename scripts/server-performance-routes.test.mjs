import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const source = await readFile(new URL('../src/server.ts', import.meta.url), 'utf8');

test('todas las solicitudes quedan envueltas por telemetrÃ­a de rendimiento', () => {
  assert.match(source, /createServer\(\(request, response\) => \{\s*void withRequestPerformance\(/);
  assert.match(source, /status: \(\) => response\.statusCode/);
  assert.match(source, /completion: \(\) => response\.writableFinished \|\| response\.destroyed/);
});

test('bootstrap se ejecuta despuÃ©s de validar sesiÃ³n y dispositivo', () => {
  const guard = source.indexOf('await assertRequestAccess(');
  const route = source.indexOf("request.url==='/api/auth/bootstrap'");
  assert.ok(guard > 0 && route > guard);
  assert.match(source.slice(route, route + 400), /bootstrapSession\(request\.headers\.authorization!,input\)/);
});

test('telemetrÃ­a detallada exige rol administrador y health no expone mÃ©tricas', () => {
  const health = source.slice(source.indexOf("request.url === '/api/health'"), source.indexOf("request.url === '/api/security/turnstile/config'"));
  assert.match(health, /status: 'ok'/);
  assert.doesNotMatch(health, /runtimePerformanceSnapshot/);
  const metrics = source.slice(source.indexOf("request.url==='/api/internal/performance'"), source.indexOf("request.url?.split('?')\[0\]==='/api/auth/companies'"));
  assert.match(metrics, /myRoleAccess\(authorization\)/);
  assert.match(metrics, /if\(!access\.isAdmin\)return error\(response,403/);
  assert.match(metrics, /runtimePerformanceSnapshot\(\)/);
});
