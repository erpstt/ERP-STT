import assert from 'node:assert/strict';
import {test,beforeEach,afterEach,after} from 'node:test';
import {runAccountingReport} from '../dist/modules/reports/accounting-reports.service.js';
import {primeRoleAccessCache,invalidateRoleAccessCaches} from '../dist/modules/security-catalogs/role-access-matrix.module.js';

const originalFetch=globalThis.fetch,originalUrl=process.env.SUPABASE_URL,originalKey=process.env.SUPABASE_ANON_KEY;
const origin='https://payables-invoice-type.example.invalid',auth='Bearer synthetic-payables-invoice-type',key='synthetic-public-key';
const base={subsidiaryIds:[24],dateTo:'2026-10-31',onlyPending:true,page:1,pageSize:50};
const codes=['ALL','STANDARD','EXPENSE','CARD','PETTY_CASH','FIXED_ASSET','OTHER'];
let calls;
beforeEach(async()=>{
 process.env.SUPABASE_URL=origin;process.env.SUPABASE_ANON_KEY=key;calls=[];invalidateRoleAccessCaches();
 await primeRoleAccessCache(auth,{isAdmin:false,grants:[{resourceKey:'reports:accounting-reports',canView:true}]});
 globalThis.fetch=async(url,init)=>{calls.push({url:String(url),init});return Response.json({rows:[],total:0,summary:{}});};
});
afterEach(()=>{globalThis.fetch=originalFetch;invalidateRoleAccessCaches();});
after(()=>{if(originalUrl===undefined)delete process.env.SUPABASE_URL;else process.env.SUPABASE_URL=originalUrl;if(originalKey===undefined)delete process.env.SUPABASE_ANON_KEY;else process.env.SUPABASE_ANON_KEY=originalKey;});

test('AP forwards the five canonical types, ALL and the defensive OTHER without mutating filters or caller identity',async()=>{
 for(const payableInvoiceType of codes){
  const source={...base,payableInvoiceType},prior=structuredClone(source);await runAccountingReport(auth,'payables-aging',source);assert.deepEqual(source,prior);
  const call=calls.at(-1),headers=new Headers(call.init.headers);assert.equal(call.url,origin+'/rest/v1/rpc/run_aging_report');assert.equal(call.init.method,'POST');assert.equal(headers.get('Authorization'),auth);assert.equal(headers.get('apikey'),key);assert.deepEqual(JSON.parse(call.init.body),{p_kind:'AP',p_filters:prior});
 }
 assert.equal(calls.length,codes.length);
});

test('AP preserves the legacy absent filter and normalizes empty/default values explicitly supplied by clients',async()=>{
 await runAccountingReport(auth,'payables-aging',base);assert.deepEqual(JSON.parse(calls.at(-1).init.body),{p_kind:'AP',p_filters:base});
 for(const value of[null,undefined,'','  ',' all ',' standard ','expense','card','petty_cash','fixed_asset','other']){
  const source={...base,payableInvoiceType:value};await runAccountingReport(auth,'payables-aging',source);
  const normalized=typeof value==='string'?value.trim().toUpperCase()||'ALL':'ALL';assert.equal(JSON.parse(calls.at(-1).init.body).p_filters.payableInvoiceType,normalized);assert.equal(source.payableInvoiceType,value);
 }
});

test('unsupported, malformed and SQL-like AP filters are rejected before querying the provider',async()=>{
 for(const payableInvoiceType of[0,true,[],{},['STANDARD'],'Factura estándar','OPENING','STANDARD,EXPENSE',"STANDARD');drop table supplier_invoice;--"]){
  await assert.rejects(runAccountingReport(auth,'payables-aging',{...base,payableInvoiceType}),error=>error.status===400&&/tipo de factura válido/.test(error.message));
 }
 assert.equal(calls.length,0);
});

test('AP permission and anonymous session checks precede malformed filter validation',async()=>{
 await assert.rejects(runAccountingReport('','payables-aging',{...base,payableInvoiceType:{}}),error=>error.status===401);
 await primeRoleAccessCache(auth,{isAdmin:false,grants:[]});await assert.rejects(runAccountingReport(auth,'payables-aging',{...base,payableInvoiceType:{}}),error=>error.status===403);
 assert.equal(calls.length,0);
});

test('AR drops any stale AP-only selector and preserves the receivables request and its filters',async()=>{
 for(const payableInvoiceType of['EXPENSE',{},null]){
  const source={...base,payableInvoiceType},prior=structuredClone(source);await runAccountingReport(auth,'receivables-aging',source);assert.deepEqual(source,prior);assert.deepEqual(JSON.parse(calls.at(-1).init.body),{p_kind:'AR',p_filters:base});
 }
});

test('type filtering keeps original/local/consolidated presentation, supplier and complete-export pagination intact',async()=>{
 for(const[agingCurrencyMode,consolidated]of[['LOCAL',false],['ORIGINAL',false],['LOCAL',true]]){
  const source={...base,payableInvoiceType:'CARD',agingCurrencyMode,consolidated,agingEntityId:7,supplierCategory:'SYNTHETIC',page:3,pageSize:250};
  await runAccountingReport(auth,'payables-aging',source);assert.deepEqual(JSON.parse(calls.at(-1).init.body),{p_kind:'AP',p_filters:source});
 }
});
