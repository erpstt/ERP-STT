import assert from 'node:assert/strict';
import {test} from 'node:test';
import {primeRoleAccessCache,invalidateRoleAccessCaches} from '../dist/modules/security-catalogs/role-access-matrix.module.js';
import {customerStatement,statementSettings} from '../dist/modules/notifications/customer-statement.js';
import {requireCustomerStatementAccess} from '../dist/modules/notifications/statement-access.service.js';

test('statement services enforce read/send/settings permissions before any data or PDF call',async t=>{
 const original=globalThis.fetch;let calls=0;globalThis.fetch=async()=>{calls++;throw Error('Unexpected network');};t.after(()=>{globalThis.fetch=original;invalidateRoleAccessCaches();});
 const grant=(resourceKey,edit=false)=>({resourceKey,canView:true,canEdit:edit});
 for(const grants of [[],[grant('reports:accounting-reports')],[grant('entities:customers',true)],[grant('inventory:products')]]){
  await primeRoleAccessCache('Bearer synthetic-denied',{isAdmin:false,grants});
  for(const action of ['get','send','pdf'])await assert.rejects(customerStatement('Bearer synthetic-denied',1,action,{cutoff:'2026-10-31'}),e=>e.status===403);
 }
 await primeRoleAccessCache('Bearer synthetic-reader',{isAdmin:false,grants:[grant('reports:accounting-reports'),grant('entities:customers')]});
 await requireCustomerStatementAccess('Bearer synthetic-reader','get');await requireCustomerStatementAccess('Bearer synthetic-reader','pdf');
 await assert.rejects(customerStatement('Bearer synthetic-reader',1,'send',{cutoff:'2026-10-31'}),e=>e.status===403);
 await assert.rejects(statementSettings('Bearer synthetic-reader','get',{}),e=>e.status===403);
 await assert.rejects(customerStatement('',1,'get',{}),e=>e.status===401);assert.equal(calls,0);
});

test('statement reads and sends preserve user JWT/company and sanitize SQL denial with mocked transport',async t=>{
 const original=globalThis.fetch,env={...process.env};const calls=[];let denied=false;
 Object.assign(process.env,{SUPABASE_URL:'https://synthetic.invalid',SUPABASE_PUBLISHABLE_KEY:'synthetic-public',SUPABASE_ANON_KEY:'synthetic-public',SMTP_HOST:'smtp.invalid',SMTP_FROM:'fixture@example.invalid',EMAIL_NOTIFICATIONS_ENABLED:'true'});
 globalThis.fetch=async(url,options)=>{calls.push({url:String(url),...options});return new Response(JSON.stringify(denied?{code:'42501',message:'PRIVATE_SQL_DETAIL'}:{statement:{saldo_total:95},queued:true}),{status:denied?403:200,headers:{'Content-Type':'application/json'}});};
 t.after(()=>{globalThis.fetch=original;for(const key of Object.keys(process.env))if(!(key in env))delete process.env[key];Object.assign(process.env,env);invalidateRoleAccessCaches();});
 for(const edit of [false,true]){
  const auth='Bearer synthetic-'+edit;await primeRoleAccessCache(auth,{isAdmin:false,grants:[{resourceKey:'reports:accounting-reports',canView:true},{resourceKey:'entities:customers',canView:true,canEdit:edit}]});
  const data=await customerStatement(auth,1,'get',{cutoff:'2026-10-31',subsidiaryId:2});assert.equal(data.access.canSend,edit);
  if(edit)await customerStatement(auth,1,'send',{cutoff:'2026-10-31',subsidiaryId:2,requestId:'00000000-0000-4000-8000-000000000001',note:'Synthetic'});
 }
 assert.equal(calls.length,3);for(const c of calls){assert.equal(new Headers(c.headers).get('apikey'),'synthetic-public');assert.match(new Headers(c.headers).get('Authorization'),/^Bearer synthetic-/);assert.equal(JSON.parse(c.body).p_sid,2);assert.match(c.url,/statement_(customer|send)$/);}
 denied=true;await assert.rejects(customerStatement('Bearer synthetic-true',1,'get',{cutoff:'2026-10-31'}),e=>e.status===403&&!e.message.includes('PRIVATE_SQL_DETAIL'));
});
