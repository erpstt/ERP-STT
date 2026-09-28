import pg from 'pg';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
process.loadEnvFile?.('.env');
const ref=new URL(process.env.SUPABASE_URL).hostname.split('.')[0];
const db=new pg.Client({host:process.env.SUPABASE_DB_HOST||'aws-0-us-east-1.pooler.supabase.com',port:Number(process.env.SUPABASE_DB_PORT||6543),database:'postgres',user:process.env.SUPABASE_DB_USER||`postgres.${ref}`,password:process.env.SUPABASE_DB_PASSWORD,ssl:{rejectUnauthorized:false},connectionTimeoutMillis:15000});
const value=async(sql,args=[])=>(await db.query(sql,args)).rows[0]?.value;
await db.connect();
try{
 await db.query("begin;set local lock_timeout='5s';set local statement_timeout='120s'");
 const installed=await value("select to_regprocedure('public.run_aging_report_before_consolidation(text,jsonb)') is not null value");
 if(!installed)await db.query(await readFile('supabase/migrations/20260922040000_consolidated_operational_reports.sql','utf8'));
 const context=(await db.query('select u.user_id,u.email,ucs.session_id,au.id sub from user_company_sessions ucs join users u using(user_id)join auth.users au on lower(au.email)=lower(u.email)order by selected_at desc limit 1')).rows[0];
 assert.ok(context);await db.query("select set_config('request.jwt.claims',$1,true)",[JSON.stringify({...context,role:'authenticated'})]);
 const cutoffValue=await value(`select max(f.end_date)value from fiscal_periods f where f.end_date<=current_date and not exists(select 1 from subsidiaries s join user_subsidiaries us using(subsidiary_id)where us.user_id=$1 and s.is_active and operational_usd_closing_rate(s.subsidiary_id,f.end_date)is null)`,[context.user_id]);
 assert.ok(cutoffValue,'No existe un mes con tasas de cierre completas para las empresas autorizadas.');const cutoff=cutoffValue instanceof Date?cutoffValue.toISOString().slice(0,10):String(cutoffValue).slice(0,10),period=cutoff.slice(0,7),filters={subsidiaryIds:[-1],dateFrom:`${period}-01`,dateTo:cutoff,consolidated:true,page:1,pageSize:250,onlyPending:true,agingCurrencyMode:'LOCAL'};
 await db.query('set local role authenticated');
 const [ar,ap,pending]=await Promise.all([value("select run_aging_report('AR',$1)value",[filters]),value("select run_aging_report('AP',$1)value",[filters]),value('select run_pending_invoice_control_report($1)value',[filters])]);
 for(const report of[ar,ap,pending]){assert.equal(report.consolidated,true);assert.equal(report.currency,'USD');assert.ok(Array.isArray(report.companies));assert.ok(Array.isArray(report.rows));}
 assert.ok(ar.rows.every(row=>row.presentation_currency==='USD'&&row.subsidiary_id&&Number(row.conversion_rate)>0));
 assert.ok(ap.rows.every(row=>row.presentation_currency==='USD'&&row.subsidiary_id&&Number(row.conversion_rate)>0));
 assert.ok(pending.rows.every(row=>row.presentation_currency==='USD'&&row.subsidiary_id&&Number(row.conversion_rate)>0));
 await db.query('savepoint permission_independence');await db.query('reset role');await db.query("update permissions set code='ACC_CONSOLIDATION_RUN_TEST_DISABLED'where code='ACC_CONSOLIDATION_RUN'");await db.query('set local role authenticated');const withoutConsolidationPermission=await value('select run_pending_invoice_control_report($1)value',[filters]);assert.equal(withoutConsolidationPermission.consolidated,true);await db.query('rollback to savepoint permission_independence');
 const apply=process.argv.includes('--apply');await db.query(apply?'commit':'rollback');
 console.log(JSON.stringify({applied:apply&&!installed,period,cutoff,companies:ar.companies.length,receivables:ar.total,payables:ap.total,pending:pending.total,permissionIndependent:true,closingRate:true,fixturesRolledBack:true}));
}catch(error){await db.query('rollback').catch(()=>{});throw error}finally{await db.end()}
