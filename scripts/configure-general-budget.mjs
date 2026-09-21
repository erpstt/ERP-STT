import pg from 'pg';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
process.loadEnvFile?.('.env');
const ref=new URL(process.env.SUPABASE_URL).hostname.split('.')[0];
const db=new pg.Client({host:process.env.SUPABASE_DB_HOST||'aws-0-us-east-1.pooler.supabase.com',port:Number(process.env.SUPABASE_DB_PORT||6543),database:'postgres',user:process.env.SUPABASE_DB_USER||`postgres.${ref}`,password:process.env.SUPABASE_DB_PASSWORD,ssl:{rejectUnauthorized:false},connectionTimeoutMillis:15000});
await db.connect();
const value=async(sql,args=[]) => (await db.query(sql,args)).rows[0]?.value;
try{
 await db.query('begin');await db.query("set local lock_timeout='5s';set local statement_timeout='90s'");
 const context=(await db.query('select u.email,ucs.session_id,au.id sub from user_company_sessions ucs join users u using(user_id)join auth.users au on lower(au.email)=lower(u.email)order by selected_at desc limit 1')).rows[0];
 await db.query("select set_config('request.jwt.claims',$1,true)",[JSON.stringify(context)]);
 const before=await value("select coalesce(jsonb_agg(to_jsonb(l)order by id),'[]')value from presupuestos_lineas l");
 await db.query(await readFile(new URL('../supabase/migrations/20260921170000_general_company_budget.sql',import.meta.url),'utf8'));
 assert.deepEqual(await value("select coalesce(jsonb_agg(to_jsonb(l)order by id),'[]')value from presupuestos_lineas l"),before);
 await db.query('savepoint fixtures');
 const opts=await value('select budget_options()value');assert.deepEqual(opts.centers,[]);
 let h=await value('select budget_save_header($1)value',[JSON.stringify({year:2026,name:'TEST-GENERAL-'+Date.now(),control:'WARNING'})]);
 const account=opts.accounts.find(a=>a.category==='Gasto').id;
 h=await value('select budget_save_lines($1)value',[JSON.stringify({id:h.id,revision:h.revision,lines:[{accountId:account,month:'2026-09',amount:100}]})]);
 for(const dimension of ['centerId','projectId']){
  await db.query('savepoint invalid_dimension');
  await assert.rejects(value('select budget_save_lines($1)value',[JSON.stringify({id:h.id,revision:h.revision,lines:[{accountId:account,month:'2026-09',amount:100,[dimension]:123}]})]),/general por sociedad/);
  await db.query('rollback to savepoint invalid_dimension');
 }
 // Controlled source rows prove that different operational centers share one balance.
 assert.ok(/^\d+$/.test(String(account)));
 await db.query(`create or replace function budget_actuals(p_sid bigint)returns table(account_id bigint,"month" date,center_id bigint,amount numeric)language sql stable security definer set search_path=public,pg_temp as $$select ${account}::bigint,date '2026-09-01',11::bigint,30::numeric union all select ${account}::bigint,date '2026-09-01',22::bigint,20::numeric$$`);
 await db.query(`create or replace function budget_commitments(p_sid bigint)returns table(source_type text,source_id bigint,account_id bigint,"month" date,center_id bigint,amount numeric)language sql stable security definer set search_path=public,pg_temp as $$select 'ORD_COM'::text,1::bigint,${account}::bigint,date '2026-09-01',11::bigint,20::numeric union all select 'ORD_COM',2::bigint,${account}::bigint,date '2026-09-01',22::bigint,10::numeric$$`);
 const report=await value('select budget_report($1)value',[JSON.stringify({id:h.id})]);assert.equal(report.rows.length,1);assert.equal(report.rows[0].executed,50);assert.equal(report.rows[0].committed,30);assert.equal(report.rows[0].available,20);assert.equal(report.rows[0].center_id,null);
 await value('select budget_header_action($1)value',[JSON.stringify({id:h.id,action:'approve'})]);
 const check=await value('select budget_check_availability($1)value',[JSON.stringify({id_subsidiaria:opts.subsidiary.id,periodo:'2026-09',id_cuenta_contable:account,id_centro_costo:999,monto:21})]);assert.equal(check.disponible,false);assert.equal(check.saldo_remanente,-1);
 await db.query('rollback to savepoint fixtures');
 const apply=process.argv.includes('--apply');await db.query(apply?'commit':'rollback');
 console.log(JSON.stringify({applied:apply,existingAmountsPreserved:true,noBudgetCenters:true,dimensionalInputRejected:true,sharedExecutionAndCommitments:true,availabilityAcrossCenters:true,fixturesRolledBack:true}));
}catch(e){await db.query('rollback').catch(()=>{});throw e;}finally{await db.end();}
