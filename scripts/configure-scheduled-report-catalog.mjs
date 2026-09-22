import pg from 'pg';
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
process.loadEnvFile?.('.env');
const ref=new URL(process.env.SUPABASE_URL).hostname.split('.')[0];
const db=new pg.Client({host:process.env.SUPABASE_DB_HOST||'aws-0-us-east-1.pooler.supabase.com',port:Number(process.env.SUPABASE_DB_PORT||6543),database:'postgres',user:process.env.SUPABASE_DB_USER||`postgres.${ref}`,password:process.env.SUPABASE_DB_PASSWORD,ssl:{rejectUnauthorized:false},connectionTimeoutMillis:15000});
await db.connect();const value=async(sql,args=[]) => (await db.query(sql,args)).rows[0]?.value;
try{
 await db.query("begin;set local lock_timeout='5s';set local statement_timeout='90s'");
 const context=(await db.query('select u.email,ucs.session_id,au.id sub from user_company_sessions ucs join users u using(user_id)join auth.users au on lower(au.email)=lower(u.email)order by selected_at desc limit 1')).rows[0];
 const claims=async(v)=>db.query("select set_config('request.jwt.claims',$1,true)",[JSON.stringify(v)]);
 await claims({...context,role:'authenticated'});
 const installed=await value("select to_regclass('public.scheduled_report_catalog') is not null value");
 if(!installed)await db.query(await readFile(new URL('../supabase/migrations/20260921200000_scheduled_report_catalog.sql',import.meta.url),'utf8'));
 await db.query('savepoint fixtures');
 const list=await value("select scheduled_report_manage('list')value"),sid=list.company.id,owner=await value('select app_user_id()value');
 // JWT claims alone do not test PostgreSQL grants/RLS while connected as postgres.
 await db.query('set local role authenticated');
 assert.equal(await value('select active_subsidiary_id_without_report_context()value'),sid);
 await db.query('select accounting_book_id from accounting_books limit 1');
 assert.equal((await value("select scheduled_report_manage('list')value")).reports.length,18);
 await db.query('reset role');
 assert.equal(list.reports.length,18);const snapshots=[];
 for(const r of list.reports){
  const opts={periodMode:'YEAR_TO_DATE',bankAccountId:r.requires_bank?list.banks[0]?.id:null};
  if(r.requires_bank)assert.ok(opts.bankAccountId,'Bank fixture is required');
  const snapshot=await value('select scheduled_report_snapshot_v2($1,$2,current_date,$3)value',[sid,r.code,opts]);
  assert.equal(snapshot.kind,r.code);assert.ok(snapshot.title);snapshots.push(snapshot);
  await claims({role:'service_role'});
  const worker=await value('select scheduled_report_snapshot_v2($1,$2,current_date,$3,$4)value',[sid,r.code,opts,owner]);
  assert.deepEqual(worker,snapshot);assert.equal(await value("select auth.jwt()->>'email'value"),null);
  await claims({...context,role:'authenticated'});
  const saved=await value("select scheduled_report_manage('save',$1)value",[{name:'TEST-CATALOG',report:r.code,frequency:'MONTHLY',weekday:1,monthDay:1,time:'08:00',cutoff:'PREVIOUS_MONTH_END',format:'BOTH',active:false,recipients:['test@example.invalid'],periodMode:'LAST_30_DAYS',reportOptions:opts}]);
  assert.equal(saved.report_kind,r.code);assert.equal(saved.period_mode,'LAST_30_DAYS');
  console.log('OK '+r.code);
 }
 await db.query('savepoint invalid_bank');await assert.rejects(value("select scheduled_report_snapshot_v2($1,'bank-reconciliation',current_date)value",[sid]),/bancaria/);await db.query('rollback to savepoint invalid_bank');
 await db.query('savepoint wrong_company');await assert.rejects(value("select scheduled_report_snapshot_v2(-1,'general-ledger',current_date)value"),/Sociedad/);await db.query('rollback to savepoint wrong_company');
 await db.query('savepoint pagination');
 await db.query(`create or replace function run_general_journal_report(p_filters jsonb default '{}')returns jsonb language sql stable security definer set search_path=public as $$select jsonb_build_object('total',251,'pageSize',100,'rows',(select jsonb_agg(jsonb_build_object('number','TEST-'||i,'debit',1))from generate_series(((p_filters->>'page')::int-1)*100+1,least((p_filters->>'page')::int*100,251))i))$$`);
 assert.equal((await value("select scheduled_report_snapshot_v2($1,'journal',current_date)value",[sid])).data.rows.length,251);await db.query('rollback to savepoint pagination');
 await db.query('rollback to savepoint fixtures');
 const apply=process.argv.includes('--apply');await db.query(apply?'commit':'rollback');
 // Snapshot values stay local for renderer verification; no emails are sent.
 if(process.argv.includes('--snapshots'))await writeFile('.tmp/scheduled-report-snapshots.json',JSON.stringify(snapshots));
 console.log(JSON.stringify({applied:apply&&!installed,alreadyInstalled:installed,reports:18,authenticatedAndWorker:true,pagination:true,companyIsolation:true,fixturesRolledBack:true,noEmailsSent:true}));
}catch(e){await db.query('rollback').catch(()=>{});throw e;}finally{await db.end();}
