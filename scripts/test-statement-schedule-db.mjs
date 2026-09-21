import pg from 'pg';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
process.loadEnvFile?.('.env');
const ref=new URL(process.env.SUPABASE_URL).hostname.split('.')[0];
const db=new pg.Client({host:process.env.SUPABASE_DB_HOST||'aws-0-us-east-1.pooler.supabase.com',port:Number(process.env.SUPABASE_DB_PORT||6543),database:'postgres',user:process.env.SUPABASE_DB_USER||`postgres.${ref}`,password:process.env.SUPABASE_DB_PASSWORD,ssl:{rejectUnauthorized:false},connectionTimeoutMillis:15000});
await db.connect();
const value=async(sql,args=[]) => (await db.query(sql,args)).rows[0]?.value;
try{
 await db.query('begin');await db.query("set local lock_timeout='5s';set local statement_timeout='60s'");
 const installed=await value("select to_regprocedure('public.statement_schedule_due(integer,time,timestamp)')is not null value");
 if(!installed)await db.query(await readFile(new URL('../supabase/migrations/20260921100000_customer_statement_schedule.sql',import.meta.url),'utf8'));
 for(const [day,time,at,expected] of [[15,'14:35','2026-09-15 14:34',false],[15,'14:35','2026-09-15 14:35',true],[15,'14:35','2026-09-16 14:35',false],[31,'08:00','2026-02-28 08:00',true],[31,'08:00','2028-02-29 08:00',true],[31,'08:00','2026-04-30 08:00',true]])assert.equal(await value('select statement_schedule_due($1,$2,$3)value',[day,time,at]),expected);
 const context=(await db.query('select u.email,ucs.session_id,au.id sub from user_company_sessions ucs join users u using(user_id)join auth.users au on lower(au.email)=lower(u.email)order by selected_at desc limit 1')).rows[0];
 await db.query("select set_config('request.jwt.claims',$1,true)",[JSON.stringify(context)]);
 await db.query('savepoint config');
 const saved=await value("select statement_settings('save',$1::jsonb)value",[JSON.stringify({subject:'Test',body:'<p>Test</p>',active:false,day:15,time:'14:35'})]);assert.equal(saved.template.envio_dia,15);assert.equal(saved.template.envio_hora,'14:35:00');
 const loaded=await value("select statement_settings('get')value");assert.equal(loaded.template.envio_dia,15);
 await db.query('savepoint invalid');await assert.rejects(value("select statement_settings('save',$1::jsonb)value",[JSON.stringify({subject:'Test',body:'<p>Test</p>',day:32,time:'08:00'})]));await db.query('rollback to savepoint invalid');
 await db.query('rollback to savepoint config');
 await db.query(process.argv.includes('--apply')?'commit':'rollback');console.log(JSON.stringify({savedAndLoaded:true,minutePrecision:true,shortMonths:true,leapYear:true,invalidDayRejected:true,applied:process.argv.includes('--apply'),emailsSent:0}));
}catch(e){await db.query('rollback').catch(()=>{});throw e}finally{await db.end()}
