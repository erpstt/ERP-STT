import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import pg from 'pg';

process.loadEnvFile?.('.env');
const projectRef = new URL(process.env.SUPABASE_URL).hostname.split('.')[0];
const db = new pg.Client({
  host: process.env.SUPABASE_DB_HOST || 'aws-0-us-east-1.pooler.supabase.com',
  port: Number(process.env.SUPABASE_DB_PORT || 6543),
  database: process.env.SUPABASE_DB_NAME || 'postgres',
  user: process.env.SUPABASE_DB_USER || `postgres.${projectRef}`,
  password: process.env.SUPABASE_DB_PASSWORD || process.env.PGPASSWORD,
  ssl: { rejectUnauthorized: false },
  connectionTimeoutMillis: 15000,
});

const filters = {
  subsidiaryId: 3,
  periodMonth: '2026-09',
  includeAdjustments: true,
  documentStatuses: ['APROBADO'],
  priorPeriodCredit: 125,
};
await db.connect();
let report;
try {
  const context = (await db.query(`
    select u.email,session.session_id
    from user_company_sessions session join users u using(user_id)
    where session.subsidiary_id=3 order by session.selected_at desc limit 1
  `)).rows[0];
  await db.query("select set_config('request.jwt.claims',$1,false)", [JSON.stringify(context)]);
  report = (await db.query('select run_vat_declaration_report($1::jsonb) value', [filters])).rows[0].value;
} finally {
  await db.end();
}

const nativeFetch = globalThis.fetch;
globalThis.fetch = async (input) => {
  if (String(input).includes('/rest/v1/rpc/run_vat_declaration_report')) {
    return new Response(JSON.stringify(report), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  throw new Error(`Solicitud inesperada: ${input}`);
};

try {
  const service = await import('../dist/modules/reports/vat-declaration-report.service.js');
  const [pdf, excel] = await Promise.all([
    service.exportVatDeclarationReportPdf('Bearer fixture', filters),
    service.exportVatDeclarationReportExcel('Bearer fixture', filters),
  ]);
  assert.equal(pdf.mimeType, 'application/pdf');
  assert.equal(pdf.buffer.subarray(0, 4).toString(), '%PDF');
  assert.ok(pdf.buffer.length > 20_000, 'El PDF debe contener el reporte renderizado.');
  assert.equal(excel.mimeType, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  assert.equal(excel.buffer.subarray(0, 2).toString(), 'PK');

  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(excel.buffer);
  assert.deepEqual(workbook.worksheets.map((sheet) => sheet.name), ['Resumen', 'Detalle Ventas', 'Detalle Compras']);
  const summary = workbook.getWorksheet('Resumen');
  const sales = workbook.getWorksheet('Detalle Ventas');
  const purchases = workbook.getWorksheet('Detalle Compras');
  assert.ok(summary && sales && purchases);
  assert.ok(sales.rowCount >= 3 + report.details.filter((row) => row.side === 'SALES').length);
  assert.ok(purchases.rowCount >= 3 + report.details.filter((row) => row.side === 'PURCHASES').length);
  const workbookText = workbook.worksheets
    .flatMap((sheet) => sheet._rows.filter(Boolean).flatMap((row) => row.values || []))
    .join(' ');
  for (const expected of ['GENTIA', 'JAM_GCT_15%', 'Retenido practicado', 'EMPRESA DE PRUEBAS']) {
    assert.ok(workbookText.includes(expected), `Falta ${expected} en Excel.`);
  }
  assert.ok(!/[ÃƒÃ‚ï¿½]/.test(workbookText), 'Los archivos no deben contener texto con codificación dañada.');
  const practicedRow = summary._rows.find((row) => row?.values?.some((value) => value === 'Retenido practicado'));
  assert.ok(practicedRow);
  assert.equal(Number(practicedRow.getCell(4).value), -Number(report.summary.vatWithheldPracticed));
  console.log(JSON.stringify({
    pdfBytes: pdf.buffer.length,
    excelBytes: excel.buffer.length,
    sheets: workbook.worksheets.map((sheet) => sheet.name),
    salesDetailRows: report.details.filter((row) => row.side === 'SALES').length,
    purchaseDetailRows: report.details.filter((row) => row.side === 'PURCHASES').length,
    netTax: report.summary.netTax,
  }, null, 2));
} finally {
  globalThis.fetch = nativeFetch;
}
