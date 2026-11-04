import assert from 'node:assert/strict';
import {test} from 'node:test';
import {reportSections} from '../dist/modules/reports/scheduled-report-renderer.js';
import {scheduledReportCsv,scheduledReportHtml,scheduledReportFiles} from '../dist/modules/reports/scheduled-reports.service.js';
import {parseBudgetCsv} from '../dist/modules/budget/budget.service.js';

const labels=['Moneda original','Tipo de cambio utilizado','Débito original','Crédito original'];
const source=()=>({kind:'general-ledger',title:'Libro Mayor',company:'Synthetic company',currency:'CRC',cutoff:'2026-09-30',dateFrom:'2026-09-01',rows:[],summary:{subledger:0,advances:0,netBalance:0},data:{rows:[{
  original_credit:0,original_exchange_rate:0.123456789012,original_currency_code:'USD',original_debit:123.123456,
  id:99,account_number:'00123',account_name:'Synthetic account',date:'2026-09-30',entity_name:'Synthetic customer',debit:15.2004,credit:0,running_balance:15.2004,
},{original_currency_code:'CRC',original_exchange_rate:1,original_debit:0,original_credit:15.2004,
  id:100,account_number:'00123',account_name:'Synthetic account',date:'2026-09-30',entity_name:'Synthetic customer',debit:0,credit:15.2004,running_balance:0,
},{original_currency_code:null,original_exchange_rate:null,original_debit:null,original_credit:null,
  id:101,account_number:'00123',account_name:'Synthetic account',date:'2026-09-30',entity_name:'Synthetic customer',debit:0,credit:0,running_balance:0,
}],summary:{debit:15.2004,credit:15.2004}}});
const detail=report=>reportSections(report).find(section=>section.title==='Detalle');

test('scheduled ledger appends four original-currency columns and preserves existing columns, local values and input',()=>{
  const report=source(),before=structuredClone(report),baseline=structuredClone(report);
  baseline.data.rows=baseline.data.rows.map(({original_currency_code,original_exchange_rate,original_debit,original_credit,...row})=>row);
  const original=detail(baseline),actual=detail(report);
  assert.deepEqual(actual.columns.slice(0,-4),original.columns);
  assert.deepEqual(actual.columns.slice(-4),labels);
  assert.deepEqual(actual.rows.map(row=>row.slice(0,-4)),original.rows);
  assert.deepEqual(actual.rows.map(row=>row.slice(-4)),[['USD',0.123456789012,123.123456,0],['CRC',1,0,15.2004],[null,null,null,null]]);
  assert.deepEqual(report,before);
  assert.deepEqual(reportSections(report).filter(section=>section.title==='Resumen'),reportSections(baseline).filter(section=>section.title==='Resumen'));
});

test('CSV attachment retains numeric precision and distinguishes original zero from unknown null',async()=>{
  const report=source(),files=await scheduledReportFiles(report,'CSV');assert.equal(files.length,1);
  const csv=Buffer.from(files[0].base64,'base64').toString('utf8');assert.equal(csv,scheduledReportCsv(report));
  const rows=parseBudgetCsv(csv.replace(/^\ufeff/,'')),header=rows.findIndex(row=>row.includes('Moneda original'));
  assert.deepEqual(rows[header].slice(-4),labels);
  assert.deepEqual(rows[header+1].slice(-4),['USD','0.123456789012','123.123456','0']);
  assert.deepEqual(rows[header+2].slice(-4),['CRC','1','0','15.2004']);
  assert.deepEqual(rows[header+3].slice(-4),['','','','']);
});

test('PDF HTML retains all four columns, twelve-decimal rate, six-decimal originals and safe text',()=>{
  const report=source();report.data.rows[0].original_currency_code='<img src=x onerror=alert(1)>';
  const html=scheduledReportHtml(report);
  for(const label of labels)assert.ok(html.includes(`<th>${label}</th>`),label);
  assert.ok(html.includes('0,123456789012'));assert.ok(html.includes('123,123456'));assert.ok(html.includes('0,00'));
  assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt;'));assert.ok(!html.includes('<img'));
  assert.ok(html.includes('>—</td>'));
});

test('local-only FX zeroes remain zero and original amounts are never combined across currencies',()=>{
  const report=source();report.data.rows=[{account_number:'00123',debit:100,credit:0,original_currency_code:'CRC',original_exchange_rate:1,original_debit:0,original_credit:0},
    {account_number:'00123',debit:0,credit:100,original_currency_code:'USD',original_exchange_rate:500,original_debit:0,original_credit:0.2}];
  report.data.summary={debit:100,credit:100};const sections=reportSections(report),rows=detail(report).rows;
  assert.deepEqual(rows.map(row=>row.slice(-4)),[['CRC',1,0,0],['USD',500,0,0.2]]);
  assert.equal(sections.filter(section=>section.title==='Resumen').length,1);
  assert.deepEqual(sections.find(section=>section.title==='Resumen').rows,[['Débito',100],['Crédito',100]]);
  assert.equal(sections.filter(section=>section.title==='Detalle').length,1);
});
