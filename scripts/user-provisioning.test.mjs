import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

const provisioning=await import('../dist/modules/auth/services/user-provisioning.service.js');
const originalFetch=globalThis.fetch,originalEnvironment={...process.env};
const authId='123e4567-e89b-42d3-a456-426614174000';
const json=(value,status=200)=>new Response(JSON.stringify(value),{status,headers:{'Content-Type':'application/json'}});
const hash=value=>createHash('sha256').update(value).digest('hex');
function configure(){process.env.SUPABASE_URL='https://project.example.test';process.env.SUPABASE_ANON_KEY='anon';process.env.SUPABASE_SERVICE_ROLE_KEY='service';process.env.GENTIA_APP_URL='https://erp.example.test';delete process.env.SMTP_HOST;delete process.env.SMTP_FROM;}
function jwt(method='otp',issuedAt=Math.floor(Date.now()/1000)){const enc=value=>Buffer.from(JSON.stringify(value)).toString('base64url');return`${enc({alg:'none'})}.${enc({iat:issuedAt,exp:issuedAt+3600,role:'authenticated',aud:'authenticated',amr:[{method,timestamp:issuedAt}]})}.signature`;}
test.beforeEach(configure);test.afterEach(()=>{globalThis.fetch=originalFetch;process.env={...originalEnvironment};});

test('crea Auth y ERP, genera un enlace seguro y habilita recuperación si SMTP falla',async()=>{
  let authBody,grantBody,erpBody,fallbackBody,authDeleted=false,grantDeletes=0,createAuthorization='';const usersAuthorizations=[];
  globalThis.fetch=async(input,init={})=>{
    const url=new URL(String(input));
    if(url.pathname==='/rest/v1/users'){usersAuthorizations.push(new Headers(init.headers).get('authorization'));if((init.method??'GET')==='GET')return json([]);}
    if(url.pathname==='/auth/v1/admin/generate_link'){
      authBody=JSON.parse(String(init.body));
      const callback=authBody.redirect_to;
      return json({user:{id:authId,email:'persona@example.com'},properties:{action_link:`https://project.example.test/auth/v1/verify?token=secret&type=invite&redirect_to=${encodeURIComponent(callback)}`,redirect_to:callback}});
    }
    if(url.pathname==='/rest/v1/user_invitation_grants'&&init.method==='DELETE'){grantDeletes++;return new Response(null,{status:204});}
    if(url.pathname==='/rest/v1/user_invitation_grants'&&init.method==='POST'){grantBody=JSON.parse(String(init.body));return new Response(null,{status:201});}
    if(url.pathname==='/rest/v1/rpc/security_create_user'&&init.method==='POST'){erpBody=JSON.parse(String(init.body));createAuthorization=new Headers(init.headers).get('authorization')??'';return json({user_id:7,email:erpBody.p_email,first_name:erpBody.p_first_name,last_name:erpBody.p_last_name,timezone_id:null,is_active:true,invitation_sent_at:null,invitation_accepted_at:null});}
    if(url.pathname==='/rest/v1/rpc/user_invitation_email_settings')return json({canEdit:true,template:{activo:false},subsidiary:{name:'Empresa',logo:null}});
    if(url.pathname===`/auth/v1/admin/users/${authId}`&&init.method==='PUT'){fallbackBody=JSON.parse(String(init.body));return json({id:authId,email:'persona@example.com'});}
    if(url.pathname===`/auth/v1/admin/users/${authId}`&&init.method==='DELETE'){authDeleted=true;return json({});}
    throw new Error(`Solicitud inesperada: ${url.pathname} ${init.method??'GET'}`);
  };
  const result=await provisioning.createSecurityUser('Bearer actor',{email:'Persona@Example.com',first_name:'María',last_name:'Pérez',is_active:true,notify_user:true,password_hash:'texto-que-debe-ignorarse'});
  assert.equal(authBody.type,'invite');assert.equal('password'in authBody,false);assert.match(authBody.redirect_to,/password_invitation=1/);assert.match(authBody.redirect_to,/state=/);
  const callback=new URL(authBody.redirect_to),state=callback.searchParams.get('state');assert.equal(grantBody.state_hash,hash(state));assert.equal(grantBody.email_hash,hash('persona@example.com'));assert.equal(JSON.stringify(grantBody).includes('persona@example.com'),false);
  assert.equal('password_hash'in erpBody,false);assert.equal(erpBody.p_auth_user_id,authId);assert.equal(erpBody.p_email,'persona@example.com');assert.equal(createAuthorization,'Bearer actor');
  assert.deepEqual(usersAuthorizations,['Bearer service']);
  assert.equal(result.notification.status,'ENVIO_FALLIDO_RECUPERACION_DISPONIBLE');assert.equal(result.user_id,7);assert.equal('password_hash'in result,false);assert.equal('auth_user_id'in result,false);assert.equal(JSON.stringify(result).includes('texto-que-debe-ignorarse'),false);assert.equal(fallbackBody.email_confirm,true);assert.match(fallbackBody.password,/^[A-Za-z0-9_-]{64}$/);assert.equal(JSON.stringify(result).includes(fallbackBody.password),false);assert.equal(grantDeletes,2);assert.equal(authDeleted,false);
});

