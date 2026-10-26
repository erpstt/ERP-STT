import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const [html, app, styles] = await Promise.all([
  readFile(new URL('../public/index.html', import.meta.url), 'utf8'),
  readFile(new URL('../public/app.js', import.meta.url), 'utf8'),
  readFile(new URL('../public/password-recovery.css', import.meta.url), 'utf8')
]);
const recoveryCode = app.slice(app.indexOf('initializePasswordRecovery(){'), app.indexOf('async selectRole('));

test('el acceso ofrece solicitud y finalización de recuperación', () => {
  assert.match(html, /¿Olvidaste tu contraseña\?/);
  assert.match(html, /submitPasswordRecoveryRequest/);
  assert.match(html, /submitPasswordRecoveryCompletion/);
  assert.match(app, /\/api\/auth\/request-password-recovery/);
  assert.match(app, /\/api\/auth\/complete-password-recovery/);
});

test('el token de recuperación se retira de la URL y nunca se persiste', () => {
  assert.match(app, /url\.hash=''/);
  assert.match(app, /history\.replaceState/);
  assert.match(app, /fragment\.get\('access_token'\)/);
  assert.doesNotMatch(recoveryCode, /setItem\(/);
});

test('el formulario usa estado opaco y el token solo como autorización', () => {
  assert.match(recoveryCode, /'Authorization':`Bearer \$\{this\.passwordRecovery\.accessToken\}`/);
  assert.match(app, /state:this\.passwordRecovery\.state/);
  assert.match(app, /recoveryType:'recovery'/);
  assert.match(html, /minlength="15"/);
  assert.match(html, /maxlength="128"/);
});

test('la confirmación de solicitud no permite enumerar cuentas', () => {
  assert.match(app, /Si el correo pertenece a una cuenta activa/);
  assert.match(html, /siempre mostraremos la misma confirmación/i);
  assert.match(styles, /\.recovery-result/);
});
