import assert from 'node:assert/strict';
import {test} from 'node:test';

assert.deepEqual(process.argv.slice(2), [], 'This isolated test accepts no credentials or destinations');
const originalEnvironment = process.env;
const originalFetch = globalThis.fetch;
const osEnvironment = {};
for (const key of ['SystemRoot', 'WINDIR', 'COMSPEC', 'PATHEXT', 'PATH', 'TEMP', 'TMP']) {
  if (originalEnvironment[key] !== undefined) osEnvironment[key] = originalEnvironment[key];
}
const publicKey = 'p102-synthetic-public-key';
const canary = 'SYNTHETIC-P102-PRIVATE-DETAIL-DO-NOT-PRINT';
const serviceKey = 'p102-synthetic-storage-key';
const fixtureEnvironment = {...osEnvironment, SUPABASE_URL: 'http://127.0.0.1:9', SUPABASE_ANON_KEY: publicKey,
  SUPABASE_SERVICE_ROLE_KEY: serviceKey, DISABLE_BACKGROUND_JOBS: 'true', EMAIL_NOTIFICATIONS_ENABLED: 'false'};
let calendar, roles;
try {
  process.env = {...fixtureEnvironment};
  globalThis.fetch = async () => { throw Error('Unexpected import-time network operation'); };
  roles = await import('../dist/modules/security-catalogs/role-access-matrix.module.js');
  calendar = await import('../dist/modules/tax-calendar/tax-calendar.service.js');
} finally {
  process.env = originalEnvironment;
  globalThis.fetch = originalFetch;
}

const resource = 'tax:tax-calendar';
const eventId = '11111111-1111-4111-8111-111111111111';
const otherId = '22222222-2222-4222-8222-222222222222';
const pdf = Buffer.from('%PDF-synthetic-only');
const grant = (view = true, create = true, edit = true, remove = true) =>
  ({resourceKey: resource, canView: view, canCreate: create, canEdit: edit, canDelete: remove});
const filePayload = (overrides = {}) => ({subsidiaryId: 1, documentType: 'file_upload',
  file: {name: 'synthetic.pdf', mimeType: 'application/pdf', size: pdf.length, dataUrl: 'data:application/pdf;base64,' + pdf.toString('base64')}, ...overrides});
let tokenCounter = 0;
const token = () => 'Bearer p102-synthetic-user-' + (++tokenCounter);
function safe(error) {
  assert.ok(!String(error.message).includes(canary));
  assert.ok(!String(error.stack).includes(canary));
  assert.equal(error.cause, undefined);
  return true;
}
const denied = status => error => { assert.equal(error.status, status); return safe(error); };
function unit(name, work) {
  test(name, async t => {
    process.env = {...fixtureEnvironment};
    roles.invalidateRoleAccessCaches();
    globalThis.fetch = async () => { throw Error('Unexpected fixture network operation'); };
    t.after(() => {
      roles.invalidateRoleAccessCaches();
      process.env = originalEnvironment;
      globalThis.fetch = originalFetch;
    });
    await work(t);
  });
}
function mocked({grants = [grant()], options, detail, respond} = {}) {
  const calls = [], storage = [], management = [];
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    assert.equal(url.origin, 'http://127.0.0.1:9', 'Only the synthetic mocked provider is permitted');
    const headers = new Headers(init.headers);
    const isStorage = url.pathname.startsWith('/storage/v1/');
    const call = {path: url.pathname, method: init.method ?? 'GET', headers, redirect: init.redirect,
      body: isStorage && init.body instanceof Uint8Array ? init.body : init.body ? JSON.parse(String(init.body)) : null};
    calls.push(call);
    if (isStorage) {
      assert.equal(headers.get('apikey'), serviceKey);
      assert.equal(headers.get('authorization'), 'Bearer ' + serviceKey);
      storage.push(call);
      if (respond) { const result = await respond(call); if (result) return result; }
      return call.method === 'GET' ? new Response(pdf, {headers: {'Content-Length': String(pdf.length)}}) : Response.json({success: true});
    }
    assert.equal(headers.get('apikey'), publicKey);
    assert.match(headers.get('authorization') ?? '', /^Bearer p102-synthetic-user-/);
    assert.ok(!JSON.stringify(call.body).includes(serviceKey));
    if (url.pathname === '/rest/v1/rpc/security_my_role_access') {
      if (respond) { const result = await respond(call); if (result) return result; }
      return Response.json({isAdmin: false, grants});
    }
    management.push(call);
    if (respond) { const result = await respond(call); if (result) return result; }
    if (url.pathname === '/rest/v1/rpc/tax_calendar_document') return Response.json({storagePath: '1/' + eventId + '/synthetic.pdf', mimeType: 'application/pdf', fileName: 'synthetic.pdf', fileSize: pdf.length});
    if (url.pathname === '/rest/v1/rpc/tax_obligation_catalog_manage') return Response.json({taxTypes: []});
    assert.equal(url.pathname, '/rest/v1/rpc/tax_calendar_manage');
    if (call.body.p_action === 'options') return Response.json(options ?? {permissions: {view: true, file: true, manage: true}, subsidiaries: [{id: 1}, {id: 2}]});
    if (call.body.p_action === 'get') return Response.json(detail ?? {event: {id: eventId, subsidiaryId: 1}});
    return Response.json({success: true, id: call.body.p_payload?.id});
  };
  return {calls, storage, management};
}
function guardedFile(overrides = {}) {
  let reads = 0;
  const payload = filePayload(overrides);
  Object.defineProperty(payload.file, 'dataUrl', {get() { reads++; throw Error(canary); }});
  return {payload, reads: () => reads};
}

