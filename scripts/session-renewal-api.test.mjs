import assert from 'node:assert/strict';
import {beforeEach,afterEach,test} from 'node:test';
import {createHash} from 'node:crypto';
import {assertAuthOrigin,issueSession,publicAuthSession,readRefreshCookie,readSessionHint,refreshCookieName,refreshSetCookie,clearRefreshCookie,signRefreshCookie} from '../dist/modules/auth/services/session-credentials.js';
import {renewSession,logoutSession,assertSessionRenewalRate} from '../dist/modules/auth/services/session-renewal.service.js';

const originalEnvironment=process.env,originalFetch=globalThis.fetch;
const userId='123e4567-e89b-42d3-a456-426614174000',sid='11111111-0000-4000-8000-000000000001',device='synthetic-device-with-more-than-twenty-characters',user={name:'Synthetic',email:'synthetic@example.invalid'};
const digest=value=>createHash('sha256').update(value).digest('hex');
const encode=value=>Buffer.from(JSON.stringify(value)).toString('base64url');
const token=(patch={},signature='signature')=>`${encode({alg:'none',typ:'JWT'})}.${encode({sub:userId,session_id:sid,exp:Math.floor(Date.now()/1000)+3600,...patch})}.${signature}`;
const json=(value,status=200)=>new Response(JSON.stringify(value),{status,headers:{'Content-Type':'application/json'}});
const expiry=()=>new Date(Date.now()+900000).toISOString();
let testId=0;
beforeEach(()=>{testId++;process.env={NODE_ENV:'test',SUPABASE_URL:'https://project.example.test',SUPABASE_ANON_KEY:'public-synthetic',SUPABASE_SERVICE_ROLE_KEY:'sb_secret_synthetic_renewal',GENTIA_APP_URL:'https://erp.example.test'};});
afterEach(()=>{process.env=originalEnvironment;globalThis.fetch=originalFetch;});
function request(credential,patch={}){return{headers:{authorization:`Bearer ${token({exp:Math.floor(Date.now()/1000)-600})}`,'x-device-token':device,origin:'https://erp.example.test',cookie:`${refreshCookieName(sid)}=${signRefreshCookie(credential)}`,...patch}};}
function session(rememberMe=false){return issueSession(token(),user,expiry(),'provider-original-refresh-secret',device,rememberMe);}
function mock({providerStatus=200,completeCode,providerPatch={},completeFailure,delay}={}){
 const calls=[];let current=digest('authoritative-current-binding'),sequence=0;
 globalThis.fetch=async(input,init={})=>{
  const url=new URL(String(input)),body=JSON.parse(init.body||'{}'),headers=new Headers(init.headers);calls.push({path:url.pathname,query:url.search,body,headers});
  if(url.pathname.startsWith('/rest/v1/rpc/')){assert.equal(headers.get('apikey'),'sb_secret_synthetic_renewal');assert.equal(headers.get('authorization'),null);}
  if(url.pathname.endsWith('/security_prepare_session_refresh'))return json({userId:44,sessionTokenHash:current,expiresAt:new Date(Date.now()-60000).toISOString(),authNotAfter:null});
  if(url.pathname==='/auth/v1/token'){
   assert.equal(url.search,'?grant_type=refresh_token');assert.equal(headers.get('apikey'),'public-synthetic');assert.equal(headers.get('authorization'),null);assert.equal(body.refresh_token,'provider-original-refresh-secret');
   if(delay)await delay;if(providerStatus!==200)return json({error:'synthetic rejection'},providerStatus);
   return json({access_token:token(providerPatch,'signature'+(++sequence)),refresh_token:'provider-new-refresh-secret',user:{id:userId,email:user.email}});
  }
  if(url.pathname.endsWith('/security_refresh_session')){
   assert.equal(body.p_expected_session_token_hash,current);assert.match(body.p_session_token_hash,/^[0-9a-f]{64}$/);
   if(completeCode)return json({code:completeCode,message:'private database detail'},completeCode==='PT409'?409:403);
   current=body.p_session_token_hash;if(completeFailure)await completeFailure();return json({userId:44,expiresAt:expiry()});
  }
  if(url.pathname.endsWith('/security_logout_session_binding')){assert.equal(body.p_expected_session_token_hash,current);return json(true);}
  if(url.pathname==='/auth/v1/logout'){assert.equal(url.search,'?scope=local');return new Response(null,{status:204});}
  throw Error('Unexpected synthetic request '+url.pathname);
 };
 return{calls,current:()=>current};
}

