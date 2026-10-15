import test from 'node:test';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import {
  parseOpeningAccountingFile,
  parseOpeningFixedAssetFile,
} from '../dist/modules/accounting-catalogs/opening-balances.service.js';

async function xlsx(headers, data, sheetName = 'Saldos iniciales') {
  const workbook = new ExcelJS.Workbook();
  workbook.addWorksheet(sheetName).addRows([headers, ...data]);
  const content = await workbook.xlsx.writeBuffer();
  return { fileName: `${sheetName}.xlsx`, base64: Buffer.from(content).toString('base64') };
}

const glHeaders = [
  'Cuenta', 'Débito Moneda Local', 'Crédito Moneda Local', 'Moneda Original',
  'Débito Moneda Origen', 'Crédito Moneda Origen', 'Departamento', 'Centro de Costos',
  'Clase', 'Acreedores Financieros', 'Compañías Relacionadas', 'Ubicación', 'Nota',
];
const glData = [['110001', 1_000_000, '', 'USD', 50_000, '', 'Administrativo', 'CC-ADM', 'Operativa', 'Banco Uno', 'Relacionada Uno', '', 'Saldo inicial']];

test('Libro Mayor conserva en XLSX el mismo contrato contable y aliases que CSV', async () => {
  const [line] = await parseOpeningAccountingFile(await xlsx(glHeaders, glData, 'Mayor'), 'GL');
  assert.deepEqual(line, {
    sourceType: 'GL', sourceRow: 2, account: '110001', documentNumber: '', issueDate: '', dueDate: '', currency: 'USD',
    debit: '1000000', credit: '', debitFx: '50000', creditFx: '', entityTaxId: '', department: 'Administrativo',
    costCenter: 'CC-ADM', className: 'Operativa', financialCreditor: 'Banco Uno', relatedCompany: 'Relacionada Uno',
    location: '', note: 'Saldo inicial',
  });
});

test('CxC y CxP aceptan XLSX y mantienen la dirección contable del saldo', async () => {
  const headers = ['Identificación Tercero', 'Número Documento', 'Fecha Emisión', 'Fecha Vencimiento', 'Cuenta', 'Moneda', 'Saldo', 'Centro de Costos', 'Sucursal', 'Nota'];
  const arFile = await xlsx(headers, [['3-101-1', 'FAC-1', '2026-01-01', '2026-02-01', '120001', 'USD', 500, 'CC-COM', '', 'Factura inicial']], 'CxC');
  const apFile = await xlsx(headers, [['3-101-2', 'FAC-PRO-1', '2026-01-05', '2026-02-05', '210001', 'USD', 300, 'CC-ADM', '', 'Proveedor inicial']], 'CxP');
  const [[ar], [ap]] = await Promise.all([
    parseOpeningAccountingFile(arFile, 'AR'),
    parseOpeningAccountingFile(apFile, 'AP'),
  ]);
  assert.equal(ar.debit, '500');
  assert.equal(ar.credit, '');
  assert.equal(ar.documentNumber, 'FAC-1');
  assert.equal(ap.debit, '');
  assert.equal(ap.credit, '300');
  assert.equal(ap.documentNumber, 'FAC-PRO-1');
});

test('Auxiliar de Activos Fijos acepta XLSX con el mismo DTO que el CSV', async () => {
  const headers = ['Código Activo', 'Nombre Activo', 'Código Categoría', 'Número Serie', 'Descripción', 'Fecha Compra', 'Fecha en Servicio', 'Costo Histórico', 'Depreciación Acumulada', 'Valor en Libros', 'Meses Depreciados', 'Ubicación', 'Tipo Departamento', 'Departamento', 'Centro Costos', 'Clase', 'Estado', 'Moneda', 'Nota'];
  const file = await xlsx(headers, [['AF-001', 'Servidor', 'CAT-ACT-00001', 'SN-1', 'Servidor principal', '2025-01-15', '2025-02-01', 12000, 2000, 10000, 20, 'Oficina', 'Interno', 'Tecnología', 'CC-TI', 'Equipos', 'ACTIVO', 'USD', 'Migración']], 'Activos');
  const [asset] = await parseOpeningFixedAssetFile(file);
  assert.equal(asset.assetNumber, 'AF-001');
  assert.equal(asset.name, 'Servidor');
  assert.equal(asset.cost, '12000');
  assert.equal(asset.accumulatedDepreciation, '2000');
  assert.equal(asset.bookValue, '10000');
  assert.equal(asset.costCenter, 'CC-TI');
});

test('mantiene compatibilidad con el contenido CSV enviado como texto', async () => {
  const csv = [glHeaders.join(','), glData[0].join(',')].join('\n');
  const [line] = await parseOpeningAccountingFile(csv, 'GL');
  assert.equal(line.account, '110001');
  assert.equal(line.debitFx, '50000');
});

test('rechaza extensiones y contenido Excel inválidos antes de procesarlos', async () => {
  await assert.rejects(
    parseOpeningAccountingFile({ fileName: 'mayor.xls', base64: Buffer.from('not-an-xls').toString('base64') }, 'GL'),
    /formato CSV o XLSX/,
  );
  await assert.rejects(
    parseOpeningAccountingFile({ fileName: 'mayor.xlsx', base64: Buffer.from('not-an-xlsx').toString('base64') }, 'GL'),
    /no es válido o está dañado/,
  );
  await assert.rejects(
    parseOpeningFixedAssetFile({ fileName: 'activos.xlsx', base64: '***' }),
    /Base64 válido/,
  );
});