unit('invalid Bearer is rejected before payload access, RPCs, decoding and Storage', async () => {
  let calls = 0;
  globalThis.fetch = async () => { calls++; throw Error(canary); };
  const unreadable = new Proxy({}, {get() { throw Error(canary); }});
  for (const authorization of ['', 'Basic synthetic', 'Bearer', 'Bearer token with spaces']) {
    for (const action of ['options', 'list', 'get', 'save', 'delete', 'mark-read']) {
      await assert.rejects(() => calendar.taxCalendarAction(authorization, action, unreadable), denied(401));
    }
    await assert.rejects(() => calendar.taxCalendarDocument(authorization, canary), denied(401));
  }
  assert.equal(calls, 0);
});

unit('view and exact create/edit/delete grants are required before file validation or tax RPCs', async () => {
  for (const grants of [[], [{...grant(), resourceKey: 'configuration:tax-codes'}], [grant(false)]]) {
    const f = mocked({grants});
    const payload = new Proxy({}, {get() { throw Error(canary); }});
    for (const action of ['options', 'list', 'get', 'save', 'delete', 'mark-read']) {
      await assert.rejects(() => calendar.taxCalendarAction(token(), action, payload), denied(403));
    }
    await assert.rejects(() => calendar.taxCalendarDocument(token(), eventId), denied(403));
    assert.equal(f.management.length, 0); assert.equal(f.storage.length, 0);
  }
  for (const [payload, permission] of [[filePayload(), grant(true, false)], [filePayload({id: eventId}), grant(true, true, false)]]) {
    const f = mocked({grants: [permission]}), guarded = guardedFile(payload);
    await assert.rejects(() => calendar.taxCalendarAction(token(), 'save', guarded.payload), denied(403));
    assert.equal(guarded.reads(), 0); assert.equal(f.management.length, 0); assert.equal(f.storage.length, 0);
  }
  const f = mocked({grants: [grant(true, true, true, false)]});
  await assert.rejects(() => calendar.taxCalendarAction(token(), 'delete', {id: eventId}), denied(403));
  assert.equal(f.management.length, 0); assert.equal(f.storage.length, 0);
});

