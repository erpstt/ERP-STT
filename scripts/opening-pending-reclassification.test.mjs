import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ExcelJS from 'exceljs';
import { parseOpeningPendingCsv } from '../dist/modules/accounting-catalogs/opening-balances.service.js';

const headers = [
  'referencia_pendiente',
  'tipo_periodo',
  'fecha_origen',
  'identificacion_cliente',
  'moneda',
  'tipo_cambio_historico',
  'cuenta',
  'debito_moneda_local',
  'credito_moneda_local',
  'debito_moneda_original',
  'credito_moneda_original',
  'es_linea_control',
  'mes_servicio',
  'pais_servicio',
  'departamento',
  'centro_costos',
  'clase',
  'acreedor_financiero',
  'compania_relacionada',
  'sucursal',
  'nota',
  'url_respaldo',
];

function rows(periodType, controlAccount, counterpartAccount) {
  return [
    ['PEN-INI-FX-001', periodType, '2025-12-31', '111', 'USD', '520', controlAccount, '260000', '', '500', '', 'SI', '2025-12', 'CRI', 'Administrativo', 'CC-ADM', '', '', '', '', 'Saldo histórico', ''],
    ['PEN-INI-FX-001', periodType, '2025-12-31', '111', 'USD', '520', counterpartAccount, '', '260000', '', '500', 'NO', '2025-12', 'CRI', 'Administrativo', 'CC-ADM', '', '', '', '', 'Saldo histórico', ''],
  ];
}

function csv(data) {
  return [headers, ...data].map((row) => row.join(',')).join('\n');
}

test('ACTUAL acepta exclusivamente Dr 113003 / Cr 413001 y conserva la tasa histórica', () => {
  const [item] = parseOpeningPendingCsv(csv(rows('ACTUAL', '113003', '413001')), '2026-01-01');
  assert.equal(item.periodType, 'ACTUAL');
  assert.equal(Number(item.exchangeRate), 520);
  assert.deepEqual(item.lines.map((line) => [line.account, line.isControlLine]), [
    ['113003', true],
    ['413001', false],
  ]);
  assert.equal(Number(item.lines[0].debit), 260000);
  assert.equal(Number(item.lines[0].debitFx), 500);
});

test('ANTERIOR acepta exclusivamente Dr 113004 / Cr 413002', () => {
  const [item] = parseOpeningPendingCsv(csv(rows('ANTERIOR', '113004', '413002')), '2026-01-01');
  assert.equal(item.periodType, 'ANTERIOR');
  assert.deepEqual(item.lines.map((line) => [line.account, line.isControlLine]), [
    ['113004', true],
    ['413002', false],
  ]);
});

test('rechaza una pareja contable cruzada entre período actual y anterior', () => {
  assert.throws(
    () => parseOpeningPendingCsv(csv(rows('ACTUAL', '113003', '413002')), '2026-01-01'),
    /113003.*413001|composición.*ACTUAL|cuentas.*ACTUAL/i,
  );
  assert.throws(
    () => parseOpeningPendingCsv(csv(rows('ANTERIOR', '113004', '413001')), '2026-01-01'),
    /113004.*413002|composición.*ANTERIOR|cuentas.*ANTERIOR/i,
  );
});

test('rechaza tipo_periodo distinto entre las dos líneas de la misma referencia', () => {
  const data = rows('ACTUAL', '113003', '413001');
  data[1][1] = 'ANTERIOR';
  assert.throws(
    () => parseOpeningPendingCsv(csv(data), '2026-01-01'),
    /tipo.*período.*igual|tipo_periodo/i,
  );
});

test('rechaza un tipo_periodo fuera del catálogo contable', () => {
  assert.throws(
    () => parseOpeningPendingCsv(csv(rows('HISTORICO', '113004', '413002')), '2026-01-01'),
    /tipo_periodo debe ser ACTUAL o ANTERIOR/i,
  );
});

test('rechaza importes que no corresponden a moneda original por tasa histórica', () => {
  const data = rows('ANTERIOR', '113004', '413002');
  data[0][7] = '259999';
  data[1][8] = '259999';
  assert.throws(
    () => parseOpeningPendingCsv(csv(data), '2026-01-01'),
    /tipo de cambio indicado/i,
  );
});

