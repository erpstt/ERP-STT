import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../public/session-renewal.js', import.meta.url), 'utf8');
const app = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
const start = Date.parse('2026-11-05T12:00:00Z');
const token = (version = 1, sid = 'session-one', sub = 'synthetic-user') => `header.${Buffer.from(JSON.stringify({ sub, session_id: sid, email: 'synthetic@example.invalid', exp: Math.floor(start / 1000) + 3600, version })).toString('base64url')}.signature`;
const login = (accessToken = token(), now = start, lease = 900000) => ({ accessToken, user: { name: 'Synthetic' }, expiresAt: new Date(start + 3600000).toISOString(), erpSessionExpiresAt: new Date(now + lease).toISOString(), refreshAt: new Date(now + lease - 60000).toISOString() });
const storage = () => { const map = new Map(); return { getItem: key => map.get(key) ?? null, setItem: (key, value) => map.set(key, String(value)), removeItem: key => map.delete(key) }; };
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
class CustomEvent extends Event { constructor(type, init = {}) { super(type); this.detail = init.detail; } }
function browser({ local = storage(), session = storage(), fetch: transport = async () => Response.json({}), top, locks, channel } = {}) {
  let now = start, serial = 0;
  const timers = new Map(), events = new EventTarget(), document = new EventTarget(), calls = [];
  document.hidden = false;
  class Clock extends Date { constructor(...args) { super(...(args.length ? args : [now])); } static now() { return now; } }
  const context = { Date: Clock, console, Promise, JSON, Set, Math, URL, Headers, Response, Request, DOMException, Event, CustomEvent, atob,
    localStorage: local, sessionStorage: session, document, location: new URL('https://erp.example.invalid/'), navigator: { locks },
    crypto: { randomUUID: () => `synthetic-generation-${++serial}-${Math.random()}` },
    setTimeout: (fn, delay) => { const id = ++serial; timers.set(id, { fn, at: now + delay }); return id; }, clearTimeout: id => timers.delete(id),
    addEventListener: (...args) => events.addEventListener(...args), dispatchEvent: event => events.dispatchEvent(event),
    fetch: async (...args) => { calls.push(args); return transport(...args); } };
  if (channel) context.BroadcastChannel = channel;
  context.window = context; context.top = top || context;
  vm.runInNewContext(source, context);
  return { window: context, local, session, calls, timers, coordinator: context.NexoSessionRenewal,
    async advance(ms) { now += ms; const ready = [...timers].filter(([, x]) => x.at <= now); for (const [id, x] of ready) { timers.delete(id); x.fn(); } await flush(); },
    time: () => now };
}
const protectedFetch = (b, bearer, method = 'POST', path = '/api/purchasing/invoice-entry') => b.window.fetch(path, { method, headers: { Authorization: `Bearer ${bearer}`, 'Content-Type': 'application/json' }, ...(method === 'GET' ? {} : { body: '{"synthetic":true}' }) });

test('renueva la lease ERP de 15 minutos aunque el JWT dure una hora; no recarga contexto', async () => {
  let refreshes = 0; const b = browser({ fetch: async path => { assert.equal(path, '/api/auth/refresh'); refreshes++; return Response.json(login(token(2), b.time())); } });
  b.coordinator.acceptLogin(login(), { rememberMe: true });
  await b.advance(839999); assert.equal(refreshes, 0);
  await b.advance(1); await flush(); assert.equal(refreshes, 1);
  assert.equal(b.local.getItem('nexo_token'), token(2));
  assert.equal(b.calls.some(([path]) => path.includes('bootstrap')), false);
});