unit('no-file saves retain create/edit distinction without requiring file permission or preflight', async () => {
  for (const [payload, allowed] of [[{subsidiaryId: 1, documentType: 'none'}, grant(true, true, false, false)],
    [{id: eventId, subsidiaryId: 1, documentType: 'none'}, grant(true, false, true, false)]]) {
    const f = mocked({grants: [allowed], options: {permissions: {view: true, file: false, manage: false}, subsidiaries: []}});
    assert.equal((await calendar.taxCalendarAction(token(), 'save', payload)).success, true);
    assert.deepEqual(f.management.map(call => call.body.p_action), ['save']);
    assert.equal(f.storage.length, 0);
  }
});

unit('upload options deny missing, non-boolean or absent file/manage permissions before encoded data is read', async () => {
  for (const permissions of [{view: false, file: true, manage: true}, {view: true, file: false, manage: true},
    {view: true, file: 'true', manage: true}, {view: true, file: true, manage: false}, {}, null]) {
    const f = mocked({options: {permissions, subsidiaries: [{id: 1}]}}), guarded = guardedFile();
    await assert.rejects(() => calendar.taxCalendarAction(token(), 'save', guarded.payload), denied(403));
    assert.equal(guarded.reads(), 0); assert.equal(f.storage.length, 0);
    assert.deepEqual(f.management.map(call => call.body.p_action), ['options']);
  }
});

unit('upload destination must be in the active authorized options list before decoding', async () => {
  for (const subsidiaries of [[], [{id: 2}], [{id: 1, isActive: false}], [{id: 1, is_active: false}], [{id: '01'}]]) {
    const f = mocked({options: {permissions: {view: true, file: true, manage: true}, subsidiaries}}), guarded = guardedFile();
    await assert.rejects(() => calendar.taxCalendarAction(token(), 'save', guarded.payload), denied(403));
    assert.equal(guarded.reads(), 0); assert.equal(f.storage.length, 0);
  }
});

unit('existing upload requires an accessible matching event and authorized source plus destination', async () => {
  for (const [detail, subsidiaries, destination, status] of [
    [{}, [{id: 1}], 1, 404], [{event: {id: otherId, subsidiaryId: 1}}, [{id: 1}], 1, 404],
    [{event: {id: eventId, subsidiaryId: 2}}, [{id: 1}], 1, 403],
    [{event: {id: eventId, subsidiaryId: 1}}, [{id: 1}], 2, 403]
  ]) {
    const f = mocked({detail, options: {permissions: {view: true, file: true, manage: false}, subsidiaries}});
    const guarded = guardedFile({id: eventId, subsidiaryId: destination});
    await assert.rejects(() => calendar.taxCalendarAction(token(), 'save', guarded.payload), denied(status));
    assert.equal(guarded.reads(), 0); assert.equal(f.storage.length, 0);
    assert.deepEqual(f.management.map(call => call.body.p_action), ['options', 'get']);
  }
});

unit('authorized new upload uses public JWT preflight, validated bytes, canonical Storage path then final save', async () => {
  const f = mocked(), authorization = token();
  const result = await calendar.taxCalendarAction(authorization, 'save', filePayload({storagePath: canary, storage_path: canary}));
  assert.equal(result.success, true); assert.equal(f.storage.length, 1);
  const actions = f.calls.map(call => call.path.startsWith('/storage/') ? 'upload' : call.body?.p_action ?? 'access');
  assert.deepEqual(actions, ['access', 'options', 'upload', 'save']);
  const preflight = f.management[0]; assert.equal(preflight.redirect, 'error');
  assert.equal(preflight.headers.get('authorization'), authorization);
  const saved = f.management.at(-1).body.p_payload;
  assert.match(saved.id, /^[0-9a-f-]{36}$/); assert.equal(saved.subsidiaryId, '1');
  assert.deepEqual(Object.keys(saved.file).sort(), ['mimeType', 'name', 'size', 'storagePath']);
  assert.equal(saved.file.size, pdf.length); assert.equal(saved.file.mimeType, 'application/pdf');
  assert.match(saved.file.storagePath, new RegExp('^1/' + saved.id + '/[0-9a-f-]{36}-synthetic\\.pdf$'));
  assert.equal('storagePath' in saved, false); assert.equal('storage_path' in saved, false);
  assert.ok(!JSON.stringify(saved).includes(canary));
  assert.deepEqual(Buffer.from(f.storage[0].body), pdf);
});

