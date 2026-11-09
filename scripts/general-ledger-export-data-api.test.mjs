import assert from 'node:assert/strict';
import {test,beforeEach,afterEach,after} from 'node:test';
import {collectGeneralLedgerExportData} from '../dist/modules/reports/general-ledger-export-data.service.js';
import {primeRoleAccessCache,invalidateRoleAccessCaches} from '../dist/modules/security-catalogs/role-access-matrix.module.js';
const auth='Bearer synthetic-general-ledger-export-reader',origin='https://ledger-export.example.invalid',key='synthetic-public-key';
const original={fetch:globalThis.fetch,url:process.env.SUPABASE_URL,key:process.env.SUPABASE_ANON_KEY};
const base={subsidiaryIds:[24],dateFrom:'2026-10-01',dateTo:'2026-10-31'};
const normalized={...base,bookId:null,accountId:null,accountIds:[],accountFrom:null,accountTo:null,entityType:null,entityId:null,costCenterId:null};
const row={id:11,account_id:95,account_number:'214006',account_name:'Synthetic payable',nature:'Acreedora',date:'2026-10-15',transaction_number:'SYN-1',transaction_type:'Asiento de Diario',journal_id:10,journal_number:'SYN-J1',entity_name:'Synthetic supplier',cost_center:'Synthetic center',concept:'Synthetic stored note',debit:0,credit:159.674,running_balance:259.674,opening_balance:100,account_debit_total:0,account_credit_total:159.674,account_final_balance:259.674,original_currency_code:'USD',original_exchange_rate:159.674,original_debit:0,original_credit:1};
const fixture=()=>({rows:[structuredClone(row)],total:1,summary:{debit:0,credit:159.674},snapshotFingerprint:'a'.repeat(32),context:{subsidiary:{id:24,name:'Synthetic selected company'},localCurrency:{id:5,code:'JMD',name:'Jamaican dollar'},book:null,bookId:null,dateFrom:base.dateFrom,dateTo:base.dateTo,filters:structuredClone(normalized),generatedAt:'2026-11-09T20:00:00.000Z'}});
let calls,payload;
beforeEach(async()=>{
 process.env.SUPABASE_URL=origin;process.env.SUPABASE_ANON_KEY=key;calls=[];payload=fixture();invalidateRoleAccessCaches();
 await primeRoleAccessCache(auth,{isAdmin:false,grants:[{resourceKey:'reports:accounting-reports',canView:true,canCreate:false,canEdit:false,canDelete:false}]});
 globalThis.fetch=async(url,init)=>{calls.push({url:String(url),init});return Response.json(payload);};
});
afterEach(()=>{globalThis.fetch=original.fetch;invalidateRoleAccessCaches();});
after(()=>{for(const[name,field]of [['SUPABASE_URL','url'],['SUPABASE_ANON_KEY','key']])if(original[field]===undefined)delete process.env[name];else process.env[name]=original[field];});

test('one complete read RPC preserves caller authorization and the anonymous key without pagination or client data',async()=>{
 const input=structuredClone(base),expected=structuredClone(payload),result=await collectGeneralLedgerExportData(auth,input);
 assert.deepEqual(input,base);assert.deepEqual(result,expected);assert.equal(calls.length,1);
 const call=calls[0],headers=new Headers(call.init.headers);assert.equal(call.url,origin+'/rest/v1/rpc/run_general_ledger_export');assert.equal(call.init.method,'POST');assert.equal(headers.get('Authorization'),auth);assert.equal(headers.get('apikey'),key);assert.deepEqual(JSON.parse(call.init.body),{p_filters:normalized});
});

test('all canonical filters normalize IDs and blanks while the trusted result can use an authorized non-active company',async()=>{
 const input={...base,subsidiaryIds:['24'],bookId:'30',accountId:'95',accountIds:['95','96'],accountFrom:'214001',accountTo:'214999',entityType:'Proveedor',entityId:'8',costCenterId:'62'},cleaned={...input,subsidiaryIds:[24],bookId:30,accountId:95,accountIds:[95,96],entityId:8,costCenterId:62};
 payload.context.book={id:30,name:'Synthetic selected book'};payload.context.bookId=30;payload.context.filters=cleaned;
 assert.deepEqual(await collectGeneralLedgerExportData(auth,input),payload);assert.deepEqual(JSON.parse(calls[0].init.body),{p_filters:cleaned});
 payload=fixture();await collectGeneralLedgerExportData(auth,{...base,bookId:'',accountId:'',accountIds:null,accountFrom:'',accountTo:'',entityType:'',entityId:'',costCenterId:''});assert.deepEqual(JSON.parse(calls[1].init.body),{p_filters:normalized});
});

