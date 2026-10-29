import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const source = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');

function method(start, end) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from + start.length);
  assert.ok(from >= 0 && to > from, `No se encontró el bloque ${start}`);
  return source.slice(from, to);
}

test('el arranque autenticado usa una sola solicitud bootstrap con el contexto preferido', () => {
  const request = method('async requestBootstrap', 'applyRoleAccessContext');
  const restore = method('async restoreSession', 'async signIn()');
  const signIn = method('async signIn()', 'initializePasswordRecovery');

  assert.match(request, /fetch\('\/api\/auth\/bootstrap'/);
  assert.match(request, /method:'POST'/);
  assert.match(request, /preferredRoleId,preferredSubsidiaryId/);
  assert.match(request, /'X-Device-Token':this\.deviceToken\(\)/);

  assert.equal((restore.match(/requestBootstrap\(/g) ?? []).length, 1);
  assert.match(restore, /storedContextId\('nexo_role'\)/);
  assert.match(restore, /storedContextId\('nexo_company'\)/);
  assert.match(restore, /if\(context\)await this\.applyBootstrapContext\(context\);else await this\.loadLegacySessionContext/);
  assert.doesNotMatch(restore, /['"]\/api\/auth\/(roles|companies|select-role|select-company)/);

  assert.equal((signIn.match(/requestBootstrap\(/g) ?? []).length, 1);
  assert.match(signIn, /storedContextId\('nexo_role'\)/);
  assert.match(signIn, /getPendingWorkspace\(\)/);
  assert.doesNotMatch(signIn, /['"]\/api\/auth\/(roles|companies|select-role|select-company)/);
});

test('el bootstrap conserva selector de empresa, permisos, idioma y activación local', () => {
  const apply = method('async applyBootstrapContext', 'async loadLegacySessionContext');
  const activeCompany = method('async applyActiveCompanyContext', 'async applyBootstrapContext');
  const selectCompany = method('async selectCompany(company)', 'changeCompany()');

  assert.match(apply, /syncLanguageOptions\(context\.languages\)/);
  assert.match(apply, /applyLanguage\(locale\)/);
  assert.match(apply, /applyRoleAccessContext\(context\.roleAccess\)/);
  assert.match(apply, /context\.requiresCompanySelection/);
  assert.match(apply, /this\.companies\.length>1/);
  assert.match(apply, /applyActiveCompanyContext\(context\.activeCompany\)/);
  assert.match(apply, /localStorage\.removeItem\('nexo_company'\)/);
  assert.match(apply, /localStorage\.removeItem\('nexo_company_name'\)/);
  assert.match(apply, /localStorage\.removeItem\('nexo_allowed_currencies'\)/);
  assert.match(apply, /this\.allowedCurrencyIds=\[\]/);
  assert.match(activeCompany, /allowedCurrencyIds/);
  assert.match(activeCompany, /updateCompanyLogo\(\)/);
  assert.match(activeCompany, /resumePendingWorkspace\(\)/);
  assert.match(selectCompany, /applyActiveCompanyContext\(selected\)/);
});

test('el despliegue rodante conserva fallback únicamente cuando bootstrap no existe', () => {
  const request = method('async requestBootstrap', 'applyRoleAccessContext');
  const legacy = method('async loadLegacySessionContext', 'async restoreSession');

  assert.match(request, /\[404,405\]\.includes\(response\.status\)\)return null/);
  assert.match(request, /if\(!response\.ok\)/);
  assert.match(request, /Number\(data\?\.bootstrapVersion\)===1\?data:null/);
  assert.match(legacy, /loadLanguagePreference\(\)/);
  assert.match(legacy, /['"]\/api\/auth\/roles['"]/);
  assert.match(legacy, /['"]\/api\/auth\/companies\?view=summary['"]/);
  assert.match(legacy, /selectRole\(role,false\)/);
  assert.match(legacy, /selectInitialCompany\(company\|\|null\)/);
});