test('marca intervención requerida si SMTP y la conversión de respaldo fallan',async()=>{
  globalThis.fetch=async(input,init={})=>{const url=new URL(String(input));if(url.pathname==='/rest/v1/users'&&(init.method??'GET')==='GET')return json([]);if(url.pathname==='/auth/v1/admin/generate_link'){const body=JSON.parse(String(init.body));return json({user:{id:authId,email:'intervencion@example.com'},action_link:`https://project.example.test/auth/v1/verify?token=x&type=invite&redirect_to=${encodeURIComponent(body.redirect_to)}`,redirect_to:body.redirect_to});}if(url.pathname==='/rest/v1/user_invitation_grants'&&init.method==='DELETE')return new Response(null,{status:204});if(url.pathname==='/rest/v1/user_invitation_grants'&&init.method==='POST')return new Response(null,{status:201});if(url.pathname==='/rest/v1/rpc/security_create_user'&&init.method==='POST')return json({user_id:10,email:'intervencion@example.com',first_name:'Requiere',last_name:'Ayuda',timezone_id:null,is_active:true,invitation_sent_at:null,invitation_accepted_at:null});if(url.pathname==='/rest/v1/rpc/user_invitation_email_settings')return json({canEdit:true,template:{activo:false},subsidiary:{name:'Empresa'}});if(url.pathname===`/auth/v1/admin/users/${authId}`&&init.method==='PUT')return json({message:'falló'},500);throw new Error(`Solicitud inesperada: ${url.pathname}`);};
  const result=await provisioning.createSecurityUser('Bearer actor',{email:'intervencion@example.com',first_name:'Requiere',last_name:'Ayuda',notify_user:true});assert.equal(result.notification.status,'REQUIERE_INTERVENCION');assert.match(result.message,/intervención administrativa/i);
});

test('notify_user=false crea una cuenta confirmada con secreto aleatorio inaccesible y no envía correo',async()=>{
  let adminBody,generateCalls=0,grantCalls=0;
  globalThis.fetch=async(input,init={})=>{const url=new URL(String(input));if(url.pathname==='/rest/v1/users'&&(init.method??'GET')==='GET')return json([]);if(url.pathname==='/auth/v1/admin/users'&&init.method==='POST'){adminBody=JSON.parse(String(init.body));return json({id:authId,email:'sinaviso@example.com'});}if(url.pathname==='/auth/v1/admin/generate_link'){generateCalls++;return json({});}if(url.pathname==='/rest/v1/user_invitation_grants'){grantCalls++;return json({});}if(url.pathname==='/rest/v1/rpc/security_create_user'&&init.method==='POST'){const row=JSON.parse(String(init.body));return json({user_id:8,email:row.p_email,first_name:row.p_first_name,last_name:row.p_last_name,timezone_id:null,is_active:true,invitation_sent_at:null,invitation_accepted_at:null});}throw new Error(`Solicitud inesperada: ${url.pathname}`);};
  const result=await provisioning.createSecurityUser('Bearer actor',{email:'sinaviso@example.com',first_name:'Sin',last_name:'Aviso',notify_user:false});
  assert.equal(adminBody.email_confirm,true);assert.match(adminBody.password,/^[A-Za-z0-9_-]{64}$/);assert.equal(generateCalls,0);assert.equal(grantCalls,0);assert.equal(result.notification.status,'NO_SOLICITADA');assert.equal(JSON.stringify(result).includes(adminBody.password),false);
});

