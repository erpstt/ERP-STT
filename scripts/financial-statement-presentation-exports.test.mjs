import assert from 'node:assert/strict';
import {test} from 'node:test';
import {reportSections} from '../dist/modules/reports/scheduled-report-renderer.js';
import {scheduledReportCsv,scheduledReportHtml,scheduledReportFiles} from '../dist/modules/reports/scheduled-reports.service.js';
import {parseBudgetCsv} from '../dist/modules/budget/budget.service.js';

const base=()=>({kind:'income-statement',title:'Estado de resultados',company:'Synthetic company',currency:'JMD',cutoff:'2026-09-30',dateFrom:'2026-01-01',rows:[],summary:{},data:{presentationCurrency:'USD',presentationCurrencyCode:'USD',localCurrencyCode:'JMD',ratesUsed:[{period:'2026-09',rateType:'PROMEDIO',rate:0.006123456789}],rows:[{account_number:'4001',account_name:'Ventas',category:'Ingreso',debit:0,credit:100},{account_number:'5001',account_name:'Costos',category:'Costo',debit:30,credit:0}],summary:{periodResult:70}}});
const parsed=report=>parseBudgetCsv(scheduledReportCsv(report).replace(/^\ufeff/,''));

test('USD scheduled CSV and PDF identify presentation and functional currencies without converting amounts twice',async()=>{
 const report=base(),before=structuredClone(report),csv=parsed(report),html=scheduledReportHtml(report);
 assert.ok(csv.some(row=>row[0]==='Moneda de presentación'&&row[1]==='USD'));assert.ok(csv.some(row=>row[0]==='Moneda local'&&row[1]==='JMD'));
 assert.ok(csv.some(row=>row[0]==='Resultado neto'&&row[1]==='70'));assert.ok(html.includes('Moneda de presentación: USD'));assert.ok(html.includes('Moneda local: JMD'));
 assert.ok(html.includes('0,006123456789'));assert.ok(csv.flat().includes('0.006123456789'));
 const files=await scheduledReportFiles(report,'CSV');assert.equal(files.length,1);assert.equal(Buffer.from(files[0].base64,'base64').toString(),scheduledReportCsv(report));assert.deepEqual(report,before);
});

test('USD balance export keeps the virtual translation adjustment and converted annual result in equity',()=>{
 const report={...base(),kind:'balance-sheet',data:{...base().data,rows:[{account_number:'1001',account_name:'Caja',category:'Activo',closing:100},{account_number:'2001',account_name:'Proveedores',category:'Pasivo',closing:-20},{account_number:'3001',account_name:'Capital',category:'Patrimonio',closing:-50},{account_number:'',account_name:'Diferencia de conversión',category:'Patrimonio',closing:-10}],summary:{currentPeriodResult:20,translationAdjustment:10}}};
 const sections=reportSections(report);assert.deepEqual(sections[0].rows,[['Activo',100],['Pasivo',20],['Resultado del ejercicio',20],['Patrimonio (incluye resultado)',80],['Pasivo y patrimonio',100],['Diferencia',0]]);
 assert.ok(parsed(report).some(row=>row.includes('Diferencia de conversión')&&row.includes('10')));
});

test('USD balance preserves an explicitly chosen zero or sub-cent annual result',()=>{
 for(const exerciseResult of [0,0.001]){
  const report={...base(),kind:'balance-sheet',data:{...base().data,rows:[],summary:{exerciseResult,currentPeriodResult:0.001,resultExercise:5,sourceBalanced:false,localBalanceDifference:10,translationAdjustment:0}}};
  assert.equal(reportSections(report)[0].rows.find(row=>row[0]==='Resultado del ejercicio')[1],exerciseResult);
  const csv=parsed(report);assert.ok(csv.some(row=>row[0]==='Origen cuadrado'&&row[1]==='false'));assert.ok(csv.some(row=>row[0]==='Diferencia en moneda local'&&row[1]==='10'));
 }
});

test('period matrix exports retain translated cells, zero periods and numeric totals',()=>{
 const report=base();report.data.columns=[{id:'2026-08',name:'Agosto 2026'},{id:'2026-09',name:'Septiembre 2026'},{id:'2026-10',name:'Octubre 2026'}];report.data.summary.columnView='ACCOUNTING_PERIOD';report.data.rows[0]={...report.data.rows[0],amount:100,dimensions:{'2026-08':40,'2026-09':60}};report.data.rows[1]={...report.data.rows[1],amount:30,dimensions:{'2026-08':10,'2026-09':20}};
 const before=structuredClone(report),sections=reportSections(report),matrix=sections.find(section=>section.title==='Resultados por dimensión'),detail=sections.find(section=>section.title==='Detalle');
 assert.deepEqual(matrix.columns,['Concepto','Agosto 2026','Septiembre 2026','Octubre 2026','Total']);assert.deepEqual(matrix.rows.at(-1),['Resultado neto',30,40,0,70]);
 assert.deepEqual(detail.rows.map(row=>row.slice(-4)),[[40,60,0,100],[10,20,0,30]]);assert.ok(parsed(report).some(row=>row[0]==='Resultado neto'&&row.slice(1).join(',')==='30,40,0,70'));assert.deepEqual(report,before);
});

test('dimension matrices keep unassigned and uncatalogued dimensions and escape hostile labels',()=>{
 const report=base(),attack='<img src=x onerror=alert(1)>';report.data.columns=[{id:'1',name:attack}];report.data.summary.columnView='DEPARTMENT';report.data.rows=[{...report.data.rows[0],amount:100,dimensions:{1:50,2:30,unassigned:20}}];
 const matrix=reportSections(report).find(section=>section.title==='Resultados por dimensión');assert.deepEqual(matrix.columns,['Concepto',attack,'Dimensión 2','Sin Asignar / General','Total']);assert.deepEqual(matrix.rows.at(-1),['Resultado neto',50,30,20,100]);
 const html=scheduledReportHtml(report);assert.ok(html.includes('&lt;img'));assert.ok(!html.includes('<img'));
});

test('LOCAL default exports retain the existing label and values without USD metadata',()=>{
 const report=base();delete report.data.presentationCurrency;delete report.data.presentationCurrencyCode;delete report.data.localCurrencyCode;delete report.data.ratesUsed;
 assert.ok(parsed(report).some(row=>row[0]==='Moneda local'&&row[1]==='JMD'));assert.ok(!scheduledReportHtml(report).includes('Moneda de presentación'));assert.equal(reportSections(report)[0].rows.at(-1)[1],70);
});

test('USD exports reject incomplete currency metadata rather than producing an ambiguous attachment',()=>{
 for(const change of [{presentationCurrencyCode:'JMD'},{localCurrencyCode:null},{localCurrencyCode:''}]){const report=base();Object.assign(report.data,change);assert.throws(()=>scheduledReportCsv(report),/moneda de presentación/);assert.throws(()=>scheduledReportHtml(report),/moneda de presentación/);}
});
