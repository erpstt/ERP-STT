import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const root = new URL('..', import.meta.url);
const source = readFileSync(new URL('../public/accounting-reports.js', import.meta.url), 'utf8');
const html = readFileSync(new URL('../public/accounting-reports.html', import.meta.url), 'utf8');
const css = readFileSync(new URL('../public/accounting-bank-reconciliation.css', import.meta.url), 'utf8');
const syntax = spawnSync(process.execPath, ['--check', 'public/accounting-reports.js'], { cwd: root, encoding: 'utf8' });

assert.equal(syntax.status, 0, syntax.stderr || 'accounting-reports.js no tiene sintaxis válida.');

const candidateStart = source.indexOf('function bankFeeCandidate(row)');
const candidateEnd = source.indexOf('\nfunction selectedBankFeeLines', candidateStart);
assert.ok(candidateStart >= 0 && candidateEnd > candidateStart, 'Falta el filtro de líneas candidatas.');
const candidate = new Function(`return (${source.slice(candidateStart, candidateEnd).replace(/^function bankFeeCandidate/, 'function')})`)();
assert.equal(candidate({ statement_line_id: 7, amount: -25, reconciliation_status: 'PENDIENTE' }), true);
assert.equal(candidate({ statement_line_id: 7, amount: 25, reconciliation_status: 'PENDIENTE' }), false, 'Una entrada no puede registrarse como comisión.');
assert.equal(candidate({ statement_line_id: 7, amount: -25, reconciliation_status: 'CONCILIADO' }), false, 'Una línea conciliada no puede reprocesarse.');
assert.equal(candidate({ statement_line_id: 7, amount: -25, reconciliation_status: 'PENDIENTE', bank_tran_id: 99 }), false, 'Una línea vinculada no puede duplicarse.');
assert.equal(candidate({ amount: -25, reconciliation_status: 'PENDIENTE' }), false, 'La línea debe tener un identificador válido.');

assert.match(source, /dataset\.bankFeeLine/,
  'La hoja debe agregar una casilla de comisión a cada salida pendiente.');
assert.match(source, /Registrar comisiones desde el extracto/,
  'Falta el panel profesional de registro masivo.');
assert.match(source, /bankFeeSelectionCount.*bankFeeSelectionTotal/s,
  'El panel debe informar cantidad y total seleccionados.');
assert.match(source, /confirmBankFeeRegistration\(lines\)/,
  'El lote debe confirmarse antes de contabilizar.');
assert.match(source, /\/api\/reports\/accounting\/bank-reconciliation\/bank-fees/,
  'Falta la llamada al endpoint de comisiones bancarias.');
for (const field of ['p_bank_account_id', 'p_cutoff', 'p_statement_line_ids']) {
  assert.ok(source.includes(field), `Falta ${field} en el payload del lote.`);
}
assert.match(source, /await run\(\);showBankActionMessage\(/,
  'La conciliación debe refrescarse y confirmar el resultado después del registro.');
assert.match(source, /new MutationObserver\(.*enhanceBankFeeWorkspace/s,
  'La mejora debe reaplicarse cuando se actualiza la tabla de conciliación.');

for (const selector of ['.bank-fee-panel', '.bank-fee-check', '.bank-fee-dialog', '#confirmBankFees']) {
  assert.ok(css.includes(selector), `Falta el estilo ${selector}.`);
}
assert.ok(html.includes('accounting-bank-reconciliation.css?v=20261027-bank-fee-batch'));
assert.ok(html.includes('accounting-reports.js?v=20261027-bank-fee-batch'));

console.log('PASS: la hoja permite seleccionar, confirmar y registrar en lote comisiones bancarias pendientes.');
