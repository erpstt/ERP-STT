import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { chromium } from '@playwright/test';

const renewal = await readFile(new URL('../public/session-renewal.js', import.meta.url));
const jwt = (version = 1, sid = 'synthetic-session') => `header.${Buffer.from(JSON.stringify({ sub: 'synthetic-user', session_id: sid, exp: Math.floor(Date.now() / 1000) + 3600, version })).toString('base64url')}.signature`;
const metadata = (accessToken, lease = 900000) => ({ accessToken, user: { name: 'Synthetic' }, expiresAt: new Date(Date.now() + 3600000).toISOString(), erpSessionExpiresAt: new Date(Date.now() + lease).toISOString(), refreshAt: new Date(Date.now() + lease - 60000).toISOString() });
const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', resolve));

test('browser: script síncrono padre/iframe conserva edición, rota Bearer y envía exactamente una operación', { timeout: 60000 }, async t => {
  const calls = []; let version = 1;
  const server = createServer(async (req, res) => {
    const path = new URL(req.url, 'http://localhost').pathname;
    if (path === '/session-renewal.js') { res.setHeader('Content-Type', 'text/javascript'); res.end(renewal); return; }
    if (path.startsWith('/api/')) {
      let body = ''; for await (const piece of req) body += piece;
      calls.push({ path, method: req.method, authorization: req.headers.authorization, body });
      res.setHeader('Content-Type', 'application/json');
      if (path === '/api/auth/refresh') { version++; res.end(JSON.stringify(metadata(jwt(version)))); }
      else res.end(JSON.stringify({ saved: true }));
      return;
    }
    res.setHeader('Content-Type', 'text/html');
    // Same parser-blocking injection contract as serveFile: runs before page scripts/modules.
    res.end(`<!doctype html><html><head><script src="/session-renewal.js?v=synthetic"></script></head><body><input id="memo"><button id="save">Guardar</button><script>
      const capturedToken=localStorage.getItem('nexo_token')||sessionStorage.getItem('nexo_token');
      window.marker=crypto.randomUUID();window.result=null;
      document.getElementById('save').onclick=async()=>{const response=await fetch('/api/purchasing/invoice-entry',{method:'POST',headers:{Authorization:'Bearer '+capturedToken,'Content-Type':'application/json'},body:JSON.stringify({memo:document.getElementById('memo').value})});window.result=await response.json();};
    </script></body></html>`);
  });
  await listen(server); t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const browser = await chromium.launch({ headless: true }); t.after(() => browser.close());
  const context = await browser.newContext(), page = await context.newPage();
  const origin = `http://127.0.0.1:${server.address().port}`; await page.goto(origin);
  await page.evaluate(data => { window.NexoSessionRenewal.acceptLogin(data, { rememberMe: true }); localStorage.setItem('nexo_device_token', 'synthetic-device'); const iframe = document.createElement('iframe'); iframe.src = '/entry'; document.body.append(iframe); }, metadata(jwt()));
  const frame = await page.waitForSelector('iframe'); const entry = await frame.contentFrame(); await entry.waitForSelector('#memo');
  await entry.locator('#memo').fill('Línea financiera sin guardar'); const marker = await entry.evaluate(() => window.marker);
  await page.evaluate(() => window.NexoSessionRenewal.ensureFresh({ force: true }));
  await entry.locator('#save').click(); await entry.waitForFunction(() => window.result?.saved);
  assert.equal(await entry.locator('#memo').inputValue(), 'Línea financiera sin guardar'); assert.equal(await entry.evaluate(() => window.marker), marker);
  const writes = calls.filter(call => call.path === '/api/purchasing/invoice-entry'); assert.equal(writes.length, 1);
  assert.equal(JSON.parse(writes[0].body).memo, 'Línea financiera sin guardar');
  assert.equal(JSON.parse(Buffer.from(writes[0].authorization.split('.')[1], 'base64url')).version, 2);
  assert.equal(calls.filter(call => call.path === '/api/auth/refresh').length, 1);
});

test('browser: dos pestañas sincronizan renovación y logout sin perder login posterior', { timeout: 60000 }, async t => {
  let refreshes = 0, version = 1; const calls = [];
  const server = createServer(async (req, res) => {
    const path = new URL(req.url, 'http://localhost').pathname;
    if (path === '/session-renewal.js') { res.setHeader('Content-Type', 'text/javascript'); res.end(renewal); return; }
    if (path.startsWith('/api/')) {
      calls.push(path); res.setHeader('Content-Type', 'application/json');
      if (path === '/api/auth/refresh') { refreshes++; await new Promise(resolve => setTimeout(resolve, 75)); res.end(JSON.stringify(metadata(jwt(++version)))); }
      else { await new Promise(resolve => setTimeout(resolve, 75)); res.end('{}'); }
      return;
    }
    res.setHeader('Content-Type', 'text/html'); res.end('<!doctype html><html><head><script src="/session-renewal.js"></script></head><body><textarea id="memo"></textarea></body></html>');
  });
  await listen(server); t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const browser = await chromium.launch({ headless: true }); t.after(() => browser.close());
  const context = await browser.newContext(), a = await context.newPage(), b = await context.newPage();
  const origin = `http://127.0.0.1:${server.address().port}`; await a.goto(origin);
  await a.evaluate(data => window.NexoSessionRenewal.acceptLogin(data, { rememberMe: true }), metadata(jwt())); await b.goto(origin);
  await b.locator('#memo').fill('Pendiente en segunda pestaña');
  await Promise.all([a.evaluate(() => window.NexoSessionRenewal.ensureFresh({ force: true })), b.evaluate(() => window.NexoSessionRenewal.ensureFresh({ force: true }))]);
  assert.equal(refreshes, 1); assert.equal(await b.locator('#memo').inputValue(), 'Pendiente en segunda pestaña');
  assert.equal(await a.evaluate(() => window.NexoSessionRenewal.current().token), await b.evaluate(() => window.NexoSessionRenewal.current().token));
  await a.evaluate(data => { window.pendingLogout = window.NexoSessionRenewal.logout(); const attempt = window.NexoSessionRenewal.beginLogin(); window.NexoSessionRenewal.acceptLogin(data, { rememberMe: true, attempt }); }, metadata(jwt(1, 'synthetic-new-session')));
  await a.evaluate(() => window.pendingLogout); await b.waitForFunction(() => window.NexoSessionRenewal.current()?.identity.endsWith('/synthetic-new-session'));
  assert.ok((await a.evaluate(() => window.NexoSessionRenewal.current().identity)).endsWith('/synthetic-new-session'));
  assert.equal(calls.filter(path => path === '/api/auth/logout').length, 1);
});
