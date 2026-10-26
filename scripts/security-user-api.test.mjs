import assert from 'node:assert/strict';
import test from 'node:test';

const security=await import('../dist/modules/security-catalogs/security-catalogs.module.js');
const originalFetch=globalThis.fetch,originalEnvironment={...process.env};
test.afterEach(()=>{globalThis.fetch=originalFetch;process.env={...originalEnvironment};});

test('la edición de usuario nunca devuelve hashes ni identificadores internos de Auth',async()=>{
  process.env.SUPABASE_URL='https://project.example.test';process.env.SUPABASE_ANON_KEY='anon';
  const catalog=security.getSecurityCatalog('users');let patchUrl;
  globalThis.fetch=async(input,init={})=>{const url=new URL(String(input));if((init.method??'GET')==='GET')return new Response(JSON.stringify([{email:'persona@example.com'}]),{status:200});if(init.method==='PATCH'){patchUrl=url;const body=JSON.parse(String(init.body));assert.equal(JSON.stringify(body).includes('password'),false);assert.equal('email'in body,false);assert.deepEqual(Object.keys(body).sort(),['first_name','is_active','last_name','timezone_id']);return new Response(JSON.stringify([{user_id:5,email:'persona@example.com',first_name:'Persona',last_name:'Segura',timezone_id:null,is_active:true}]),{status:200});}throw new Error('Solicitud inesperada.');};
  const result=await security.updateSecurityRow(catalog,'Bearer actor',5,{email:'persona@example.com',first_name:'Persona',last_name:'Segura',timezone_id:null,is_active:true,password_hash:'no-debe-usarse'});
  assert.match(patchUrl.searchParams.get('select'),/^user_id,email,first_name,last_name,timezone_id,is_active$/);assert.equal('password_hash'in result,false);assert.equal('auth_user_id'in result,false);
});

test('el alta genérica no puede evadir el aprovisionamiento seguro',async()=>{const catalog=security.getSecurityCatalog('users');globalThis.fetch=async()=>{throw new Error('No debe escribir directamente.');};await assert.rejects(()=>security.createSecurityRow(catalog,'Bearer actor',{email:'persona@example.com'}),/flujo seguro de invitación/);});
