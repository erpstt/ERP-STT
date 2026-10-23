import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ExcelJS from 'exceljs';
import {
  OpeningBalanceFilesValidationError,
  openingBalances,
  parseOpeningAccountingCsv,
  parseOpeningAccountingFile,
  parseOpeningFixedAssetFile,
} from '../dist/modules/accounting-catalogs/opening-balances.service.js';

async function xlsx(headers, data, sheetName = 'Saldos iniciales') {
  const workbook = new ExcelJS.Workbook();
  workbook.addWorksheet(sheetName).addRows([headers, ...data]);
  const content = await workbook.xlsx.writeBuffer();
  return { fileName: `${sheetName}.xlsx`, base64: Buffer.from(content).toString('base64') };
}

test('las plantillas publicadas de CxC y CxP incluyen importes históricos e instrucciones de no duplicación', async () => {
  for (const key of ['cxc', 'cxp']) {
    const csv = await readFile(new URL(`../public/plantilla-saldos-${key}.csv`, import.meta.url), 'utf8');
    const csvHeaders = csv.trim().split(/\r?\n/, 1)[0].split(',');
    assert.ok(csvHeaders.includes('equivalente_moneda_local'));
    assert.ok(csvHeaders.includes('tipo_cambio_historico'));

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(new URL(`../public/plantilla-saldos-${key}.xlsx`, import.meta.url));
    const dataSheet = workbook.getWorksheet('Datos');
    const instructions = workbook.getWorksheet('Instrucciones');
    assert.ok(dataSheet);
    assert.ok(instructions);
    assert.ok(dataSheet.getRow(1).values.includes('equivalente_moneda_local'));
    assert.ok(dataSheet.getRow(1).values.includes('tipo_cambio_historico'));
    const instructionText = instructions.getColumn(2).values.join(' ');
    assert.match(instructionText, /no lo suma dos veces|reemplaza automáticamente/i);
  }
});

