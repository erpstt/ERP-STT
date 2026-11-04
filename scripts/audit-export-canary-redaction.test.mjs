import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {test} from 'node:test';
import ExcelJS from 'exceljs';

assert.deepEqual(process.argv.slice(2),[],'This isolated export test accepts no destinations or credentials');
const originalEnvironment=process.env,originalFetch=globalThis.fetch,originalLoadEnvFile=process.loadEnvFile;
const environment={};
for(const key of['SystemRoot','WINDIR','COMSPEC','PATHEXT','PATH','TEMP','TMP'])if(originalEnvironment[key]!==undefined)environment[key]=originalEnvironment[key];
Object.assign(environment,{SUPABASE_URL:'http://127.0.0.1:9',SUPABASE_ANON_KEY:'p125-synthetic-public',SUPABASE_PUBLISHABLE_KEY:'p125-synthetic-public',DISABLE_BACKGROUND_JOBS:'true'});
process.env={...environment};
process.loadEnvFile=()=>{throw Error('Environment files are disabled in this synthetic export fixture');};
globalThis.fetch=async()=>{throw Error('Fetch is disabled during synthetic module initialization');};
const access=await import('../dist/modules/security-catalogs/role-access-matrix.module.js');
const {exportAuditChangeReportExcel}=await import('../dist/modules/reports/audit-change-report.service.js');
process.env=originalEnvironment;globalThis.fetch=originalFetch;

test.beforeEach(()=>{process.env={...environment};access.invalidateRoleAccessCaches();});
test.afterEach(()=>{access.invalidateRoleAccessCaches();process.env=originalEnvironment;globalThis.fetch=originalFetch;});
test.after(()=>{process.loadEnvFile=originalLoadEnvFile;});

for(const snapshotFormat of['object','JSON string'])test('the actual Excel exporter omits runtime canaries from changed values and '+snapshotFormat+' deletion snapshots',async()=>{
 const canary=['SYNTHETIC','AUDIT',randomBytes(24).toString('hex')].join('_');
 const authorization='Bearer p125-synthetic-export-actor',calls=[];
 const snapshot={name:'Synthetic visible record',api_token:canary,password_hash:canary};
 const actor={name:'Synthetic actor',email:'synthetic-actor@example.invalid',type:'HUMAN',source:'Synthetic fixture'};
 const shared={timestamp:'2026-11-04T00:00:00.000Z',module:'Synthetic',entityType:'synthetic_entity',entityLabel:'Synthetic entity',transactionType:'SYNTHETIC',transactionTypeLabel:'Synthetic transaction',subsidiaryName:'Synthetic company',actor};
 const report={header:{month:'2026-11',filterDescription:'Synthetic canary redaction'},total:2,summary:{totalEvents:2,operationCount:2,modifiedCount:1,deletedCount:1,fieldChanges:3,userCount:1},rows:[
  {...shared,auditId:'1',recordLabel:'Synthetic modified record',documentNumber:'SYNTHETIC-ONE',action:'MODIFICACION',changes:[{field:'access_token',oldValue:canary,newValue:canary},{field:'name',oldValue:'Synthetic before',newValue:'Synthetic after'}]},
  {...shared,auditId:'2',recordLabel:'Synthetic deleted record',documentNumber:'SYNTHETIC-TWO',action:'ELIMINACION',deletedSnapshot:snapshotFormat==='object'?snapshot:JSON.stringify(snapshot)},
 ]};
 globalThis.fetch=async(input,init={})=>{
  const url=new URL(input instanceof Request?input.url:String(input)),headers=new Headers(init.headers);
  assert.equal(url.origin,environment.SUPABASE_URL);assert.equal(init.method,'POST');
  assert.equal(headers.get('authorization'),authorization);assert.equal(headers.get('apikey'),environment.SUPABASE_ANON_KEY);
  calls.push(url.pathname);
  if(url.pathname==='/rest/v1/rpc/security_my_role_access')return Response.json({isAdmin:false,grants:[{resourceKey:'audit:change-report',canView:true,canCreate:false,canEdit:false,canDelete:false}]});
  assert.equal(url.pathname,'/rest/v1/rpc/run_audit_change_report');
  const payload=JSON.parse(init.body);assert.equal(payload.p_filters.month,'2026-11');assert.equal(payload.p_filters.page,1);assert.equal(payload.p_filters.pageSize,500);
  return Response.json(report);
 };
 // Inspect the actual generated workbook in memory; do not import the legacy
 // script, render a PDF, write an export, or contact a provider.
 const file=await exportAuditChangeReportExcel(authorization,{month:'2026-11'});
 assert.equal(file.mimeType,'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
 const workbook=new ExcelJS.Workbook();await workbook.xlsx.load(file.buffer);
 const exported=JSON.stringify(workbook.model);
 assert.equal(exported.includes(canary),false,'The runtime canary must not appear in any exported worksheet');
 assert.ok(exported.includes('[dato protegido]'));
 assert.ok(exported.includes('Synthetic visible record'));
 assert.ok(exported.includes('Synthetic before'));assert.ok(exported.includes('Synthetic after'));
 assert.deepEqual(calls,['/rest/v1/rpc/security_my_role_access','/rest/v1/rpc/run_audit_change_report']);
});
