import { writeFile } from 'node:fs/promises';
import ExcelJS from 'exceljs';

const columns = [
  'identificacion_tercero', 'numero_documento', 'fecha_emision', 'fecha_vencimiento',
  'cuenta', 'moneda', 'saldo', 'equivalente_moneda_local', 'tipo_cambio_historico',
  'centro_costos', 'sucursal', 'nota',
];

const definitions = [
  {
    key: 'cxc',
    title: 'Cuentas por Cobrar',
    example: ['3-101-000001', 'FAC-INI-001', '2026-08-01', '2026-09-01', '113001', 'USD', 500, 75500, 151, 'CC-COM', '', 'Factura inicial'],
    accountHelp: 'Use la cuenta de control que corresponda al cliente, por ejemplo 113001 o 113002 para intercompany.',
  },
  {
    key: 'cxp',
    title: 'Cuentas por Pagar',
    example: ['3-101-000002', 'PRO-INI-001', '2026-08-01', '2026-09-01', '211001', 'USD', 500, 75500, 151, 'CC-ADM', '', 'Factura proveedor inicial'],
    accountHelp: 'Use la cuenta de control que corresponda: 211001, 211002, 211003 o 211004.',
  },
];

const csvCell = value => {
  const text = String(value ?? '');
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
};

for (const definition of definitions) {
  const csv = `${columns.join(',')}\r\n${definition.example.map(csvCell).join(',')}\r\n`;
  await writeFile(new URL(`../public/plantilla-saldos-${definition.key}.csv`, import.meta.url), `\uFEFF${csv}`, 'utf8');

  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'GENTIA ERP';
  workbook.company = 'GENTIA';
  workbook.created = new Date();
  const sheet = workbook.addWorksheet('Datos', { views: [{ state: 'frozen', ySplit: 1 }] });
  sheet.addRow(columns);
  sheet.addRow(definition.example);
  sheet.autoFilter = { from: 'A1', to: 'L1000' };
  sheet.getRow(1).height = 30;
  sheet.getRow(1).eachCell(cell => {
    cell.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 10 };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF063B79' } };
    cell.alignment = { vertical: 'middle', wrapText: true };
    cell.border = { bottom: { style: 'medium', color: { argb: 'FFF26A3D' } } };
  });
  const widths = [24, 23, 17, 19, 14, 12, 18, 28, 25, 20, 18, 34];
  sheet.columns.forEach((column, index) => { column.width = widths[index]; });
  for (let row = 2; row <= 1000; row += 1) {
    sheet.getCell(`C${row}`).numFmt = '@';
    sheet.getCell(`D${row}`).numFmt = '@';
    for (const letter of ['G', 'H', 'I']) sheet.getCell(`${letter}${row}`).numFmt = '0.000000';
    sheet.getCell(`F${row}`).dataValidation = {
      type: 'textLength', operator: 'equal', formulae: [3], allowBlank: false,
      showErrorMessage: true, errorTitle: 'Moneda no válida', error: 'Use un código ISO de tres letras, por ejemplo USD o JMD.',
    };
  }
  for (const letter of ['G', 'H', 'I']) sheet.getCell(`${letter}1`).note = letter === 'G'
    ? 'Saldo pendiente en la moneda del documento.'
    : letter === 'H'
      ? 'Equivalente histórico exacto en la moneda funcional de la subsidiaria.'
      : 'Tasa histórica: equivalente_moneda_local / saldo. Use 1 cuando la moneda del documento sea la moneda funcional.';
  sheet.getCell('A2').note = 'Use la Identificación fiscal del cliente o proveedor, no el número interno del catálogo.';

  const help = workbook.addWorksheet('Instrucciones', { views: [{ state: 'frozen', ySplit: 2 }] });
  help.columns = [{ width: 28 }, { width: 115 }];
  help.mergeCells('A1:B1');
  help.getCell('A1').value = `GENTIA · Carga inicial · ${definition.title}`;
  help.getCell('A1').font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 15 };
  help.getCell('A1').fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF063B79' } };
  help.getCell('A1').alignment = { vertical: 'middle' };
  help.getRow(1).height = 32;
  const instructions = [
    ['Identificación del tercero', 'Corresponde a la Identificación fiscal del cliente o proveedor. No use el número interno del registro.'],
    ['Cuenta contable', definition.accountHelp],
    ['saldo', 'Saldo pendiente de la factura en la moneda indicada en la columna moneda.'],
    ['equivalente_moneda_local', 'Valor histórico pendiente expresado en la moneda funcional. Es preferible completarlo para conservar el valor contable exacto.'],
    ['tipo_cambio_historico', 'Tasa usada originalmente. Si se completa junto con el equivalente local, ambos deben coincidir al centavo: saldo × tasa = equivalente local.'],
    ['Compatibilidad', 'Las dos columnas históricas pueden quedar vacías en archivos anteriores; el sistema intentará inferirlas a partir del Libro Mayor conciliado por cuenta y moneda.'],
    ['Moneda funcional', 'Use equivalente_moneda_local igual a saldo y tipo_cambio_historico igual a 1.'],
    ['Sin duplicación', 'Conserve en el Libro Mayor la cuenta de control. GENTIA concilia el auxiliar y reemplaza automáticamente ese saldo agregado por el detalle de facturas al contabilizar.'],
    ['Formato', 'Use fechas AAAA-MM-DD e importes positivos sin separadores de miles. Puede usar punto o coma como separador decimal.'],
  ];
  help.addRows(instructions);
  for (let row = 2; row <= help.rowCount; row += 1) {
    help.getCell(`A${row}`).font = { bold: true, color: { argb: 'FF063B79' } };
    help.getCell(`A${row}`).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: row % 2 ? 'FFF7FAFC' : 'FFEDF2F7' } };
    help.getCell(`B${row}`).alignment = { vertical: 'top', wrapText: true };
    help.getRow(row).height = 36;
  }
  help.headerFooter.oddFooter = `GENTIA · ${definition.title}                                      Página &P de &N`;
  await workbook.xlsx.writeFile(new URL(`../public/plantilla-saldos-${definition.key}.xlsx`, import.meta.url));
}

console.log('Plantillas CxC/CxP actualizadas en CSV y Excel.');
