import assert from 'node:assert/strict';
import pg from 'pg';

process.loadEnvFile('.env');
const projectRef=new URL(process.env.SUPABASE_URL).hostname.split('.')[0];
const db=new pg.Client({
 host:process.env.SUPABASE_DB_HOST||'aws-0-us-east-1.pooler.supabase.com',
 port:Number(process.env.SUPABASE_DB_PORT||6543),database:process.env.SUPABASE_DB_NAME||'postgres',
 user:process.env.SUPABASE_DB_USER||`postgres.${projectRef}`,password:process.env.SUPABASE_DB_PASSWORD||process.env.PGPASSWORD,
 ssl:{rejectUnauthorized:false},connectionTimeoutMillis:15000
});
await db.connect();
try{
 const context=(await db.query(`select u.email,ucs.session_id from user_company_sessions ucs join users u using(user_id) join user_role_sessions urs using(session_id,user_id) join roles r using(role_id) where lower(r.role_name) in('administrador','administrator','admin') order by ucs.selected_at desc limit 1`)).rows[0];
 assert.ok(context);
 await db.query(`select set_config('request.jwt.claims',$1,false)`,[JSON.stringify(context)]);
 const options=(await db.query('select payment_request_report_options() value')).rows[0].value;
 const report=(await db.query('select run_payment_request_report($1::jsonb) value',[{subsidiaryId:options.subsidiary.id,dateFrom:'2026-01-01',dateTo:'2026-12-31',dateField:'REQUEST',page:1,pageSize:50}])).rows[0].value;
 assert.equal(report.summary.requestCount,report.total);
 assert.ok(report.total>=1);
 assert.ok(report.rows.every(row=>Array.isArray(row.lines)&&row.lines.length));
 assert.ok(report.summary.totalsByCurrency.every(item=>Number(item.requestAmount)>0));
 const grants=(await db.query(`select routine_name,privilege_type from information_schema.routine_privileges where routine_schema='public' and grantee='authenticated' and routine_name in('payment_request_report_options','run_payment_request_report')`)).rows;
 assert.equal(new Set(grants.map(row=>row.routine_name)).size,2);
 console.log(JSON.stringify({live:true,subsidiary:options.subsidiary.name,requests:report.total,lines:report.summary.lineCount,currencies:report.summary.totalsByCurrency.map(item=>({currency:item.currency,amount:item.requestAmount})),functions:[...new Set(grants.map(row=>row.routine_name))]},null,2));
}finally{await db.end();}
