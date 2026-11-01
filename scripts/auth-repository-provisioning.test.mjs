import assert from 'node:assert/strict';
import test from 'node:test';

const originalFetch=globalThis.fetch,originalEnvironment={...process.env};
const json=(value,status=200)=>new Response(JSON.stringify(value),{status,headers:{'Content-Type':'application/json'}});
const encode=value=>Buffer.from(JSON.stringify(value)).toString('base64url');
const accessToken=`${encode({alg:'none',typ:'JWT'})}.${encode({sub:'123e4567-e89b-42d3-a456-426614174000',session_id:'11111111-0000-4000-8000-000000000001',email:'persona@example.com',exp:Math.floor(Date.now()/1000)+3600})}.signature`;

test.afterEach(()=>{globalThis.fetch=originalFetch;process.env={...originalEnvironment};});

test('login valida identidad ERP mediante registro exclusivo del servidor',async()=>{
  process.env.SUPABASE_URL='https://project.example.test';
  process.env.SUPABASE_ANON_KEY='anon';
  process.env.SUPABASE_SERVICE_ROLE_KEY='sb_secret_synthetic';
  const requests=[];
  globalThis.fetch=async(input,init={})=>{
    const url=new URL(String(input)),method=init.method??'GET';
    requests.push({url:url.toString(),method,body:init.body,headers:init.headers});
    if(url.pathname==='/auth/v1/token')return json({access_token:accessToken,user:{id:'123e4567-e89b-42d3-a456-426614174000',email:'persona@example.com'}});
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
    if(url.pathname==='/auth/v1/token')return json({access_token:accessToken,user:{id:'123e4567-e89b-42d3-a456-426614174000',email:'persona@example.com'}});
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
