import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { chromium } from '@playwright/test';
import ExcelJS from 'exceljs';
import { csvCell } from '../public/spreadsheet-safety.js';
import { renderGeneralLedgerExport } from '../dist/modules/reports/general-ledger-export-renderer.js';

const source = await readFile(new URL('../public/accounting-reports.js', import.meta.url), 'utf8');
const css = await readFile(new URL('../public/accounting-reports.css', import.meta.url), 'utf8');
const sourceFile = ts.createSourceFile('accounting-reports.js', source, 99, true, ts.ScriptKind.JS);
function declarations(names) {
  return names.map(name => {
    for (const statement of sourceFile.statements) {
      if (ts.isFunctionDeclaration(statement) && statement.name?.text === name) return statement.getText(sourceFile);
      if (ts.isVariableStatement(statement)) for (const declaration of statement.declarationList.declarations) {
        if (declaration.name.getText(sourceFile) === name) return 'const ' + declaration.getText(sourceFile) + ';';
      }
    }
    throw Error('Missing declaration: ' + name);
  }).join('\n');
}
const originalHeaders = ['Moneda original', 'Tipo de cambio utilizado', 'Débito original', 'Crédito original'];
const attack = '<img src=x onerror="window.syntheticXss=1">';
const baseRow = {
  date: '2026-11-04', transaction_number: 'FAC-SYN', transaction_type: 'Factura', journal_id: 4,
  journal_number: 'ASI-SYN', account_id: 1, account_number: '1101', account_name: 'Clientes', nature: 'Deudora',
  entity_name: 'Cliente sintético', entity_type: 'Cliente', cost_center: 'Centro sintético', concept: 'Servicio',
  debit: 500, credit: 0, running_balance: 500, opening_balance: 0,
  account_debit_total: 500, account_credit_total: 0, account_final_balance: 500,
  original_currency_code: 'USD', original_exchange_rate: 523.123456789012,
  original_debit: 1.234567, original_credit: 0
};

test('formatos originales conservan ceros, hasta seis decimales en importes y doce en tasas', () => {
  const result = runInNewContext(declarations(['ledgerOriginalAmount', 'ledgerOriginalRate']) + `({
    zero:ledgerOriginalAmount(0,'USD'),crc:ledgerOriginalAmount(1000.123456,'CRC'),
    missing:ledgerOriginalAmount(null,'USD'),rate:ledgerOriginalRate(523.123456789012),
    missingRate:ledgerOriginalRate(null),zeroRate:ledgerOriginalRate(0)
  })`);
  assert.equal(result.zero, 'USD 0,00');
  assert.match(result.crc, /^CRC 1[.\u00a0 ]000,123456$/);
  assert.equal(result.missing, '—');
  assert.equal(result.rate, '523,123456789012');
  assert.equal(result.missingRate, '—');
  assert.equal(result.zeroRate, '0');
});

