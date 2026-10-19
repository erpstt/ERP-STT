import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';

process.env.SUPABASE_URL = 'https://audit-export-test.invalid';
process.env.SUPABASE_ANON_KEY = 'test-anon-key';

const report = {
  header: {
    month: '2026-10',
    periodLabel: 'octubre de 2026',
    generatedAt: '2026-10-19T14:00:00Z',
    filterDescription: 'Todas las subsidiarias · Todos los usuarios · Modificados y eliminados'
  },
  summary: {
    totalEvents: 2,
    operationCount: 2,
    modifiedCount: 1,
    deletedCount: 1,
    fieldChanges: 2,
    userCount: 1,
    mostActiveUser: 'Ana Pérez',
    byUser: [
      { name: 'Ana Pérez', email: 'ana@example.test', events: 2, operations: 2, modified: 1, deleted: 1 }
    ],
    byModule: [
      { module: 'sales', label: 'Ventas y cuentas por cobrar', events: 1, modified: 1, deleted: 0 },
      { module: 'purchases', label: 'Compras y cuentas por pagar', events: 1, modified: 0, deleted: 1 }
    ],
    byDay: [
      { date: '2026-10-18', events: 2, modified: 1, deleted: 1 }
    ],
    byTransactionType: [
      { transactionType: 'sales_invoice', transactionTypeLabel: 'Facturas de venta', total: 1, modified: 1, deleted: 0 },
      { transactionType: 'supplier_invoice', transactionTypeLabel: 'Facturas de proveedor', total: 1, modified: 0, deleted: 1 }
    ]
  },
  total: 2,
  page: 1,
  pageSize: 200,
  rows: [
    {
      auditId: 101,
      executionContextId: 'request-1',
      timestamp: '2026-10-18T16:20:00Z',
      action: 'MODIFICACION',
      module: 'sales',
      moduleLabel: 'Ventas y cuentas por cobrar',
      entityType: 'invoice',
      entityLabel: 'Factura de venta',
      entityKey: 'invoice_id=44',
      recordLabel: 'FAC_VEN-000044',
      transactionType: 'sales_invoice',
      transactionTypeLabel: 'Facturas de venta',
      documentNumber: 'FAC_VEN-000044',
      subsidiaryId: 'subsidiary-1',
      subsidiaryName: 'EMPRESA DE PRUEBAS',
      documentCreator: { id: 'user-2', name: 'Luis Gómez', email: 'luis@example.test' },
      actor: { name: 'Ana Pérez', email: 'ana@example.test', type: 'HUMAN', source: 'NEXO ERP' },
      ipAddress: '127.0.0.1',
      fieldsChangedCount: 2,
      changes: [
        { field: 'status', fieldLabel: 'Estado', oldValue: 'BORRADOR', newValue: 'APROBADO' },
        { field: 'password_hash', fieldLabel: 'Contraseña', oldValue: 'secret-old', newValue: 'secret-new' }
      ],
      deletedSnapshot: {}
    },
    {
      auditId: 102,
      executionContextId: 'request-2',
      timestamp: '2026-10-18T16:25:00Z',
      action: 'ELIMINACION',
      module: 'purchases',
      moduleLabel: 'Compras y cuentas por pagar',
      entityType: 'supplier_invoice',
      entityLabel: 'Factura de proveedor',
      entityKey: 'supplier_invoice_id=8',
      recordLabel: 'FAC_PRO-000008',
      transactionType: 'supplier_invoice',
      transactionTypeLabel: 'Facturas de proveedor',
      documentNumber: 'FAC_PRO-000008',
      subsidiaryId: 'subsidiary-2',
      subsidiaryNames: ['EMPRESA COSTA RICA', 'EMPRESA DE PRUEBAS'],
      documentCreator: { id: 'user-3', name: 'Carlos Mora', email: 'carlos@example.test' },
      actor: { name: 'Ana Pérez', email: 'ana@example.test', type: 'HUMAN', source: 'NEXO ERP' },
      ipAddress: '127.0.0.1',
      fieldsChangedCount: 0,
      changes: [],
      deletedSnapshot: {
        invoice_number: 'FAC_PRO-000008',
        description: 'Servicio eliminado',
        amount: '125.00',
        smtp_secret: 'must-not-leak'
      }
    }
  ]
};

globalThis.fetch = async input => {
  const path = new URL(String(input)).pathname;
  if (path.endsWith('/rpc/security_assert_role_access')) {
    return new Response('null', { status: 200, headers: { 'Content-Type': 'application/json' } });
  }
  if (path.endsWith('/rpc/run_audit_change_report')) {
    return new Response(JSON.stringify(report), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }
  throw new Error(`Solicitud no esperada: ${path}`);
};

const { exportAuditChangeReportExcel, exportAuditChangeReportPdf } = await import('../dist/modules/reports/audit-change-report.service.js');
const filters = { month: '2026-10' };
const [pdf, excel] = await Promise.all([
  exportAuditChangeReportPdf('Bearer test', filters),
  exportAuditChangeReportExcel('Bearer test', filters)
]);

assert.equal(pdf.buffer.subarray(0, 4).toString(), '%PDF');
assert.equal(excel.buffer.subarray(0, 2).toString(), 'PK');
assert.match(pdf.fileName, /auditoria-transacciones-2026-10\.pdf$/);
assert.match(excel.fileName, /auditoria-transacciones-2026-10\.xlsx$/);
assert.ok(!pdf.buffer.includes(Buffer.from('secret-old')));
assert.ok(!excel.buffer.includes(Buffer.from('must-not-leak')));

const workbook = new ExcelJS.Workbook();
await workbook.xlsx.load(excel.buffer);
assert.deepEqual(workbook.worksheets.map(sheet => sheet.name), ['Resumen', 'Transacciones', 'Cambios']);

const summary = workbook.getWorksheet('Resumen');
const transactions = workbook.getWorksheet('Transacciones');
const changes = workbook.getWorksheet('Cambios');
assert.ok(summary);
assert.ok(transactions);
assert.ok(changes);

const sheetText = sheet => sheet.getSheetValues()
  .flat(3)
  .filter(value => value !== undefined && value !== null)
  .join(' | ');

const summaryText = sheetText(summary);
const transactionText = sheetText(transactions);
const changeText = sheetText(changes);

assert.match(summaryText, /Facturas de venta/);
assert.match(summaryText, /Facturas de proveedor/);
assert.match(transactionText, /FAC_VEN-000044/);
assert.match(transactionText, /FAC_PRO-000008/);
assert.match(transactionText, /EMPRESA DE PRUEBAS/);
assert.match(transactionText, /EMPRESA COSTA RICA/);
assert.match(transactionText, /EMPRESA COSTA RICA · EMPRESA DE PRUEBAS/);
assert.match(transactionText, /Luis Gómez/);
assert.match(transactionText, /Carlos Mora/);
assert.match(changeText, /BORRADOR/);
assert.match(changeText, /APROBADO/);
assert.match(changeText, /Servicio eliminado/);
assert.doesNotMatch(`${summaryText} ${transactionText} ${changeText}`, /secret-old|secret-new|must-not-leak/);

console.log(JSON.stringify({
  passed: true,
  pdfBytes: pdf.buffer.length,
  excelBytes: excel.buffer.length,
  sheets: workbook.worksheets.map(sheet => sheet.name),
  groupedTransactionTypes: 2,
  sensitiveValuesHidden: true
}));
