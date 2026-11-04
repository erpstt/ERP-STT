import assert from 'node:assert/strict';
import {test} from 'node:test';
import {runAccountingReport} from '../dist/modules/reports/accounting-reports.service.js';
import {primeRoleAccessCache,invalidateRoleAccessCaches} from '../dist/modules/security-catalogs/role-access-matrix.module.js';

const auth='Bearer synthetic-financial-presentation';
async function fixture(t,{allowed=true,status=200,payload={rows:[],summary:{},presentationCurrency:'USD',presentationCurrencyCode:'USD',localCurrencyCode:'JMD'}}={}){
 const oldFetch=globalThis.fetch,oldUrl=process.env.SUPABASE_URL,oldKey=process.env.SUPABASE_ANON_KEY,calls=[];
 Object.assign(process.env,{SUPABASE_URL:'https://financial-presentation.invalid',SUPABASE_ANON_KEY:'synthetic-public-key'});
 await primeRoleAccessCache(auth,{isAdmin:false,grants:allowed?[{resourceKey:'reports:accounting-reports',canView:true,canCreate:false,canEdit:false,canDelete:false}]:[]});
 globalThis.fetch=async(input,init)=>{const url=new URL(String(input)),headers=new Headers(init.headers);assert.equal(url.origin,'https://financial-presentation.invalid');calls.push({path:url.pathname,authorization:headers.get('authorization'),key:headers.get('apikey'),input:JSON.parse(init.body)});return Response.json(payload,{status});};
 t.after(()=>{globalThis.fetch=oldFetch;for(const[key,value]of[['SUPABASE_URL',oldUrl],['SUPABASE_ANON_KEY',oldKey]])if(value===undefined)delete process.env[key];else process.env[key]=value;invalidateRoleAccessCaches();});
 return calls;
}
const filters=()=>({subsidiaryIds:[24],bookId:7,dateFrom:'2026-01-01',dateTo:'2026-09-30',departmentId:4,classId:5,locationId:6,costCenterId:8,currencyId:2,hierarchy:4,excludeZero:true,page:1,pageSize:500,accountId:17});

test('LOCAL default and explicit LOCAL retain existing total and matrix RPCs',async t=>{
 const calls=await fixture(t);
 for(const presentationCurrency of [undefined,'LOCAL']){
  const input={...filters(),...(presentationCurrency?{presentationCurrency}:{})},before=structuredClone(input);
  await runAccountingReport(auth,'balance-sheet',input);assert.deepEqual(calls.at(-1).input,{p_report:'balance-sheet',p_filters:before});assert.equal(calls.at(-1).path,'/rest/v1/rpc/run_accounting_report');
  await runAccountingReport(auth,'income-statement',{...input,columnView:'TOTAL'});assert.deepEqual(calls.at(-1).input.p_filters,{...before,columnView:'TOTAL',accountId:null});assert.equal(calls.at(-1).path,'/rest/v1/rpc/run_accounting_report');
  await runAccountingReport(auth,'income-statement',{...input,columnView:'DEPARTMENT'});assert.equal(calls.at(-1).path,'/rest/v1/rpc/run_income_statement_matrix');assert.equal(calls.at(-1).input.p_filters.accountId,null);assert.deepEqual(input,before);
 }
});

test('USD total and all matrices use one protected presentation RPC without changing company, book or dimensions',async t=>{
 const response={rows:[{debit:0,credit:1}],summary:{periodResult:1},presentationCurrency:'USD',presentationCurrencyCode:'USD',localCurrencyCode:'JMD',ratesUsed:[{rate:0.00625}]};
 const calls=await fixture(t,{payload:response});
 for(const report of ['balance-sheet','income-statement'])for(const columnView of report==='balance-sheet'?['TOTAL']:['TOTAL','DEPARTMENT','CLASS','LOCATION','COST_CENTER','ACCOUNTING_PERIOD']){
  const input={...filters(),presentationCurrency:'USD',columnView},before=structuredClone(input),result=await runAccountingReport(auth,report,input),call=calls.at(-1);
  assert.deepEqual(result,response);assert.equal(call.path,'/rest/v1/rpc/run_financial_statement_presentation');assert.equal(call.authorization,auth);assert.equal(call.key,'synthetic-public-key');
  assert.deepEqual(call.input,{p_report:report,p_filters:{...before,...(report==='income-statement'?{accountId:null}:{})}});assert.equal(Object.hasOwn(call.input.p_filters,'consolidated'),false);assert.deepEqual(input,before);
 }
});

test('unknown presentation modes and USD on other reports fail before any data RPC',async t=>{
 const calls=await fixture(t);
 for(const value of ['EUR','usd','',null,1,{},[]])assert.throws(()=>runAccountingReport(auth,'balance-sheet',{...filters(),presentationCurrency:value}),error=>error.status===400);
 for(const report of ['general-ledger','journal','cash-flow','equity-changes','trial-balance','bank-balances'])assert.throws(()=>runAccountingReport(auth,report,{...filters(),presentationCurrency:'USD'}),error=>error.status===400);
 assert.equal(calls.length,0);
});

test('USD requires accounting report view, with no consolidation permission or privileged fallback',async t=>{
 const calls=await fixture(t,{allowed:false});
 await assert.rejects(runAccountingReport(auth,'balance-sheet',{...filters(),presentationCurrency:'USD'}),error=>error.status===403);
 await assert.rejects(runAccountingReport('','balance-sheet',{...filters(),presentationCurrency:'USD'}),error=>error.status===401);assert.equal(calls.length,0);
});

test('missing rates and SQL scope rejection are propagated without retrying a local report',async t=>{
 const calls=await fixture(t,{status:400,payload:{message:'Falta la tasa de conversión hacia USD para el período seleccionado.'}});
 await assert.rejects(runAccountingReport(auth,'income-statement',{...filters(),presentationCurrency:'USD'}),/Falta la tasa/);assert.equal(calls.length,1);
});

test('SQL authorization rejection retains 403 and does not invoke legacy calculation',async t=>{
 const calls=await fixture(t,{status:403,payload:{message:'Synthetic private scope detail'}});
 await assert.rejects(runAccountingReport(auth,'balance-sheet',{...filters(),presentationCurrency:'USD'}),error=>error.status===403&&!error.message.includes('private'));assert.equal(calls.length,1);
});
