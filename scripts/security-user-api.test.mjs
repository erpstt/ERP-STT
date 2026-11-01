import assert from 'node:assert/strict';
import test from 'node:test';

const security=await import('../dist/modules/security-catalogs/security-catalogs.module.js');
const originalFetch=globalThis.fetch,originalEnvironment={...process.env};
test.afterEach(()=>{globalThis.fetch=originalFetch;process.env={...originalEnvironment};});

test('edicion protegida conserva revision y JWT sin enviar hashes ni devolver identidad Auth',async()=>{process.env.SUPABASE_URL='https://project.example.test';process.env.SUPABASE_ANON_KEY='anon';let calls=0;globalThis.fetch=async(input,init)=>{calls++;assert.ok(new URL(String(input)).pathname.endsWith('/rpc/security_save_access_master'));assert.equal(new Headers(init.headers).get('authorization'),'Bearer actor');assert.equal(new Headers(init.headers).get('apikey'),'anon');const p=JSON.parse(init.body);assert.equal(p.p_catalog,'users');assert.equal(p.p_id,5);assert.equal(p.p_payload._revision,'SYN');assert.equal('password_hash'in p.p_payload,false);assert.equal('notify_user'in p.p_payload,false);return Response.json({user_id:5,email:'synthetic@example.invalid',_revision:'NEW'});};const r=await security.updateSecurityRow(security.getSecurityCatalog('users'),'Bearer actor',5,{email:'synthetic@example.invalid',first_name:'Synthetic',last_name:'User',is_active:true,_revision:'SYN',password_hash:'ignored',notify_user:true});assert.equal(calls,1);assert.equal(r._revision,'NEW');assert.equal('password_hash'in r,false);assert.equal('auth_user_id'in r,false);});

test('el alta genérica no puede evadir el aprovisionamiento seguro',async()=>{const catalog=security.getSecurityCatalog('users');globalThis.fetch=async()=>{throw new Error('No debe escribir directamente.');};await assert.rejects(()=>security.createSecurityRow(catalog,'Bearer actor',{email:'persona@example.com'}),/flujo seguro de invitación/);});
