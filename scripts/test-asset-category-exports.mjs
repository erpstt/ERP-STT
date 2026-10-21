import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ExcelJS from 'exceljs';
import {
  ASSET_CATEGORY_EXPORT_COLUMNS,
  buildAssetCategoryCsv,
  buildAssetCategoryExcel,
  buildAssetCategoryPdfHtml,
} from '../dist/modules/fixed-asset-catalogs/asset-category-export.service.js';
import { renderBankReconciliationPdf } from '../dist/modules/reports/accounting-reports.service.js';

const row = {
  code: 'CAT-"TEC"',
  name: '=HYPERLINK("https://example.test")',
  description: 'Equipo "crítico" <script>alert(1)</script>',
  usefulLifeMonths: '60',
  method: 'Línea Recta',
  residualPercentage: 5.25,
  assetAccount: '150101 · Equipo de cómputo',
  depreciationAccount: '159201 · Depreciación acumulada',
  expenseAccount: '520101 · Gasto por depreciación',
  linkedAssets: 12,
  status: 'ACTIVA',
};

const nonDepreciableRow = {
  code: 'CAT-TER',
  name: 'Terrenos',
  description: 'Categoría no depreciable',
  usefulLifeMonths: 'No aplica',
  method: 'No Depreciable',
  residualPercentage: 100,
  assetAccount: '150201 · Terrenos',
  depreciationAccount: '159299 · Depreciación acumulada de control',
  expenseAccount: 'No aplica',
  linkedAssets: 1,
  status: 'INACTIVA',
};

const payload = {
  header: {
    subsidiary: 'Compañía Costa Rica, S.A.',
    status: 'ALL',
    search: '<equipo crítico>',
    generatedAt: '2026-10-20T15:30:00.000Z',
  },
  rows: [row, nonDepreciableRow],
  totals: { count: 2, active: 1, inactive: 1, linkedAssets: 13 },
};

test('CSV de categorías usa UTF-8, CRLF, escapa comillas y neutraliza fórmulas', () => {
  const csv = buildAssetCategoryCsv(payload.rows).toString('utf8');
  const lines = csv.split('\r\n');

  assert.ok(csv.startsWith('\uFEFF'));
  assert.equal(lines.length, 3);
  assert.equal(lines[0].split(',').length, ASSET_CATEGORY_EXPORT_COLUMNS.length);
  assert.match(lines[0], /"Código","Categoría","Descripción"/);
  assert.match(csv, /"CAT-""TEC"""/);
  assert.match(csv, /"'=HYPERLINK\(""https:\/\/example\.test""\)"/);
  assert.match(csv, /Equipo ""crítico"" <script>alert\(1\)<\/script>/);
  assert.match(csv, /"5\.25"/);
  assert.match(csv, /"12"/);
  assert.match(csv, /"No aplica","No Depreciable"/);
});

test('Excel de categorías es XLSX real, conserva encabezado, filtros y tipos', async () => {
  const buffer = await buildAssetCategoryExcel(payload);
  assert.equal(buffer.subarray(0, 2).toString(), 'PK');

  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);
  assert.equal(workbook.creator, 'GENTIA ERP');
  assert.equal(workbook.company, payload.header.subsidiary);

  const sheet = workbook.getWorksheet('Categorías de activos');
  assert.ok(sheet);
  assert.equal(sheet.getCell('A1').value, 'GENTIA · CATEGORÍAS DE ACTIVOS');
  assert.match(String(sheet.getCell('A2').value), /Compañía Costa Rica/);
  assert.match(String(sheet.getCell('A3').value), /Estado: Todas/);
  assert.match(String(sheet.getCell('A3').value), /equipo crítico/);
  assert.match(String(sheet.getCell('A4').value), /2 categorías/);
  assert.match(String(sheet.getCell('A4').value), /13 activos vinculados/);

  assert.equal(sheet.getCell(6, 1).value, 'Código');
  assert.equal(sheet.getCell(6, 11).value, 'Estado');
  assert.equal(sheet.getCell(7, 1).value, row.code);
  assert.equal(sheet.getCell(7, 2).value, `'${row.name}`);
  assert.equal(sheet.getCell(7, 6).value, row.residualPercentage);
  assert.equal(sheet.getCell(7, 10).value, row.linkedAssets);
  assert.equal(typeof sheet.getCell(7, 6).value, 'number');
  assert.equal(typeof sheet.getCell(7, 10).value, 'number');
  assert.match(sheet.getCell(7, 6).numFmt, /0\.00/);
  assert.match(sheet.getCell(7, 10).numFmt, /#,##0/);
  assert.equal(sheet.getCell(8, 4).value, 'No aplica');
  assert.equal(sheet.getCell(8, 9).value, 'No aplica');
  assert.equal(sheet.views[0].state, 'frozen');
  assert.equal(sheet.views[0].ySplit, 6);
  assert.equal(sheet.autoFilter, 'A6:K6');
});

