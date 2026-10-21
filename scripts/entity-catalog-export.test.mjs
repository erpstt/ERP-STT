import test from 'node:test';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import {
  ENTITY_EXPORT_CATALOGS,
  buildEntityCatalogCsv,
  buildEntityCatalogExcel,
  buildEntityCatalogPdfHtml,
  isEntityExportCatalog,
} from '../dist/modules/entity-catalogs/entity-export.service.js';

const header = {
  catalog: 'customers',
  subsidiaryId: 17,
  subsidiary: 'Compañía Panamá',
  legalName: 'Compañía Panamá, S.A.',
  taxId: 'RUC-155-123',
  search: 'José',
  generatedAt: '2026-10-20T14:30:00.000Z',
};

const catalogFixtures = {
  customers: {
    sheet: 'Clientes',
    firstHeader: 'Subsidiaria',
    lastHeader: 'Comentarios',
    row: {
      subsidiary: 'Compañía Panamá', code: 'CLI-00000001',
      name: '=HYPERLINK("https://example.test")', entityType: 'Empresa', taxId: '8-123-456',
      country: 'Panamá', email: 'jose@example.test', phone: '+507 200-0000',
      address: 'Avenida España, "Torre 1"', department: 'Clientes regionales',
      salesRepresentative: 'José Núñez', paymentTerm: 'Neto 30', currencies: 'USD, PAB',
      creditLimit: 125000.5, isPrimary: false, isIntercompany: true,
      appliesWithholding: false, automaticStatement: true, comments: 'Cliente estratégico',
    },
  },
  suppliers: {
    sheet: 'Proveedores',
    firstHeader: 'Subsidiaria',
    lastHeader: 'Comentarios',
    row: {
      subsidiary: 'Compañía Panamá', code: 'PROV-00000001', name: 'Servicios Ñandú',
      entityType: 'Empresa', category: 'Servicios', taxId: '155-987', email: 'pagos@example.test',
      phone: '+507 300-0000', address: 'Ciudad de Panamá', paymentTerm: 'Neto 15', currencies: 'USD',
      isPrimary: true, isIntercompany: false, appliesWithholding: true,
      beneficiary: 'Servicios Ñandú', bank: 'Banco Regional', iban: 'PA001234567890', comments: 'Proveedor activo',
    },
  },
  employees: {
    sheet: 'Empleados',
    firstHeader: 'Subsidiaria',
    lastHeader: 'Activo',
    row: {
      subsidiary: 'Compañía Panamá', code: 'EMP-00000001', identification: '8-765-432',
      name: 'Ana María Pérez', jobTitle: 'Contadora', email: 'ana@example.test', phone: '+507 400-0000',
      department: 'Finanzas', location: 'Panamá', linkedUser: 'Ana Pérez - ana@example.test',
      isSalesRepresentative: false, isActive: true,
    },
  },
  'entity-subsidiaries': {
    sheet: 'Entidades',
    firstHeader: 'Subsidiaria',
    lastHeader: 'Límite de crédito',
    row: {
      subsidiary: 'Compañía Panamá', entityKind: 'Cliente', code: 'CLI-00000001',
      name: 'Cliente Regional', taxId: '8-123-456', email: 'cliente@example.test', phone: '+507 500-0000',
      currencies: 'USD, PAB', isPrimary: false, creditLimit: 88000.25,
    },
  },
};

const mojibake = /(?:Ãƒ|Ã‚|â€|ï¿½)/;

test('los cuatro catálogos de Entidades admiten exportación', () => {
  assert.deepEqual([...ENTITY_EXPORT_CATALOGS], ['customers', 'suppliers', 'employees', 'entity-subsidiaries']);
  for (const catalog of ENTITY_EXPORT_CATALOGS) assert.equal(isEntityExportCatalog(catalog), true);
  assert.equal(isEntityExportCatalog('users'), false);
});