test('preflight de varias escrituras renueva una vez y envía cada POST una sola vez', async () => {
  const wait = deferred(), sent = []; let refreshes = 0;
  const b = browser({ fetch: async (path, init) => { if (path === '/api/auth/refresh') { refreshes++; await wait.promise; return Response.json(login(token(2), b.time())); } sent.push(new Headers(init.headers).get('Authorization')); return Response.json({ id: 1 }); } });
  b.coordinator.acceptLogin(login(token(), start, 60000));
  const a = protectedFetch(b, token()), c = protectedFetch(b, token()); await flush();
  assert.equal(refreshes, 1); assert.equal(sent.length, 0); wait.resolve(); await Promise.all([a, c]);
  assert.deepEqual(sent, [`Bearer ${token(2)}`, `Bearer ${token(2)}`]);
});

test('iframe ya abierto usa token renovado y conserva el formulario', async () => {
  const sent = []; const parent = browser({ fetch: async path => { assert.equal(path, '/api/auth/refresh'); return Response.json(login(token(2))); } });
  parent.coordinator.acceptLogin(login());
  const frame = browser({ top: parent.window, fetch: async (path, init) => { sent.push(new Headers(init.headers).get('Authorization')); return Response.json({}); } });
  const captured = parent.coordinator.current().token; frame.window.unsavedMemo = 'Detalle sin guardar';
  await parent.coordinator.ensureFresh({ force: true }); await protectedFetch(frame, captured);
  assert.deepEqual(sent, [`Bearer ${token(2)}`]); assert.equal(frame.window.unsavedMemo, 'Detalle sin guardar');
});

test('401 financiero no repite POST y una renovación posterior sólo sirve a la próxima petición', async () => {
  let posts = 0, refreshes = 0; const b = browser({ fetch: async path => path === '/api/auth/refresh' ? (refreshes++, Response.json(login(token(2)))) : (posts++, Response.json({ error: { message: 'Expired' } }, { status: 401 })) });
  b.coordinator.acceptLogin(login()); const response = await protectedFetch(b, token());
  assert.equal(response.status, 401); assert.equal(posts, 1); assert.equal(refreshes, 1); assert.equal(b.coordinator.current().token, token(2));
});

test('no reescribe terceros, Bearer ajeno ni rutas públicas/recovery/logout/refresh', async () => {
  const sent = []; const b = browser({ fetch: async (path, init) => { sent.push([path, new Headers(init.headers).get('Authorization')]); return Response.json({}); } });
  b.coordinator.acceptLogin(login());
  for (const path of ['https://third.example.invalid/api/data', '/api/auth/login', '/api/auth/refresh', '/api/auth/logout', '/api/auth/complete-password-recovery', '/api/auth/complete-password-invitation']) await protectedFetch(b, 'unrelated-recovery', 'POST', path);
  await protectedFetch(b, 'unrelated-bearer');
  assert.equal(sent.length, 7); assert.ok(sent.every(([, header]) => header.startsWith('Bearer unrelated-')));
});

test('fetch sin Authorization y Request con headers conservan la semántica nativa', async () => {
  const sent = []; const b = browser({ fetch: async (resource, init) => { sent.push([resource, init]); return Response.json({}); } });
  b.coordinator.acceptLogin(login());
  await b.window.fetch('/api/health'); assert.equal(sent.length, 1); assert.equal(sent[0][1], undefined);
  const request = new Request('https://erp.example.invalid/api/read', { headers: { Authorization: `Bearer ${token()}`, 'X-Synthetic': 'kept' } });
  await b.window.fetch(request); assert.equal(new Headers(sent[1][1].headers).get('X-Synthetic'), 'kept');
});

test('respuesta refresh malformada es transitoria; token de otro SID se rechaza', async () => {
  for (const data of [{}, login(token(2, 'foreign-session'))]) {
    const b = browser({ fetch: async () => Response.json(data) }); b.coordinator.acceptLogin(login());
    await assert.rejects(b.coordinator.ensureFresh({ force: true }));
    assert.equal(Boolean(b.coordinator.current()), !data.accessToken);
  }
});