async function withSupabaseValidationError(message, callback) {
  const previousFetch = globalThis.fetch;
  const previousUrl = process.env.SUPABASE_URL;
  const previousKey = process.env.SUPABASE_ANON_KEY;
  process.env.SUPABASE_URL = 'https://opening-errors.test';
  process.env.SUPABASE_ANON_KEY = 'test-anon-key';
  globalThis.fetch = async () => new Response(JSON.stringify({ message }), {
    status: 400,
    headers: { 'Content-Type': 'application/json' },
  });
  try {
    return await callback();
  } finally {
    globalThis.fetch = previousFetch;
    if (previousUrl === undefined) delete process.env.SUPABASE_URL;
    else process.env.SUPABASE_URL = previousUrl;
    if (previousKey === undefined) delete process.env.SUPABASE_ANON_KEY;
    else process.env.SUPABASE_ANON_KEY = previousKey;
  }
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

test('CxC y CxP conservan el equivalente local y la tasa histórica sin cambiar el saldo original', async () => {
  const headers = [
    'Identificación Tercero', 'Número Documento', 'Fecha Emisión', 'Fecha Vencimiento',
    'Cuenta', 'Moneda', 'Saldo', 'Equivalente Moneda Local', 'Tipo Cambio Histórico',
    'Centro de Costos', 'Sucursal', 'Nota',
  ];
  const arFile = await xlsx(headers, [['3-101-1', 'FAC-USD-1', '2026-01-01', '2026-02-01', '113001', 'USD', 500, 75500, 151, '', '', 'Histórica']], 'CxC');
  const apFile = await xlsx(headers, [['3-101-2', 'PRO-USD-1', '2026-01-05', '2026-02-05', '211001', 'USD', 300, 45300, 151, '', '', 'Histórica']], 'CxP');
  const [[ar], [ap]] = await Promise.all([
    parseOpeningAccountingFile(arFile, 'AR'),
    parseOpeningAccountingFile(apFile, 'AP'),
  ]);

  assert.equal(ar.debit, '500');
  assert.equal(ar.debitFx, '500');
  assert.equal(ar.localEquivalent, '75500');
  assert.equal(ar.localDebit, '75500');
  assert.equal(ar.historicalRate, '151');
  assert.equal(ap.credit, '300');
  assert.equal(ap.creditFx, '300');
  assert.equal(ap.localEquivalent, '45300');
  assert.equal(ap.localCredit, '45300');
  assert.equal(ap.historicalRate, '151');
});

test('CxC mantiene compatibilidad y permite inferir los campos históricos desde el Mayor', () => {
  const headers = ['identificacion_tercero', 'numero_documento', 'fecha_emision', 'fecha_vencimiento', 'cuenta', 'moneda', 'saldo', 'centro_costos', 'sucursal', 'nota'];
  const [line] = parseOpeningAccountingCsv([
    headers.join(','),
    ['3-101-1', 'FAC-LEGACY', '2026-01-01', '2026-02-01', '113001', 'USD', '500', '', '', 'Archivo anterior'].join(','),
  ].join('\n'), 'AR');
  assert.equal(line.localEquivalent, '');
  assert.equal(line.historicalRate, '');
  assert.equal(line.debit, '500');
});

test('CxC identifica archivo, fila, campo y columna cuando la equivalencia histórica no coincide', async () => {
  const headers = ['identificacion_tercero', 'numero_documento', 'fecha_emision', 'fecha_vencimiento', 'cuenta', 'moneda', 'saldo', 'equivalente_moneda_local', 'tipo_cambio_historico', 'centro_costos', 'sucursal', 'nota'];
  const ar = [
    headers.join(','),
    ['3-101-1', 'FAC-ERROR-TC', '2026-01-01', '2026-02-01', '113001', 'USD', '500', '75501', '151', '', '', 'No coincide'].join(','),
  ].join('\n');

  await assert.rejects(
    openingBalances('', 'validate', { openingDate: '2026-09-30', ar, arFileName: 'Cartera histórica.csv' }),
    error => {
      assert.ok(error instanceof OpeningBalanceFilesValidationError);
      assert.equal(error.files[0].key, 'ar');
      assert.equal(error.files[0].fileName, 'Cartera histórica.csv');
      assert.deepEqual(
        Object.fromEntries(['code', 'row', 'field', 'column', 'columnLetter'].map(key => [key, error.files[0].errors[0][key]])),
        { code: 'EXCHANGE_RATE_MISMATCH', row: 2, field: 'Tipo de cambio histórico', column: 9, columnLetter: 'I' },
      );
      assert.match(error.files[0].errors[0].suggestion, /saldo_moneda_original/);
      return true;
    },
  );
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

test('identifica la columna exacta cuando un CSV tiene un encabezado vacío', () => {
  const emptyMiddle = 'Cuenta,,Moneda\n110001,100,USD';
  assert.throws(
    () => parseOpeningAccountingCsv(emptyMiddle, 'GL'),
    /Fila 1: la columna B \(2\) no tiene encabezado/,
  );

  const trailing = `${glHeaders.join(',')},\n${glData[0].join(',')},`;
  assert.throws(
    () => parseOpeningAccountingCsv(trailing, 'GL'),
    /Fila 1: la columna N \(14\) no tiene encabezado/,
  );
});

test('conserva las filas físicas con directiva sep y saltos CRLF', () => {
  const invalidRow = [...glData[0]];
  invalidRow[0] = '';
  const csv = ['sep=;', glHeaders.join(';'), invalidRow.join(';')].join('\r\n');

  assert.throws(
    () => parseOpeningAccountingCsv(csv, 'GL'),
    /GL fila 3: complete la cuenta contable/,
  );
});

test('reconoce la directiva sep después de líneas vacías y conserva la fila del encabezado', () => {
  const csv = ['', '  ', 'sep=;', '', 'Cuenta;;Moneda', '110001;100;USD'].join('\r\n');

  assert.throws(
    () => parseOpeningAccountingCsv(csv, 'GL'),
    /Fila 5: la columna B \(2\) no tiene encabezado/,
  );
});

test('conserva las filas físicas cuando existen líneas vacías iniciales e intermedias', () => {
  const invalidRow = [...glData[0]];
  invalidRow[0] = '';
  const csv = `\n\n${glHeaders.join(',')}\n\n${invalidRow.join(',')}`;

  assert.throws(
    () => parseOpeningAccountingCsv(csv, 'GL'),
    /GL fila 5: complete la cuenta contable/,
  );
});

test('conserva la fila inicial del registro después de un campo multilínea', () => {
  const multilineRow = [...glData[0]];
  multilineRow[12] = '"Saldo inicial\r\ncon detalle"';
  const invalidRow = [...glData[0]];
  invalidRow[0] = '';
  const csv = [glHeaders.join(','), multilineRow.join(','), invalidRow.join(',')].join('\r\n');

  assert.throws(
    () => parseOpeningAccountingCsv(csv, 'GL'),
    /GL fila 4: complete la cuenta contable/,
  );
});

test('indica el encabezado duplicado y todas sus posiciones', () => {
  assert.throws(
    () => parseOpeningAccountingCsv('Cuenta,cuenta,Moneda\n110001,110001,USD', 'GL'),
    /"cuenta" en A \(1\) y B \(2\)/,
  );
});

test('acumula los errores de varios archivos con nombre, origen y posición', async () => {
  const invalidWorkbook = await xlsx(
    ['Cuenta', null, 'Moneda'],
    [['110001', 100, 'USD']],
    'Mayor con error',
  );
  invalidWorkbook.fileName = 'levantamiento-mayor.xlsx';
  const invalidPending = 'referencia_pendiente,,fecha_origen\nPEN-1,ACTUAL,2026-09-30';

  await assert.rejects(
    openingBalances('', 'validate', {
      openingDate: '2026-09-30',
      gl: invalidWorkbook,
      glFileName: invalidWorkbook.fileName,
      pending: invalidPending,
      pendingFileName: 'pendientes-septiembre.csv',
    }),
    error => {
      assert.ok(error instanceof OpeningBalanceFilesValidationError);
      assert.deepEqual(error.files.map(file => file.key), ['gl', 'pending']);
      assert.deepEqual(error.files.map(file => file.fileName), ['levantamiento-mayor.xlsx', 'pendientes-septiembre.csv']);
      assert.equal(error.files[0].errors[0].columnLetter, 'B');
      assert.equal(error.files[0].errors[0].column, 2);
      assert.equal(error.files[1].errors[0].columnLetter, 'B');
      assert.match(error.message, /2 archivos requieren corrección/);
      return true;
    },
  );
});

test('atribuye un error RPC de dimensión a cada archivo y fila física que contiene el valor', { concurrency: false }, async () => {
  const firstGlRow = [...glData[0]];
  const secondGlRow = [...glData[0]];
  firstGlRow[11] = 'Of. Centrales';
  secondGlRow[0] = '110002';
  secondGlRow[11] = 'Of. Centrales';
  const gl = ['', '', glHeaders.join(','), firstGlRow.join(','), secondGlRow.join(',')].join('\n');
  const arHeaders = ['Identificación Tercero', 'Número Documento', 'Fecha Emisión', 'Fecha Vencimiento', 'Cuenta', 'Moneda', 'Saldo', 'Centro de Costos', 'Sucursal', 'Nota'];
  const ar = [arHeaders.join(','), ['3-101-1', 'FAC-1', '2026-01-01', '2026-02-01', '113001', 'USD', '500', '', 'Of. Centrales', 'Saldo inicial'].join(',')].join('\n');

  await withSupabaseValidationError(
    'Ubicación / sucursal "Of. Centrales" no existe, está inactivo, no pertenece a la subsidiaria o es ambiguo. Use código, nombre exacto o ID:identificador.',
    () => assert.rejects(
      openingBalances('Bearer test', 'validate', {
        expectedSubsidiaryId: '1', openingDate: '2026-09-30', loadType: 'MID_YEAR', transitionAccountId: '1',
        gl, glFileName: 'Levantamiento GENTIA - Libro Mayor.csv',
        ar, arFileName: 'Cuentas por cobrar septiembre.csv',
      }),
      error => {
        assert.ok(error instanceof OpeningBalanceFilesValidationError);
        assert.deepEqual(error.files.map(file => file.key), ['gl', 'ar']);
        assert.deepEqual(error.files.map(file => file.fileName), ['Levantamiento GENTIA - Libro Mayor.csv', 'Cuentas por cobrar septiembre.csv']);
        assert.deepEqual(error.files[0].errors[0].rows, [4, 5]);
        assert.equal(error.files[0].errors[0].row, 4);
        assert.equal(error.files[1].errors[0].row, 2);
        assert.equal(error.files[0].errors[0].field, 'Sucursal');
        assert.equal(error.files[0].errors[0].value, 'Of. Centrales');
        assert.match(error.files[0].errors[0].message, /Filas afectadas: 4–5/);
        assert.match(error.files[0].errors[0].suggestion, /nombre exacto o ID:identificador/);
        return true;
      },
    ),
  );
});

test('mapea un error RPC prefijado de CxP al archivo real sin atribuirlo a otra plantilla', { concurrency: false }, async () => {
  const headers = ['Identificación Tercero', 'Número Documento', 'Fecha Emisión', 'Fecha Vencimiento', 'Cuenta', 'Moneda', 'Saldo', 'Centro de Costos', 'Sucursal', 'Nota'];
  const ap = [headers.join(','), ['3-101-2', 'FAC-PRO-1', '2026-01-05', '2026-02-05', '211001', 'USD', '300', '', '', 'Proveedor inicial'].join(',')].join('\n');

  await withSupabaseValidationError(
    'CxP fila 2: proveedor 3-101-2 no encontrado.',
    () => assert.rejects(
      openingBalances('Bearer test', 'validate', {
        expectedSubsidiaryId: '1', openingDate: '2026-09-30', loadType: 'MID_YEAR', transitionAccountId: '1',
        ap, apFileName: 'CxP inicial.csv',
      }),
      error => {
        assert.ok(error instanceof OpeningBalanceFilesValidationError);
        assert.equal(error.files.length, 1);
        assert.equal(error.files[0].key, 'ap');
        assert.equal(error.files[0].label, 'Cuentas por Pagar');
        assert.equal(error.files[0].fileName, 'CxP inicial.csv');
        assert.equal(error.files[0].errors[0].row, 2);
        assert.equal(error.files[0].errors[0].code, 'INVALID_OPENING_BALANCE_ROW');
        assert.equal(error.files[0].errors[0].message, 'proveedor 3-101-2 no encontrado.');
        return true;
      },
    ),
  );
});

test('normaliza fechas de CxC en formatos ISO, DD/MM y DD-MM antes de enviarlas a PostgreSQL', () => {
  const headers = ['Identificaci\u00f3n Tercero', 'N\u00famero Documento', 'Fecha Emisi\u00f3n', 'Fecha Vencimiento', 'Cuenta', 'Moneda', 'Saldo', 'Centro de Costos', 'Sucursal', 'Nota'];
  const csv = [
    headers.join(','),
    ['3-101-1', 'FAC-1', '29/12/2021', '28/01/2022', '113001', 'USD', '500', '', '', 'Formato con barra'].join(','),
    ['3-101-1', 'FAC-2', '30-12-2021', '29-01-2022', '113001', 'USD', '600', '', '', 'Formato con guion'].join(','),
    ['3-101-1', 'FAC-3', '2021-12-31', '2022-01-30', '113001', 'USD', '700', '', '', 'Formato ISO'].join(','),
  ].join('\n');

  const parsed = parseOpeningAccountingCsv(csv, 'AR');
  assert.deepEqual(parsed.map(row => [row.issueDate, row.dueDate]), [
    ['2021-12-29', '2022-01-28'],
    ['2021-12-30', '2022-01-29'],
    ['2021-12-31', '2022-01-30'],
  ]);
});

test('los errores de fecha identifican archivo, fila, campo, columna y valor en cada plantilla', async () => {
  const arHeaders = ['Identificaci\u00f3n Tercero', 'N\u00famero Documento', 'Fecha Emisi\u00f3n', 'Fecha Vencimiento', 'Cuenta', 'Moneda', 'Saldo', 'Centro de Costos', 'Sucursal', 'Nota'];
  const ar = [
    arHeaders.join(','),
    ['3-101-1', 'FAC-ERROR', '31/02/2021', '28/02/2021', '113001', 'USD', '500', '', '', 'Fecha imposible'].join(','),
  ].join('\n');
  const assetHeaders = ['C\u00f3digo Activo', 'Nombre Activo', 'C\u00f3digo Categor\u00eda', 'N\u00famero Serie', 'Descripci\u00f3n', 'Fecha Compra', 'Fecha en Servicio', 'Costo Hist\u00f3rico', 'Depreciaci\u00f3n Acumulada', 'Valor en Libros', 'Meses Depreciados', 'Ubicaci\u00f3n', 'Tipo Departamento', 'Departamento', 'Centro Costos', 'Clase', 'Estado', 'Moneda', 'Nota'];
  const fa = [
    assetHeaders.join(','),
    ['AF-ERROR', 'Servidor', 'CAT-ACT-00001', '', '', '2021-12-29', '31-02-2022', '1000', '0', '1000', '0', 'Oficina', 'Interno', '', '', '', 'ACTIVO', 'USD', 'Fecha imposible'].join(','),
  ].join('\n');

  await assert.rejects(
    openingBalances('', 'validate', {
      openingDate: '2026-09-30',
      ar,
      arFileName: 'Levantamiento de saldos - CxC.csv',
      fa,
      faFileName: 'Auxiliar de activos al corte.csv',
    }),
    error => {
      assert.ok(error instanceof OpeningBalanceFilesValidationError);
      assert.deepEqual(error.files.map(file => [file.key, file.fileName]), [
        ['ar', 'Levantamiento de saldos - CxC.csv'],
        ['fa', 'Auxiliar de activos al corte.csv'],
      ]);
      assert.deepEqual(
        Object.fromEntries(['code', 'row', 'field', 'column', 'columnLetter', 'value'].map(key => [key, error.files[0].errors[0][key]])),
        { code: 'INVALID_DATE', row: 2, field: 'Fecha de emisi\u00f3n', column: 3, columnLetter: 'C', value: '31/02/2021' },
      );
      assert.deepEqual(
        Object.fromEntries(['code', 'row', 'field', 'column', 'columnLetter', 'value'].map(key => [key, error.files[1].errors[0][key]])),
        { code: 'INVALID_DATE', row: 2, field: 'Fecha en servicio', column: 7, columnLetter: 'G', value: '31-02-2022' },
      );
      assert.match(error.files[0].errors[0].message, /31\/02\/2021/);
      assert.match(error.files[0].errors[0].suggestion, /DD\/MM\/AAAA/);
      return true;
    },
  );
});
