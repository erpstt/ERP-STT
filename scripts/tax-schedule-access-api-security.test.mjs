import assert from 'node:assert/strict';
import test from 'node:test';

assert.deepEqual(process.argv.slice(2), [], 'This synthetic test accepts no destinations or credentials');
const originalEnvironment = process.env, originalFetch = globalThis.fetch, originalLoadEnvFile = process.loadEnvFile;
const environment = {};
for (const key of ['SystemRoot', 'WINDIR', 'COMSPEC', 'PATHEXT', 'PATH', 'TEMP', 'TMP']) if (originalEnvironment[key] !== undefined) environment[key] = originalEnvironment[key];
Object.assign(environment, { SUPABASE_URL: 'http://127.0.0.1:9', SUPABASE_ANON_KEY: 'p147-synthetic-public', SUPABASE_PUBLISHABLE_KEY: 'p147-synthetic-public', DISABLE_BACKGROUND_JOBS: 'true', EMAIL_NOTIFICATIONS_ENABLED: 'false' });
process.env = { ...environment };
process.loadEnvFile = () => { throw Error('Environment-file access disabled in this synthetic fixture'); };
globalThis.fetch = async () => { throw Error('Unexpected initialization fetch'); };
const { taxObligationCatalogAction: tax } = await import('../dist/modules/tax-calendar/tax-obligation-catalog.service.js');
const { scheduledReportsAction: schedule } = await import('../dist/modules/reports/scheduled-reports.service.js');
const access = await import('../dist/modules/security-catalogs/role-access-matrix.module.js');
process.env = originalEnvironment; globalThis.fetch = originalFetch;
test.beforeEach(() => { process.env = { ...environment }; access.invalidateRoleAccessCaches(); });
test.afterEach(() => { process.env = originalEnvironment; globalThis.fetch = originalFetch; access.invalidateRoleAccessCaches(); });
test.after(() => { process.loadEnvFile = originalLoadEnvFile; });

const auth = 'Bearer p147-synthetic-actor', id = '12345678-1234-1234-1234-123456789abc';
const taxResource = 'tax:tax-obligations', calendarResource = 'tax:tax-calendar', scheduleResource = 'reports:scheduled-reports';
const grant = (resourceKey, actions = []) => ({ resourceKey, canView: actions.includes('view'), canCreate: actions.includes('create'), canEdit: actions.includes('edit'), canDelete: actions.includes('delete') });
function upstream(grants, reply = () => Response.json({ success: true }), { admin = false } = {}) {
  const calls = [], business = [];
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(input instanceof Request ? input.url : String(input)), headers = new Headers(init.headers);
    assert.equal(url.origin, environment.SUPABASE_URL); assert.equal(init.method, 'POST');
    assert.equal(headers.get('authorization'), auth); assert.equal(headers.get('apikey'), environment.SUPABASE_ANON_KEY);
    const call = { name: url.pathname.split('/').at(-1), payload: JSON.parse(init.body) }; calls.push(call);
    if (call.name === 'security_my_role_access') return Response.json({ isAdmin: admin, grants });
    assert.ok(['tax_obligation_catalog_manage', 'scheduled_report_manage', 'scheduled_report_snapshot_v2'].includes(call.name), 'Only synthetic business RPCs are allowed');
    business.push(call); return reply(call);
  };
  return { calls, business };
}
const status = expected => error => error instanceof Error && error.status === expected;

test('unknown actions and malformed payloads are rejected before permission lookup or business I/O', async () => {
  let calls = 0; globalThis.fetch = async () => { calls++; throw Error('No I/O allowed'); };
  for (const action of ['', 'save-template/extra', 'claim', 'calendar-options/extra']) {
    await assert.rejects(() => tax(auth, action, {}), status(400));
    await assert.rejects(() => schedule(auth, action, {}), status(400));
  }
  for (const payload of [null, [], 'invalid']) for (const service of [tax, schedule]) await assert.rejects(() => service(auth, 'save', payload), status(400));
  for (const service of [tax, schedule]) await assert.rejects(() => service('', 'list'), status(401));
  assert.equal(calls, 0);
});

test('present invalid tax UUIDs never become create and missing delete targets fail before permission I/O', async () => {
  let calls = 0; globalThis.fetch = async () => { calls++; throw Error('No I/O allowed'); };
  for (const value of [undefined, null, '', 1, [], {}, '0', ' '+id, id+' ', '../'+id, id.replaceAll('-', '')]) for (const action of ['save', 'delete']) await assert.rejects(() => tax(auth, action, { id: value }), status(400));
  await assert.rejects(() => tax(auth, 'delete', {}), status(400)); assert.equal(calls, 0);
});