test('logout invalida antes de esperar red y su respuesta tardía no borra login nuevo', async () => {
  const wait = deferred(); const b = browser({ fetch: () => wait.promise });
  b.coordinator.acceptLogin(login()); const ending = b.coordinator.logout();
  assert.equal(b.coordinator.current(), null);
  const attempt = b.coordinator.beginLogin(); b.coordinator.acceptLogin(login(token(1, 'new-session')), { attempt });
  wait.resolve(Response.json({})); await ending;
  assert.equal(b.coordinator.current().token, token(1, 'new-session'));
});

test('refresh tardío tras logout o login nuevo nunca resucita la sesión previa', async () => {
  const wait = deferred(); const b = browser({ fetch: () => wait.promise }); b.coordinator.acceptLogin(login());
  const renewal = b.coordinator.ensureFresh({ force: true }); await flush();
  const attempt = b.coordinator.beginLogin(); b.coordinator.acceptLogin(login(token(1, 'new-session')), { attempt });
  wait.resolve(Response.json(login(token(2)))); await assert.rejects(renewal, /sesión/);
  assert.equal(b.coordinator.current().token, token(1, 'new-session'));
  await assert.rejects(protectedFetch(b, token()), /sesión/);
});

test('401 tardío de una solicitud vieja no renueva ni elimina login nuevo', async () => {
  const wait = deferred(); let refreshes = 0; const b = browser({ fetch: async path => { if (path === '/api/auth/refresh') refreshes++; return wait.promise; } });
  b.coordinator.acceptLogin(login()); const request = protectedFetch(b, token()); await flush();
  const attempt = b.coordinator.beginLogin(); b.coordinator.acceptLogin(login(token(1, 'new-session')), { attempt });
  wait.resolve(Response.json({}, { status: 401 })); assert.equal((await request).status, 401);
  assert.equal(refreshes, 0); assert.equal(b.coordinator.current().token, token(1, 'new-session'));
});

test('fallo transitorio bloquea dispatch sin perder datos; refresh reintenta como máximo una vez', async () => {
  let count = 0; const b = browser({ fetch: async () => { count++; throw Error('synthetic lost response'); } });
  b.coordinator.acceptLogin(login(token(), start, 60000)); b.window.memo = 'Sin guardar';
  await assert.rejects(protectedFetch(b, token()), /conexión/);
  assert.equal(count, 2); assert.equal(b.coordinator.current().token, token()); assert.equal(b.window.memo, 'Sin guardar');
});

test('CAS409 o respuesta perdida sólo repiten refresh, nunca la escritura', async () => {
  for (const failure of [409, 'network']) {
    let refreshes = 0, writes = 0; const b = browser({ fetch: async path => {
      if (path !== '/api/auth/refresh') { writes++; return Response.json({}); }
      refreshes++; if (refreshes === 1) { if (failure === 'network') throw Error('lost'); return Response.json({}, { status: 409 }); }
      return Response.json(login(token(2)));
    } }); b.coordinator.acceptLogin(login(token(), start, 60000)); await protectedFetch(b, token());
    assert.equal(refreshes, 2); assert.equal(writes, 1);
  }
});

test('revocación definitiva y sesión heredada sin refresh requieren login sin enviar POST', async () => {
  for (const legacy of [false, true]) {
    let writes = 0; const b = browser({ fetch: async path => { if (path !== '/api/auth/refresh') writes++; return Response.json({}, { status: 401 }); } });
    b.coordinator.acceptLogin(legacy ? { accessToken: token() } : login(token(), start, 60000));
    if (legacy) await b.advance(3600000);
    await assert.rejects(protectedFetch(b, token()), /sesión/); assert.equal(writes, 0); assert.equal(b.coordinator.current(), null);
  }
});

