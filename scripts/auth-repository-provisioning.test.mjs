import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';

const originalFetch=globalThis.fetch,originalEnvironment={...process.env};
const json=(value,status=200)=>new Response(JSON.stringify(value),{status,headers:{'Content-Type':'application/json'}});
const encode=value=>Buffer.from(JSON.stringify(value)).toString('base64url');
const accessToken=`${encode({alg:'none',typ:'JWT'})}.${encode({sub:'123e4567-e89b-42d3-a456-426614174000',session_id:'11111111-0000-4000-8000-000000000001',email:'persona@example.com',exp:Math.floor(Date.now()/1000)+3600})}.signature`;
const deviceHash=value=>createHash('sha256').update(value).digest('hex');

test.afterEach(()=>{globalThis.fetch=originalFetch;process.env={...originalEnvironment};});

test('login valida identidad ERP mediante registro exclusivo del servidor',async()=>{
  process.env.SUPABASE_URL='https://project.example.test';
  process.env.SUPABASE_ANON_KEY='anon';
  process.env.SUPABASE_SERVICE_ROLE_KEY='sb_secret_synthetic';
  const requests=[];
  globalThis.fetch=async(input,init={})=>{
    const url=new URL(String(input)),method=init.method??'GET';
    requests.push({url:url.toString(),method,body:init.body,headers:init.headers});
    if(url.pathname==='/auth/v1/token')return json({access_token:accessToken,refresh_token:'synthetic-refresh-login-only',user:{id:'123e4567-e89b-42d3-a456-426614174000',email:'persona@example.com'}});
    if(url.pathname==='/rest/v1/rpc/security_register_login'&&method==='POST')return json({userId:44,expiresAt:new Date(Date.now()+900000).toISOString()});
    if(url.pathname==='/rest/v1/password_history'&&method==='GET')return json([{history_id:1}]);
    if(['/rest/v1/devices','/rest/v1/sessions','/rest/v1/login_history'].includes(url.pathname)&&method==='POST')return new Response(null,{status:204});
    throw new Error(`Solicitud inesperada: ${method} ${url.pathname}`);
  };
  const {SupabaseAuthRepository}=await import('../dist/modules/auth/repositories/auth.repository.js');
  const result=await new SupabaseAuthRepository().signIn({
    email:'persona@example.com',
    password:'secreto',
    deviceToken:'device-token-with-more-than-twenty-characters',
    deviceName:'Navegador de prueba'
  });
  assert.equal(result.accessToken,accessToken);
  const identityRequest=requests.find(item=>new URL(item.url).pathname==='/rest/v1/rpc/security_register_login');
  assert.equal(identityRequest.method,'POST');
  assert.equal(new Headers(identityRequest.headers).get('authorization'),null);
  assert.equal(new Headers(identityRequest.headers).get('apikey'),'sb_secret_synthetic');
  assert.equal(requests.some(item=>new URL(item.url).pathname==='/rest/v1/users'),false);
});

test('login revoca Auth local y no autoaprovisiona si el registro protegido falla',async()=>{
  process.env.SUPABASE_URL='https://project.example.test';
  process.env.SUPABASE_ANON_KEY='anon';
  process.env.SUPABASE_SERVICE_ROLE_KEY='sb_secret_synthetic';
  const requests=[];let loggedOut=false;
  globalThis.fetch=async(input,init={})=>{
    const url=new URL(String(input)),method=init.method??'GET';
    requests.push({url:url.toString(),method,body:init.body,headers:init.headers});
    if(url.pathname==='/auth/v1/token')return json({access_token:accessToken,refresh_token:'synthetic-refresh-login-only',user:{id:'123e4567-e89b-42d3-a456-426614174000',email:'persona@example.com'}});
    if(url.pathname==='/rest/v1/rpc/security_register_login'&&method==='POST')return json({message:'Denied'},403);
    if(url.pathname==='/auth/v1/logout'&&method==='POST'){loggedOut=true;return new Response(null,{status:204});}
    throw new Error(`Solicitud inesperada: ${method} ${url.pathname}`);
  };
  const {SupabaseAuthRepository}=await import('../dist/modules/auth/repositories/auth.repository.js');
  await assert.rejects(()=>new SupabaseAuthRepository().signIn({email:'persona@example.com',password:'secreto',deviceToken:'device-token-with-more-than-twenty-characters'}),/aprovisionado correctamente.*inactivo/i);
  assert.equal(requests.some(item=>new URL(item.url).pathname==='/rest/v1/users'),false);
  assert.equal(requests.some(item=>new URL(item.url).pathname==='/rest/v1/rpc/security_register_login'),true);
  assert.equal(loggedOut,true);
});