unit('an existing authorized filer needs edit and file, not manage, while retaining the checked event subsidiary', async () => {
  const f = mocked({grants: [grant(true, false, true, false)],
    options: {permissions: {view: true, file: true, manage: false}, subsidiaries: [{id: 1}, {id: 2}]}});
  await calendar.taxCalendarAction(token(), 'save', filePayload({id: eventId, subsidiaryId: 1}));
  assert.deepEqual(f.management.map(call => call.body.p_action), ['options', 'get', 'save']);
  for (const preflight of f.management.slice(0, 2)) assert.equal(preflight.redirect, 'error');
  const saved = f.management.at(-1).body.p_payload;
  assert.equal(saved.id, eventId); assert.equal(saved.subsidiaryId, '1');
  assert.ok(saved.file.storagePath.startsWith('1/' + eventId + '/'));
  assert.equal(f.storage.length, 1);
});

unit('an existing event can retain its authorized subsidiary when omitted by a legitimate caller', async () => {
  const payload = filePayload({id: eventId}); delete payload.subsidiaryId;
  const f = mocked(); await calendar.taxCalendarAction(token(), 'save', payload);
  assert.equal(f.management.at(-1).body.p_payload.subsidiaryId, '1');
  assert.equal(f.storage.length, 1);
});

unit('preflight provider errors, malformed JSON, redirects and fetch exceptions expose only safe errors and never decode or upload', async () => {
  for (const [action, response, status] of [
    ['options', () => Response.json({message: canary, code: '42501'}, {status: 403}), 403],
    ['options', () => Response.json({message: canary}, {status: 401}), 401],
    ['get', () => Response.json({message: canary, code: 'P0001'}, {status: 400}), 404],
    ['options', () => new Response(canary, {status: 200}), 503],
    ['options', () => Response.json({message: canary}, {status: 302}), 503],
    ['options', () => Response.json({message: canary}, {status: 500}), 503],
    ['options', () => { throw Error(canary); }, 503]
  ]) {
    const f = mocked({respond: call => call.body?.p_action === action ? response() : undefined});
    const guarded = guardedFile({id: eventId});
    await assert.rejects(() => calendar.taxCalendarAction(token(), 'save', guarded.payload), denied(status));
    assert.equal(guarded.reads(), 0); assert.equal(f.storage.length, 0);
  }
});

unit('role provider errors are sanitized before tax RPCs and file decoding', async () => {
  for (const [response, status] of [
    [() => Response.json({message: canary}, {status: 403}), 403],
    [() => Response.json({message: canary}, {status: 401}), 401],
    [() => new Response(canary, {status: 200}), 503],
    [() => { throw Error(canary); }, 503]
  ]) {
    const f = mocked({respond: call => call.path.endsWith('/security_my_role_access') ? response() : undefined});
    const guarded = guardedFile();
    await assert.rejects(() => calendar.taxCalendarAction(token(), 'save', guarded.payload), denied(status));
    assert.equal(guarded.reads(), 0); assert.equal(f.management.length, 0); assert.equal(f.storage.length, 0);
  }
});