test('scope, real calendar dates and unexpected fields fail before provider data access',async()=>{
 const cases=[null,[],{},...[
  {subsidiaryIds:[]},{subsidiaryIds:[24,25]},{subsidiaryIds:[true]},{subsidiaryIds:['01']},{bookId:0},{entityId:'1e2'},{accountIds:'1'},{accountIds:[false]},
  {dateFrom:'2026-02-30'},{dateTo:'2026-11-31'},{dateTo:'0000-01-01'},{dateTo:'2026-10-31T00:00:00Z'},{dateFrom:'2026-11-01'},
  {accountFrom:1},{entityType:{}},{page:1},{pageSize:500},{departmentId:1},{currencyId:10},{presentationCurrency:'USD'},{rows:[row]},{html:'<html>'},{format:'pdf'},
 ].map(patch=>({...base,...patch}))];
 for(const input of cases)await assert.rejects(collectGeneralLedgerExportData(auth,input),e=>e.status===400);
 assert.equal(calls.length,0);
});

test('authorization takes priority over malformed export inputs and no denied role can probe the provider',async()=>{
 await assert.rejects(collectGeneralLedgerExportData('',{html:'ignored'}),e=>e.status===401);
 await primeRoleAccessCache(auth,{isAdmin:false,grants:[]});await assert.rejects(collectGeneralLedgerExportData(auth,null),e=>e.status===403);assert.equal(calls.length,0);
});

test('the complete snapshot is not capped at 500 and a partial or duplicate row response is rejected',async()=>{
 payload.rows=Array.from({length:1201},(_,index)=>({...row,id:index+1}));payload.total=1201;assert.equal((await collectGeneralLedgerExportData(auth,base)).rows.length,1201);
 payload.rows=payload.rows.slice(0,500);await assert.rejects(collectGeneralLedgerExportData(auth,base),e=>e.status===502);
 payload=fixture();payload.rows=[row,{...row}];payload.total=2;await assert.rejects(collectGeneralLedgerExportData(auth,base),e=>e.status===502);
 payload=fixture();payload.rows=[];payload.total=0;payload.summary={debit:0,credit:0};assert.equal((await collectGeneralLedgerExportData(auth,base)).total,0);
});

test('four original columns preserve precision, zero and NULL instead of reconstructing native amounts',async()=>{
 payload.rows[0].original_exchange_rate=159.674123456789;payload.rows[0].original_credit=1.234299;payload.rows[0].original_debit=0;
 const first=await collectGeneralLedgerExportData(auth,base);assert.equal(first.rows[0].original_exchange_rate,159.674123456789);assert.equal(first.rows[0].original_credit,1.234299);assert.equal(first.rows[0].original_debit,0);
 for(const k of ['original_currency_code','original_exchange_rate','original_debit','original_credit'])payload.rows[0][k]=null;
 assert.deepEqual((await collectGeneralLedgerExportData(auth,base)).rows[0],payload.rows[0]);
});

test('context, counts, fingerprints, dates and finite financial data must be complete and coherent',async()=>{
 const mutations=[
  d=>{delete d.rows;},d=>{d.total=2;},d=>{d.snapshotFingerprint='not-a-fingerprint';},d=>{d.context.subsidiary.id=25;},d=>{d.context.bookId=30;},d=>{d.context.book={id:30,name:'Foreign'};},
  d=>{d.context.dateTo='2026-11-30';},d=>{d.context.generatedAt='not-a-date';},d=>{d.context.filters.entityId=999;},d=>{d.context.localCurrency.id=true;},
  d=>{d.rows[0].id=true;},d=>{d.rows[0].date='2026-10-32';},d=>{d.rows[0].date='2026-09-30';},d=>{d.rows[0].credit='Infinity';},d=>{delete d.rows[0].original_credit;},d=>{d.rows[0].original_debit='NaN';},
 ];
 for(const change of mutations){payload=fixture();change(payload);await assert.rejects(collectGeneralLedgerExportData(auth,base),e=>e.status===502);}
});

test('provider failures retain permission priority and never expose SQL details or a fake complete file',async()=>{
 for(const[http,code,status]of [[401,'42501',401],[403,'42501',403],[400,'42501',403],[400,'22023',400],[400,'22P02',400],[500,'57014',504],[500,'XX000',500]]){
  globalThis.fetch=async()=>Response.json({code,message:'PRIVATE SQL and account data',details:'PRIVATE detail',hint:'PRIVATE hint'},{status:http});
  await assert.rejects(collectGeneralLedgerExportData(auth,base),e=>e.status===status&&!/PRIVATE|XX000|57014|42501/.test(e.message));
 }
 for(const body of ['not JSON','null','[]','{}']){globalThis.fetch=async()=>new Response(body,{status:200});await assert.rejects(collectGeneralLedgerExportData(auth,base),e=>e.status===502);}
});
