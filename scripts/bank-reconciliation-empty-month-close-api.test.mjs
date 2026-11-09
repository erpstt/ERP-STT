import assert from'node:assert/strict';
import{test,beforeEach,afterEach,after}from'node:test';
import{bankReconciliationAction,accountingReportOptions,invalidateAccountingReportOptionsCache}from'../dist/modules/reports/accounting-reports.service.js';
import{reconciliationRpc}from'../dist/modules/banking-catalogs/bank-reconciliation-security.service.js';
import{primeRoleAccessCache,invalidateRoleAccessCaches}from'../dist/modules/security-catalogs/role-access-matrix.module.js';
const auth='Bearer synthetic-empty-month-editor',other='Bearer synthetic-empty-month-reader',origin='https://empty-month.example.invalid',key='synthetic-public',input={p_bank_account_id:5,p_cutoff:'2026-10-31',p_bank_adjustments:0};
const previous={fetch:globalThis.fetch,url:process.env.SUPABASE_URL,key:process.env.SUPABASE_ANON_KEY};
const rights=(edit=true)=>({isAdmin:false,grants:[{resourceKey:'banking:bank-reconciliations',canView:true,canCreate:false,canEdit:edit,canDelete:false},{resourceKey:'reports:accounting-reports',canView:true,canCreate:false,canEdit:false,canDelete:false}]});let calls,optionReads;
beforeEach(async()=>{process.env.SUPABASE_URL=origin;process.env.SUPABASE_ANON_KEY=key;calls=[];optionReads=0;invalidateRoleAccessCaches();invalidateAccountingReportOptionsCache();await primeRoleAccessCache(auth,rights());await primeRoleAccessCache(other,rights(false));globalThis.fetch=async(url,init)=>{calls.push({url:String(url),init});return String(url).endsWith('/accounting_report_options_bundle')?Response.json({version:++optionReads}):Response.json(91);};});
afterEach(()=>{globalThis.fetch=previous.fetch;invalidateRoleAccessCaches();invalidateAccountingReportOptionsCache();});
after(()=>{for(const[name,field]of[['SUPABASE_URL','url'],['SUPABASE_ANON_KEY','key']])if(previous[field]===undefined)delete process.env[name];else process.env[name]=previous[field];});

test('closing an empty month forwards only its exact account, cutoff and zero adjustments under the caller identity',async()=>{
 const source=structuredClone(input);assert.equal(await bankReconciliationAction(auth,'close',source),91);assert.deepEqual(source,input);assert.equal(calls.length,1);
 const call=calls[0],headers=new Headers(call.init.headers);assert.equal(call.url,origin+'/rest/v1/rpc/close_bank_reconciliation');assert.equal(call.init.method,'POST');assert.equal(headers.get('Authorization'),auth);assert.equal(headers.get('apikey'),key);assert.deepEqual(JSON.parse(call.init.body),input);
});
test('anonymous and read-only callers cannot invoke the closing provider',async()=>{
 await assert.rejects(bankReconciliationAction('','close',input),e=>e.status===401);await assert.rejects(bankReconciliationAction(other,'close',input),e=>e.status===403);assert.equal(calls.length,0);
});
test('five no-movement closing failures have safe actionable messages and never expose provider details',async()=>{
 for(const[code,pattern]of[['PBN01',/saldo único.*mes anterior/],['PBN02',/movimientos.*período/],['PBN03',/último día.*período contable abierto/],['PBN04',/saldos no coinciden.*tránsito/],['PBN05',/no admite ajustes/]]){
  let attempts=0;globalThis.fetch=async()=>{attempts++;return Response.json({code,message:'PRIVATE SQL bank/actor',details:'PRIVATE row',hint:'PRIVATE hint'},{status:400});};
  await assert.rejects(bankReconciliationAction(auth,'close',input),e=>e.status===422&&pattern.test(e.message)&&!/PRIVATE|SQL|PBN/.test(e.message));assert.equal(attempts,1);
 }
});
test('no-movement closing messages cannot replace errors from other banking operations',async()=>{
 for(const code of['PBN01','PBN02','PBN03','PBN04','PBN05']){globalThis.fetch=async()=>Response.json({code,message:'PRIVATE detail'},{status:400});await assert.rejects(reconciliationRpc(auth,'auto_match_bank_reconciliation',{p_bank_account_id:5,p_cutoff:input.p_cutoff},'banking:bank-reconciliations','edit'),e=>e.status===422&&e.message==='Revise los datos de la conciliación o extracto.');}
});
test('session, authorization and protected-state errors retain priority over domain errors',async()=>{
 for(const[http,code,status,pattern]of[[401,'PBN01',401,/sesión/],[403,'PBN02',403,/permiso/],[400,'42501',403,/permiso/],[400,'55000',409,/protegido/],[400,'XX000',422,/Revise los datos/]]){globalThis.fetch=async()=>Response.json({code,message:'PRIVATE detail'},{status:http});await assert.rejects(bankReconciliationAction(auth,'close',input),e=>e.status===status&&pattern.test(e.message)&&!e.message.includes('PRIVATE'));}
});
test('a successful close refreshes every cached history while a rejected close preserves its snapshot',async()=>{
 for(const token of[auth,other]){await accountingReportOptions(token);await accountingReportOptions(token);}assert.equal(optionReads,2);await bankReconciliationAction(auth,'close',input);for(const token of[auth,other])await accountingReportOptions(token);assert.equal(optionReads,4);
 const successFetch=globalThis.fetch;let attempts=0;globalThis.fetch=async(url,init)=>String(url).endsWith('/accounting_report_options_bundle')?successFetch(url,init):(attempts++,Response.json({code:'PBN02',message:'PRIVATE detail'},{status:400}));await assert.rejects(bankReconciliationAction(auth,'close',input),e=>e.status===422);assert.equal(attempts,1);for(const token of[auth,other])await accountingReportOptions(token);assert.equal(optionReads,4);
});