test('compensa la cuenta Auth si falla la creación del usuario ERP',async()=>{
  let deleted=false;
  globalThis.fetch=async(input,init={})=>{const url=new URL(String(input));if(url.pathname==='/rest/v1/users'&&(init.method??'GET')==='GET')return json([]);if(url.pathname==='/auth/v1/admin/users'&&init.method==='POST')return json({id:authId,email:'fallo@example.com'});if(url.pathname==='/rest/v1/rpc/security_create_user'&&init.method==='POST')return json({code:'23505',message:'duplicate'},409);if(url.pathname===`/auth/v1/admin/users/${authId}`&&init.method==='DELETE'){deleted=true;return json({});}throw new Error(`Solicitud inesperada: ${url.pathname}`);};
  await assert.rejects(()=>provisioning.createSecurityUser('Bearer actor',{email:'fallo@example.com',first_name:'Con',last_name:'Fallo',notify_user:false}),error=>error?.status===409);assert.equal(deleted,true);
});

test('reporta intervención si no puede compensar un alta incompleta',async()=>{
  globalThis.fetch=async(input,init={})=>{const url=new URL(String(input));if(url.pathname==='/rest/v1/users'&&(init.method??'GET')==='GET')return json([]);if(url.pathname==='/auth/v1/admin/users'&&init.method==='POST')return json({id:authId,email:'huerfano@example.com'});if(url.pathname==='/rest/v1/rpc/security_create_user'&&init.method==='POST')return json({message:'fallo ERP'},500);if(url.pathname===`/auth/v1/admin/users/${authId}`&&init.method==='DELETE')return json({message:'fallo compensación'},500);throw new Error(`Solicitud inesperada: ${url.pathname}`);};
  await assert.rejects(()=>provisioning.createSecurityUser('Bearer actor',{email:'huerfano@example.com',first_name:'Alta',last_name:'Incompleta',notify_user:false}),error=>error?.status===500&&/intervención administrativa/i.test(error.message));
});

test('completa una invitación de un solo uso y registra la contraseña',async()=>{
  const email='invitado@example.com',state='I'.repeat(43),issuedAt=Math.floor(Date.now()/1000);let consumed=false,updated=false,history=false;
  globalThis.fetch=async(input,init={})=>{const url=new URL(String(input));if(url.pathname==='/auth/v1/user'&&(init.method??'GET')==='GET')return json({id:authId,email});if(url.pathname==='/rest/v1/user_invitation_grants')return json([{invitation_id:1,email_hash:hash(email),auth_user_id:authId,created_at:new Date((issuedAt-5)*1000).toISOString()}]);if(url.pathname==='/rest/v1/users'&&(init.method??'GET')==='GET')return json([{user_id:9,is_active:true}]);if(url.pathname==='/rest/v1/password_history'&&(init.method??'GET')==='GET')return json([]);if(url.pathname==='/rest/v1/rpc/consume_user_invitation_grant'){consumed=true;return json(true);}if(url.pathname==='/auth/v1/user'&&init.method==='PUT'){updated=true;assert.deepEqual(JSON.parse(String(init.body)),{password:'Clave de invitación 2026!'});return json({id:authId,email});}if(url.pathname==='/rest/v1/password_history'&&init.method==='POST'){history=true;return new Response(null,{status:201});}if(url.pathname==='/rest/v1/users'&&init.method==='PATCH')return new Response(null,{status:204});if(url.pathname==='/rest/v1/sessions'&&init.method==='DELETE')return new Response(null,{status:204});if(url.pathname==='/auth/v1/logout')return new Response(null,{status:204});throw new Error(`Solicitud inesperada: ${url.pathname} ${init.method??'GET'}`);};
  const result=await provisioning.completePasswordInvitation(`Bearer ${jwt('otp',issuedAt)}`,{state,invitationType:'invite',newPassword:'Clave de invitación 2026!',confirmation:'Clave de invitación 2026!'});assert.equal(result.success,true);assert.equal(consumed,true);assert.equal(updated,true);assert.equal(history,true);
});

test('un token de sesión por contraseña no puede completar una invitación',async()=>{globalThis.fetch=async()=>{throw new Error('No debe consultar Supabase.');};await assert.rejects(()=>provisioning.completePasswordInvitation(`Bearer ${jwt('password')}`,{state:'J'.repeat(43),invitationType:'invite',newPassword:'Clave de invitación 2026!',confirmation:'Clave de invitación 2026!'}),error=>error?.status===401);});