test('signed host-only cookies bind identity/device and keep refresh secrets out of public JSON',()=>{
 const value=session(),cookie=refreshSetCookie(value.refreshCredential);assert.match(cookie,/^__Host-erp-refresh-/);assert.match(cookie,/; HttpOnly; SameSite=Strict; Secure/);assert.doesNotMatch(cookie,/Domain=|Max-Age=/);
 assert.deepEqual(readRefreshCookie(request(value.refreshCredential),readSessionHint(request(value.refreshCredential).headers.authorization),device),value.refreshCredential);
 assert.doesNotMatch(JSON.stringify(publicAuthSession(value)),/provider-original|refreshCredential|refreshToken/);
 assert.equal(new Date(value.refreshAt).getTime(),Math.min(new Date(value.expiresAt).getTime(),new Date(value.erpSessionExpiresAt).getTime())-60000);
 const remembered=session(true),initial=remembered.refreshCredential;assert.match(refreshSetCookie(initial),/Max-Age=/);assert.ok(initial.cookieExpiresAt-initial.issuedAt<=30*86400000);
 const later=issueSession(token(),user,expiry(),'rotated-secret',device,true,initial,new Date(Date.now()+3600000).toISOString());assert.equal(later.refreshCredential.issuedAt,initial.issuedAt);assert.ok(later.refreshCredential.cookieExpiresAt<=initial.cookieExpiresAt);assert.ok(later.refreshCredential.cookieExpiresAt<=Date.now()+3600000);
 assert.throws(()=>issueSession(token(),user,expiry(),'rotated-secret',device,true,{...initial,cookieExpiresAt:Date.now()-1}),e=>e.status===401);
 const otherSid='11111111-0000-4000-8000-000000000002';assert.ok(!clearRefreshCookie(sid).includes(otherSid));assert.ok(clearRefreshCookie(sid).includes('Max-Age=0'));
});
test('canonical same-origin protection rejects missing/sibling origins and ignores forwarded host as authority',()=>{
 assertAuthOrigin({headers:{origin:'https://erp.example.test','x-forwarded-host':'attacker.invalid'}});
 for(const origin of[undefined,'null','https://sibling.example.test','https://erp.example.test.evil.invalid','http://erp.example.test'])assert.throws(()=>assertAuthOrigin({headers:{origin}}),e=>e.status===403);
 assert.throws(()=>assertAuthOrigin({headers:{origin:'https://erp.example.test','sec-fetch-site':'cross-site'}}),e=>e.status===403);
});
test('forged, expired, wrong-device and wrong-identity cookies perform zero provider or trusted RPC calls',async()=>{
 let calls=0;globalThis.fetch=async()=>{calls++;throw Error('No network expected');};const c=session().refreshCredential;
 const altered=request(c);altered.headers.cookie=altered.headers.cookie.slice(0,-1)+(altered.headers.cookie.endsWith('A')?'B':'A');
 const cases=[altered,request({...c,cookieExpiresAt:Date.now()-1}),request(c,{'x-device-token':device+'-other'}),request(c,{authorization:`Bearer ${token({sub:'123e4567-e89b-42d3-a456-426614174001'})}`}),request(c,{cookie:''})];
 for(const req of cases)await assert.rejects(renewSession(req,'test-invalid-'+testId),e=>e.status===401);assert.equal(calls,0);
});
test('expired access hints renew using authoritative prepare binding and fresh matching provider proof',async()=>{
 const c=session().refreshCredential,m=mock(),result=await renewSession(request(c),'test-'+testId);
 assert.equal(result.user.email,user.email);assert.equal(result.refreshCredential.refreshToken,'provider-new-refresh-secret');assert.equal(result.refreshCredential.issuedAt,c.issuedAt);
 assert.deepEqual(m.calls.map(x=>x.path.split('/').at(-1)),['security_prepare_session_refresh','token','security_refresh_session']);
 assert.equal(m.calls[0].body.p_device_token_hash,digest(device));assert.equal(m.calls[2].body.p_session_token_hash,digest(result.accessToken));assert.doesNotMatch(JSON.stringify(publicAuthSession(result)),/refresh-secret|refreshCredential/);
});
test('concurrent renewals share one provider exchange and one CAS for the same binding',async()=>{
 let release;const delay=new Promise(resolve=>{release=resolve;}),m=mock({delay}),req=request(session().refreshCredential);
 const first=renewSession(req,'test-'+testId),second=renewSession(req,'test-'+testId);release();const[a,b]=await Promise.all([first,second]);assert.equal(a.accessToken,b.accessToken);assert.equal(m.calls.length,3);
});
test('provider identity/session mismatch never completes the ERP binding',async()=>{
 const m=mock({providerPatch:{session_id:'11111111-0000-4000-8000-000000000002'}});
 await assert.rejects(renewSession(request(session().refreshCredential),'test-'+testId),e=>e.status===401);assert.equal(m.calls.length,2);
});
test('provider transient failures and CAS conflicts are classified without mutation retries or secret errors',async()=>{
 for(const[providerStatus,expected]of[[429,429],[408,503],[503,503],[409,409],[400,401]]){const m=mock({providerStatus});await assert.rejects(renewSession(request(session().refreshCredential),'test-'+testId+'-'+providerStatus),e=>e.status===expected&&!/private|refresh-secret/.test(e.message));assert.equal(m.calls.length,2);}
 let m=mock({completeCode:'PT409'});await assert.rejects(renewSession(request(session().refreshCredential),'test-'+testId+'-cas'),e=>e.status===409);assert.equal(m.calls.length,3);
 m=mock({completeCode:'42501'});await assert.rejects(renewSession(request(session().refreshCredential),'test-'+testId+'-revoked'),e=>e.status===401);assert.equal(m.calls.length,3);
});
test('lost completion response recovers through a new prepare and new provider proof instead of stale caller hash',async()=>{
 let lose=true;const m=mock({completeFailure:async()=>{if(lose){lose=false;throw Error('Synthetic lost response');}}}),req=request(session().refreshCredential);
 await assert.rejects(renewSession(req,'test-'+testId),e=>e.status===503);const persisted=m.current();const result=await renewSession(req,'test-'+testId);assert.notEqual(m.current(),persisted);assert.equal(m.current(),digest(result.accessToken));assert.equal(m.calls.length,6);
});
test('expired-lease logout requires a signed cookie plus fresh provider proof before its CAS and provider revoke',async()=>{
 const m=mock(),req=request(session().refreshCredential);assert.equal(await logoutSession(req,'test-'+testId),sid);
 assert.deepEqual(m.calls.map(x=>x.path.split('/').at(-1)),['security_prepare_session_refresh','token','security_logout_session_binding','logout']);
 assert.ok(!m.calls.some(x=>x.path.endsWith('/security_register_login')));
});
test('renewal rate limit is bounded and fails before an additional upstream operation',()=>{
 for(let n=0;n<20;n++)assertSessionRenewalRate('synthetic-rate-limit','rate-'+testId);
 assert.throws(()=>assertSessionRenewalRate('synthetic-rate-limit','rate-'+testId),e=>e.status===429&&e.retryAfterSeconds>0&&e.retryAfterSeconds<=60);
});
