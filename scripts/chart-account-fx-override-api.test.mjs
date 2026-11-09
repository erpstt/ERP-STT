import '../dist/modules/security-catalogs/role-access-matrix.module.js';
import assert from'node:assert/strict';import{test,beforeEach,afterEach,after}from'node:test';
import{getAccountingCatalog,createAccountingRow,updateAccountingRow,listAccountingRows}from'../dist/modules/accounting-catalogs/accounting-catalogs.module.js';
const auth='Bearer synthetic-chart-fx-editor',origin='https://chart-fx.example.invalid',key='synthetic-public',catalog=getAccountingCatalog('chart-accounts');
const original={fetch:globalThis.fetch,url:process.env.SUPABASE_URL,key:process.env.SUPABASE_ANON_KEY};
const base={account_group_id:9,account_name:'Synthetic monetary account',level:4,nature:'Acreedora',financial_statement:'Balance General',category:'Pasivo',cash_flow_activity:'OPERACION',accepts_entries:true,full_ifrs_only:false,pending_fx_revaluation:true,is_inactive:false,subsidiary_ids:[1,2,2]};let calls;
beforeEach(()=>{process.env.SUPABASE_URL=origin;process.env.SUPABASE_ANON_KEY=key;calls=[];globalThis.fetch=async(url,init)=>{calls.push({url:String(url),init});const body=JSON.parse(init.body);return Response.json({account_id:body.p_account_id??77,...body.p_payload,subsidiary_ids:body.p_subsidiary_ids});};});
afterEach(()=>{globalThis.fetch=original.fetch;});after(()=>{for(const[name,field]of[['SUPABASE_URL','url'],['SUPABASE_ANON_KEY','key']])if(original[field]===undefined)delete process.env[name];else process.env[name]=original[field];});
test('create and edit preserve explicit false, true and reset-to-group null without forwarding the derived flag',async()=>{
 for(const selected of[false,true,null])for(const id of[null,55]){const input={...base,account_number:'FORGED',pending_fx_revaluation_override:selected},copy=structuredClone(input);const result=id===null?await createAccountingRow(catalog,auth,input):await updateAccountingRow(catalog,auth,id,input);assert.deepEqual(input,copy);assert.equal(result.pending_fx_revaluation_override,selected);const call=calls.at(-1),headers=new Headers(call.init.headers),body=JSON.parse(call.init.body);assert.equal(call.url,origin+'/rest/v1/rpc/save_chart_account_catalog');assert.equal(call.init.method,'POST');assert.equal(headers.get('Authorization'),auth);assert.equal(headers.get('apikey'),key);assert.equal(body.p_account_id,id);assert.deepEqual(body.p_subsidiary_ids,[1,2]);assert.equal(body.p_payload.pending_fx_revaluation_override,selected);assert.equal(Object.hasOwn(body.p_payload,'pending_fx_revaluation'),false);assert.equal(Object.hasOwn(body.p_payload,'account_number'),false);}
});
test('an omitted choice remains omitted for new accounts and edits including legacy echoes of the effective value',async()=>{
 for(const id of[null,55])for(const legacy of[true,false,undefined]){const input={...base,pending_fx_revaluation:legacy};if(id===null)await createAccountingRow(catalog,auth,input);else await updateAccountingRow(catalog,auth,id,input);const body=JSON.parse(calls.at(-1).init.body);assert.equal(Object.hasOwn(body.p_payload,'pending_fx_revaluation_override'),false);assert.equal(Object.hasOwn(body.p_payload,'pending_fx_revaluation'),false);}
});
test('invalid override types cannot reach the protected save RPC',async()=>{
 for(const value of['false','true','',0,1,[],{},undefined])await assert.rejects(updateAccountingRow(catalog,auth,55,{...base,pending_fx_revaluation_override:value}),e=>e.status===400);assert.equal(calls.length,0);
});
test('the chart list preserves nullable manual choice and effective booleans exactly as returned by the catalog RPC',async()=>{
 const rows=[{account_id:1,pending_fx_revaluation:true,pending_fx_revaluation_override:null},{account_id:2,pending_fx_revaluation:false,pending_fx_revaluation_override:false},{account_id:3,pending_fx_revaluation:true,pending_fx_revaluation_override:true}];
 for(const envelope of[rows,{rows},{accounts:rows}]){globalThis.fetch=async(url,init)=>{assert.equal(String(url),origin+'/rest/v1/rpc/chart_accounts_catalog');assert.equal(new Headers(init.headers).get('Authorization'),auth);return Response.json(envelope);};assert.deepEqual(await listAccountingRows(catalog,auth),rows);}
});
test('group editing keeps its existing effective default and does not receive the account-only override',async()=>{
 const group=getAccountingCatalog('account-groups');globalThis.fetch=async(url,init)=>{const body=JSON.parse(init.body);calls.push({url:String(url),init});return Response.json([body]);};const result=await updateAccountingRow(group,auth,9,{group_code:'214',group_name:'Synthetic liabilities',level:3,nature:'Acreedora',financial_statement:'Balance General',category:'Pasivo',pending_fx_revaluation:true,pending_fx_revaluation_override:false});assert.equal(result.pending_fx_revaluation,true);assert.equal(Object.hasOwn(result,'pending_fx_revaluation_override'),false);assert.match(calls.at(-1).url,/\/account_group\?/);
});
test('Node save and reload preserve the choice through the actual guarded RPC and inheritance triggers',async t=>{
 globalThis.fetch=original.fetch;
 const{setupChartAccountFxOverrideFixture,assumeSecurityUser}=await import('./fixtures/setup-chart-account-fx-override.mjs');
 const fixture=await setupChartAccountFxOverrideFixture();t.after(()=>fixture.db.close());await assumeSecurityUser(fixture.db,1,1,1);
 const input={...fixture.basePayload,subsidiary_ids:[fixture.ids.subsidiaryId]},requests=[];
 globalThis.fetch=async(url,init)=>{
  const path=new URL(String(url)).pathname,headers=new Headers(init.headers),body=JSON.parse(init.body);assert.equal(headers.get('Authorization'),auth);assert.equal(headers.get('apikey'),key);requests.push({path,body});
  try{let result;if(path==='/rest/v1/rpc/save_chart_account_catalog')result=await fixture.db.query('select public.save_chart_account_catalog($1,$2,$3::bigint[]) result',[body.p_account_id,body.p_payload,body.p_subsidiary_ids]);else{assert.equal(path,'/rest/v1/rpc/chart_accounts_catalog');result=await fixture.db.query('select public.chart_accounts_catalog() result');}return Response.json(result.rows[0].result);}catch(error){return Response.json({code:error.code,message:error.message},{status:error.code==='42501'?403:400});}
 };
 let saved=await updateAccountingRow(catalog,auth,fixture.ids.accountId,{...input,pending_fx_revaluation_override:false});assert.equal(saved.pending_fx_revaluation,false);assert.equal(saved.pending_fx_revaluation_override,false);
 let reloaded=(await listAccountingRows(catalog,auth)).find(r=>r.account_id===fixture.ids.accountId);assert.equal(reloaded.pending_fx_revaluation,false);assert.equal(reloaded.pending_fx_revaluation_override,false);
 saved=await updateAccountingRow(catalog,auth,fixture.ids.accountId,{...input,account_name:'Synthetic unrelated name edit',pending_fx_revaluation:true});assert.equal(saved.pending_fx_revaluation,false);assert.equal(saved.pending_fx_revaluation_override,false);
 saved=await updateAccountingRow(catalog,auth,fixture.ids.accountId,{...input,pending_fx_revaluation_override:null});assert.equal(saved.pending_fx_revaluation,true);assert.equal(saved.pending_fx_revaluation_override,null);
 reloaded=(await listAccountingRows(catalog,auth)).find(r=>r.account_id===fixture.ids.accountId);assert.equal(reloaded.pending_fx_revaluation,true);assert.equal(reloaded.pending_fx_revaluation_override,null);assert.equal(requests.filter(r=>r.path.endsWith('/save_chart_account_catalog')).length,3);
});
