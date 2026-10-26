import assert from 'node:assert/strict';
import test from 'node:test';

const invitation = await import('../dist/modules/notifications/user-invitation-email.js');

const snapshot = {
  empresa_nombre: 'Empresa de Pruebas',
  empresa_logo_url: 'https://assets.example.com/logo.png',
  usuario_nombre: 'María <Administradora>',
  usuario_correo: 'maria@example.com',
  enlace_activacion: 'https://app.example.com/activar?token=secreto-de-un-solo-uso',
  fecha_expiracion: '2026-10-27T18:00:00-06:00'
};

test('renderiza una invitación profesional sin contraseña en claro', () => {
  const result = invitation.renderUserInvitationEmail(
    invitation.userInvitationEmailSubject,
    invitation.userInvitationEmailBody,
    snapshot
  );
  assert.equal(result.subject, 'Activa tu acceso a GENTIA ERP · Empresa de Pruebas');
  assert.match(result.html, /Activar mi cuenta/);
  assert.match(result.html, /Pasos para ingresar/);
  assert.match(result.html, /Cambiar contraseña/);
  assert.match(result.html, /¿Olvidaste tu contraseña\?/);
  assert.match(result.html, /https:\/\/app\.example\.com\/activar\?token=secreto-de-un-solo-uso/);
  assert.match(result.html, /María &lt;Administradora&gt;/);
  assert.doesNotMatch(result.html, /password\s*[:=]/i);
  assert.doesNotMatch(result.html, /contraseña\s*[:=]/i);
});

test('rechaza variables no autorizadas y enlaces inseguros', () => {
  assert.throws(
    () => invitation.renderUserInvitationEmail(
      'Activa tu acceso {{enlace_activacion}}',
      invitation.userInvitationEmailBody,
      snapshot
    ),
    /solo puede utilizarse en el cuerpo/
  );
  assert.throws(
    () => invitation.renderUserInvitationEmail(
      'Acceso {{password}}',
      invitation.userInvitationEmailBody,
      snapshot
    ),
    /Variable no admitida/
  );
  assert.throws(
    () => invitation.renderUserInvitationEmail(
      invitation.userInvitationEmailSubject,
      invitation.userInvitationEmailBody,
      {...snapshot, enlace_activacion: 'http://attacker.example/activar'}
    ),
    /HTTPS/
  );
});

test('rechaza destinatarios inválidos', () => {
  assert.throws(
    () => invitation.renderUserInvitationEmail(
      invitation.userInvitationEmailSubject,
      invitation.userInvitationEmailBody,
      {...snapshot, usuario_correo: 'maria@example.com,evil@example.com'}
    ),
    /correo electrónico válido/
  );
});
