import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { request as httpRequest } from 'node:http';
import { createServer } from 'node:net';
import { test } from 'node:test';

async function freePort() {
  const probe = createServer();
  await new Promise((resolve, reject) => probe.once('error', reject).listen(0, '127.0.0.1', resolve));
  const address = probe.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  await new Promise(resolve => probe.close(resolve));
  return port;
}

async function waitUntilReady(baseUrl, process) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (process.exitCode !== null) throw new Error(`El servidor de prueba finalizó con código ${process.exitCode}.`);
    try {
      const response = await fetch(baseUrl, { signal: AbortSignal.timeout(500) });
      if (response.ok) return;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('El servidor de prueba no inició a tiempo.');
}

test('entrega estáticos comprimidos, revalidables y con rango para video', { timeout: 20_000 }, async t => {
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ['dist/server.js'], {
    cwd: process.cwd(),
    env: { ...process.env, PORT: String(port), DISABLE_BACKGROUND_JOBS: 'true' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let diagnostics = '';
  child.stdout.on('data', chunk => { diagnostics += chunk; });
  child.stderr.on('data', chunk => { diagnostics += chunk; });
  t.after(() => child.kill());

  try {
    await waitUntilReady(baseUrl, child);

    const asset = await fetch(`${baseUrl}/app.js?v=performance-test`, { headers: { 'Accept-Encoding': 'gzip' } });
    assert.equal(asset.status, 200);
    assert.equal(asset.headers.get('content-encoding'), 'gzip');
    assert.match(asset.headers.get('cache-control') ?? '', /immutable/);
    assert.match(asset.headers.get('vary') ?? '', /Accept-Encoding/i);
    const etag = asset.headers.get('etag');
    assert.ok(etag);
    assert.match(await asset.text(), /createApp/);

    const unchanged = await fetch(`${baseUrl}/app.js?v=performance-test`, { headers: { 'If-None-Match': etag } });
    assert.equal(unchanged.status, 304);

    const head = await fetch(`${baseUrl}/styles.css`, { method: 'HEAD' });
    assert.equal(head.status, 200);
    assert.ok(Number(head.headers.get('content-length')) > 0);
    assert.equal((await head.arrayBuffer()).byteLength, 0);

    const videoRange = await fetch(`${baseUrl}/nexo-login.mp4`, { headers: { Range: 'bytes=0-1023' } });
    assert.equal(videoRange.status, 206);
    assert.equal(videoRange.headers.get('accept-ranges'), 'bytes');
    assert.match(videoRange.headers.get('content-range') ?? '', /^bytes 0-1023\//);
    assert.equal((await videoRange.arrayBuffer()).byteLength, 1024);

    const suffixRange = await fetch(`${baseUrl}/nexo-login.mp4`, { headers: { Range: 'bytes=-128' } });
    assert.equal(suffixRange.status, 206);
    assert.equal((await suffixRange.arrayBuffer()).byteLength, 128);

    const report = await fetch(`${baseUrl}/accounting-reports.html`);
    assert.equal(report.status, 200);
    assert.match(await report.text(), /inside-erp-workspace/);

    const oversizedStatus = await new Promise((resolve, reject) => {
      const target = new URL('/api/auth/login', baseUrl);
      const request = httpRequest(target, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': String(9 * 1024 * 1024) } }, response => {
        response.resume();
        response.once('end', () => resolve(response.statusCode));
      });
      request.once('error', reject);
      request.end();
    });
    assert.equal(oversizedStatus, 413);
  } catch (error) {
    throw new Error(`${error instanceof Error ? error.message : error}\n${diagnostics}`);
  }
});
