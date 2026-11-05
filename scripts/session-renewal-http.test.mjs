import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';

const uid='123e4567-e89b-42d3-a456-426614174000',device='synthetic-http-device-more-than-twenty-characters';
const digest=value=>createHash('sha256').update(value).digest('hex'),encode=value=>Buffer.from(JSON.stringify(value)).toString('base64url');
const jwt=(sid,version)=>`${encode({alg:'none',typ:'JWT'})}.${encode({sub:uid,session_id:sid,exp:Math.floor(Date.now()/1000)+3600})}.signature${version}`;
const cookiePair=response=>response.headers.get('set-cookie')?.split(';')[0];
test('HTTP renewal protects cookie boundaries, origin/body limits, transient state and another login cookie',{timeout:45000},async t=>{
 let loginCount=0,version=0,providerStatus=200,providerCalls=0;const bindings=new Map(),calls=[];
 const stub=createServer(async(req,res)=>{
  const url=new URL(req.url,'http://fixture'),chunks=[];for await(const part of req)chunks.push(part);const body=JSON.parse(Buffer.concat(chunks).toString()||'{}');calls.push(url.pathname);res.setHeader('Content-Type','application/json');
  const reply=(value,status=200)=>{res.writeHead(status);res.end(JSON.stringify(value));};
  if(url.pathname==='/auth/v1/token'&&url.searchParams.get('grant_type')==='password'){
   const sid=`11111111-0000-4000-8000-${String(++loginCount).padStart(12,'0')}`,token=jwt(sid,++version);bindings.set(sid,{hash:digest(token),active:true});return reply({access_token:token,refresh_token:'synthetic-provider-refresh-secret-'+sid,user:{id:uid,email:'synthetic@example.invalid'}});
  }
  if(url.pathname==='/rest/v1/rpc/security_register_login')return reply({userId:44,expiresAt:new Date(Date.now()+900000).toISOString()});
  if(url.pathname==='/rest/v1/password_history')return reply([{history_id:1}]);
  if(url.pathname==='/rest/v1/rpc/security_prepare_session_refresh'){
   const b=bindings.get(body.p_auth_session_id);if(!b?.active)return reply({code:'42501',message:'private detail'},403);
   return reply({userId:44,sessionTokenHash:b.hash,expiresAt:new Date(Date.now()-1000).toISOString(),authNotAfter:null});
  }
  if(url.pathname==='/auth/v1/token'&&url.searchParams.get('grant_type')==='refresh_token'){
   providerCalls++;if(providerStatus!==200)return reply({message:'synthetic provider failure'},providerStatus);
   const sid=body.refresh_token.slice('synthetic-provider-refresh-secret-'.length);return reply({access_token:jwt(sid,++version),refresh_token:body.refresh_token,user:{id:uid,email:'synthetic@example.invalid'}});
  }
  if(url.pathname==='/rest/v1/rpc/security_refresh_session'){
   const b=bindings.get(body.p_auth_session_id);if(!b?.active)return reply({code:'42501'},403);if(b.hash!==body.p_expected_session_token_hash)return reply({code:'PT409'},409);b.hash=body.p_session_token_hash;return reply({userId:44,expiresAt:new Date(Date.now()+900000).toISOString()});
  }
  return reply({unexpected:true},500);
 });
 await new Promise(resolve=>stub.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>{stub.closeAllConnections();stub.close(resolve);}));
 const reservation=createServer();await new Promise(resolve=>reservation.listen(0,'127.0.0.1',resolve));const port=reservation.address().port;await new Promise(resolve=>reservation.close(resolve));
 const origin=`http://127.0.0.1:${port}`,child=spawn(process.execPath,['dist/server.js'],{cwd:process.cwd(),env:{PATH:process.env.PATH,SystemRoot:process.env.SystemRoot,NODE_ENV:'test',PORT:String(port),DISABLE_BACKGROUND_JOBS:'true',SUPABASE_URL:`http://127.0.0.1:${stub.address().port}`,SUPABASE_ANON_KEY:'public-http-fixture',SUPABASE_SERVICE_ROLE_KEY:'sb_secret_http_fixture',GENTIA_APP_URL:origin,SESSION_REFRESH_ALLOW_LOCAL_HTTP:'true',AUTH_REQUEST_ACCESS_CACHE_TTL_MS:'0',TURNSTILE_ENABLED:'false'},stdio:'ignore'});
 t.after(()=>child.kill());let ready=false;for(let n=0;n<100;n++){try{if((await fetch(origin+'/api/health')).ok){ready=true;break;}}catch{}await new Promise(resolve=>setTimeout(resolve,100));}assert.ok(ready);
 const login=async rememberMe=>fetch(origin+'/api/auth/login',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify({email:'synthetic@example.invalid',password:'synthetic-password',deviceToken:device,rememberMe})});
 let response=await login(false);assert.equal(response.status,200);const first=await response.json(),firstCookie=cookiePair(response),sid1='11111111-0000-4000-8000-000000000001';assert.ok(firstCookie.startsWith('erp-refresh-'+sid1+'='));assert.match(response.headers.get('set-cookie'),/HttpOnly; SameSite=Strict/);assert.doesNotMatch(response.headers.get('set-cookie'),/Max-Age=|Domain=/);assert.match(response.headers.get('cache-control'),/no-store/);assert.doesNotMatch(JSON.stringify(first),/refresh-secret|refreshToken|refreshCredential/);
 const headers={Origin:origin,Authorization:`Bearer ${first.accessToken}`,'X-Device-Token':device,Cookie:firstCookie,'Content-Type':'application/json'};
 const before=calls.length;
 response=await fetch(origin+'/api/auth/refresh',{method:'POST',headers:{...headers,Origin:'http://attacker.invalid'},body:'{}'});assert.equal(response.status,403);assert.equal(calls.length,before);
 response=await fetch(origin+'/api/auth/refresh',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({padding:'x'.repeat(2048)})});assert.equal(response.status,413);assert.equal(calls.length,before);
 response=await fetch(origin+'/api/auth/refresh',{method:'POST',headers,body:JSON.stringify({refresh_token:'must-not-be-accepted'})});assert.equal(response.status,400);assert.equal(calls.length,before);
 response=await fetch(origin+'/api/auth/refresh',{method:'POST',headers,body:'{}'});assert.equal(response.status,200);const renewed=await response.json(),renewedCookie=cookiePair(response);assert.notEqual(renewed.accessToken,first.accessToken);assert.doesNotMatch(JSON.stringify(renewed),/refresh-secret|refreshToken|refreshCredential/);
 providerStatus=503;response=await fetch(origin+'/api/auth/refresh',{method:'POST',headers:{...headers,Cookie:renewedCookie,Authorization:`Bearer ${renewed.accessToken}`},body:'{}'});assert.equal(response.status,503);assert.equal(response.headers.get('set-cookie'),null);providerStatus=200;
 response=await login(true);assert.equal(response.status,200);const sid2='11111111-0000-4000-8000-000000000002',secondCookie=response.headers.get('set-cookie');assert.ok(secondCookie.startsWith('erp-refresh-'+sid2+'='));assert.match(secondCookie,/Max-Age=/);assert.ok(Number(secondCookie.match(/Max-Age=(\d+)/)[1])<=30*86400);
 bindings.get(sid1).active=false;const beforeProvider=providerCalls;response=await fetch(origin+'/api/auth/logout',{method:'POST',headers:{...headers,Cookie:renewedCookie,Authorization:`Bearer ${renewed.accessToken}`},body:'{}'});assert.equal(response.status,401);assert.equal(providerCalls,beforeProvider);assert.ok(response.headers.get('set-cookie').startsWith('erp-refresh-'+sid1+'='));assert.ok(!response.headers.get('set-cookie').includes(sid2));assert.ok(bindings.get(sid2).active);
 for(const page of['/','/supplier-invoice-entry.html']){response=await fetch(origin+page);assert.equal(response.status,200,page);const html=await response.text();assert.equal((html.match(/session-renewal\.js\?v=20261105-session-renewal/g)||[]).length,1);assert.match(html.match(/<script\b[^>]*>/i)?.[0]||'',/src="\/session-renewal\.js\?v=20261105-session-renewal"/);}
});