test('las plantillas CSV y Excel publican tipo_periodo y ambas parejas contables', async () => {
  const csvBuffer = await readFile(new URL('../public/plantilla-saldos-pendientes-facturar.csv', import.meta.url));
  assert.deepEqual([...csvBuffer.subarray(0, 3)], [0xef, 0xbb, 0xbf], 'El CSV debe conservar BOM UTF-8 para Excel.');
  const csvText = csvBuffer.toString('utf8').replace(/^\ufeff/, '');
  const csvRows = csvText.trim().split(/\r?\n/).map((line) => line.split(','));
  assert.equal(csvRows[0][1], 'tipo_periodo');
  assert.ok(csvRows.some((row) => row[1] === 'ACTUAL' && row[6] === '113003'));
  assert.ok(csvRows.some((row) => row[1] === 'ACTUAL' && row[6] === '413001'));
  assert.ok(csvRows.some((row) => row[1] === 'ANTERIOR' && row[6] === '113004'));
  assert.ok(csvRows.some((row) => row[1] === 'ANTERIOR' && row[6] === '413002'));

  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(new URL('../public/plantilla-saldos-pendientes-facturar.xlsx', import.meta.url));
  const sheet = workbook.worksheets[0];
  const values = [];
  sheet.eachRow((row) => values.push(row.values.slice(1).map((value) => String(value ?? '').trim())));
  assert.equal(values[0][1], 'tipo_periodo');
  assert.ok(values.some((row) => row[1] === 'ACTUAL' && row[6] === '113003'));
  assert.ok(values.some((row) => row[1] === 'ANTERIOR' && row[6] === '113004'));
  assert.ok(values.some((row) => row[1] === 'ANTERIOR' && row[6] === '413002'));
});

test('la pantalla de apertura explica y presenta por separado ambos tipos de período', async () => {
  const [html, script] = await Promise.all([
    readFile(new URL('../public/opening-balances.html', import.meta.url), 'utf8'),
    readFile(new URL('../public/opening-balances.js', import.meta.url), 'utf8'),
  ]);
  assert.match(html, /ACTUAL[\s\S]*113003[\s\S]*413001/i);
  assert.match(html, /ANTERIOR[\s\S]*113004[\s\S]*413002/i);
  assert.match(html, /Tipo de período/i);
  assert.match(script, /periodType[\s\S]*period_type/);
  assert.match(script, /Períodos anteriores/);
});

test('Control de Pendientes expone filtro, columna y botón protegido de reclasificación', async () => {
  const [html, script, accessMatrix] = await Promise.all([
    readFile(new URL('../public/accounting-reports.html', import.meta.url), 'utf8'),
    readFile(new URL('../public/accounting-reports.js', import.meta.url), 'utf8'),
    readFile(new URL('../src/modules/security-catalogs/role-access-matrix.module.ts', import.meta.url), 'utf8'),
  ]);
  assert.match(script, /id="pendingPeriodType"/);
  assert.match(script, /<th>Tipo de período<\/th>/);
  assert.match(script, /id="pendingReclassifyButton"/);
  assert.match(script, /pendingInvoiceOptions\?\.canReclassify/);
  assert.match(html, /id="pendingReclassificationModal"/);
  assert.match(html, /413002[\s\S]*efecto neto cero/i);
  assert.match(accessMatrix, /pending-invoice-reclassification['"],\['view','create'\]/);
});

test('API y servicio exigen permiso y fecha contable 01-01', async () => {
  const [server, service] = await Promise.all([
    readFile(new URL('../src/server.ts', import.meta.url), 'utf8'),
    readFile(new URL('../src/modules/reports/accounting-reports.service.ts', import.meta.url), 'utf8'),
  ]);
  assert.match(server, /pending-invoice-reclassification/);
  assert.match(server,
    /assertRoleAccess\(authorization,'accounting:pending-invoice-reclassification',pendingReclassificationRoute\[1\]==='preview'\?'view':'create'\)/);
  assert.match(service, /\^\\d\{4\}-01-01\$/);
  assert.match(service, /pending_invoice_reclassification_preview/);
  assert.match(service, /pending_invoice_reclassification_execute/);
});
