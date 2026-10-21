import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import ExcelJS from 'exceljs';
import {
  parseOpeningBankCsv,
  parseOpeningBankFile,
} from '../dist/modules/accounting-catalogs/opening-balances.service.js';

const headers = [
  'codigo_banco',
  'numero_cuenta_bancaria',
  'moneda',
  'tipo_registro',
  'fecha_movimiento',
  'fecha_valor',
  'referencia',
  'beneficiario',
  'descripcion',
  'importe_moneda_original',
  'equivalente_moneda_local',
];

const data = [
  ['001', '000123456789', 'USD', 'SALDO_CONCILIADO', '2026-09-30', '2026-09-30', 'APERTURA', '', 'Saldo conciliado anterior', '900', '486000'],
  ['001', '000123456789', 'USD', 'DEPOSITO_EN_TRANSITO', '2026-09-29', '', 'DEP-001', 'Cliente inicial', 'Deposito pendiente en extracto', '200', '108000'],
  ['001', '000123456789', 'USD', 'CHEQUE_EN_TRANSITO', '2026-09-28', '', 'CHQ-001', 'Proveedor inicial', 'Cheque pendiente en extracto', '100', '54000'],
];

function csv(rows = data) {
  return [headers, ...rows].map(row => row.join(',')).join('\n');
}

test('convierte el auxiliar bancario al contrato firmado y conserva los ceros de la cuenta', () => {
  const result = parseOpeningBankCsv(csv(), '2026-09-30');
  assert.equal(result.length, 3);
  assert.equal(result[0].bankCode, '001');
  assert.equal(result[0].accountNumber, '000123456789');
  assert.deepEqual(
    result.map(item => [item.recordType, item.originalAmount, item.localEquivalent]),
    [
      ['SALDO_CONCILIADO', '900', '486000'],
      ['DEPOSITO_EN_TRANSITO', '200', '108000'],
      ['CHEQUE_EN_TRANSITO', '-100', '-54000'],
    ],
  );
});

test('acepta XLSX y mantiene banco y cuenta como texto', async () => {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Auxiliar de Bancos');
  sheet.addRows([headers, ...data]);
  const content = await workbook.xlsx.writeBuffer();
  const result = await parseOpeningBankFile({
    fileName: 'auxiliar-bancos.xlsx',
    base64: Buffer.from(content).toString('base64'),
  }, '2026-09-30');
  assert.equal(result[0].bankCode, '001');
  assert.equal(result[0].accountNumber, '000123456789');
  assert.equal(result[2].originalAmount, '-100');
});

test('impide dos saldos conciliados para la misma cuenta', () => {
  const duplicate = structuredClone(data);
  duplicate.push(['001', '000123456789', 'USD', 'SALDO_CONCILIADO', '2026-09-30', '', 'APERTURA-2', '', 'Duplicado', '1', '540']);
  assert.throws(
    () => parseOpeningBankCsv(csv(duplicate), '2026-09-30'),
    /ya tiene una fila SALDO_CONCILIADO/,
  );
});

test('acepta un saldo conciliado cero cuando ambas monedas son cero', () => {
  const zeroBalance = structuredClone(data);
  zeroBalance[0][9] = '0';
  zeroBalance[0][10] = '0';
  const result = parseOpeningBankCsv(csv(zeroBalance), '2026-09-30');
  assert.equal(result[0].originalAmount, '0');
  assert.equal(result[0].localEquivalent, '0');
});

test('impide un saldo conciliado cero solo en una de las dos monedas', () => {
  const inconsistentOriginal = structuredClone(data);
  inconsistentOriginal[0][9] = '0';
  assert.throws(
    () => parseOpeningBankCsv(csv(inconsistentOriginal), '2026-09-30'),
    /deben ser ambos cero o ambos distintos de cero/,
  );

  const inconsistentLocal = structuredClone(data);
  inconsistentLocal[0][10] = '0';
  assert.throws(
    () => parseOpeningBankCsv(csv(inconsistentLocal), '2026-09-30'),
    /deben ser ambos cero o ambos distintos de cero/,
  );
});

test('impide fechas posteriores a la apertura e importes no positivos en partidas en transito', () => {
  const future = structuredClone(data);
  future[1][4] = '2026-10-01';
  assert.throws(
    () => parseOpeningBankCsv(csv(future), '2026-09-30'),
    /no puede ser posterior a la fecha de apertura/,
  );

  const negativeTransit = structuredClone(data);
  negativeTransit[2][9] = '-100';
  assert.throws(
    () => parseOpeningBankCsv(csv(negativeTransit), '2026-09-30'),
    /partidas en transito deben ingresarse con importes positivos/,
  );
});

test('las plantillas CSV y Excel comparten el contrato del auxiliar bancario', async () => {
  const csvTemplate = await readFile(new URL('../public/plantilla-saldos-bancos.csv', import.meta.url), 'utf8');
  assert.deepEqual(csvTemplate.replace(/^\uFEFF/, '').split(/\r?\n/, 1)[0].split(','), headers);

  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(new URL('../public/plantilla-saldos-bancos.xlsx', import.meta.url));
  const sheet = workbook.worksheets[0];
  assert.deepEqual(sheet.getRow(1).values.slice(1), headers);
  assert.equal(String(sheet.getCell('B2').value).startsWith('0'), true);
});
