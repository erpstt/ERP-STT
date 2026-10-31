import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createPdfWorker } from '../services/pdf-renderer/server.mjs';
import { pdfRendererConfig, renderPdf } from '../dist/core/security/pdf-renderer.js';

const token = 'pdf-worker-fixture-token-0123456789abcdef';
const pdf = Buffer.from('%PDF-1.4\n% fixture\n%%EOF');
async function listen(t, worker) {
  await new Promise(resolve => worker.server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { worker.server.closeAllConnections(); worker.server.close(resolve); }));
  return `http://127.0.0.1:${worker.server.address().port}`;
}
function remoteEnvironment(t) {
  const keys = ['PDF_RENDERER_URL', 'PDF_RENDERER_TOKEN'];
  const saved = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  const fetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = fetch; for (const key of keys) if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key]; });
  process.env.PDF_RENDERER_URL = 'http://gentia-pdf.railway.internal:8080';
  process.env.PDF_RENDERER_TOKEN = token;
  return fetch;
}

test('readiness bloquea el servicio cuando Chrome no logra iniciar con sandbox', async t => {
  let calls = 0;
  const worker = createPdfWorker({ token, render: async () => { calls++; throw Error('sandbox denied'); } });
  const base = await listen(t, worker); await worker.ready;
  const health = await fetch(base + '/health'); assert.equal(health.status, 503);
  assert.equal((await health.json()).status, 'blocked');
  const result = await fetch(base + '/render', { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ html: '<!doctype html><p>Prueba</p>' }) });
  assert.equal(result.status, 503); assert.equal(calls, 1);
});

test('el worker exige su token independiente y limita métodos, formato y tamaño', async t => {
  const worker = createPdfWorker({ token, render: async () => pdf });
  const base = await listen(t, worker); await worker.ready;
  assert.equal((await fetch(base + '/health')).status, 200);
  for (const supplied of ['', 'Bearer invalid', 'Bearer ' + 'x'.repeat(40)]) {
    const response = await fetch(base + '/render', { method: 'POST', headers: { Authorization: supplied }, body: '{}' });
    assert.equal(response.status, 401);
  }
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  assert.equal((await fetch(base + '/render', { headers })).status, 405);
  assert.equal((await fetch(base + '/render', { method: 'POST', headers: { Authorization: headers.Authorization }, body: '{}' })).status, 415);
  assert.equal((await fetch(base + '/render', { method: 'POST', headers, body: JSON.stringify({ html: '<!doctype html>', fileName: 'client.pdf' }) })).status, 400);
  assert.equal((await fetch(base + '/render', { method: 'POST', headers, body: '{' })).status, 400);
  assert.equal((await fetch(base + '/render', { method: 'POST', headers, body: 'x'.repeat(6 * 1024 * 1024 + 1) })).status, 413);
});

test('el destino del ERP debe ser privado de Railway y no acepta credenciales en la URL', t => {
  remoteEnvironment(t);
  assert.equal(pdfRendererConfig().url.href, 'http://gentia-pdf.railway.internal:8080/render');
  for (const url of ['https://example.com', 'http://127.0.0.1:8080', 'file:///tmp/pdf', 'http://user:password@gentia-pdf.railway.internal', 'http://gentia-pdf.railway.internal/other', 'http://gentia-pdf.railway.internal/?token=x']) {
    process.env.PDF_RENDERER_URL = url;
    assert.throws(() => pdfRendererConfig(), error => error.status === 503);
  }
});

test('el ERP envía solo HTML saneado y la credencial independiente al worker', async t => {
  const originalFetch = remoteEnvironment(t);
  const documents = [];
  const worker = createPdfWorker({ token, render: async html => { documents.push(html); return pdf; } });
  const base = await listen(t, worker); await worker.ready;
  globalThis.fetch = async (url, init) => {
    assert.equal(String(url), 'http://gentia-pdf.railway.internal:8080/render');
    assert.equal(init.redirect, 'error');
    const headers = new Headers(init.headers);
    assert.equal(headers.get('Authorization'), `Bearer ${token}`);
    assert.deepEqual([...headers.keys()].sort(), ['authorization', 'content-type']);
    return originalFetch(base + '/render', init);
  };
  const rendered = await renderPdf('<!doctype html><script>bad()</script><img src="file:///secret"><p>Importe 100</p>');
  assert.equal(rendered.toString(), pdf.toString());
  assert.doesNotMatch(documents.at(-1), /<script|file:\/\//);
  assert.match(documents.at(-1), /Importe 100/);
});

test('el ERP falla cerrado sin fallback local ante respuesta inválida, excesiva o no disponible', async t => {
  remoteEnvironment(t);
  for (const response of [new Response('{}', { status: 503 }), new Response('{}', { headers: { 'Content-Type': 'application/json' } }), new Response('not pdf', { headers: { 'Content-Type': 'application/pdf' } }), new Response(pdf, { headers: { 'Content-Type': 'application/pdf', 'Content-Length': String(25 * 1024 * 1024) } })]) {
    globalThis.fetch = async () => response;
    await assert.rejects(renderPdf('<!doctype html><p>Prueba</p>'), error => error.status === 503);
  }
});

test('worker y ERP producen un PDF real sin navegador en el proceso ERP', { skip: process.env.PDF_SECURITY_BROWSER_TESTS !== 'true', timeout: 90_000 }, async t => {
  const originalFetch = remoteEnvironment(t);
  const worker = createPdfWorker({ token });
  const base = await listen(t, worker); await worker.ready;
  assert.equal(worker.getState(), 'ready');
  globalThis.fetch = (_url, init) => originalFetch(base + '/render', init);
  const result = await renderPdf('<!doctype html><h1>GENTIA renderer aislado</h1><table><tr><td>100.00</td></tr></table>');
  assert.equal(result.subarray(0, 4).toString(), '%PDF'); assert.ok(result.length > 1000);
});
