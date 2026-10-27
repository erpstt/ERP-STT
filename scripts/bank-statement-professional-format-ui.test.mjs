import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const root = new URL('..', import.meta.url);
const app = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const css = readFileSync(new URL('../public/dashboard.css', import.meta.url), 'utf8');
const syntax = spawnSync(process.execPath, ['--check', 'public/app.js'], {
  cwd: root,
  encoding: 'utf8'
});

assert.equal(syntax.status, 0, syntax.stderr || 'public/app.js no tiene sintaxis válida.');

const methodBlock = (startMarker, endMarker) => {
  const start = app.indexOf(startMarker);
  const end = app.indexOf(endMarker, start + startMarker.length);
  assert.ok(start >= 0 && end > start, `No fue posible aislar ${startMarker}.`);
  return app.slice(start, end);
};

const catalog = app.match(/\{slug:'bank-statements'.*?\}\]},/s)?.[0] ?? '';
assert.ok(catalog, 'Falta la configuración de Extractos bancarios.');
for (const key of ['opening_balance', 'closing_balance']) {
  assert.match(
    catalog,
    new RegExp(`key:'${key}'[^}]*numberFormat:'money'`),
    `${key} debe declararse como importe monetario.`
  );
}

for (const helper of [
  'parseLocalizedAmount',
  'formatBankStatementAmount',
  'formatBankStatementMoneyField',
  'normalizeBankStatementPayload',
  'bankStatementCurrencyCode'
]) {
  assert.match(app, new RegExp(`${helper}\\s*\\(`), `Falta el helper ${helper}.`);
}

const parserMethod = methodBlock('parseLocalizedAmount(value){', 'formatBankStatementAmount(value');
const parserBody = parserMethod.slice(parserMethod.indexOf('{') + 1, parserMethod.lastIndexOf('},'));
const parseLocalizedAmount = new Function('value', parserBody);
for (const [source, expected] of [
  ['20 895,66', 20895.66],
  ['20895.66', 20895.66],
  ['-5 399,02', -5399.02],
  ['(5 399,02)', -5399.02]
]) {
  assert.equal(parseLocalizedAmount(source), expected, `No se interpretó correctamente: ${source}`);
}
for (const source of ['abc123', '12-3', '1e3', '1..2', '1000,123', '1000.123', '0,123']) {
  assert.equal(parseLocalizedAmount(source), null, `Debe rechazarse el importe ambiguo: ${source}`);
}

const submitRecord = methodBlock('async submitRecord()', 'async calculateConsolidatedRates');
const normalizeAt = submitRecord.indexOf('normalizeBankStatementPayload(payload)');
const requestAt = submitRecord.indexOf('this.api(');
assert.ok(
  normalizeAt >= 0 && requestAt > normalizeAt,
  'El payload debe normalizar los importes antes de enviarlos al backend.'
);

const displayValue = methodBlock('displayValue(field,value)', 'parseLocalizedAmount(value)');
assert.ok(
  displayValue.includes("field.numberFormat==='money'")
    && displayValue.includes('formatBankStatementAmount(value'),
  'La tabla debe derivar los campos monetarios al formateador regional.'
);
assert.ok(
  app.includes("toLocaleString('es-CR',{minimumFractionDigits:2,maximumFractionDigits:2,useGrouping:true})")
    || app.includes("new Intl.NumberFormat('es-CR'"),
  'Los saldos deben mostrarse con agrupación y exactamente dos decimales.'
);
assert.ok(
  displayValue.includes("field.key==='statement_date'")
    && displayValue.includes('formatBankStatementDate(value)'),
  'La fecha del listado debe presentarse con el formateador local legible.'
);
assert.ok(
  app.includes("new Intl.DateTimeFormat('es-CR'"),
  'La fecha del extracto debe usar la configuración regional es-CR.'
);
assert.ok(
  displayValue.includes('referenceChoiceLabel(field,option)')
    && app.includes("field.key==='bank_account_id'")
    && app.includes("join(' · ')"),
  'La tabla debe conservar Banco · Cuenta · Moneda en la columna de cuenta bancaria.'
);

assert.match(html, /'bank-statement-modal':activeCatalog\.slug==='bank-statements'/,
  'El formulario debe utilizar una variante visual dedicada.');
assert.match(html, /class="bank-statement-form-overview"/,
  'Falta el resumen de contexto del extracto.');
assert.match(html, /class="bank-statement-money-input"/,
  'Falta el contenedor visual de importes monetarios.');
assert.match(html, /inputmode="decimal"/,
  'Los saldos deben abrir teclado decimal y aceptar entrada localizada.');
assert.match(html, /formatBankStatementMoneyField\(field\.key\)/,
  'Los importes deben formatearse al terminar la edición.');
assert.match(html, /'bank-statement-table-card':activeCatalog\.slug==='bank-statements'/,
  'El listado debe utilizar su variante visual de extractos bancarios.');

for (const selector of [
  '.bank-statement-modal',
  '.bank-statement-form-overview',
  '.bank-statement-money-input',
  '.bank-statement-table-card',
  '.field-opening_balance',
  '.field-closing_balance'
]) {
  assert.ok(css.includes(selector), `Falta el estilo ${selector}.`);
}

console.log('PASS: formulario y listado de extractos presentan fechas, cuentas y saldos con formato profesional.');