test('pantalla del Mayor mantiene columnas locales, añade cuatro originales y deja sus totales vacíos', { timeout: 45000 }, async t => {
  const server = createServer((request, response) => {
    if (request.url === '/accounting-reports.css') { response.setHeader('Content-Type', 'text/css'); response.end(css); }
    else { response.setHeader('Content-Type', 'text/html'); response.end('<!doctype html><html><head><link rel="stylesheet" href="/accounting-reports.css"></head><body><main><section id="workspace" class="ledger-report"><select id="currency"><option value="1">CRC</option></select><select id="ledgerView"><option value="ENTITY">Entidad</option></select><div class="table-wrap"><table><thead id="thead"></thead><tbody id="tbody"></tbody></table></div><div id="summary"></div></section></main></body></html>'); }
  });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  t.after(() => new Promise(done => { server.closeAllConnections(); server.close(done); }));
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1500, height: 1000 } });
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  const rows = [baseRow,
    { ...baseRow, original_currency_code: 'CRC', original_exchange_rate: 1, original_debit: 0, original_credit: 100.123456 },
    { ...baseRow, original_currency_code: null, original_exchange_rate: null, original_debit: null, original_credit: null },
    { ...baseRow, original_currency_code: attack, original_exchange_rate: 1, original_debit: 0, original_credit: 0 }
  ];
  await page.evaluate(({ code, rows }) => {
    window.syntheticRows = rows;
    window.syntheticRender = new Function('rows', `const $=id=>document.getElementById(id),data={rows,total:rows.length},options={currencies:[{id:1,symbol:'₡'}]},htmlText=value=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char])),escapeHtml=htmlText,renderPager=()=>{},openJournalDrawer=id=>window.syntheticJournal=id;` + code + 'renderGeneralLedger();');
    window.syntheticRender(rows);
  }, { code: declarations(['financial', 'ledgerOriginalAmount', 'ledgerOriginalRate', 'renderGeneralLedger']), rows });
  const headers = await page.locator('#thead th').allTextContents();
  assert.equal(headers.length, 14);
  assert.deepEqual(headers.slice(10), originalHeaders);
  const movements = page.locator('#tbody tr').filter({ has: page.locator('.ledger-link') });
  const first = await movements.nth(0).locator('td').allTextContents();
  assert.deepEqual(first.slice(7, 10), ['₡ 500,00', '₡ 0,00', '₡ 500,00']);
  assert.deepEqual(first.slice(10), ['USD', '523,123456789012', 'USD 1,234567', 'USD 0,00']);
  const second = await movements.nth(1).locator('td').allTextContents();
  assert.deepEqual(second.slice(10), ['CRC', '1', 'CRC 0,00', 'CRC 100,123456']);
  assert.deepEqual((await movements.nth(2).locator('td').allTextContents()).slice(10), ['—', '—', '—', '—']);
  assert.equal(await movements.nth(3).locator('td').nth(10).textContent(), attack);
  assert.equal(await page.locator('img,[onerror]').count(), 0);
  assert.equal(await page.evaluate(() => window.syntheticXss), undefined);
  assert.ok((await page.locator('#tbody tr').evaluateAll(rows => rows.map(row => [...row.cells].reduce((sum, cell) => sum + cell.colSpan, 0)))).every(count => count === 14));
  assert.deepEqual(await page.locator('.ledger-subtotal td:last-child,.ledger-account-footer td:last-child').allTextContents(), ['', '']);
  await movements.first().locator('.ledger-link').first().click();
  assert.equal(await page.evaluate(() => window.syntheticJournal), '4');
  assert.ok(await page.locator('.table-wrap').evaluate(element => element.scrollWidth > element.clientWidth));
  await page.emulateMedia({ media: 'print' });
  assert.equal(await page.locator('table').evaluate(element => getComputedStyle(element).minWidth), '0px');
  assert.equal(await page.locator('#tbody td.number').first().evaluate(element => getComputedStyle(element).whiteSpace), 'nowrap');
  await page.evaluate(() => window.syntheticRender([]));
  assert.equal(await page.locator('#tbody td').getAttribute('colspan'), '14');
});