test('Web Locks serializa dos pestañas recordadas y la segunda usa estado vigente', async () => {
  const local = storage(); let tail = Promise.resolve(), refreshes = 0;
  const locks = { request: (_name, fn) => { const task = tail.then(fn); tail = task.catch(() => {}); return task; } };
  const transport = async () => { refreshes++; await flush(); return Response.json(login(token(2))); };
  const a = browser({ local, locks, fetch: transport }); a.coordinator.acceptLogin(login(token(), start, 60000), { rememberMe: true });
  const b = browser({ local, locks, fetch: transport });
  await Promise.all([a.coordinator.ensureFresh(), b.coordinator.ensureFresh()]);
  assert.equal(refreshes, 1); assert.equal(a.coordinator.current().token, token(2)); assert.equal(b.coordinator.current().token, token(2));
});

test('sin Web Locks dos coordinadores no degradan H1 con un 401/409 tardío de H0', async () => {
  for (const status of [401, 409]) {
    const local = storage(), slow = deferred(); let firstCalls = 0, secondCalls = 0;
    const a = browser({ local, fetch: async () => { firstCalls++; return Response.json(login(token(2))); } });
    a.coordinator.acceptLogin(login(token(), start, 60000), { rememberMe: true });
    const b = browser({ local, fetch: async () => { secondCalls++; return slow.promise; } });
    const second = b.coordinator.ensureFresh(); await flush(); await a.coordinator.ensureFresh();
    slow.resolve(Response.json({}, { status })); await second;
    assert.equal(a.coordinator.current().token, token(2)); assert.equal(b.coordinator.current().token, token(2));
    assert.equal(firstCalls, 1); assert.equal(secondCalls, 1);
  }
});

test('429 conserva sesión y programa backoff de un minuto sin bucle de 250ms', async () => {
  let calls = 0; const b = browser({ fetch: async () => { calls++; return Response.json({}, { status: 429 }); } });
  b.coordinator.acceptLogin(login(token(), start, 60000)); await assert.rejects(b.coordinator.ensureFresh(), cause => cause.status === 429);
  await b.advance(59999); assert.equal(calls, 1); await b.advance(1); await flush(); assert.equal(calls, 2);
  assert.equal(b.coordinator.current().token, token());
});

test('logout con revocación fallida informa el problema sin restaurar sesión local', async () => {
  const b = browser({ fetch: async () => Response.json({}, { status: 503 }) }); let message;
  b.window.addEventListener('nexo:session-revocation-error', event => { message = event.detail.message; });
  b.coordinator.acceptLogin(login()); await b.coordinator.logout();
  assert.match(message, /no fue posible confirmar/); assert.equal(b.coordinator.current(), null);
});

test('401 tardío H0 después de rotación H1 en la misma sesión no cierra ni renueva H1', async () => {
  const slow = deferred(); let refreshes = 0;
  const b = browser({ fetch: async path => path === '/api/auth/refresh' ? (refreshes++, Response.json(login(token(2)))) : slow.promise });
  b.coordinator.acceptLogin(login()); const request = protectedFetch(b, token()); await flush();
  await b.coordinator.ensureFresh({ force: true }); slow.resolve(Response.json({}, { status: 401 })); await request;
  assert.equal(refreshes, 1); assert.equal(b.coordinator.current().token, token(2));
});

test('rememberMe respeta almacenamiento elegido y nunca guarda refresh token', () => {
  for (const rememberMe of [false, true]) {
    const b = browser(); b.coordinator.acceptLogin({ ...login(), refreshToken: 'must-never-be-stored' }, { rememberMe });
    assert.equal(Boolean(b.local.getItem('nexo_token')), rememberMe); assert.equal(Boolean(b.session.getItem('nexo_token')), !rememberMe);
    for (const store of [b.local, b.session]) assert.equal((store.getItem('nexo_session_renewal') || '').includes('must-never-be-stored'), false);
  }
});