test('present invalid schedule IDs never become create and mutations require canonical safe targets', async () => {
  let calls = 0; globalThis.fetch = async () => { calls++; throw Error('No I/O allowed'); };
  for (const value of [undefined, null, '', 0, -1, 1.5, Number.MAX_SAFE_INTEGER+1, NaN, Infinity, [], {}, '01', '1e2', '+1', ' 1', '1 ', '../1', '9007199254740992']) for (const action of ['save', 'toggle', 'delete']) await assert.rejects(() => schedule(auth, action, { id: value }), status(400));
  for (const action of ['toggle', 'delete']) await assert.rejects(() => schedule(auth, action, {}), status(400)); assert.equal(calls, 0);
});

for (const [label, service, resource, cases] of [
  ['tax obligations', tax, taxResource, [['options', {}], ['list', {}], ['save', {}], ['save', {id}], ['delete', {id}], ['save-template', {}]]],
  ['scheduled reports', schedule, scheduleResource, [['list', {}], ['preview', {}], ['save', {}], ['save', {id:1}], ['toggle', {id:1}], ['delete', {id:1}]]],
]) test(label+' requires view even if action flags exist and denies before business RPC', async () => {
  for (const [action, payload] of cases) {
    access.invalidateRoleAccessCaches(); const observed = upstream([grant(resource, ['create','edit','delete'])]);
    await assert.rejects(() => service(auth, action, payload), status(403)); assert.equal(observed.business.length, 0); assert.equal(observed.calls.length, 1);
  }
});

for (const [label, service, resource, cases] of [
  ['tax reader', tax, taxResource, [['save', {}], ['save', {id}], ['delete', {id}], ['save-template', {}]]],
  ['schedule reader', schedule, scheduleResource, [['save', {}], ['save', {id:1}], ['toggle', {id:1}], ['delete', {id:1}]]],
]) test(label+' cannot mutate despite the existing operational permission', async () => {
  for (const [action, payload] of cases) {
    access.invalidateRoleAccessCaches(); const observed = upstream([grant(resource, ['view'])]);
    await assert.rejects(() => service(auth, action, payload), status(403)); assert.equal(observed.business.length, 0);
  }
});

test('denied preview never reads report inputs or calls snapshot/render/SMTP', async () => {
  const observed = upstream([]); let reads = 0;
  const payload = {}; for (const key of ['report','format','cutoff']) Object.defineProperty(payload,key,{get(){reads++;throw Error('Synthetic private input must not be read');}});
  await assert.rejects(() => schedule(auth, 'preview', payload), status(403)); assert.equal(reads, 0); assert.equal(observed.business.length, 0);
});

test('calendar-options requires explicit calendar view and does not borrow obligations access', async () => {
  let observed = upstream([grant(taxResource, ['view','create','edit','delete'])]);
  await assert.rejects(() => tax(auth, 'calendar-options', {}), status(403)); assert.equal(observed.business.length, 0);
  access.invalidateRoleAccessCaches(); observed = upstream([grant(calendarResource, ['view'])], () => Response.json({taxTypes:[{id,code:'SYNTHETIC'}]}));
  assert.deepEqual(await tax(auth, 'calendar-options', {}), {taxTypes:[{id,code:'SYNTHETIC'}]});
  assert.deepEqual(observed.business, [{name:'tax_obligation_catalog_manage',payload:{p_action:'calendar-options',p_payload:{}}}]);
});

test('tax options intersect separate A06 actions with the unchanged operational manage flag', async () => {
  for (const manage of [true, false]) for (const action of ['create','edit','delete']) {
    access.invalidateRoleAccessCaches(); const observed = upstream([grant(taxResource, ['view',action])], () => Response.json({permissions:{view:true,manage,create:true,edit:true,delete:true},countries:[{id:1}],placeholders:[]}));
    const result = await tax(auth, 'options'); assert.equal(result.permissions.manage, manage); assert.equal(result.permissions.view,true);
    for (const current of ['create','edit','delete']) assert.equal(result.permissions[current], manage && current===action);
    assert.deepEqual(result.countries,[{id:1}]); assert.equal(observed.business.length,1);
  }
});

