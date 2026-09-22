import pg from 'pg';
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
process.loadEnvFile?.('.env');
const ref=new URL(process.env.SUPABASE_URL).hostname.split('.')[0];
const db=new pg.Client({host:process.env.SUPABASE_DB_HOST||'aws-0-us-east-1.pooler.supabase.com',port:Number(process.env.SUPABASE_DB_PORT||6543),database:'postgres',user:process.env.SUPABASE_DB_USER||`postgres.${ref}`,password:process.env.SUPABASE_DB_PASSWORD,ssl:{rejectUnauthorized:false},connectionTimeoutMillis:15000});
await db.connect();const value=async(sql,args=[]) => (await db.query(sql,args)).rows[0]?.value;
try{
 await db.query("begin;set local lock_timeout='5s';set local statement_timeout='90s'");
 const installed=await value("select to_regclass('public.income_forecast_scenarios') is not null value");
 if(!installed)await db.query(await readFile('supabase/migrations/20260922020000_income_forecast.sql','utf8'));
 const scoped=await value("select to_regprocedure('public.income_forecast_options(boolean)') is not null value");
 if(!scoped)await db.query(await readFile('supabase/migrations/20260922030000_scope_income_forecast.sql','utf8'));
 const context=(await db.query('select u.user_id,u.email,ucs.session_id,au.id sub from user_company_sessions ucs join users u using(user_id)join auth.users au on lower(au.email)=lower(u.email)order by selected_at desc limit 1')).rows[0];
 await db.query("select set_config('request.jwt.claims',$1,true)",[JSON.stringify({...context,role:'authenticated'})]);
 await db.query('savepoint fixtures');await db.query('set local role authenticated');
 const opts=await value('select income_forecast_options(false)value'),year=opts.years.find(y=>y.start<='2026-09-01'&&y.end>='2026-09-30');assert.ok(year);assert.equal(opts.mode,'SUBSIDIARY');assert.deepEqual(opts.subsidiaries.map(s=>Number(s.id)),[Number(opts.activeSubsidiaryId)]);
 const p={subsidiaryIds:[opts.activeSubsidiaryId],fiscalYearId:year.id,cutoff:'2026-08-31',method:'RUN_RATE',columnView:'ACCOUNTING_PERIOD',excludeClosing:true};
 const source=await value('select income_forecast_source($1)value',[p]);assert.ok(Array.isArray(source.facts));
 for(const [field,key]of [['departmentId','department_id'],['locationId','location_id'],['classId','class_id'],['costCenterId','cost_center_id'],['projectId','cost_center_id']]){
  const id=source.facts.find(f=>f[key]!==null)?.[key]||-1;
  const filtered=await value('select income_forecast_source($1)value',[{...p,[field]:id}]);assert.ok(filtered.facts.every(f=>String(f[key])===String(id)));
 }
 const byType=await value('select income_forecast_source($1)value',[{...p,departmentType:'__NO_SUCH_TYPE__'}]);assert.equal(byType.facts.length,0);
 await db.query('reset role');
 const gl=(await db.query(`select x.account_id,sum(x.debit_amount-x.credit_amount)::float8 amount from gl_impact x join accounting_books b using(accounting_book_id)join chart_accounts a on a.account_id=x.account_id left join account_group ag on ag.group_id=a.account_group_id where x.subsidiary_id=$1 and b.is_primary and b.is_active and x.posting_date between $2::date-interval '1 year' and $3::date and coalesce(a.category,ag.category)in('Ingreso','Costo','Gasto')group by x.account_id`,[opts.activeSubsidiaryId,year.start,p.cutoff])).rows;
 await db.query('set local role authenticated');
 const inclusive=await value('select income_forecast_source($1)value',[{...p,excludeClosing:false}]);
 for(const row of gl)assert.ok(Math.abs(inclusive.facts.filter(f=>String(f.account_id)===String(row.account_id)).reduce((sum,f)=>sum+Number(f.amount),0)-row.amount)<.000001,'Actuals must reconcile with primary GL');
 await db.query('savepoint closing');await db.query('reset role');
 const journal=await value(`select j.journal_id value from journal j join gl_impact g using(transaction_id)join chart_accounts ca on ca.account_id=g.account_id where ca.category in('Ingreso','Costo','Gasto')and g.subsidiary_id=$1 and g.posting_date between $2::date and $3::date and not j.is_year_end_closing limit 1`,[opts.activeSubsidiaryId,year.start,p.cutoff]);
 if(journal){await db.query('update journal set is_year_end_closing=true where journal_id=$1',[journal]);await db.query('set local role authenticated');const excluded=await value('select income_forecast_source($1)value',[p]);const included=await value('select income_forecast_source($1)value',[{...p,excludeClosing:false}]);assert.deepEqual(included.facts,inclusive.facts);assert.notDeepEqual(excluded.facts,included.facts);}
 await db.query('rollback to savepoint closing');
 await db.query('savepoint forbidden');await assert.rejects(value('select income_forecast_source($1)value',[{...p,subsidiaryIds:[-1]}]),/empresa activa/);await db.query('rollback to savepoint forbidden');
 await db.query('savepoint multiple');await assert.rejects(value('select income_forecast_source($1)value',[{...p,subsidiaryIds:[opts.activeSubsidiaryId,-1]}]),/empresa activa/);await db.query('rollback to savepoint multiple');
 if(opts.canConsolidate){const consolidated=await value('select income_forecast_options(true)value');assert.equal(consolidated.mode,'CONSOLIDATED');assert.ok(consolidated.subsidiaries.length>=opts.subsidiaries.length);assert.ok(consolidated.holding?.id);}
 const saved=await value('select income_forecast_save($1)value',[{name:'TEST-FORECAST',configuration:p}]);assert.ok(saved.id);
 const changed=await value('select income_forecast_save($1)value',[{id:saved.id,revision:saved.revision,name:'TEST-FORECAST-UPDATED',configuration:p}]);assert.equal(changed.revision,saved.revision+1);
 await db.query('savepoint stale');await assert.rejects(value('select income_forecast_save($1)value',[{id:saved.id,revision:saved.revision,name:'TEST-STALE',configuration:p}]),/cambió/);await db.query('rollback to savepoint stale');
 await db.query('rollback to savepoint fixtures');
 const apply=process.argv.includes('--apply');await db.query(apply?'commit':'rollback');
 console.log(JSON.stringify({applied:apply&&(!installed||!scoped),actualRole:true,activeSubsidiaryOnly:true,consolidationPermission:true,options:true,source:true,unauthorizedCompanyRejected:true,scenarioSave:true,fixturesRolledBack:true,facts:source.facts.length}));
 if(process.argv.includes('--snapshot'))await writeFile('.tmp/income-forecast-source.json',JSON.stringify({source,p,opts}));
}catch(e){await db.query('rollback').catch(()=>{});throw e;}finally{await db.end();}
