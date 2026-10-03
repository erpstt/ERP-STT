import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import pg from 'pg';

process.loadEnvFile('.env');
const projectRef=new URL(process.env.SUPABASE_URL).hostname.split('.')[0];
const db=new pg.Client({
 host:process.env.SUPABASE_DB_HOST||'aws-0-us-east-1.pooler.supabase.com',
 port:Number(process.env.SUPABASE_DB_PORT||6543),database:process.env.SUPABASE_DB_NAME||'postgres',
 user:process.env.SUPABASE_DB_USER||`postgres.${projectRef}`,password:process.env.SUPABASE_DB_PASSWORD,
 ssl:{rejectUnauthorized:false}
});

const migration=await readFile(new URL('../supabase/migrations/20261002130000_payment_request_report.sql',import.meta.url),'utf8');
await db.connect();
try{
 await db.query('begin');
 await db.query(migration);
 const context=(await db.query(`
  select u.email,ucs.session_id
  from user_company_sessions ucs join users u using(user_id)
  join user_role_sessions urs using(session_id,user_id) join roles r using(role_id)
  where lower(r.role_name) in('administrador','administrator','admin')
  order by ucs.selected_at desc limit 1
 `)).rows[0];
 assert.ok(context,'Se requiere una sesión administrativa activa para probar el informe.');
 await db.query(`select set_config('request.jwt.claims',$1,true)`,[JSON.stringify(context)]);
 const subsidiaryId=(await db.query('select active_subsidiary_id() id')).rows[0].id;
 assert.ok(subsidiaryId);

 const options=(await db.query('select payment_request_report_options() value')).rows[0].value;
 assert.equal(String(options.subsidiary.id),String(subsidiaryId));
 assert.ok(options.requestTypes.some(item=>item.id==='CXP'));
 assert.ok(options.requestTypes.some(item=>item.id==='OTROS'));
 assert.ok(Array.isArray(options.thirdParties));

 const allFilters={subsidiaryId,dateFrom:'2026-01-01',dateTo:'2026-12-31',dateField:'REQUEST',page:1,pageSize:50};
 const report=(await db.query('select run_payment_request_report($1::jsonb) value',[allFilters])).rows[0].value;
 assert.ok(report.total>=1,'La subsidiaria de prueba debe tener solicitudes de pago.');
 assert.equal(report.rows.length,report.total);
 assert.equal(report.summary.requestCount,report.total);
 assert.ok(report.summary.totalsByCurrency.length>=1);
 assert.ok(report.rows.every(row=>Array.isArray(row.lines)&&row.lines.length>=1));
 assert.ok(report.rows.every(row=>Number(row.total)>0));
 assert.ok(!JSON.stringify(report).includes('fileData'));
 assert.ok(!JSON.stringify(report).includes('contenido_archivo'));

 const expectedByType=await db.query(`select tipo_solicitud,count(*)::int count from solicitudes_pago where id_subsidiaria=$1 and fecha_solicitud between date '2026-01-01' and date '2026-12-31' group by tipo_solicitud`,[subsidiaryId]);
 for(const expected of expectedByType.rows){
  const filtered=(await db.query('select run_payment_request_report($1::jsonb) value',[{...allFilters,types:[expected.tipo_solicitud]}])).rows[0].value;
  assert.equal(filtered.total,expected.count,`Filtro ${expected.tipo_solicitud}`);
  assert.ok(filtered.rows.every(row=>row.type===expected.tipo_solicitud));
 }

 const party=options.thirdParties.find(item=>report.rows.some(row=>(row.thirdParties||[]).some(value=>value.key===item.key)));
 if(party){
  const filtered=(await db.query('select run_payment_request_report($1::jsonb) value',[{...allFilters,thirdPartyKey:party.key}])).rows[0].value;
  assert.ok(filtered.total>=1);
  assert.ok(filtered.rows.every(row=>(row.thirdParties||[]).some(value=>value.key===party.key)));
 }
 const department=options.departments.find(item=>report.rows.some(row=>(row.departments||[]).some(value=>String(value.id)===String(item.id))));
 if(department){
  const filtered=(await db.query('select run_payment_request_report($1::jsonb) value',[{...allFilters,departmentId:department.id}])).rows[0].value;
  assert.ok(filtered.total>=1);
  assert.ok(filtered.rows.every(row=>(row.departments||[]).some(value=>String(value.id)===String(department.id))));
 }
 const center=options.costCenters.find(item=>report.rows.some(row=>(row.costCenters||[]).some(value=>String(value.id)===String(item.id))));
 if(center){
  const filtered=(await db.query('select run_payment_request_report($1::jsonb) value',[{...allFilters,costCenterId:center.id}])).rows[0].value;
  assert.ok(filtered.total>=1);
  assert.ok(filtered.rows.every(row=>(row.costCenters||[]).some(value=>String(value.id)===String(center.id))));
 }
 const account=options.accounts.find(item=>report.rows.some(row=>(row.accounts||[]).some(value=>String(value.id)===String(item.id))));
 if(account){
  const filtered=(await db.query('select run_payment_request_report($1::jsonb) value',[{...allFilters,accountId:account.id}])).rows[0].value;
  assert.ok(filtered.total>=1);
  assert.ok(filtered.rows.every(row=>(row.accounts||[]).some(value=>String(value.id)===String(account.id))));
 }
 const paid=report.rows.find(row=>row.method);
 if(paid){
  const filtered=(await db.query('select run_payment_request_report($1::jsonb) value',[{...allFilters,method:paid.method}])).rows[0].value;
  assert.ok(filtered.total>=1);
  assert.ok(filtered.rows.every(row=>row.method===paid.method));
 }
 const approved=report.rows.find(row=>row.approver?.id);
 if(approved){
  const filtered=(await db.query('select run_payment_request_report($1::jsonb) value',[{...allFilters,approverId:approved.approver.id}])).rows[0].value;
  assert.ok(filtered.total>=1);
  assert.ok(filtered.rows.every(row=>String(row.approver?.id)===String(approved.approver.id)));
 }
 const paged=(await db.query('select run_payment_request_report($1::jsonb) value',[{...allFilters,pageSize:2}])).rows[0].value;
 assert.ok(paged.rows.length<=2);
 assert.equal(paged.total,report.total);
 console.log(`PASS: ${report.total} solicitudes, ${report.summary.lineCount} líneas y ${report.summary.totalsByCurrency.length} moneda(s). Filtros, seguridad de respaldos y paginación verificados con rollback.`);
}finally{
 await db.query('rollback').catch(()=>{});
 await db.end();
}
