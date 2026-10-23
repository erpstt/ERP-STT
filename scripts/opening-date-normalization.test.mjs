import test from 'node:test';
import assert from 'node:assert/strict';
import {
  OpeningBalanceFilesValidationError,
  openingBalances,
  parseOpeningAccountingCsv,
  parseOpeningBankCsv,
  parseOpeningFixedAssetCsv,
  parseOpeningPendingCsv,
} from '../dist/modules/accounting-catalogs/opening-balances.service.js';

const csv = rows => rows.map(row => row.join(',')).join('\n');

const accountingHeaders = [
  'identificacion_tercero', 'numero_documento', 'fecha_emision', 'fecha_vencimiento',
  'cuenta', 'moneda', 'saldo', 'centro_costos', 'sucursal', 'nota',
];

test('normaliza fechas DD/MM/AAAA y DD-MM-AAAA de CxC y CxP antes de enviarlas a PostgreSQL', () => {
  const receivable = parseOpeningAccountingCsv(csv([
    accountingHeaders,
    ['CLI-1', 'FAC-1', '29/12/2021', '28-01-2022', '113001', 'JMD', '100', '', '', 'Apertura'],
  ]), 'AR')[0];
  const payable = parseOpeningAccountingCsv(csv([
    accountingHeaders,
    ['PRO-1', 'FAC-P-1', '1/2/2022', '03/04/2022', '211001', 'JMD', '75', '', '', 'Apertura'],
  ]), 'AP')[0];

  assert.deepEqual([receivable.issueDate, receivable.dueDate], ['2021-12-29', '2022-01-28']);
  assert.deepEqual([payable.issueDate, payable.dueDate], ['2022-02-01', '2022-04-03']);
});

test('normaliza todos los campos de fecha de activos, pendientes de facturar y bancos', () => {
  const asset = parseOpeningFixedAssetCsv(csv([
    ['codigo_activo', 'nombre_activo', 'codigo_categoria', 'numero_serie', 'descripcion', 'fecha_compra', 'fecha_en_servicio', 'costo_historico', 'depreciacion_acumulada', 'valor_en_libros', 'meses_depreciados', 'ubicacion', 'tipo_departamento', 'departamento', 'centro_costos', 'clase', 'estado', 'moneda', 'nota'],
    ['AF-1', 'Equipo', 'CAT-1', '', '', '29/12/2021', '01-01-2022', '100', '0', '100', '0', 'Principal', '', '', '', '', 'ACTIVO', 'JMD', 'Apertura'],
  ]))[0];

  const pendingHeaders = ['referencia_pendiente', 'tipo_periodo', 'fecha_origen', 'identificacion_cliente', 'moneda', 'tipo_cambio_historico', 'cuenta', 'debito_moneda_local', 'credito_moneda_local', 'debito_moneda_original', 'credito_moneda_original', 'es_linea_control', 'mes_servicio', 'pais_servicio', 'departamento', 'centro_costos', 'clase', 'acreedor_financiero', 'compania_relacionada', 'sucursal', 'nota', 'enlace_respaldo'];
  const pending = parseOpeningPendingCsv(csv([
    pendingHeaders,
    ['PEN-1', 'ACTUAL', '29/12/2021', 'CLI-1', 'JMD', '1', '113003', '100', '', '100', '', 'SI', '2021-12', 'JAM', '', '', '', '', '', '', 'Apertura', ''],
    ['PEN-1', 'ACTUAL', '29/12/2021', 'CLI-1', 'JMD', '1', '413001', '', '100', '', '100', 'NO', '2021-12', 'JAM', '', '', '', '', '', '', 'Apertura', ''],
  ]), '2022-01-31')[0];

  const bank = parseOpeningBankCsv(csv([
    ['codigo_banco', 'numero_cuenta_bancaria', 'moneda', 'tipo_registro', 'fecha_movimiento', 'fecha_valor', 'referencia', 'beneficiario', 'descripcion', 'importe_moneda_original', 'equivalente_moneda_local'],
    ['BANK01', '0001', 'JMD', 'SALDO_CONCILIADO', '29/12/2021', '30-12-2021', 'APERTURA', '', 'Saldo', '100', '100'],
  ]), '2022-01-31')[0];

  assert.deepEqual([asset.purchaseDate, asset.serviceDate], ['2021-12-29', '2022-01-01']);
  assert.equal(pending.originDate, '2021-12-29');
  assert.deepEqual([bank.transactionDate, bank.valueDate], ['2021-12-29', '2021-12-30']);
});

test('un error de fecha identifica archivo, fila, campo, columna y valor exactos', async () => {
  const ar = csv([
    accountingHeaders,
    ['CLI-1', 'FAC-1', '31/02/2021', '28/03/2021', '113001', 'JMD', '100', '', '', 'Apertura'],
  ]);

  await assert.rejects(
    openingBalances('', 'validate', {
      openingDate: '2022-01-31',
      ar,
      arFileName: 'cxc-apertura.csv',
    }),
    error => {
      assert.ok(error instanceof OpeningBalanceFilesValidationError);
      assert.equal(error.files.length, 1);
      assert.equal(error.files[0].key, 'ar');
      assert.equal(error.files[0].fileName, 'cxc-apertura.csv');
      assert.deepEqual(error.files[0].errors[0], {
        code: 'INVALID_DATE',
        message: 'El valor "31/02/2021" no es una fecha valida para Fecha de emisión.',
        row: 2,
        column: 3,
        columnLetter: 'C',
        field: 'Fecha de emisión',
        value: '31/02/2021',
        suggestion: 'Use AAAA-MM-DD, DD/MM/AAAA o DD-MM-AAAA; por ejemplo, 2021-12-29 o 29/12/2021.',
      });
      return true;
    },
  );
});
