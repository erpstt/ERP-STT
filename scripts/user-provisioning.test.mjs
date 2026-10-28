import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import nodemailer from 'nodemailer';

const provisioning=await import('../dist/modules/auth/services/user-provisioning.service.js');
const originalFetch=globalThis.fetch,originalEnvironment={...process.env},originalCreateTransport=nodemailer.createTransport;
const authId='123e4567-e89b-42d3-a456-426614174000';
const json=(value,status=200)=>new Response(JSON.stringify(value),{status,headers:{'Content-Type':'application/json'}});
const hash=value=>createHash('sha256').update(value).digest('hex');
function configure(){process.env.SUPABASE_URL='https://project.example.test';process.env.SUPABASE_ANON_KEY='anon';process.env.SUPABASE_SERVICE_ROLE_KEY='service';process.env.GENTIA_APP_URL='https://erp.example.test';delete process.env.RAILWAY_PUBLIC_DOMAIN;delete process.env.SMTP_HOST;delete process.env.SMTP_FROM;}
function jwt(method='otp',issuedAt=Math.floor(Date.now()/1000)){const enc=value=>Buffer.from(JSON.stringify(value)).toString('base64url');return`${enc({alg:'none'})}.${enc({iat:issuedAt,exp:issuedAt+3600,role:'authenticated',aud:'authenticated',amr:[{method,timestamp:issuedAt}]})}.signature`;}
function continuationLink(flow='recovery',state='A'.repeat(43),redirectOverride=''){const type=flow==='invitation'?'invite':'recovery',flag=flow==='invitation'?'password_invitation':'password_recovery',redirect=redirectOverride||`https://erp.example.test/?${flag}=1&state=${state}`;return`https://project.example.test/auth/v1/verify?token=secret&type=${type}&redirect_to=${encodeURIComponent(redirect)}`;}
test.beforeEach(configure);test.afterEach(()=>{globalThis.fetch=originalFetch;process.env={...originalEnvironment};nodemailer.createTransport=originalCreateTransport;});

test('acepta únicamente una continuación con grant vigente y del flujo correspondiente',async()=>{
  const cases=[{flow:'recovery',state:'A'.repeat(43),table:'/rest/v1/password_recovery_grants',id:'recovery_id'},{flow:'invitation',state:'B'.repeat(43),table:'/rest/v1/user_invitation_grants',id:'invitation_id'}];
  for(const item of cases){
    globalThis.fetch=async(input,init={})=>{const url=new URL(String(input));assert.equal(url.pathname,item.table);assert.equal(init.method??'GET','GET');assert.equal(url.searchParams.get('select'),item.id);assert.equal(url.searchParams.get('state_hash'),`eq.${hash(item.state)}`);assert.equal(url.searchParams.get('consumed_at'),'is.null');assert.match(url.searchParams.get('expires_at')||'',/^gt\./);assert.equal(url.searchParams.get('limit'),'1');return json([{[item.id]:1}]);};
    assert.deepEqual(await provisioning.validatePasswordAccessContinuation({confirmationUrl:continuationLink(item.flow,item.state),flow:item.flow},`198.51.100.${item.flow==='recovery'?10:11}`),{success:true});
  }
});

test('rechaza de forma indistinguible grants vencidos, consumidos o inexistentes',async()=>{
  const cases=[['vencido','C'.repeat(43)],['consumido','D'.repeat(43)],['inexistente','E'.repeat(43)]];
  for(const[index,[label,state]]of cases.entries()){
    let queried=false;
    globalThis.fetch=async input=>{const url=new URL(String(input));queried=true;assert.equal(url.pathname,'/rest/v1/password_recovery_grants');assert.equal(url.searchParams.get('state_hash'),`eq.${hash(state)}`);assert.equal(url.searchParams.get('consumed_at'),'is.null');assert.match(url.searchParams.get('expires_at')||'',/^gt\./);return json([]);};
    await assert.rejects(()=>provisioning.validatePasswordAccessContinuation({confirmationUrl:continuationLink('recovery',state),flow:'recovery'},`198.51.100.${20+index}`),error=>error?.status===400&&error.message==='El enlace de acceso no es válido o ya expiró.',label);
    assert.equal(queried,true);
  }
});