test('CSV y XLSX anexan cuatro campos numéricos sin redondeo de origen ni sumas de monedas mixtas', async () => {
  const row = { ...baseRow, original_currency_code: 'USD' }, downloads = [],formats=[];
  const rows=[row,{ ...row, original_currency_code: 'CRC', original_debit: 1000.123456, original_credit: 0 },{ ...row, original_currency_code: null, original_exchange_rate: null, original_debit: null, original_credit: null }].map((value,index)=>({...value,id:index+1,running_balance:(index+1)*500,account_debit_total:1500,account_credit_total:0,account_final_balance:1500}));
  const snapshot={rows,total:3,summary:{debit:1500,credit:0},snapshotFingerprint:'a'.repeat(32),context:{subsidiary:{id:1,name:'Empresa sintética'},localCurrency:{id:1,code:'CRC',name:'Colón'},book:{id:1,name:'Principal'},bookId:1,dateFrom:'2026-11-04',dateTo:'2026-11-04',filters:{subsidiaryIds:[1],dateFrom:'2026-11-04',dateTo:'2026-11-04'},generatedAt:'2026-11-09T20:00:00Z'}};
  const script = declarations(['labels', 'moneyKeys', 'isFinancialPresentationReport', 'exportRows']) + `exportRows('csv').then(()=>exportRows('excel'))`;
  await runInNewContext(script, {
    data: { rows },
    current: ['operational', 'general-ledger', 'Libro Mayor'],
    $: id => ({ value: id === 'to' ? '2026-11-04' : '' }),
    exportContext: () => ({ currencyLabel: 'CRC', subsidiaryName: 'Empresa sintética' }),
    download: (blob, name) => downloads.push({ blob, name }), csvCell,
    exportGeneralLedger:async format=>{formats.push(format);const file=await renderGeneralLedgerExport(snapshot,format,'ACCOUNT');downloads.push({blob:new Blob([file.buffer],{type:file.mimeType}),name:file.fileName});},Blob,
    alert: message => { throw Error(message); }
  });
  assert.deepEqual(formats,['csv','xlsx']);
  const csv = await downloads[0].blob.text();
  assert.ok(csv.split('\r\n')[0].endsWith(originalHeaders.map(csvCell).join(',')));
  assert.ok(csv.includes('"USD","523.123456789012","1.234567","0"'));
  assert.ok(csv.includes('"CRC","523.123456789012","1000.123456","0"'));
  assert.ok(csv.split('\r\n').filter(Boolean).at(-1).endsWith('"","","",""'));
  const book = new ExcelJS.Workbook();
  await book.xlsx.load(await downloads[1].blob.arrayBuffer());
  const sheet = book.worksheets[0], header = sheet.getRow(8), columns = {},movements=[];
  sheet.eachRow(value=>{if(value.getCell(1).value instanceof Date)movements.push(value);});
  assert.equal(movements.length,3);
  header.eachCell((cell, column) => { columns[String(cell.value)] = column; });
  assert.deepEqual(header.values.slice(-4), originalHeaders);
  const debit = columns['Débito original'], credit = columns['Crédito original'], rate = columns['Tipo de cambio utilizado'];
  assert.equal(movements[0].getCell(debit).value, 1.234567);
  assert.equal(movements[1].getCell(debit).value, 1000.123456);
  assert.equal(movements[0].getCell(credit).value, 0);
  assert.equal(movements[0].getCell(rate).value, 523.123456789012);
  assert.equal(movements[0].getCell(rate).numFmt, '0.############');
  assert.equal(movements[0].getCell(debit).numFmt, '#,##0.00####;(#,##0.00####)');
  assert.equal(movements[2].getCell(debit).value, null);
  const footer=sheet.getRow(sheet.rowCount);
  for (const column of Object.values(columns).filter(column => column >= columns['Moneda original'])) assert.equal(footer.getCell(column).value, null);
  assert.equal(footer.getCell(columns['Débito local']).value,1500);
  assert.equal(footer.getCell(columns['Débito local']).formula,undefined);
});

test('PDF del Mayor solicita descarga completa sin abrir impresión y distingue moneda local de original', async () => {
  const statement = sourceFile.statements.find(statement => ts.isExpressionStatement(statement) && statement.expression.getText(sourceFile).startsWith("$('pdf').onclick="));
  assert.ok(statement, 'PDF handler');
  const formats=[],pdf={},window={print(){throw Error('Libro Mayor no debe abrir impresión');}};
  await runInNewContext(statement.getText(sourceFile) + "$('pdf').onclick();", {
    $:()=>pdf,current:['operational','general-ledger'],window,exportGeneralLedger:async format=>formats.push(format),isFinancialPresentationReport:()=>false
  });
  assert.deepEqual(formats,['pdf']);
  assert.match(declarations(['exportContext']), /Moneda local:.*moneda original/s);
  const html = await readFile(new URL('../public/accounting-reports.html', import.meta.url), 'utf8');
  assert.match(html, /accounting-reports\.js\?v=20261109-general-ledger-exports/);
  assert.match(html, /accounting-reports\.css\?v=20261109-general-ledger-exports/);
});