unit('authorized uploads retain MIME, extension, declared size, magic byte, nonempty and 5MiB validation before Storage', async () => {
  const invalidFiles = [
    {name: 'synthetic.pdf', dataUrl: 'data:application/pdf;base64,'},
    {name: 'synthetic.pdf', dataUrl: 'data:text/html;base64,' + Buffer.from('<html>').toString('base64')},
    {name: 'synthetic.png', mimeType: 'application/pdf', size: pdf.length, dataUrl: 'data:application/pdf;base64,' + pdf.toString('base64')},
    {name: 'synthetic.pdf', mimeType: 'application/pdf', size: 1, dataUrl: 'data:application/pdf;base64,' + pdf.toString('base64')},
    {name: 'synthetic.pdf', mimeType: 'application/pdf', size: 7, dataUrl: 'data:application/pdf;base64,' + Buffer.from('invalid').toString('base64')},
    {name: '../synthetic.pdf', dataUrl: 'data:application/pdf;base64,' + pdf.toString('base64')},
    {name: 'synthetic.pdf', dataUrl: 'data:application/pdf;base64,' + Buffer.alloc(5 * 1024 * 1024 + 1, 65).toString('base64')}
  ];
  for (const file of invalidFiles) {
    const f = mocked(); await assert.rejects(() => calendar.taxCalendarAction(token(), 'save', filePayload({file})), safe);
    assert.equal(f.storage.length, 0); assert.deepEqual(f.management.map(call => call.body.p_action), ['options']);
  }
});

unit('PDF, JPEG and PNG accepted formats still upload and save after authorization', async () => {
  for (const [name, mime, bytes] of [['synthetic.pdf', 'application/pdf', pdf],
    ['synthetic.jpg', 'image/jpeg', Buffer.from([255, 216, 255, 0])],
    ['synthetic.png', 'image/png', Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])]]) {
    const f = mocked();
    await calendar.taxCalendarAction(token(), 'save', filePayload({file: {name, mimeType: mime, size: bytes.length, dataUrl: 'data:' + mime + ';base64,' + bytes.toString('base64')}}));
    assert.equal(f.storage.length, 1); assert.deepEqual(Buffer.from(f.storage[0].body), bytes);
  }
});

unit('a final SQL save rejection retains cleanup of only the new authorized upload', async () => {
  const f = mocked({respond: call => call.body?.p_action === 'save' ? Response.json({message: 'Synthetic final save rejected'}, {status: 403}) : undefined});
  await assert.rejects(() => calendar.taxCalendarAction(token(), 'save', filePayload({id: eventId})), /Synthetic final save rejected/);
  assert.equal(f.storage.length, 2); assert.equal(f.storage[0].method, 'POST'); assert.equal(f.storage[1].method, 'DELETE');
  assert.deepEqual(f.storage[1].body.prefixes, [decodeURIComponent(f.storage[0].path.split('/tax-calendar/')[1])]);
});

unit('delete and download require their A06 action before existing SQL permission checks and privileged Storage IO', async () => {
  let f = mocked({grants: [grant(true, false, false, true)], respond: call => call.body?.p_action === 'delete'
    ? Response.json({success: true, obsoleteStoragePath: '1/' + eventId + '/synthetic.pdf'}) : undefined});
  assert.equal((await calendar.taxCalendarAction(token(), 'delete', {id: eventId})).success, true);
  assert.deepEqual(f.management.map(call => call.body.p_action), ['delete']);
  assert.equal(f.storage.length, 1); assert.equal(f.storage[0].method, 'DELETE');
  f = mocked({grants: [grant(true, false, false, false)]});
  const result = await calendar.taxCalendarDocument(token(), eventId);
  assert.deepEqual(result.bytes, pdf); assert.equal(result.mimeType, 'application/pdf'); assert.equal(result.fileName, 'synthetic.pdf');
  assert.equal(f.management.length, 1); assert.equal(f.management[0].path, '/rest/v1/rpc/tax_calendar_document');
  assert.equal(f.storage.length, 1); assert.equal(f.storage[0].method, 'GET');
});

unit('read-only calendar actions preserve their original RPC contracts after exact view authorization', async () => {
  const f = mocked({grants: [grant(true, false, false, false)]}), authorization = token();
  for (const action of ['options', 'list', 'get', 'mark-read']) await calendar.taxCalendarAction(authorization, action, {id: eventId});
  assert.deepEqual(f.management.map(call => call.body.p_action), ['options', 'calendar-options', 'list', 'get', 'mark-read']);
  assert.equal(f.storage.length, 0);
});