test('HTML de PDF escapa datos y presenta filtros, cuentas y resumen', () => {
  const html = buildAssetCategoryPdfHtml(payload);

  assert.match(html, /CATEGORÍAS DE ACTIVOS/i);
  assert.match(html, /Compañía Costa Rica/);
  assert.match(html, /Estado: Todas/);
  assert.match(html, /2<\/b><\/div><div class="metric"><small>Activas/);
  assert.match(html, /13<\/b>/);
  assert.match(html, /150101 · Equipo de cómputo/);
  assert.match(html, /No aplica/);
  assert.match(html, /&lt;equipo crítico&gt;/);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.doesNotMatch(html, /<script>alert\(1\)<\/script>/);
});

test('PDF vacío conserva estructura y explica que no hay resultados', () => {
  const html = buildAssetCategoryPdfHtml({
    ...payload,
    rows: [],
    totals: { count: 0, active: 0, inactive: 0, linkedAssets: 0 },
  });

  assert.match(html, /No hay categorías que coincidan con los filtros seleccionados/);
  assert.match(html, /Total de categorías/);
  assert.match(html, /Activos vinculados/);
  assert.equal((html.match(/<th>/g) || []).length, ASSET_CATEGORY_EXPORT_COLUMNS.length);
});

test('PDF se genera como binario descargable', async () => {
  const rendered = await renderBankReconciliationPdf({
    html: buildAssetCategoryPdfHtml(payload),
    fileName: 'categorias-de-activos-prueba.pdf',
  });
  const buffer = Buffer.from(rendered.base64, 'base64');

  assert.equal(rendered.mimeType, 'application/pdf');
  assert.equal(rendered.fileName, 'categorias-de-activos-prueba.pdf');
  assert.equal(buffer.subarray(0, 4).toString(), '%PDF');
  assert.ok(buffer.length > 10_000);
});

test('interfaz y servidor ofrecen descargas directas con filtros y permiso de consulta', async () => {
  const [html, script, server] = await Promise.all([
    readFile(new URL('../public/asset-categories.html', import.meta.url), 'utf8'),
    readFile(new URL('../public/asset-categories.js', import.meta.url), 'utf8'),
    readFile(new URL('../src/server.ts', import.meta.url), 'utf8'),
  ]);

  for (const id of ['exportCsv', 'exportExcel', 'exportPdf']) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
  assert.match(script, /format,\s*status:\s*\$\('filterStatus'\)\.value,\s*search:\s*\$\('search'\)\.value\.trim\(\)/);
  assert.match(script, /\/api\/fixed-assets\/asset-categories\/export/);
  assert.match(script, /'X-Device-Token':\s*device\s*\|\|\s*''/);
  assert.match(script, /response\.blob\(\)/);
  assert.doesNotMatch(script, /window\.print|\bprint\(\)/);

  assert.match(server, /fixedAssetExportUrl\.pathname==='\/api\/fixed-assets\/asset-categories\/export'/);
  assert.match(server, /assertRoleAccess\(authorization,'fixed-assets:asset-categories','view'\)/);
  assert.match(server, /return download\(response,await exportAssetCategories/);
  assert.match(server, /status:fixedAssetExportUrl\.searchParams\.get\('status'\)/);
  assert.match(server, /search:fixedAssetExportUrl\.searchParams\.get\('search'\)/);
});
