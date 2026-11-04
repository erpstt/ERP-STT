import assert from 'node:assert/strict';
import {test} from 'node:test';
import {assertIsolatedTestArgs} from './lib/migration-preview.mjs';

assertIsolatedTestArgs();
const {isolatedRoleTemplateDatabase,assumeSecurityUser,assumeSqlRole,beginIsolatedCase,deniedSql}=await import('./fixtures/isolated-role-template-security.mjs');
const db=await isolatedRoleTemplateDatabase({templates:true});
test.after(()=>db.close());
const rows=async(sql,params=[])=>(await db.query(sql,params)).rows;
const value=async(sql,params=[])=>(await rows(sql,params))[0]?.value;
const settings=(action='get',payload={})=>value('select user_invitation_email_settings($1,$2) value',[action,payload]);
const deny=(action='get',payload={},code='42501')=>deniedSql(db,'select user_invitation_email_settings($1,$2)',[action,payload],code);
const valid={subject:'Bienvenido {{usuario_nombre}} · {{empresa_nombre}}',body:'<p>Activa tu acceso con {{enlace_activacion}} antes de {{fecha_expiracion}}.</p>',active:true};

test('central administrator reads a seeded invitation template with five allowed variables and no stored activation credential',async t=>{
 await beginIsolatedCase(db,t);await assumeSecurityUser(db,4,5);
 const data=await settings();assert.equal(data.canEdit,true);assert.equal(data.template.tipo_notificacion,'USUARIO_INVITACION');assert.equal(data.subsidiary.id,1);
 assert.deepEqual(data.variables,['empresa_nombre','usuario_nombre','usuario_correo','enlace_activacion','fecha_expiracion']);
 assert.match(data.template.asunto_template,/GENTIA ERP/);assert.match(data.template.cuerpo_template,/\{\{fecha_expiracion\}\}/);assert.doesNotMatch(data.template.cuerpo_template,/contraseña\s*[:=]|https?:\/\//i);
 assert.ok(!Object.keys(data.template).some(key=>/token|password|auth_user/i.test(key)));
});

test('a template viewer can read but cannot save or request user-delivery access',async t=>{
 await beginIsolatedCase(db,t);await assumeSecurityUser(db,1,3);
 const readOnly=await settings();assert.equal(readOnly.canEdit,false);await deny('save',valid);await deny('delivery');
});

test('an explicit template editor saves only the selected company and audit email comes from the ERP identity',async t=>{
 await beginIsolatedCase(db,t);await assumeSecurityUser(db,4,5,2);const other=await settings();
 await assumeSecurityUser(db,3,1,1);assert.equal((await settings()).canEdit,true);
 const saved=await settings('save',valid);assert.equal(saved.template.asunto_template,valid.subject);assert.equal(saved.template.cuerpo_template,valid.body);assert.equal(saved.template.activo,true);assert.equal(saved.template.updated_by_email,'synthetic-3@example.invalid');
 assert.ok(!JSON.stringify(saved).includes('forged-header'));
 await assumeSecurityUser(db,4,5,2);assert.deepEqual((await settings()).template,other.template);
});

test('a delegated user-creation matrix row no longer delegates invitation delivery; the central administrator retains delivery',async t=>{
 await beginIsolatedCase(db,t);await assumeSecurityUser(db,1,2);
 await deny('delivery');await deny('get');await deny('save',valid);
 await assumeSecurityUser(db,4,5);const delivered=await settings('delivery');
 assert.equal(delivered.template.tipo_notificacion,'USUARIO_INVITACION');assert.equal(delivered.canEdit,true);
 // This SQL operation retrieves a template only; no Auth link or SMTP is used.
 assert.match(delivered.template.cuerpo_template,/enlace/i);assert.doesNotMatch(delivered.template.cuerpo_template,/https?:\/\//i);
});

test('disallowed variables, activation links in subjects, CRLF and size violations leave the current template unchanged',async t=>{
 await beginIsolatedCase(db,t);await assumeSecurityUser(db,3,1);const initial=await settings();
 for(const payload of[
  {...valid,subject:'Acceso {{password}}'},
  {...valid,body:'<p>{{secret}}</p>'},
  {...valid,subject:'Acceso {{ enlace_activacion }}'},
  {...valid,subject:'Acceso\r\nBcc: synthetic@example.invalid'},
  {...valid,subject:''},
  {...valid,subject:'x'.repeat(201)},
  {...valid,body:''},
  {...valid,body:'x'.repeat(20001)}
 ])await deny('save',payload,'22023');
 await deny('unsupported',{},'22023');assert.deepEqual((await settings()).template,initial.template);
});

test('valid central updates preserve template placeholders and the active switch without generating or persisting a link',async t=>{
 await beginIsolatedCase(db,t);await assumeSecurityUser(db,4,5);
 const saved=await settings('save',{...valid,active:false});assert.equal(saved.template.activo,false);assert.equal(saved.template.updated_by_email,'synthetic-4@example.invalid');
 assert.equal(saved.template.cuerpo_template,valid.body);assert.ok(!Object.hasOwn(saved,'activationUrl'));assert.ok(!Object.hasOwn(saved,'accessToken'));
 assert.deepEqual((await settings()).template,saved.template);
});

test('anonymous/service function access and direct ensure-template execution remain denied under current grants',async t=>{
 await beginIsolatedCase(db,t);
 const privileges=(await rows("select has_function_privilege('anon','user_invitation_email_settings(text,jsonb)','execute') anon_execute,has_function_privilege('authenticated','user_invitation_email_settings(text,jsonb)','execute') authenticated_execute,has_function_privilege('authenticated','user_invitation_email_ensure_template(bigint)','execute') ensure_execute"))[0];
 assert.deepEqual(privileges,{anon_execute:false,authenticated_execute:true,ensure_execute:false});
 for(const role of['anon','service_role']){await assumeSqlRole(db,role);await deny();}
 await assumeSecurityUser(db,4,5);await deniedSql(db,'select user_invitation_email_ensure_template(1)');
 await db.exec('reset role');
 assert.equal(await value("select count(*)::int value from pg_proc where proname in('security_assert_role_access','security_resource_allowed','user_invitation_email_settings') and prosrc like '%legacy:all%'"),0);
 await deniedSql(db,"insert into role_access_matrix(role_id,resource_key,can_view,can_create,can_edit,can_delete) values(3,'legacy:all',true,true,true,true)",[],'23514');
});

test('revoked sessions, a wrong device and unauthorized company selections cannot read or save templates',async t=>{
 await beginIsolatedCase(db,t);
 await assumeSecurityUser(db,3,1,2);await deny();await deny('save',valid);
 await assumeSecurityUser(db,3,1,1,1);await deny();
 await db.exec('reset role;update sessions set revoked_at=now() where user_id=3');await assumeSecurityUser(db,3,1);await deny();await deny('save',valid);
 await db.exec('reset role');await deniedSql(db,'select user_invitation_email_ensure_template(3)',[],'22023');
});
