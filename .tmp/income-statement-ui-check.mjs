import { chromium } from './record-audit-validation/node_modules/playwright-core/index.mjs';

const browser = await chromium.launch({ headless: true, executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe' });
const fail = async reason => { console.error(reason instanceof Error ? reason.stack : reason); await browser.close(); process.exit(1); };
process.on('unhandledRejection', fail);
setTimeout(() => fail(new Error('La prueba visual excedió 20 segundos.')), 20000).unref();
const page = await browser.newPage();
page.setDefaultTimeout(5000);
const errors = [];
const requests = [];
page.on('pageerror', error => errors.push(error.message));
await page.addInitScript(() => localStorage.setItem('nexo_token', 'ui-check'));
await page.route('**/api/reports/accounting/options', route => route.fulfill({ json: {
  subsidiaries: [{ id: 1, name: 'Empresa de Pruebas', currencyId: 1 }], currencies: [{ id: 1, code: 'USD', symbol: '$' }],
  books: [], periods: [], departments: [{ id: 11, name: 'Cliente CR', type: 'Cliente', subsidiaryId: 1 }, { id: 12, name: 'Administrativo', type: 'Interno', subsidiaryId: 1 }], locations: [],
  classes: [{ id: 21, name: 'HRO', subsidiaryId: 1, departmentIds: [11] }, { id: 22, name: 'Administración', subsidiaryId: 1, departmentIds: [12] }],
  costCenters: [{ id: 31, name: 'Cliente A', subsidiaryId: 1, departmentId: 11, classId: 21 }, { id: 32, name: 'Oficina', subsidiaryId: 1, departmentId: 12, classId: 22 }],
  reportDepartments: [{ id: 11, name: 'Cliente CR', displayName: 'Cliente CR', type: 'Cliente', subsidiaryId: 1 }, { id: 13, name: 'PAGUS LLC', displayName: 'PAGUS LLC (Inactivo · con movimientos)', type: 'Cliente', subsidiaryId: 1, isInactive: true }, { id: 12, name: 'Administrativo', displayName: 'Administrativo', type: 'Interno', subsidiaryId: 1 }],
  reportClasses: [{ id: 21, name: 'HRO', displayName: 'HRO', subsidiaryId: 1, departmentIds: [11, 13] }, { id: 22, name: 'Administración', displayName: 'Administración', subsidiaryId: 1, departmentIds: [12] }],
  reportCostCenters: [{ id: 31, name: 'Cliente A', displayName: 'Cliente A', subsidiaryId: 1, departmentId: 11, classId: 21 }, { id: 32, name: 'Oficina', displayName: 'Oficina', subsidiaryId: 1, departmentId: 12, classId: 22 }], accounts: [], thirdParties: [],
  accountGroups: [{ id: 10, code: '4', name: 'Ingresos', level: 1 }, { id: 20, code: '5', name: 'Gastos', level: 1 }]
} }));
await page.route('**/api/reports/accounting/income-statement', async route => {
  const request = route.request().postDataJSON();
  requests.push(request);
  const matrix = request.columnView !== 'TOTAL';
  await route.fulfill({ json: matrix ? {
    columns: [{ id: '7', name: 'Ventas' }, { id: '8', name: 'Centro sin movimientos' }],
    rows: [
      { account_id: 1, account_number: '4101', account_name: 'Ventas de servicios', group_id: 10, category: 'Ingreso', amount: 150, dimensions: { '7': 100, unassigned: 50 } },
      { account_id: 2, account_number: '5101', account_name: 'Salarios', group_id: 20, category: 'Gasto', amount: 40, dimensions: { '7': 40 } }
    ], total: 2, summary: { periodResult: 110 }
  } : {
    rows: [
      { account_id: 1, account_number: '4101', account_name: 'Ventas de servicios', group_id: 10, category: 'Ingreso', debit: 0, credit: 150 },
      { account_id: 2, account_number: '5101', account_name: 'Salarios', group_id: 20, category: 'Gasto', debit: 40, credit: 0 }
    ], total: 2, summary: { periodResult: 110 }
  } });
});
await page.goto('http://localhost:3000/', { waitUntil: 'domcontentloaded', timeout: 10000 });
await page.setContent('<iframe id="app" src="http://localhost:3000/accounting-reports.html" style="width:1200px;height:800px"></iframe>');
const app = page.frameLocator('#app');
await app.locator('#financial .card').first().waitFor();
if (await app.locator('#financial .card').count() !== 4) throw new Error('No se restauraron las cuatro tarjetas financieras.');
if (await app.locator('#operational .card').count() < 8) throw new Error('Faltan tarjetas operativas.');
await app.locator('#financial .card').nth(1).click();
await app.locator('#tbody tr').first().waitFor();
if (await app.locator('#thead th').count() !== 3) throw new Error('La vista Total dejó de usar sus tres columnas originales.');
await app.locator('#departmentType').selectOption('Cliente');
if (await app.locator('#department option').allTextContents().then(values => values.join('|')) !== 'Todos|Cliente CR|PAGUS LLC (Inactivo · con movimientos)') throw new Error('Tipo Cliente no incluyó correctamente los departamentos activos e históricos.');
if (await app.locator('#class option').allTextContents().then(values => values.join('|')) !== 'Todas las clases aplicables|HRO') throw new Error('Tipo Cliente no filtró las clases.');
if (await app.locator('#costCenter option').allTextContents().then(values => values.join('|')) !== 'Todos los centros aplicables|Cliente A') throw new Error('Tipo Cliente no filtró los centros de costo.');
await app.locator('#department').selectOption('11');
await app.locator('#class').selectOption('21');
await app.locator('#costCenter').selectOption('31');
await app.locator('#columnView').selectOption('DEPARTMENT');
await app.locator('#thead th').nth(4).waitFor();
const headings = await app.locator('#thead th').allTextContents();
if (!headings.includes('Ventas') || !headings.includes('Sin Asignar / General') || !headings.includes('Total Consolidado')) throw new Error('La matriz no contiene las columnas obligatorias.');
if (headings.includes('Centro sin movimientos')) throw new Error('La matriz mostró una dimensión completamente en cero.');
if (!(await app.locator('table.income-matrix').count())) throw new Error('No se activó el formato matricial.');
const filteredRequest = requests.at(-1);
if (filteredRequest.departmentType !== 'Cliente' || String(filteredRequest.departmentId) !== '11' || String(filteredRequest.classId) !== '21' || String(filteredRequest.costCenterId) !== '31') throw new Error('El tipo y los filtros relacionados no llegaron juntos al informe.');
if (errors.length) throw new Error(errors.join('\n'));
console.log(JSON.stringify({ financialCards: 4, operationalCards: await app.locator('#operational .card').count(), headings }));
await browser.close();
