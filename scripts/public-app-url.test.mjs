import assert from 'node:assert/strict';
import test from 'node:test';

const {
  PublicAppUrlConfigurationError,
  publicAppUrl,
  tryPublicAppUrl
} = await import('../dist/shared/services/public-app-url.js');

const originalEnvironment = {...process.env};

function clearPublicUrls() {
  delete process.env.GENTIA_APP_URL;
  delete process.env.APP_BASE_URL;
  delete process.env.NEXO_APP_URL;
  delete process.env.RAILWAY_PUBLIC_DOMAIN;
}

test.beforeEach(clearPublicUrls);
test.afterEach(() => { process.env = {...originalEnvironment}; });

test('prioriza GENTIA_APP_URL y puede normalizarla al origen', () => {
  process.env.GENTIA_APP_URL = 'https://erp.gentia.example/base?source=test#section';
  process.env.APP_BASE_URL = 'https://legacy.example';
  process.env.NEXO_APP_URL = 'https://oldest.example';

  assert.equal(publicAppUrl({rootOnly: true}).toString(), 'https://erp.gentia.example/');
});

test('mantiene APP_BASE_URL y NEXO_APP_URL como aliases compatibles', () => {
  process.env.APP_BASE_URL = 'https://app-base.example';
  assert.equal(publicAppUrl().origin, 'https://app-base.example');

  delete process.env.APP_BASE_URL;
  process.env.NEXO_APP_URL = 'https://nexo-legacy.example';
  assert.equal(publicAppUrl().origin, 'https://nexo-legacy.example');
});

test('utiliza el dominio público inyectado por Railway como respaldo HTTPS', () => {
  process.env.RAILWAY_PUBLIC_DOMAIN = 'erp-stt-production.up.railway.app';
  assert.equal(
    publicAppUrl({rootOnly: true}).toString(),
    'https://erp-stt-production.up.railway.app/'
  );
});

test('una URL explícita tiene prioridad sobre el dominio de Railway', () => {
  process.env.GENTIA_APP_URL = 'https://erp.gentia.example';
  process.env.RAILWAY_PUBLIC_DOMAIN = 'railway-fallback.example';
  assert.equal(publicAppUrl().origin, 'https://erp.gentia.example');
});

test('exige HTTPS fuera del desarrollo local', () => {
  process.env.GENTIA_APP_URL = 'http://erp.example.test';
  assert.throws(
    () => publicAppUrl(),
    error => error instanceof PublicAppUrlConfigurationError && error.issue === 'INSECURE'
  );

  process.env.GENTIA_APP_URL = 'http://localhost:3000';
  assert.equal(publicAppUrl({allowLocalHttp: true}).toString(), 'http://localhost:3000/');
  assert.throws(
    () => publicAppUrl({allowLocalHttp: true, disallowLocalhost: true}),
    error => error instanceof PublicAppUrlConfigurationError && error.issue === 'LOCAL_DISALLOWED'
  );
});

test('rechaza credenciales embebidas y ofrece una variante segura sin excepción', () => {
  process.env.GENTIA_APP_URL = 'https://usuario:secreto@erp.example.test';
  assert.throws(
    () => publicAppUrl(),
    error => error instanceof PublicAppUrlConfigurationError && error.issue === 'INVALID'
  );
  assert.equal(tryPublicAppUrl(), null);

  clearPublicUrls();
  assert.equal(tryPublicAppUrl(), null);
});