test('rechaza orígenes, fragmentos, parámetros duplicados y flags cruzadas antes de consultar grants',async()=>{
  const state='F'.repeat(43),valid=continuationLink('recovery',state),duplicateState=`https://erp.example.test/?password_recovery=1&state=${state}&state=${'G'.repeat(43)}`,crossed=`https://erp.example.test/?password_recovery=1&password_invitation=1&state=${state}`;
  const invalid=[
    {url:valid,flow:'invitation'},
    {url:valid.replace('project.example.test','attacker.example.test'),flow:'recovery'},
    {url:valid.replace('erp.example.test','attacker.example.test'),flow:'recovery'},
    {url:`${valid}#fragmento`,flow:'recovery'},
    {url:`${valid}&type=recovery`,flow:'recovery'},
    {url:`${valid}&token_hash=otro`,flow:'recovery'},
    {url:continuationLink('recovery',state,duplicateState),flow:'recovery'},
    {url:continuationLink('recovery',state,crossed),flow:'recovery'}
  ];
  let fetchCalls=0;globalThis.fetch=async()=>{fetchCalls++;return json([{recovery_id:1}]);};
  for(const[index,item]of invalid.entries())await assert.rejects(()=>provisioning.validatePasswordAccessContinuation({confirmationUrl:item.url,flow:item.flow},`203.0.113.${index+1}`),error=>error?.status===400);
  assert.equal(fetchCalls,0);
});

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
    if(url.pathname==='/rest/v1/rpc/user_invitation_email_settings')return json({canEdit:true,template:{activo:true},subsidiary:{name:'Empresa',logo:null}});
    if(url.pathname===`/auth/v1/admin/users/${authId}`&&init.method==='PUT'){fallbackBody=JSON.parse(String(init.body));return json({id:authId,email:'persona@example.com'});}
    if(url.pathname===`/auth/v1/admin/users/${authId}`&&init.method==='DELETE'){authDeleted=true;return json({});}
    throw new Error(`Solicitud inesperada: ${url.pathname} ${init.method??'GET'}`);
  };
  const result=await provisioning.createSecurityUser('Bearer actor',{email:'Persona@Example.com',first_name:'María',last_name:'Pérez',is_active:true,notify_user:true,password_hash:'texto-que-debe-ignorarse'});
  assert.equal(authBody.type,'invite');assert.equal('password'in authBody,false);assert.match(authBody.redirect_to,/password_invitation=1/);assert.match(authBody.redirect_to,/state=/);
  const callback=new URL(authBody.redirect_to),state=callback.searchParams.get('state');assert.equal(grantBody.state_hash,hash(state));assert.equal(grantBody.email_hash,hash('persona@example.com'));assert.equal(JSON.stringify(grantBody).includes('persona@example.com'),false);
  assert.equal('password_hash'in erpBody,false);assert.equal(erpBody.p_auth_user_id,authId);assert.equal(erpBody.p_email,'persona@example.com');assert.equal(createAuthorization,'Bearer actor');
  assert.deepEqual(usersAuthorizations,['Bearer service']);
  assert.equal(result.notification.status,'ENVIO_FALLIDO_RECUPERACION_DISPONIBLE');assert.match(result.notification.error,/configure SMTP_HOST, SMTP_PORT y SMTP_FROM en Railway/i);assert.equal(result.user_id,7);assert.equal('password_hash'in result,false);assert.equal('auth_user_id'in result,false);assert.equal(JSON.stringify(result).includes('texto-que-debe-ignorarse'),false);assert.equal(fallbackBody.email_confirm,true);assert.match(fallbackBody.password,/^[A-Za-z0-9_-]{64}$/);assert.equal(JSON.stringify(result).includes(fallbackBody.password),false);assert.equal(grantDeletes,2);assert.equal(authDeleted,false);
});

