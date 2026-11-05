import assert from 'node:assert/strict';
import {test} from 'node:test';
import {PGlite} from '@electric-sql/pglite';
import {setupSessionTokenRenewal,applySessionTokenRenewal,hash,authSession} from './fixtures/setup-session-token-renewal.mjs';
import {assertIsolatedTestArgs} from './lib/migration-preview.mjs';
import {renewSession,logoutSession} from '../dist/modules/auth/services/session-renewal.service.js';
import {refreshCookieName,signRefreshCookie,publicAuthSession} from '../dist/modules/auth/services/session-credentials.js';

assertIsolatedTestArgs();

test('real backend and SQL renew the same binding after a lost response, preserve context and enforce logout', {timeout:60000}, async t => {
 const db=new PGlite(),originalFetch=globalThis.fetch,originalEnvironment={...process.env};
 t.after(async()=>{globalThis.fetch=originalFetch;process.env={...originalEnvironment};await db.close();});
 await setupSessionTokenRenewal(db);await applySessionTokenRenewal(db);
 const origin='https://session-integration.example.invalid',user='123e4567-e89b-42d3-a456-426614174000',sid=authSession(1),device='synthetic-integration-device-long-enough';
 const key='sb_secret_synthetic_session_integration',email='integration@example.invalid';
 Object.assign(process.env,{NODE_ENV:'test',GENTIA_APP_URL:'https://erp-integration.example.invalid',SUPABASE_URL:origin,SUPABASE_ANON_KEY:'synthetic-public',SUPABASE_PUBLISHABLE_KEY:'synthetic-public',SUPABASE_SERVICE_ROLE_KEY:key});
 const expiresAt=Math.floor(Date.now()/1000)+3600;
 const token=n=>'header.'+Buffer.from(JSON.stringify({sub:user,session_id:sid,email,exp:expiresAt,jti:'synthetic-'+n})).toString('base64url')+'.signature';
 const initialToken=token(0),initialRefresh='synthetic-refresh-0',now=Date.now();
 await db.query('update users set auth_user_id=$1 where user_id=1',[user]);
 await db.query('update auth.sessions set user_id=$1 where id=$2',[user,sid]);
 await db.query('update devices set device_token=$1 where user_id=1',[hash(device)]);
 await db.query("update sessions set session_token=$1,expires_at=clock_timestamp()-interval'1 hour'where user_id=1",[hash(initialToken)]);
 const snapshot=async()=>({
  sessions:(await db.query('select session_id,user_id,auth_session_id,device_id,created_at,revoked_at from sessions order by session_id')).rows,
  devices:(await db.query('select * from devices order by device_id')).rows,
  roles:(await db.query('select * from user_role_sessions order by user_id,session_id')).rows,
  companies:(await db.query('select * from user_company_sessions order by user_id,session_id')).rows,
  history:(await db.query('select * from login_history order by history_id')).rows
 });
 const before=await snapshot();
 const credential={version:1,authUserId:user,authSessionId:sid,deviceHash:hash(device),refreshToken:initialRefresh,rememberMe:false,issuedAt:now,cookieExpiresAt:now+30*86400000};
 const request=(accessToken,proof)=>({headers:{authorization:'Bearer '+accessToken,'x-device-token':device,cookie:refreshCookieName(sid)+'='+signRefreshCookie(proof)}});
 const initialRequest=request(initialToken,credential),calls=[];let rotation=0,currentRefresh=initialRefresh,previousRefresh=null;
 globalThis.fetch=async(input,init={})=>{
  const url=new URL(String(input)),headers=new Headers(init.headers),body=init.body?JSON.parse(init.body):null;
  assert.equal(url.origin,origin,'No external provider is reachable');
  assert.equal(init.method,'POST');calls.push(url.pathname);
  if(url.pathname==='/auth/v1/token'){
   assert.equal(url.searchParams.get('grant_type'),'refresh_token');assert.equal(headers.get('apikey'),'synthetic-public');
   assert.equal(headers.get('authorization'),null);assert.ok([currentRefresh,previousRefresh].includes(body.refresh_token),'Provider accepts current credential or its direct parent after a lost response');
   previousRefresh=currentRefresh;currentRefresh='synthetic-refresh-'+(++rotation);
   return Response.json({access_token:token(rotation),refresh_token:currentRefresh,user:{id:user,email}});
  }
  if(url.pathname==='/auth/v1/logout'){
   assert.equal(url.searchParams.get('scope'),'local');assert.equal(headers.get('authorization'),'Bearer '+token(rotation));return Response.json(true);
  }
  assert.equal(headers.get('apikey'),key);
  const operations={
   '/rest/v1/rpc/security_prepare_session_refresh':['select security_prepare_session_refresh($1,$2,$3) value',['p_auth_user_id','p_auth_session_id','p_device_token_hash']],
   '/rest/v1/rpc/security_refresh_session':['select security_refresh_session($1,$2,$3,$4,$5,$6) value',['p_auth_user_id','p_auth_session_id','p_device_token_hash','p_expected_session_token_hash','p_session_token_hash','p_expires_at']],
   '/rest/v1/rpc/security_logout_session_binding':['select security_logout_session_binding($1,$2,$3,$4) value',['p_auth_user_id','p_auth_session_id','p_device_token_hash','p_expected_session_token_hash']]
  };
  const operation=operations[url.pathname];assert.ok(operation,'Only the three reviewed RPCs may run');
  assert.deepEqual(Object.keys(body).sort(),[...operation[1]].sort());
  await db.exec('set role service_role');
  try{return Response.json((await db.query(operation[0],operation[1].map(name=>body[name]))).rows[0].value);}
  catch(cause){return Response.json({code:cause.code,message:'Synthetic SQL refusal'}, {status:cause.code==='PT409'?409:403});}
  finally{await db.exec('reset role');}
 };
 const allowed=async accessToken=>{
  await db.query("select set_config('request.jwt.claims',$1,false),set_config('request.headers',$2,false)",[JSON.stringify({sub:user,session_id:sid}),JSON.stringify({'x-erp-device-hash':hash(device)})]);
  await db.exec('set role authenticated');
  try{return (await db.query('select assert_request_access($1,$2) value',[hash(accessToken),hash(device)])).rows[0].value.allowed;}
  finally{await db.exec('reset role');}
 };
 assert.equal(await allowed(initialToken),false);
 const first=await renewSession(initialRequest,'127.0.0.1');
 assert.equal(first.accessToken,token(1));assert.ok(Date.parse(first.refreshAt)<=Date.parse(first.erpSessionExpiresAt)-60000);
 assert.ok(Date.parse(first.erpSessionExpiresAt)<Date.parse(first.expiresAt)-30*60000,'ERP lease remains 15min despite 1h JWT');
 assert.equal(await allowed(first.accessToken),true);assert.equal(await allowed(initialToken),false);assert.deepEqual(await snapshot(),before);
 assert.equal(JSON.stringify(publicAuthSession(first)).includes('synthetic-refresh-'),false);
 // The first HTTP response is lost, so both caller JWT and cookie are still old.
 const recovered=await renewSession(initialRequest,'127.0.0.1');
 assert.equal(recovered.accessToken,token(2));assert.equal(await allowed(recovered.accessToken),true);assert.equal(await allowed(first.accessToken),false);assert.deepEqual(await snapshot(),before);
 assert.equal(recovered.refreshCredential.cookieExpiresAt,credential.cookieExpiresAt);
 await logoutSession(request(initialToken,recovered.refreshCredential),'127.0.0.1');
 assert.equal(await allowed(recovered.accessToken),false);
 const providerCalls=calls.filter(path=>path==='/auth/v1/token').length;
 await assert.rejects(renewSession(request(initialToken,recovered.refreshCredential),'127.0.0.1'),cause=>cause.status===401);
 assert.equal(calls.filter(path=>path==='/auth/v1/token').length,providerCalls,'Revoked ERP binding fails before provider renewal');
 const after=await snapshot();assert.equal(after.sessions.length,before.sessions.length);assert.deepEqual(after.devices,before.devices);assert.deepEqual(after.history,before.history);
 assert.deepEqual(after.sessions.filter(s=>s.user_id!==1),before.sessions.filter(s=>s.user_id!==1));
 assert.equal(after.roles.filter(r=>r.user_id===1&&r.session_id===sid).length,0);assert.equal(after.companies.filter(r=>r.user_id===1&&r.session_id===sid).length,0);
});
