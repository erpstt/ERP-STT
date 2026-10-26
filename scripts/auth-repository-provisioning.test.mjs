import assert from 'node:assert/strict';
import test from 'node:test';

const originalFetch=globalThis.fetch,originalEnvironment={...process.env};
const json=(value,status=200)=>new Response(JSON.stringify(value),{status,headers:{'Content-Type':'application/json'}});

test.afterEach(()=>{globalThis.fetch=originalFetch;process.env={...originalEnvironment};});

test('login valida el vínculo internamente y no autoaprovisiona usuarios ERP inexistentes',async()=>{
  process.env.SUPABASE_URL='https://project.example.test';
  process.env.SUPABASE_ANON_KEY='anon';
  process.env.SUPABASE_SERVICE_ROLE_KEY='service';
  const requests=[];let loggedOut=false;
  globalThis.fetch=async(input,init={})=>{
    const url=new URL(String(input)),method=init.method??'GET';
    requests.push({url:url.toString(),method,body:init.body,headers:init.headers});
    if(url.pathname==='/auth/v1/token')return json({access_token:'access-token',user:{id:'123e4567-e89b-42d3-a456-426614174000',email:'Persona@Example.com',user_metadata:{first_name:'No debe usarse'}}});
    if(url.pathname==='/rest/v1/users'&&method==='GET')return json([]);
    if(url.pathname==='/auth/v1/logout'&&method==='POST'){loggedOut=true;return new Response(null,{status:204});}
    throw new Error(`Solicitud inesperada: ${method} ${url.pathname}`);
  };
  const {SupabaseAuthRepository}=await import('../dist/modules/auth/repositories/auth.repository.js');
  await assert.rejects(()=>new SupabaseAuthRepository().signIn({email:'Persona@Example.com',password:'secreto'}),/no está aprovisionado/i);
  const userRequest=requests.find(item=>new URL(item.url).pathname==='/rest/v1/users');
  assert.equal(new URL(userRequest.url).searchParams.get('select'),'user_id,is_active,auth_user_id');
  assert.equal(new Headers(userRequest.headers).get('authorization'),'Bearer service');
  assert.equal(userRequest.url.includes('password_hash'),false);
  assert.equal(requests.some(item=>new URL(item.url).pathname==='/rest/v1/users'&&['POST','PATCH'].includes(item.method)),false);
  assert.equal(loggedOut,true);
});

test('login rechaza y revoca una identidad Auth cruzada aunque coincida el correo',async()=>{
  process.env.SUPABASE_URL='https://project.example.test';
  process.env.SUPABASE_ANON_KEY='anon';
  process.env.SUPABASE_SERVICE_ROLE_KEY='service';
  const authId='123e4567-e89b-42d3-a456-426614174000',otherAuthId='123e4567-e89b-42d3-a456-426614174001';
  let profileAuthorization='',loggedOut=false;
  globalThis.fetch=async(input,init={})=>{
    const url=new URL(String(input)),method=init.method??'GET';
    if(url.pathname==='/auth/v1/token')return json({access_token:'access-token',user:{id:authId,email:'persona@example.com'}});
    if(url.pathname==='/rest/v1/users'&&method==='GET'){profileAuthorization=new Headers(init.headers).get('authorization')??'';return json([{user_id:44,is_active:true,auth_user_id:otherAuthId}]);}
    if(url.pathname==='/auth/v1/logout'&&method==='POST'){loggedOut=true;return new Response(null,{status:204});}
    throw new Error(`Solicitud inesperada: ${method} ${url.pathname}`);
  };
  const {SupabaseAuthRepository}=await import('../dist/modules/auth/repositories/auth.repository.js');
  await assert.rejects(()=>new SupabaseAuthRepository().signIn({email:'persona@example.com',password:'secreto'}),/aprovisionado correctamente/i);
  assert.equal(profileAuthorization,'Bearer service');
  assert.equal(loggedOut,true);
});