test('marca intervención requerida si SMTP y la conversión de respaldo fallan',async()=>{
  globalThis.fetch=async(input,init={})=>{const url=new URL(String(input));if(url.pathname==='/rest/v1/users'&&(init.method??'GET')==='GET')return json([]);if(url.pathname==='/auth/v1/admin/generate_link'){const body=JSON.parse(String(init.body));return json({user:{id:authId,email:'intervencion@example.com'},action_link:`https://project.example.test/auth/v1/verify?token=x&type=invite&redirect_to=${encodeURIComponent(body.redirect_to)}`,redirect_to:body.redirect_to});}if(url.pathname==='/rest/v1/user_invitation_grants'&&init.method==='DELETE')return new Response(null,{status:204});if(url.pathname==='/rest/v1/user_invitation_grants'&&init.method==='POST')return new Response(null,{status:201});if(url.pathname==='/rest/v1/rpc/security_create_user'&&init.method==='POST')return json({user_id:10,email:'intervencion@example.com',first_name:'Requiere',last_name:'Ayuda',timezone_id:null,is_active:true,invitation_sent_at:null,invitation_accepted_at:null});if(url.pathname==='/rest/v1/rpc/user_invitation_email_settings')return json({canEdit:true,template:{activo:false},subsidiary:{name:'Empresa'}});if(url.pathname===`/auth/v1/admin/users/${authId}`&&init.method==='PUT')return json({message:'falló'},500);throw new Error(`Solicitud inesperada: ${url.pathname}`);};
  const result=await provisioning.createSecurityUser('Bearer actor',{email:'intervencion@example.com',first_name:'Requiere',last_name:'Ayuda',notify_user:true});assert.equal(result.notification.status,'REQUIERE_INTERVENCION');assert.match(result.notification.error,/Active la plantilla de invitación/i);assert.match(result.message,/intervención administrativa/i);
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

test('rechaza el envío antes de llamar servicios externos si falta la clave administrativa',async()=>{
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  let fetchCalls=0,transportCalls=0;
  globalThis.fetch=async()=>{fetchCalls++;throw new Error('No debe consultar Supabase sin configuración administrativa.');};
  nodemailer.createTransport=()=>{transportCalls++;throw new Error('No debe crear el transporte SMTP sin configuración administrativa.');};

  await assert.rejects(
    ()=>provisioning.sendExistingUserPasswordLink('Bearer actor',30),
    error=>error?.status===503&&error.message==='El servidor no tiene habilitada la administración segura de usuarios. Configure SUPABASE_SERVICE_ROLE_KEY en el entorno del servidor y reinicie el servicio.'
  );
  assert.equal(fetchCalls,0);
  assert.equal(transportCalls,0);
});

test('autoriza actor, subsidiaria y objetivo antes de usar service role para recuperar acceso',async()=>{
  const calls=[];
  globalThis.fetch=async(input,init={})=>{const url=new URL(String(input));calls.push(`${init.method??'GET'} ${url.pathname}`);assert.equal(url.pathname,'/rest/v1/rpc/security_prepare_user_password_recovery');assert.equal(new Headers(init.headers).get('authorization'),'Bearer actor');return json({message:'El usuario no está disponible para recuperar su acceso.'},403);};
  await assert.rejects(()=>provisioning.sendExistingUserPasswordLink('Bearer actor',30),error=>error?.status===403);
  assert.deepEqual(calls,['POST /rest/v1/rpc/security_prepare_user_password_recovery']);
});

test('edición envía recovery de un solo uso, conserva enlaces concurrentes hasta el consumo y no devuelve secretos',async()=>{
  delete process.env.GENTIA_APP_URL;process.env.RAILWAY_PUBLIC_DOMAIN='erp-stt-production.up.railway.app';
  process.env.SMTP_HOST='smtp.example.test';process.env.SMTP_FROM='seguridad@example.test';process.env.SMTP_PORT='587';process.env.EMAIL_NOTIFICATIONS_ENABLED='true';
  let generatedBody,grantBody,mailMessage,concurrentGrantsDeleted=false,audited=false;
  nodemailer.createTransport=()=>({sendMail:async message=>{mailMessage=message;return{accepted:['persona@example.com'],messageId:'mail-1'};},close(){}});
  globalThis.fetch=async(input,init={})=>{
    const url=new URL(String(input)),method=init.method??'GET';
    if(url.pathname==='/rest/v1/rpc/security_prepare_user_password_recovery'){assert.equal(new Headers(init.headers).get('authorization'),'Bearer actor');return json({actor_user_id:7,subsidiary_id:4,user_id:21,email:'persona@example.com',first_name:'María',last_name:'Pérez'});}
    if(url.pathname==='/rest/v1/users'&&method==='GET')return json([{user_id:21,email:'persona@example.com',auth_user_id:authId,is_active:true}]);
    if(url.pathname==='/rest/v1/password_recovery_grants'&&method==='DELETE'&&url.searchParams.has('expires_at'))return new Response(null,{status:204});
    if(url.pathname==='/rest/v1/password_recovery_grants'&&method==='POST'){grantBody=JSON.parse(String(init.body));return new Response(null,{status:201});}
    if(url.pathname==='/auth/v1/admin/generate_link'){generatedBody=JSON.parse(String(init.body));return json({user:{id:authId,email:'persona@example.com'},properties:{action_link:`https://project.example.test/auth/v1/verify?token=admin-secret&type=recovery&redirect_to=${encodeURIComponent(generatedBody.redirect_to)}`,redirect_to:generatedBody.redirect_to}});}
    if(url.pathname==='/rest/v1/rpc/user_password_recovery_email_settings'){assert.deepEqual(JSON.parse(String(init.body)),{p_action:'delivery',p_payload:{}});return json({template:{activo:true,asunto_template:'Recupera tu acceso a {{empresa_nombre}}',cuerpo_template:'<p>Hola {{usuario_nombre}}, define tu nueva clave.</p>'},subsidiary:{name:'Empresa',logo:null}});}
    if(url.pathname==='/rest/v1/password_recovery_grants'&&method==='DELETE'){concurrentGrantsDeleted=true;return new Response(null,{status:204});}
    if(url.pathname==='/rest/v1/rpc/security_audit_user_password_notification'){audited=true;assert.equal(new Headers(init.headers).get('authorization'),'Bearer service');assert.deepEqual(JSON.parse(String(init.body)),{p_actor_user_id:7,p_target_user_id:21,p_subsidiary_id:4,p_result:'ENVIADO'});return json(true);}
    throw new Error(`Solicitud inesperada: ${method} ${url.pathname}${url.search}`);
  };
  const result=await provisioning.sendExistingUserPasswordLink('Bearer actor',21);
  assert.equal(generatedBody.type,'recovery');assert.match(generatedBody.redirect_to,/password_recovery=1/);assert.match(generatedBody.redirect_to,/state=/);
  assert.equal(new URL(generatedBody.redirect_to).origin,'https://erp-stt-production.up.railway.app');
  const state=new URL(generatedBody.redirect_to).searchParams.get('state');assert.equal(grantBody.state_hash,hash(state));assert.equal(grantBody.email_hash,hash('persona@example.com'));
  assert.equal(concurrentGrantsDeleted,false);assert.equal(audited,true);assert.match(mailMessage.html,/RECUPERACIÓN SEGURA/);assert.match(mailMessage.html,/contraseña actual no se conoce/);
  assert.match(mailMessage.html,/https:\/\/erp-stt-production\.up\.railway\.app\/\?password_access=recovery#confirmation_url=/);
  assert.doesNotMatch(mailMessage.html,/href="https:\/\/project\.example\.test\/auth\/v1\/verify/);
  assert.equal(result.status,'RECUPERACION_ENVIADA');assert.equal(JSON.stringify(result).includes('admin-secret'),false);assert.equal(JSON.stringify(result).includes(state),false);assert.equal(JSON.stringify(result).toLowerCase().includes('password'),false);
});

test('si el SMTP aceptó el correo conserva el grant y reporta una advertencia si falla la auditoría',async()=>{
  process.env.SMTP_HOST='smtp.example.test';process.env.SMTP_FROM='seguridad@example.test';process.env.SMTP_PORT='587';process.env.EMAIL_NOTIFICATIONS_ENABLED='true';
  let generatedBody,newStateHash='',newGrantDeleted=false,mailAccepted=false;
  nodemailer.createTransport=()=>({sendMail:async()=>{mailAccepted=true;return{accepted:['mantenimiento@example.com'],messageId:'mail-maintenance'};},close(){}});
  globalThis.fetch=async(input,init={})=>{const url=new URL(String(input)),method=init.method??'GET';if(url.pathname==='/rest/v1/rpc/security_prepare_user_password_recovery')return json({actor_user_id:7,subsidiary_id:4,user_id:23,email:'mantenimiento@example.com',first_name:'Enlace',last_name:'Vigente'});if(url.pathname==='/rest/v1/users'&&method==='GET')return json([{user_id:23,email:'mantenimiento@example.com',auth_user_id:authId,is_active:true}]);if(url.pathname==='/rest/v1/password_recovery_grants'&&method==='DELETE'&&url.searchParams.has('expires_at'))return new Response(null,{status:204});if(url.pathname==='/rest/v1/password_recovery_grants'&&method==='POST'){newStateHash=JSON.parse(String(init.body)).state_hash;return new Response(null,{status:201});}if(url.pathname==='/auth/v1/admin/generate_link'){generatedBody=JSON.parse(String(init.body));return json({user:{id:authId,email:'mantenimiento@example.com'},action_link:`https://project.example.test/auth/v1/verify?token=secret&type=recovery&redirect_to=${encodeURIComponent(generatedBody.redirect_to)}`,redirect_to:generatedBody.redirect_to});}if(url.pathname==='/rest/v1/rpc/user_password_recovery_email_settings')return json({template:{activo:true,asunto_template:'Recupera {{empresa_nombre}}',cuerpo_template:'<p>Hola {{usuario_nombre}}</p>'},subsidiary:{name:'Empresa'}});if(url.pathname==='/rest/v1/password_recovery_grants'&&method==='DELETE'&&url.searchParams.get('state_hash')===`eq.${newStateHash}`){newGrantDeleted=true;return new Response(null,{status:204});}if(url.pathname==='/rest/v1/rpc/security_audit_user_password_notification')return json({message:'auditoría no disponible'},500);throw new Error(`Solicitud inesperada: ${method} ${url.pathname}${url.search}`);};
  const result=await provisioning.sendExistingUserPasswordLink('Bearer actor',23);
  assert.equal(mailAccepted,true);assert.equal(newGrantDeleted,false);assert.equal(result.sent,true);assert.equal(result.status,'RECUPERACION_ENVIADA_MANTENIMIENTO_PENDIENTE');assert.match(result.message,/auditoría requiere revisión/i);
});

test('si SMTP falla elimina solo el grant nuevo y conserva enlaces anteriores',async()=>{
  process.env.SMTP_HOST='smtp.example.test';process.env.SMTP_FROM='seguridad@example.test';process.env.SMTP_PORT='587';process.env.EMAIL_NOTIFICATIONS_ENABLED='true';
  let generatedBody,newStateHash='',newGrantDeleted=false,olderGrantsDeleted=false;
  nodemailer.createTransport=()=>({sendMail:async()=>{throw new Error('SMTP caído');},close(){}});
  globalThis.fetch=async(input,init={})=>{const url=new URL(String(input)),method=init.method??'GET';if(url.pathname==='/rest/v1/rpc/security_prepare_user_password_recovery')return json({actor_user_id:7,subsidiary_id:4,user_id:22,email:'fallo-correo@example.com',first_name:'Correo',last_name:'Fallido'});if(url.pathname==='/rest/v1/users'&&method==='GET')return json([{user_id:22,email:'fallo-correo@example.com',auth_user_id:authId,is_active:true}]);if(url.pathname==='/rest/v1/password_recovery_grants'&&method==='DELETE'&&url.searchParams.has('expires_at'))return new Response(null,{status:204});if(url.pathname==='/rest/v1/password_recovery_grants'&&method==='POST'){newStateHash=JSON.parse(String(init.body)).state_hash;return new Response(null,{status:201});}if(url.pathname==='/auth/v1/admin/generate_link'){generatedBody=JSON.parse(String(init.body));return json({user:{id:authId,email:'fallo-correo@example.com'},action_link:`https://project.example.test/auth/v1/verify?token=secret&type=recovery&redirect_to=${encodeURIComponent(generatedBody.redirect_to)}`,redirect_to:generatedBody.redirect_to});}if(url.pathname==='/rest/v1/rpc/user_password_recovery_email_settings')return json({template:{activo:true,asunto_template:'Recupera tu acceso a {{empresa_nombre}}',cuerpo_template:'<p>Hola {{usuario_nombre}}</p>'},subsidiary:{name:'Empresa'}});if(url.pathname==='/rest/v1/password_recovery_grants'&&method==='DELETE'){if(url.searchParams.get('state_hash')===`eq.${newStateHash}`)newGrantDeleted=true;else olderGrantsDeleted=true;return new Response(null,{status:204});}if(url.pathname==='/rest/v1/rpc/security_audit_user_password_notification'){assert.deepEqual(JSON.parse(String(init.body)),{p_actor_user_id:7,p_target_user_id:22,p_subsidiary_id:4,p_result:'ERROR'});return json(true);}throw new Error(`Solicitud inesperada: ${method} ${url.pathname}${url.search}`);};
  await assert.rejects(()=>provisioning.sendExistingUserPasswordLink('Bearer actor',22),error=>error?.status===503&&/Revise la configuración SMTP de Railway/i.test(error.message));
  assert.equal(newGrantDeleted,true);assert.equal(olderGrantsDeleted,false);
});

test('completa una invitación de un solo uso y registra la contraseña',async()=>{
  const email='invitado@example.com',state='I'.repeat(43),issuedAt=Math.floor(Date.now()/1000);let consumed=false,updated=false,history=false;
  globalThis.fetch=async(input,init={})=>{const url=new URL(String(input));if(url.pathname==='/auth/v1/user'&&(init.method??'GET')==='GET')return json({id:authId,email});if(url.pathname==='/rest/v1/user_invitation_grants')return json([{invitation_id:1,email_hash:hash(email),auth_user_id:authId,created_at:new Date((issuedAt-5)*1000).toISOString()}]);if(url.pathname==='/rest/v1/users'&&(init.method??'GET')==='GET')return json([{user_id:9,is_active:true}]);if(url.pathname==='/rest/v1/password_history'&&(init.method??'GET')==='GET')return json([]);if(url.pathname==='/rest/v1/rpc/consume_user_invitation_grant'){consumed=true;return json(true);}if(url.pathname==='/auth/v1/user'&&init.method==='PUT'){updated=true;assert.deepEqual(JSON.parse(String(init.body)),{password:'Clave de invitación 2026!'});return json({id:authId,email});}if(url.pathname==='/rest/v1/password_history'&&init.method==='POST'){history=true;return new Response(null,{status:201});}if(url.pathname==='/rest/v1/users'&&init.method==='PATCH')return new Response(null,{status:204});if(url.pathname==='/rest/v1/sessions'&&init.method==='DELETE')return new Response(null,{status:204});if(url.pathname==='/auth/v1/logout')return new Response(null,{status:204});throw new Error(`Solicitud inesperada: ${url.pathname} ${init.method??'GET'}`);};
  const result=await provisioning.completePasswordInvitation(`Bearer ${jwt('otp',issuedAt)}`,{state,invitationType:'invite',newPassword:'Clave de invitación 2026!',confirmation:'Clave de invitación 2026!'});assert.equal(result.success,true);assert.equal(consumed,true);assert.equal(updated,true);assert.equal(history,true);
});

test('un token de sesión por contraseña no puede completar una invitación',async()=>{globalThis.fetch=async()=>{throw new Error('No debe consultar Supabase.');};await assert.rejects(()=>provisioning.completePasswordInvitation(`Bearer ${jwt('password')}`,{state:'J'.repeat(43),invitationType:'invite',newPassword:'Clave de invitación 2026!',confirmation:'Clave de invitación 2026!'}),error=>error?.status===401);});
