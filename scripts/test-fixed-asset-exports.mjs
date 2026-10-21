import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ExcelJS from 'exceljs';
import {
  FIXED_ASSET_EXPORT_COLUMNS,
  buildFixedAssetCsv,
  buildFixedAssetExcel,
  buildFixedAssetPdfHtml,
} from '../dist/modules/fixed-asset-catalogs/fixed-asset-export.service.js';
import { renderBankReconciliationPdf } from '../dist/modules/reports/accounting-reports.service.js';

const row = {
  number: 'ACT-000123',
  name: '=HYPERLINK("https://example.test")',
  description: 'Servidor "principal" <script>alert(1)</script>',
  serial: 'SER-Ñ-001',
  category: 'Equipo tecnológico',
  location: 'San José',
  purchaseDate: '2026-01-15',
  serviceDate: '2026-02-01',
  department: 'Administración',
  costCenter: 'CC-ADM · Administración',
  className: 'Tecnología',
  currency: 'CRC',
  cost: 1250000.25,
  accumulated: 250000.05,
  bookValue: 1000000.20,
  status: 'ACTIVO',
};

const payload = {
  header: {
    subsidiary: 'Compañía Costa Rica, S.A.',
    currency: 'CRC',
    status: 'ACTIVO',
    category: 'Equipo tecnológico',
    search: '<equipo crítico>',
    generatedAt: '2026-10-20T15:30:00.000Z',
  },
  rows: [row],
  totals: { count: 1, cost: row.cost, accumulated: row.accumulated, bookValue: row.bookValue },
};

test('CSV de activos es UTF-8, conserva columnas e impide fórmulas', () => {
  const csv = buildFixedAssetCsv([row]).toString('utf8');
  assert.ok(csv.startsWith('\uFEFF'));
  assert.ok(csv.includes('\r\n'));
  assert.match(csv, /"Número","Activo","Descripción"/);
  assert.match(csv, /Compañía|Equipo tecnológico/);
  assert.match(csv, /"'=HYPERLINK\(""https:\/\/example\.test""\)"/);
  assert.match(csv, /Servidor ""principal""/);
  assert.equal(csv.split('\r\n')[0].split(',').length, FIXED_ASSET_EXPORT_COLUMNS.length);
});

test('Excel de activos es XLSX real, profesional y conserva importes numéricos', async () => {
  const buffer = await buildFixedAssetExcel(payload);
  assert.equal(buffer.subarray(0, 2).toString(), 'PK');
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);
  assert.equal(workbook.creator, 'GENTIA ERP');
  const sheet = workbook.getWorksheet('Activos fijos');
  assert.ok(sheet);
  assert.equal(sheet.getCell('A1').value, 'GENTIA · MAESTRO DE ACTIVOS FIJOS');
  assert.match(String(sheet.getCell('A2').value), /Compañía Costa Rica/);
  assert.match(String(sheet.getCell('A3').value), /Estado: ACTIVO/);
  assert.equal(sheet.getCell(6, 1).value, 'Número');
  assert.equal(sheet.getCell(6, 16).value, 'Estado');
  assert.equal(sheet.getCell(7, 1).value, row.number);
  assert.equal(sheet.getCell(7, 2).value, `'${row.name}`);
  assert.equal(sheet.getCell(7, 13).value, row.cost);
  assert.equal(sheet.getCell(7, 14).value, row.accumulated);
  assert.equal(sheet.getCell(7, 15).value, row.bookValue);
  assert.match(sheet.getCell(7, 13).numFmt, /#,##0\.00/);
  assert.equal(sheet.views[0].state, 'frozen');
  assert.equal(sheet.views[0].ySplit, 6);
  assert.ok(sheet.autoFilter);
});

test('HTML para PDF escapa datos y presenta filtros y totales', () => {
  const html = buildFixedAssetPdfHtml(payload);
  assert.match(html, /MAESTRO DE ACTIVOS FIJOS/i);
  assert.match(html, /Compañía Costa Rica/);
  assert.match(html, /Costo histórico/);
  assert.match(html, /1(?:[.\s\u00a0])*250(?:[.\s\u00a0])*000,25/);
  assert.match(html, /&lt;equipo crítico&gt;/);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.doesNotMatch(html, /<script>alert\(1\)<\/script>/);
});

test('PDF vacío conserva encabezados y explica que no hay resultados', () => {
  const html = buildFixedAssetPdfHtml({
    ...payload,
    rows: [],
    totals: { count: 0, cost: 0, accumulated: 0, bookValue: 0 },
  });
  assert.match(html, /No hay activos que coincidan con los filtros seleccionados/);
  assert.match(html, /Total de activos/);
});

test('el PDF se genera como archivo binario descargable', async () => {
  const rendered = await renderBankReconciliationPdf({
    html: buildFixedAssetPdfHtml(payload),
    fileName: 'activos-fijos-prueba.pdf',
  });
  const buffer = Buffer.from(rendered.base64, 'base64');
  assert.equal(rendered.mimeType, 'application/pdf');
  assert.equal(rendered.fileName, 'activos-fijos-prueba.pdf');
  assert.equal(buffer.subarray(0, 4).toString(), '%PDF');
  assert.ok(buffer.length > 10_000);
});

test('la interfaz ofrece las tres descargas directas y transmite los filtros', async () => {
  const [html, script, server] = await Promise.all([
    readFile(new URL('../public/fixed-assets.html', import.meta.url), 'utf8'),
    readFile(new URL('../public/fixed-assets.js', import.meta.url), 'utf8'),
    readFile(new URL('../src/server.ts', import.meta.url), 'utf8'),
  ]);
  for (const id of ['exportCsv', 'exportExcel', 'exportPdf']) assert.match(html, new RegExp(`id="${id}"`));
  assert.match(script, /format,status:\$\('filterStatus'\)\.value,categoryId:\$\('filterCategory'\)\.value,search:\$\('search'\)\.value\.trim\(\)/);
  assert.match(script, /\/api\/fixed-assets\/assets\/export/);
  assert.doesNotMatch(script, /window\.print|\bprint\(\)/);
  assert.match(server, /assertRoleAccess\(authorization,'fixed-assets:assets','view'\)/);
  assert.match(server, /return download\(response,await exportFixedAssets/);
});