test('BroadcastChannel sincroniza rotación sólo entre pestañas de la misma sesión no recordada', async () => {
  const instances = new Set();
  class Channel {
    constructor() { instances.add(this); }
    postMessage(data) { for (const instance of instances) if (instance !== this) queueMicrotask(() => instance.onmessage?.({ data })); }
  }
  const a = browser({ channel: Channel, fetch: async () => Response.json(login(token(2))) }); a.coordinator.acceptLogin(login());
  const secondStorage = storage(); secondStorage.setItem('nexo_token', a.session.getItem('nexo_token')); secondStorage.setItem('nexo_session_renewal', a.session.getItem('nexo_session_renewal'));
  const b = browser({ session: secondStorage, channel: Channel });
  const unrelated = browser({ channel: Channel }); unrelated.coordinator.acceptLogin(login(token(1, 'other-session')));
  await a.coordinator.ensureFresh({ force: true }); await flush();
  assert.equal(b.coordinator.current().token, token(2)); assert.equal(b.local.getItem('nexo_token'), null);
  assert.equal(unrelated.coordinator.current().token, token(1, 'other-session'));
});

function appMethod(name, next, globals) {
  const from = app.indexOf(name), to = app.indexOf(next, from + name.length); assert.ok(from >= 0 && to > from);
  return vm.runInNewContext(`({${app.slice(from, to)}})`, globals);
}

test('restoreSession ejecutado conserva token ante un fallo transitorio de bootstrap', async () => {
  const b = browser(); b.coordinator.acceptLogin(login());
  const ui = appMethod('async restoreSession()', 'async signIn()', { ...b.window, sessionRenewal: b.coordinator, getPendingWorkspace: () => null });
  Object.assign(ui, { token: () => b.coordinator.current()?.token, storedContextId: () => null, requestBootstrap: async () => { throw Error('Synthetic network failure'); } });
  await ui.restoreSession(); assert.equal(b.coordinator.current().token, token()); assert.equal(ui.authenticated, false); assert.equal(ui.sessionReady, true); assert.equal(ui.formError, 'Synthetic network failure');
});

test('catálogo de tasas acepta renovación de la misma generación y completa la carga', async () => {
  const b = browser({ fetch: async path => Response.json(path === '/api/auth/refresh' ? login(token(2)) : path.includes('/access?') ? { canView: true, references: {} } : [{ rate_id: 7 }]) });
  b.coordinator.acceptLogin(login(token(), start, 60000));
  const ui = appMethod('async loadRateCatalog(catalog)', 'async loadCatalog()', { ...b.window, sessionRenewal: b.coordinator, rateCatalogLoads: new WeakMap(), cancelRateCatalogLoad() {}, AbortController });
  const catalog = { slug: 'exchange-rates', fields: [] };
  Object.assign(ui, { token: () => b.coordinator.current()?.token, deviceToken: () => 'synthetic-device', activeCompany: { subsidiaryId: 1 }, activeRole: { roleId: 2 }, activeCatalog: catalog, currentModule: 'Configuration', currentSection: 'Rates', referenceOptions: {} });
  await ui.loadRateCatalog(catalog); assert.equal(ui.rows[0].rate_id, 7); assert.equal(ui.tableLoading, false); assert.equal(ui.tableError, ''); assert.equal(b.coordinator.current().token, token(2));
});

test('app preserva sesión con bootstrap transitorio y logout no limpia después de await', () => {
  const restore = app.slice(app.indexOf('async restoreSession()'), app.indexOf('async signIn()'));
  assert.match(restore, /await sessionRenewal.ensureFresh\(\)/); assert.match(restore, /if\(!sessionRenewal\)await this.logout\(true\)/);
  const logout = app.slice(app.indexOf('async logout(preservePendingWorkspace=false)'));
  assert.match(logout, /const completion=sessionRenewal.logout\(\);this.resetSessionView\(preservePendingWorkspace\);await completion;return/);
  assert.match(app, /rememberMe:this.rememberMe/); assert.match(app, /sessionRenewal.acceptLogin\(data/);
});
