import test from 'node:test';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import {
  buildCostCenterCsv,
  buildCostCenterExcel,
} from '../dist/modules/organization-catalogs/cost-center-export.service.js';

const rows = [{
  id: 2,
  name: 'CC Administración',
  subsidiary: 'EMPRESA DE PRUEBAS',
  type: 'INTERNO',
  customer: '',
  className: 'Administración',
  code: 'CC-ADM',
}];

test('CSV de centros de costos conserva encabezados y caracteres Unicode', () => {
  const csv = buildCostCenterCsv(rows).toString('utf8');
  assert.ok(csv.startsWith('\uFEFF'));
  assert.match(csv, /"Nombre del centro de costos"/);
  assert.match(csv, /"CC Administración"/);
  assert.match(csv, /"EMPRESA DE PRUEBAS"/);
  assert.match(csv, /"CC-ADM"/);
});

test('CSV neutraliza valores que una hoja de cálculo podría interpretar como fórmula', () => {
  const csv = buildCostCenterCsv([{ ...rows[0], name: '=HYPERLINK("https://example.com")' }]).toString('utf8');
  assert.match(csv, /"'=HYPERLINK\(""https:\/\/example\.com""\)"/);
});

test('Excel de centros de costos crea una tabla profesional y filtrable', async () => {
  const buffer = await buildCostCenterExcel(rows, 'EMPRESA DE PRUEBAS', 'administración');
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);
  const sheet = workbook.getWorksheet('Centros de costos');
  assert.ok(sheet);
  assert.equal(sheet.getCell('A1').value, 'GENTIA · CATÁLOGO DE CENTROS DE COSTOS');
  assert.equal(sheet.getCell('A5').value, 'ID interno');
  assert.equal(sheet.getCell('B6').value, 'CC Administración');
  assert.equal(sheet.getCell('C6').value, 'EMPRESA DE PRUEBAS');
  assert.equal(sheet.getCell('G6').value, 'CC-ADM');
  assert.equal(sheet.views[0].ySplit, 5);
  assert.equal(sheet.getTables().length, 1);
});
