import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const app = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const syntax = spawnSync(process.execPath, ['--check', 'public/app.js'], {
  cwd: new URL('..', import.meta.url),
  encoding: 'utf8'
});

assert.equal(syntax.status, 0, syntax.stderr || 'public/app.js no tiene sintaxis válida.');

const catalog = app.match(/\{slug:'bank-statements'.*?\}\]},/s)?.[0] ?? '';
assert.ok(catalog, 'Falta el catálogo frontend de extractos bancarios.');
assert.match(catalog, /key:'bank_account_id'.*reference:'banking\/bank-accounts'.*activeSubsidiaryOnly:true/s,
  'El selector de cuentas debe limitarse a la subsidiaria activa.');

assert.match(app, /activeSubsidiaryOnly.*activeCompany\?\.subsidiaryId.*option\.subsidiary_id/s,
  'Falta el filtro de opciones por la subsidiaria activa.');
assert.match(app, /isBankStatementAccounts.*\/api\/banking\/bank-statements\/account-options/s,
  'El formulario debe usar el endpoint dedicado de cuentas enriquecidas de la empresa activa.');
assert.doesNotMatch(app, /slug==='bank-statements'\)references\.push\('banking\/banks','core\/currencies'\)/,
  'El selector no debe depender de permisos separados para bancos y monedas.');
assert.match(app, /slug==='bank-statements'&&field\.key==='bank_account_id'.*bank_name.*account_number.*currency_code/s,
  'La etiqueta debe combinar banco, número de cuenta y moneda.');
assert.match(app, /\[bankName,accountNumber,currencyCode\]\.filter\(Boolean\)\.join\(' · '\)/,
  'La cuenta bancaria debe presentarse en un formato legible y profesional.');

console.log('PASS: las cuentas del extracto se filtran por empresa activa y muestran banco, número y moneda.');
