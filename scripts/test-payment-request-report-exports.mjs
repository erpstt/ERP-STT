import assert from 'node:assert/strict';
import pg from 'pg';
import ExcelJS from 'exceljs';

process.loadEnvFile('.env');
const projectRef=new URL(process.env.SUPABASE_URL).hostname.split('.')[0];
const db=new pg.Client({
 host:process.env.SUPABASE_DB_HOST||'aws-0-us-east-1.pooler.supabase.com',port:Number(process.env.SUPABASE_DB_PORT||6543),
 database:process.env.SUPABASE_DB_NAME||'postgres',user:process.env.SUPABASE_DB_USER||`postgres.${projectRef}`,
 password:process.env.SUPABASE_DB_PASSWORD,ssl:{rejectUnauthorized:false}
});
await db.connect();
let report;
try{
 const context=(await db.query(`select u.email,ucs.session_id from user_company_sessions ucs join users u using(user_id) join user_role_sessions urs using(session_id,user_id) join roles r using(role_id) where lower(r.role_name) in('administrador','administrator','admin') order by ucs.selected_at desc limit 1`)).rows[0];
 await db.query(`select set_config('request.jwt.claims',$1,false)`,[JSON.stringify(context)]);
 report=(await db.query('select run_payment_request_report($1::jsonb) value',[{dateFrom:'2026-01-01',dateTo:'2026-12-31',dateField:'REQUEST',page:1,pageSize:5000}])).rows[0].value;
}finally{await db.end();}

const nativeFetch=globalThis.fetch;
globalThis.fetch=async input=>{
 const url=String(input);
 if(url.includes('/rest/v1/rpc/run_payment_request_report'))return new Response(JSON.stringify(report),{status:200,headers:{'content-type':'application/json'}});
 throw new Error(`Solicitud inesperada durante la prueba: ${url}`);
};
try{
 const service=await import('../dist/modules/reports/payment-requests-report.service.js');
 const filters={dateFrom:'2026-01-01',dateTo:'2026-12-31',dateField:'REQUEST'};
 const [pdf,excel]=await Promise.all([
  service.exportPaymentRequestReportPdf('Bearer fixture',filters),
  service.exportPaymentRequestReportExcel('Bearer fixture',filters)
 ]);
 assert.equal(pdf.mimeType,'application/pdf');
 assert.equal(pdf.buffer.subarray(0,4).toString(),'%PDF');
 assert.ok(pdf.buffer.length>20_000,'El PDF debe contener el informe renderizado.');
 assert.equal(excel.mimeType,'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
 assert.equal(excel.buffer.subarray(0,2).toString(),'PK');
 const workbook=new ExcelJS.Workbook();
 await workbook.xlsx.load(excel.buffer);
 assert.deepEqual(workbook.worksheets.map(sheet=>sheet.name),['Solicitudes de pago','Resumen analítico']);
 const detail=workbook.getWorksheet('Solicitudes de pago');
 const analytics=workbook.getWorksheet('Resumen analítico');
 assert.ok(detail&&detail.rowCount>=8+report.summary.lineCount);
 assert.ok(analytics&&analytics.rowCount>2);
 const text=[...detail._rows,...analytics._rows].filter(Boolean).flatMap(row=>row.values||[]).join(' ');
 assert.ok(text.includes('GENTIA'));
 assert.ok(text.includes('Pago de CxP'));
 assert.ok(!/[ÃÂ�]/.test(text),'Los archivos no deben contener texto con codificación dañada.');
 console.log(JSON.stringify({pdfBytes:pdf.buffer.length,excelBytes:excel.buffer.length,sheets:workbook.worksheets.map(sheet=>sheet.name),requests:report.total,lines:report.summary.lineCount},null,2));
}finally{globalThis.fetch=nativeFetch;}