test('login inicializa historial con el dispositivo del cuerpo y el JWT del usuario sin contexto externo',async()=>{
  process.env.SUPABASE_URL='https://project.example.test';
  process.env.SUPABASE_ANON_KEY='anon';
  process.env.SUPABASE_SERVICE_ROLE_KEY='sb_secret_synthetic';
  const deviceToken='  login-device-with-more-than-twenty-characters  ',historyRequests=[];
  globalThis.fetch=async(input,init={})=>{
    const url=new URL(String(input)),method=init.method??'GET',headers=new Headers(init.headers);
    if(url.pathname==='/auth/v1/token')return json({access_token:accessToken,refresh_token:'synthetic-refresh-login-only',user:{id:'123e4567-e89b-42d3-a456-426614174000',email:'persona@example.com'}});
    if(url.pathname==='/rest/v1/rpc/security_register_login')return json({userId:44,expiresAt:new Date(Date.now()+900000).toISOString()});
    if(url.pathname==='/rest/v1/password_history'){
      historyRequests.push({method,headers,body:init.body});
      if(headers.get('x-erp-device-hash')!==deviceHash(deviceToken.trim()))return json({message:'new row violates row-level security policy for table "password_history"'},403);
      assert.equal(headers.get('authorization'),`Bearer ${accessToken}`);
      assert.equal(headers.get('apikey'),'anon');
      assert.equal(headers.get('x-device-token'),null);
      if(method==='GET')return json([]);
      if(method==='POST')return new Response(null,{status:204});
    }
    throw new Error(`Solicitud inesperada: ${method} ${url.pathname}`);
  };
  const {SupabaseAuthRepository}=await import('../dist/modules/auth/repositories/auth.repository.js');
  const {verifyPassword}=await import('../dist/shared/services/password.service.js');
  const result=await new SupabaseAuthRepository().signIn({email:'persona@example.com',password:'secreto',deviceToken});
  assert.equal(result.accessToken,accessToken);
  assert.deepEqual(historyRequests.map(item=>item.method),['GET','POST']);
  const history=JSON.parse(historyRequests[1].body);
  assert.equal(history.user_id,44);
  assert.notEqual(history.password_hash,'secreto');
  assert.equal(await verifyPassword('secreto',history.password_hash),true);
});

