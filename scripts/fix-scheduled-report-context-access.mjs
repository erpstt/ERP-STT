import pg from 'pg';
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
process.loadEnvFile?.('.env');
const ref=new URL(process.env.SUPABASE_URL).hostname.split('.')[0];
const db=new pg.Client({host:process.env.SUPABASE_DB_HOST||'aws-0-us-east-1.pooler.supabase.com',port:Number(process.env.SUPABASE_DB_PORT||6543),database:'postgres',user:process.env.SUPABASE_DB_USER||`postgres.${ref}`,password:process.env.SUPABASE_DB_PASSWORD,ssl:{rejectUnauthorized:false},connectionTimeoutMillis:15000});
await db.connect();const value=async(sql,args=[]) => (await db.query(sql,args)).rows[0]?.value;
try{
 await db.query('begin');
 const context=(await db.query('select u.email,ucs.session_id,au.id sub from user_company_sessions ucs join users u using(user_id)join auth.users au on lower(au.email)=lower(u.email)order by selected_at desc limit 1')).rows[0];
 await db.query("select set_config('request.jwt.claims',$1,true)",[JSON.stringify({...context,role:'authenticated'})]);
 await db.query('savepoint before_fix');
 await db.query('set local role authenticated');
 let reproduced=false;
 try{await value('select active_subsidiary_id_without_report_context() value');}catch(e){assert.equal(e.code,'42501');reproduced=true;}
 await db.query('rollback to savepoint before_fix');
 await db.query(await readFile('supabase/migrations/20260922010000_restore_session_subsidiary_function_access.sql','utf8'));
 await db.query('set local role authenticated');
 const sid=await value('select active_subsidiary_id_without_report_context() value');assert.ok(sid);
 assert.equal(await value('select active_subsidiary_id() value'),sid);
 const list=await value("select scheduled_report_manage('list') value");assert.equal(list.reports.length,18);
 await db.query('select accounting_book_id from accounting_books limit 1');
 await db.query('select asset_id from asset limit 1');
 const snapshot=await value("select scheduled_report_snapshot_v2($1,'trial-balance',current_date) value",[sid]);assert.equal(snapshot.kind,'trial-balance');
 // A forged worker company in ordinary JWT claims must not override the selected society.
 await db.query("select set_config('request.jwt.claims',$1,true)",[JSON.stringify({...context,role:'authenticated',scheduled_report_sid:-1})]);
 assert.equal(await value('select active_subsidiary_id() value'),sid);
 await db.query("select set_config('request.jwt.claims',$1,true)",[JSON.stringify({role:'authenticated'})]);
 assert.equal(await value('select active_subsidiary_id_without_report_context() value'),null);
 assert.equal(await value("select has_function_privilege('anon','active_subsidiary_id_without_report_context()','EXECUTE') value"),false);
 await db.query('reset role');
 const apply=process.argv.includes('--apply');await db.query(apply?'commit':'rollback');
 console.log(JSON.stringify({reproduced,applied:apply,actualAuthenticatedRole:true,catalogReports:18,rlsQueries:true,reportSnapshot:true,companyOverrideRejected:true,anonymousDenied:true,noDataModified:true}));
}catch(e){await db.query('rollback').catch(()=>{});throw e;}finally{await db.end();}