test('schedule list adds exact capabilities only after its existing SQL access succeeds', async () => {
  for (const action of ['create','edit','delete']) {
    access.invalidateRoleAccessCaches(); const observed = upstream([grant(scheduleResource, ['view',action])], () => Response.json({company:{id:1,name:'Synthetic'},schedules:[],history:[]}));
    const result = await schedule(auth,'list'); assert.equal(result.permissions.view,true);
    for (const current of ['create','edit','delete']) assert.equal(result.permissions[current], current===action);
    assert.deepEqual(result.transport,{configured:false,enabled:false}); assert.equal(observed.business.length,1);
  }
});

test('view-only reads and administrator capabilities preserve their successful payloads',async()=>{
  for(const admin of[false,true]){
    access.invalidateRoleAccessCaches();let observed=upstream(admin?[]:[grant(taxResource,['view'])],()=>Response.json({permissions:{view:true,manage:true},countries:[],placeholders:[]}),{admin});
    const options=await tax(auth,'options');assert.deepEqual(options.permissions,{view:true,manage:true,create:admin,edit:admin,delete:admin});
    await tax(auth,'list');assert.deepEqual(observed.business.map(call=>call.payload.p_action),['options','list']);
    access.invalidateRoleAccessCaches();observed=upstream(admin?[]:[grant(scheduleResource,['view'])],()=>Response.json({company:{id:1},schedules:[],history:[]}),{admin});
    const list=await schedule(auth,'list');assert.deepEqual(list.permissions,{view:true,create:admin,edit:admin,delete:admin});assert.equal(observed.business.length,1);
  }
});

for (const [label, service, resource, expectedName, cases] of [
  ['tax',tax,taxResource,'tax_obligation_catalog_manage',[['create','save',{}],['edit','save',{id}],['edit','save-template',{countryId:1,kind:'reminder'}],['delete','delete',{id}]]],
  ['schedule',schedule,scheduleResource,'scheduled_report_manage',[['create','save',{}],['edit','save',{id:'1',revision:2}],['edit','toggle',{id:1,revision:2,active:false}],['delete','delete',{id:Number.MAX_SAFE_INTEGER,revision:2}]]],
]) test(label+' create-only/edit-only/delete-only preserve JWT, payload and operation without substituting permissions',async()=>{
  for(const [allowed,action,payload] of cases){
    access.invalidateRoleAccessCaches(); const observed=upstream([grant(resource,['view',allowed])]);
    assert.equal((await service(auth,action,payload)).success,true);
    assert.deepEqual(observed.business,[{name:expectedName,payload:label==='tax'?{p_action:action,p_payload:payload}:{p_action:action,p:payload}}]);
    access.invalidateRoleAccessCaches(); const denied=upstream([grant(resource,['view',...['create','edit','delete'].filter(value=>value!==allowed)])]);
    await assert.rejects(()=>service(auth,action,payload),status(403));assert.equal(denied.business.length,0);
  }
});

test('successful reader preview uses synthetic CSV and keeps the current snapshot contract without SMTP',async()=>{
  const observed=upstream([grant(scheduleResource,['view'])],call=>Response.json(call.name==='scheduled_report_manage'?{company:{id:1}}:{kind:'AR',cutoff:'2026-11-01',company:'Synthetic',currency:'USD',rows:[],summary:{subledger:0,advances:0,netBalance:0}}));
  const result=await schedule(auth,'preview',{cutoff:'SEND_DATE',report:'AR',format:'CSV',periodMode:'MONTH_TO_DATE',reportOptions:{bookId:1}});
  assert.equal(result.file.mimeType,'text/csv');assert.equal(result.cutoff,'2026-11-01');
  assert.deepEqual(observed.business.map(call=>call.name),['scheduled_report_manage','scheduled_report_snapshot_v2']);
  assert.deepEqual(observed.business[0].payload,{p_action:'list',p:{}});assert.deepEqual(observed.business[1].payload.p_options,{bookId:1,periodMode:'MONTH_TO_DATE'});
  assert.equal(observed.business[1].payload.p_sid,1);assert.equal(observed.business[1].payload.p_kind,'AR');
});

test('administrator A06 bypass still cannot bypass existing operational SQL denials',async()=>{
  for(const [service,action,payload]of[[tax,'save-template',{}],[schedule,'save',{}]]){
    access.invalidateRoleAccessCaches();const observed=upstream([],()=>Response.json({message:'Synthetic operational requirement remains'},{status:403}),{admin:true});
    await assert.rejects(()=>service(auth,action,payload),/Synthetic operational requirement remains/);assert.equal(observed.business.length,1);
  }
});