test('CSV conserva Unicode, escapa comillas y neutraliza fórmulas', () => {
  const csv = buildEntityCatalogCsv('customers', [catalogFixtures.customers.row]).toString('utf8');
  assert.ok(csv.startsWith('\uFEFF'), 'Excel necesita el BOM UTF-8 para conservar acentos.');
  assert.match(csv, /"Nombre \/ razón social"/);
  assert.match(csv, /Compañía Panamá/);
  assert.match(csv, /José Núñez/);
  assert.match(csv, /Avenida España, ""Torre 1""/);
  assert.match(csv, /"'=HYPERLINK\(""https:\/\/example\.test""\)"/);
  assert.match(csv, /"Sí"/);
  assert.match(csv, /"No"/);
  assert.ok(csv.includes('\r\n'));
  assert.doesNotMatch(csv, mojibake);
});

for (const catalog of ENTITY_EXPORT_CATALOGS) {
  test(`Excel de ${catalog} tiene presentación profesional y datos tipados`, async () => {
    const fixture = catalogFixtures[catalog];
    const payload = { header: { ...header, catalog }, rows: [fixture.row], total: 1 };
    const buffer = await buildEntityCatalogExcel(catalog, payload);
    assert.equal(buffer.subarray(0, 2).toString(), 'PK');

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer);
    assert.equal(workbook.creator, 'GENTIA ERP');
    const sheet = workbook.getWorksheet(fixture.sheet);
    assert.ok(sheet, `Falta la hoja ${fixture.sheet}.`);
    assert.match(String(sheet.getCell('A1').value), /^GENTIA · /);
    assert.match(String(sheet.getCell('A2').value), /Compañía Panamá/);
    assert.match(String(sheet.getCell('A3').value), /Búsqueda aplicada/);
    assert.equal(sheet.getCell(5, 1).value, fixture.firstHeader);
    assert.equal(sheet.getCell(5, sheet.columnCount).value, fixture.lastHeader);
    assert.equal(sheet.getCell(6, 1).value, 'Compañía Panamá');
    assert.equal(sheet.views[0].state, 'frozen');
    assert.equal(sheet.views[0].ySplit, 5);
    assert.ok(sheet.autoFilter);
    assert.match(sheet.headerFooter.oddFooter, /GENTIA ERP/);
    const text = sheet.getRows(1, sheet.rowCount).flatMap(row => row.values).join(' ');
    assert.doesNotMatch(text, mojibake);
  });
}

test('Excel conserva importes como números y neutraliza texto ejecutable', async () => {
  const payload = { header, rows: [catalogFixtures.customers.row], total: 1 };
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(await buildEntityCatalogExcel('customers', payload));
  const sheet = workbook.getWorksheet('Clientes');
  assert.ok(sheet);
  assert.equal(sheet.getCell(6, 3).value, '\'=HYPERLINK("https://example.test")');
  assert.equal(sheet.getCell(6, 14).value, 125000.5);
  assert.equal(sheet.getCell(6, 15).value, 'No');
  assert.equal(sheet.getCell(6, 16).value, 'Sí');
  assert.match(sheet.getCell(6, 14).numFmt, /#,##0\.00/);
});

test('HTML del PDF escapa datos y presenta el alcance por subsidiaria', () => {
  const row = { ...catalogFixtures['entity-subsidiaries'].row, name: '<script>alert("x")</script>' };
  const payload = {
    header: { ...header, catalog: 'entity-subsidiaries', search: '<img src=x onerror=alert(1)>' },
    rows: [row], total: 1,
  };
  const html = buildEntityCatalogPdfHtml('entity-subsidiaries', payload);
  assert.match(html, /GENTIA/);
  assert.match(html, /Entidades por subsidiaria/i);
  assert.match(html, /Subsidiaria activa/);
  assert.match(html, /Compañía Panamá/);
  assert.match(html, /&lt;script&gt;alert\(&quot;x&quot;\)&lt;\/script&gt;/);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.doesNotMatch(html, /<script>alert/);
  assert.doesNotMatch(html, /<img src=x/);
  assert.doesNotMatch(html, mojibake);
});

test('PDF vacío sigue siendo un reporte válido y comprensible', () => {
  const payload = { header: { ...header, catalog: 'employees', search: '' }, rows: [], total: 0 };
  const html = buildEntityCatalogPdfHtml('employees', payload);
  assert.match(html, /Total de registros/);
  assert.match(html, />0<\/b>/);
  assert.match(html, /No hay registros que coincidan con los filtros seleccionados/);
});