test('logins concurrentes reemplazan el contexto heredado con su propio dispositivo y lo restauran al finalizar',async()=>{
  process.env.SUPABASE_URL='https://project.example.test';
  process.env.SUPABASE_ANON_KEY='anon';
  process.env.SUPABASE_SERVICE_ROLE_KEY='sb_secret_synthetic';
  const accounts=['uno','dos'].map((name,index)=>({
    email:`${name}@example.com`,
    authId:`123e4567-e89b-42d3-a456-42661417400${index}`,
    deviceToken:`device-${name}-with-more-than-twenty-characters`,
    userId:44+index,
    token:`header.${encode({sub:`123e4567-e89b-42d3-a456-42661417400${index}`,session_id:`11111111-0000-4000-8000-00000000000${index}`,exp:Math.floor(Date.now()/1000)+3600})}.signature`,
  }));
  const historyRequests=[];
  let arrivals=0,releaseHistory;
  const bothReading=new Promise(resolve=>{releaseHistory=resolve;});
  globalThis.fetch=async(input,init={})=>{
    const url=new URL(String(input)),headers=new Headers(init.headers),method=init.method??'GET';
    if(url.pathname==='/auth/v1/token'){
      const account=accounts.find(item=>item.email===JSON.parse(init.body).email);
      return json({access_token:account.token,refresh_token:'synthetic-refresh-login-only',user:{id:account.authId,email:account.email}});
    }
    if(url.pathname==='/rest/v1/rpc/security_register_login')return json({userId:accounts.find(item=>item.authId===JSON.parse(init.body).p_auth_user_id).userId,expiresAt:new Date(Date.now()+900000).toISOString()});
    if(url.pathname==='/rest/v1/password_history'){
      const account=accounts.find(item=>headers.get('authorization')===`Bearer ${item.token}`);
      assert.ok(account);
      assert.equal(headers.get('apikey'),'anon');
      assert.equal(headers.get('x-erp-device-hash'),deviceHash(account.deviceToken));
      historyRequests.push({email:account.email,method});
      if(method==='GET'){
        assert.equal(url.searchParams.get('user_id'),`eq.${account.userId}`);
        if(++arrivals===accounts.length)releaseHistory();
        await bothReading;
        return json([]);
      }
      assert.equal(JSON.parse(init.body).user_id,account.userId);
      return new Response(null,{status:204});
    }
    if(url.pathname==='/rest/v1/probe')return json({deviceHash:headers.get('x-erp-device-hash')});
    throw new Error(`Solicitud inesperada: ${method} ${url.pathname}`);
  };
  const {SupabaseAuthRepository}=await import('../dist/modules/auth/repositories/auth.repository.js');
  const {withDeviceContext}=await import('../dist/core/security/device-context.js');
  const {fetchSupabase}=await import('../dist/core/database/supabase.client.js');
  const inherited='different-inherited-device-context';
  await withDeviceContext(inherited,async()=>{
    const results=await Promise.all(accounts.map(account=>new SupabaseAuthRepository().signIn({...account,password:'secreto'})));
    assert.deepEqual(results.map(item=>item.accessToken),accounts.map(item=>item.token));
    const probe=await fetchSupabase('https://project.example.test/rest/v1/probe');
    assert.equal((await probe.json()).deviceHash,deviceHash(inherited));
  });
  assert.equal(historyRequests.length,4);
  const probe=await fetchSupabase('https://project.example.test/rest/v1/probe');
  assert.equal((await probe.json()).deviceHash,null);
});

for(const failureMethod of ['GET','POST'])test(`login revoca Auth local si falla ${failureMethod} del historial`,async()=>{
  process.env.SUPABASE_URL='https://project.example.test';
  process.env.SUPABASE_ANON_KEY='anon';
  process.env.SUPABASE_SERVICE_ROLE_KEY='sb_secret_synthetic';
  const requests=[];
  globalThis.fetch=async(input,init={})=>{
    const url=new URL(String(input)),method=init.method??'GET';
    requests.push({url,method,headers:new Headers(init.headers)});
    if(url.pathname==='/auth/v1/token')return json({access_token:accessToken,refresh_token:'synthetic-refresh-login-only',user:{id:'123e4567-e89b-42d3-a456-426614174000',email:'persona@example.com'}});
    if(url.pathname==='/rest/v1/rpc/security_register_login')return json({userId:44,expiresAt:new Date(Date.now()+900000).toISOString()});
    if(url.pathname==='/rest/v1/password_history')return method===failureMethod?json({message:'Historial no disponible'},403):json([]);
    if(url.pathname==='/auth/v1/logout')return new Response(null,{status:204});
    throw new Error(`Solicitud inesperada: ${method} ${url.pathname}`);
  };
  const {SupabaseAuthRepository}=await import('../dist/modules/auth/repositories/auth.repository.js');
  await assert.rejects(()=>new SupabaseAuthRepository().signIn({email:'persona@example.com',password:'secreto',deviceToken:'device-with-more-than-twenty-characters'}),/Historial no disponible/);
  const logout=requests.filter(item=>item.url.pathname==='/auth/v1/logout');
  assert.equal(logout.length,1);
  assert.equal(logout[0].method,'POST');
  assert.equal(logout[0].url.searchParams.get('scope'),'local');
  assert.equal(logout[0].headers.get('authorization'),`Bearer ${accessToken}`);
  assert.equal(logout[0].headers.get('apikey'),'anon');
});
