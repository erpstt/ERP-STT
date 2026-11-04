import assert from 'node:assert/strict';
import {test} from 'node:test';
import {paymentRequestApprovedTemplateSettings,paymentRequestApprovedEmailTags} from '../dist/modules/notifications/payment-request-approved-email.js';
import {primeRoleAccessCache,invalidateRoleAccessCaches} from '../dist/modules/security-catalogs/role-access-matrix.module.js';
import {getOrganizationCatalog} from '../dist/modules/organization-catalogs/organization-catalogs.module.js';

const auth='Bearer synthetic-approved-template';
const template={asunto_template:'Solicitud {{numero_solicitud}}',cuerpo_template:'<p>Detalle {{concepto}}</p><img src=x onerror=alert(1)>',activo:true};
async function fixture(t,{view=true,edit=false,status=200,result={template,subsidiary:{id:24,name:'Empresa sintética'}}}={}){
 const oldFetch=globalThis.fetch,keys=['SUPABASE_URL','SUPABASE_ANON_KEY','GENTIA_APP_URL'],before=Object.fromEntries(keys.map(key=>[key,process.env[key]])),calls=[];
 Object.assign(process.env,{SUPABASE_URL:'https://approved-template.invalid',SUPABASE_ANON_KEY:'synthetic-public-key',GENTIA_APP_URL:'https://erp.example.invalid'});
 await primeRoleAccessCache(auth,{isAdmin:false,grants:[{resourceKey:'configuration:notification-templates',canView:view,canEdit:edit,canCreate:false,canDelete:false}]});
 globalThis.fetch=async(input,init)=>{const url=new URL(String(input)),headers=new Headers(init.headers);assert.equal(url.origin,'https://approved-template.invalid');assert.equal(url.pathname,'/rest/v1/rpc/payment_request_approved_email_settings');calls.push({authorization:headers.get('authorization'),key:headers.get('apikey'),input:JSON.parse(init.body)});return Response.json(result,{status});};
 t.after(()=>{globalThis.fetch=oldFetch;for(const[key,value]of Object.entries(before))if(value===undefined)delete process.env[key];else process.env[key]=value;invalidateRoleAccessCaches();});return calls;
}

test('template GET is tenant-scoped by the caller JWT, sanitizes stored HTML and exposes only the new tag contract',async t=>{
 const calls=await fixture(t),result=await paymentRequestApprovedTemplateSettings(auth,'get',{subsidiaryId:999});
 assert.deepEqual(calls,[{authorization:auth,key:'synthetic-public-key',input:{p_action:'get',p_payload:{}}}]);assert.equal(result.subsidiary.id,24);assert.ok(!result.template.cuerpo_template.includes('<img'));assert.deepEqual(result.variables,paymentRequestApprovedEmailTags);assert.ok(result.variables.includes('fecha_aprobacion'));assert.ok(!result.variables.includes('treasury_email'));
});

test('template SAVE requires edit and forwards only cleaned subject/body/active without a tenant override',async t=>{
 const calls=await fixture(t,{edit:true});await paymentRequestApprovedTemplateSettings(auth,'save',{subject:'Aprobada {{numero_solicitud}}',body:'<p>{{beneficiario_nombre}}</p><script>bad()</script>',active:true,subsidiaryId:999,email:'other@example.invalid'});
 assert.equal(calls.length,1);assert.equal(calls[0].authorization,auth);assert.deepEqual(calls[0].input,{p_action:'save',p_payload:{subject:'Aprobada {{numero_solicitud}}',body:'<p>{{beneficiario_nombre}}</p>',active:true}});
});

test('preview renders synthetic request data and a scoped read link, without claim, SMTP or side-effect RPCs',async t=>{
 const calls=await fixture(t),result=await paymentRequestApprovedTemplateSettings(auth,'preview',{subject:'Aviso {{numero_solicitud}}',body:'<p>{{concepto}}</p>'});
 assert.equal(calls.length,1);assert.equal(calls[0].input.p_action,'get');assert.ok(result.subject.includes('EJEMPLO'));assert.ok(result.html.includes('id=128&amp;subsidiaryId=24'));assert.ok(result.html.includes('Importe aprobado de la solicitud'));assert.ok(!result.html.includes('other@example.invalid'));
});

test('anonymous, unrelated roles and view-only writers are denied before requesting any template',async t=>{
 const calls=await fixture(t);await assert.rejects(paymentRequestApprovedTemplateSettings('','get',{}),error=>error.status===401);await assert.rejects(paymentRequestApprovedTemplateSettings(auth,'save',{subject:'A',body:'<p>A</p>'}),error=>error.status===403);assert.equal(calls.length,0);
 await primeRoleAccessCache(auth,{isAdmin:false,grants:[]});await assert.rejects(paymentRequestApprovedTemplateSettings(auth,'get',{}),error=>error.status===403);assert.equal(calls.length,0);
});

test('invalid actions, header injection and unknown placeholders fail before a save RPC',async t=>{
 const calls=await fixture(t,{edit:true});await assert.rejects(paymentRequestApprovedTemplateSettings(auth,'send',{}),error=>error.status===400);
 await assert.rejects(paymentRequestApprovedTemplateSettings(auth,'save',{subject:'Aviso\r\nBcc: bad@example.invalid',body:'<p>Detalle</p>'}),/sin saltos/);
 await assert.rejects(paymentRequestApprovedTemplateSettings(auth,'save',{subject:'Aviso',body:'<p>{{variable_ajena}}</p>'}),/Variable no admitida/);await assert.rejects(paymentRequestApprovedTemplateSettings(auth,'get',null),error=>error.status===400);assert.equal(calls.length,0);
});

test('SQL scope denial stays 403 with a fixed message and no payment-template fallback',async t=>{
 const calls=await fixture(t,{status:403,result:{code:'42501',message:'Synthetic private detail'}});await assert.rejects(paymentRequestApprovedTemplateSettings(auth,'get',{}),error=>error.status===403&&!error.message.includes('private'));assert.equal(calls.length,1);
});

test('Treasury address is an optional company field separate from the general contact email',()=>{
 const fields=getOrganizationCatalog('subsidiaries').fields;assert.equal(fields.filter(field=>field.key==='treasury_email').length,1);assert.equal(fields.find(field=>field.key==='treasury_email').required,undefined);assert.ok(fields.some(field=>field.key==='email'));assert.equal(fields.find(field=>field.key==='treasury_email').type,'text');
});
