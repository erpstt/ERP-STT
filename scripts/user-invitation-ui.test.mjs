import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const [app, html, styles, templatesUi, server, invitationEmail, invitationTemplateMigration] = await Promise.all([
  readFile(new URL('../public/app.js', import.meta.url), 'utf8'),
  readFile(new URL('../public/index.html', import.meta.url), 'utf8'),
  readFile(new URL('../public/security-user-invitation.css', import.meta.url), 'utf8'),
  readFile(new URL('../public/notification-templates.js', import.meta.url), 'utf8'),
  readFile(new URL('../src/server.ts', import.meta.url), 'utf8'),
  readFile(new URL('../src/modules/notifications/user-invitation-email.ts', import.meta.url), 'utf8'),
  readFile(new URL('../supabase/migrations/20261026103000_user_invitation_email_template.sql', import.meta.url), 'utf8')
]);

const usersCatalog = app.slice(app.indexOf("{slug:'users'"), app.indexOf("{slug:'roles'"));

test('el alta de usuario propone notificación por correo y nunca pide una contraseña', () => {
  assert.match(usersCatalog, /key:'notify_user'/);
  assert.match(usersCatalog, /defaultValue:true/);
  assert.match(usersCatalog, /createOnly:true/);
  assert.doesNotMatch(usersCatalog, /password_hash/);
  assert.match(html, /Sin correo automático/);
});

test('notify_user no se envía al editar un usuario existente', () => {
  assert.match(app, /slug==='users'&&id\)delete payload\.notify_user/);
  assert.match(app, /Usuario creado sin notificación/);
});

test('el mensaje de invitación no reemplaza ni oculta la tabla', () => {
  assert.match(app, /tableNotice:''/);
  assert.match(app, /this\.tableNotice=`✓ \$\{userNotice\}`/);
  assert.match(app, /this\.tableNotice=''/);
  assert.match(html, /v-if="tableNotice"[^>]*form-success/);
  assert.match(html, /v-else-if="tableError"[^>]*form-error/);
});

test('la invitación permite definir contraseña sin persistir el token', () => {
  assert.match(app, /password_invitation/);
  assert.match(app, /fragmentType==='invite'/);
  assert.match(app, /\/api\/auth\/complete-password-invitation/);
  assert.match(app, /invitationType:'invite'/);
  assert.match(app, /url\.hash=''/);
  assert.doesNotMatch(app.slice(app.indexOf('initializePasswordRecovery(){'), app.indexOf('async selectRole(')), /setItem\(/);
});

test('la presentación diferencia invitación, activación y recuperación', () => {
  assert.match(html, /INVITACIÓN VERIFICADA/);
  assert.match(html, /CUENTA ACTIVADA/);
  assert.match(styles, /\.user-invitation-field/);
  assert.match(styles, /\.table-message\.form-success/);
});

test('el endpoint de plantillas separa permisos de consulta y edición', () => {
  assert.match(server, /resourceKey='configuration:notification-templates'/);
  assert.match(server, /action==='save'\?'edit':'view'/);
  assert.match(server, /grant\.resourceKey==='legacy:all'/);
  assert.match(server, /grant\.resourceKey===resourceKey&&grant\.canEdit/);
});

test('el RPC de invitación aplica la misma matriz de permisos', () => {
  assert.match(invitationTemplateMigration, /security_assert_role_access\([\s\S]*'configuration:notification-templates'/);
  assert.match(invitationTemplateMigration, /when action_name='save' then 'edit'[\s\S]*else 'view'/);
  assert.match(invitationTemplateMigration, /access\.resource_key='legacy:all'/);
  assert.match(invitationTemplateMigration, /'canEdit',can_edit/);
  assert.doesNotMatch(invitationTemplateMigration, /Solo un administrador puede modificar la plantilla/);
});

test('el envío interno usa permiso de alta de usuarios sin exigir acceso a plantillas', () => {
  assert.match(invitationEmail, /p_action: 'delivery'/);
  assert.match(invitationTemplateMigration, /when action_name='delivery' then 'security:users'/);
  assert.match(invitationTemplateMigration, /when action_name='delivery' then 'create'/);
  assert.match(invitationTemplateMigration, /action_name not in\('get','save','delivery'\)/);
});

test('la pantalla respeta canEdit y mantiene Guardar deshabilitado en solo lectura', () => {
  assert.match(templatesUi, /applyEditAccess\(data\.canEdit===true\)/);
  assert.match(templatesUi, /\$\('save'\)\.disabled=!templateCanEdit/);
  assert.match(templatesUi, /\$\('subject'\)\.readOnly=!templateCanEdit/);
  assert.match(templatesUi, /\$\('editor'\)\.contentEditable=String\(templateCanEdit\)/);
  assert.match(templatesUi, /if\(!templateCanEdit\)\{report\('Su rol permite consultar la plantilla, pero no modificarla\.'/);
});
