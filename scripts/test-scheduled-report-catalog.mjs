import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {scheduledReportFiles,scheduledReportCsv,scheduledReportHtml,deliverScheduledReport} from '../dist/modules/reports/scheduled-reports.service.js';
import {reportSections} from '../dist/modules/reports/scheduled-report-renderer.js';
const reports=JSON.parse(await readFile('.tmp/scheduled-report-snapshots.json','utf8'));
assert.equal(reports.length,18);
for(const report of reports){
 const html=scheduledReportHtml(report),csv=scheduledReportCsv(report);
 assert.ok(html.includes(report.title));assert.ok(csv.length>20);assert.ok(!html.includes('[object Object]'));
 const files=await scheduledReportFiles(report,'BOTH');assert.equal(files.length,2);assert.equal(Buffer.from(files[0].base64,'base64').subarray(0,4).toString(),'%PDF');assert.ok(files[0].fileName.includes(report.kind==='AR'?'cxc':report.kind==='AP'?'cxp':report.kind));
 console.log('PDF + CSV '+report.kind);
}
const sample={kind:'journal',title:'Libro Diario',company:'Empresa <test>',currency:'USD',cutoff:'2026-09-21',data:{rows:[{journal_number:'ASI-1',memo:'<script>alert(1)</script>',lines:[{account_number:'1001',note:'=HYPERLINK("bad")',debit:100,credit:0}]}]}};
assert.ok(scheduledReportHtml(sample).includes('&lt;script&gt;'));assert.ok(scheduledReportHtml(sample).includes('1001'));assert.ok(scheduledReportCsv(sample).includes("'=HYPERLINK"));
const financial={...sample,kind:'income-statement',data:{rows:[{category:'Ingreso',account_name:'Ventas',debit:0,credit:1000},{category:'Costo',account_name:'Costo',debit:300,credit:0},{category:'Gasto',account_name:'Alquiler',debit:200,credit:0}],summary:{}}};
assert.equal(reportSections(financial)[0].rows.find(r=>r[0]==='Resultado neto')[1],500);
let sends=0;
await deliverScheduledReport({id:'mock',lease:'mock',recipient:'finance@example.invalid',configuration:{format:'CSV',name:'Diario'}},async()=>sample,async mail=>{sends++;assert.ok(mail.subject.includes('Libro Diario'));assert.ok(!mail.html.includes('Saldo neto'));return{accepted:['finance@example.invalid']};},async()=>true,async status=>assert.equal(status,'ENVIADO'),async()=>[{fileName:'diario.csv',mimeType:'text/csv',base64:Buffer.from('test').toString('base64')}]);
assert.equal(sends,1);
// A safe synthetic preview is retained for visual inspection, without company records.
await writeFile('.tmp/scheduled-report-catalog-preview.html',scheduledReportHtml(sample));
console.log(JSON.stringify({reports:18,realPdfs:true,csv:true,nestedLines:true,escapedHtml:true,csvInjectionProtected:true,financialTotals:true,genericEmail:true,noRealEmails:true}));
