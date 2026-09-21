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
 await db.query(await readFile(new URL('../supabase/migrations/20260921160000_budget_result_categories.sql',import.meta.url),'utf8'));
 await db.query('savepoint fixtures');
 const opts=await value('select budget_options()value');
 assert.ok(opts.accounts.some(a=>a.category==='Ingreso'));
 let h=await value('select budget_save_header($1)value',[JSON.stringify({year:2026,name:'TEST-AUTO-'+Date.now(),control:'HARD_LOCK',categories:['Ingreso']})]);
 let report=await value('select budget_report($1)value',[JSON.stringify({id:h.id})]);
 assert.equal(report.rows.filter(r=>r.line_id).length,opts.accounts.filter(a=>a.category==='Ingreso').length*12);
 assert.ok(report.rows.every(r=>r.category==='Ingreso'));
 const actual=await value("select coalesce(sum(g.credit_amount-g.debit_amount),0)::float value from gl_impact g join accounting_books b using(accounting_book_id)join chart_accounts a on a.account_id=g.account_id where g.subsidiary_id=active_subsidiary_id()and b.is_primary and b.is_active and a.category='Ingreso'and extract(year from g.posting_date)=2026");assert.ok(Math.abs(report.rows.reduce((sum,r)=>sum+Number(r.executed),0)-actual)<.000001);
 const account=opts.accounts.find(a=>a.category==='Ingreso');
 h=await value('select budget_save_lines($1)value',[JSON.stringify({id:h.id,revision:h.revision,lines:[{accountId:account.id,month:'2026-01',amount:123}]})]);
 h=await value('select budget_save_header($1)value',[JSON.stringify({id:h.id,revision:h.revision,year:2026,name:h.nombre_version,control:'HARD_LOCK',categories:['Ingreso','Costo','Gasto']})]);
 report=await value('select budget_report($1)value',[JSON.stringify({id:h.id})]);
 assert.equal(report.rows.find(r=>String(r.account_id)===String(account.id)&&r.month.startsWith('2026-01')).initial,123);
 assert.equal(report.rows.filter(r=>r.line_id&&String(r.account_id)===String(account.id)).length,1);
 // A revenue-only plan may be approved even when revenue already exceeds its target.
 let income=await value('select budget_save_header($1)value',[JSON.stringify({year:2026,name:'TEST-INCOME-'+Date.now(),control:'HARD_LOCK',categories:['Ingreso']})]);
 await value('select budget_header_action($1)value',[JSON.stringify({id:income.id,action:'approve'})]);
 const state=await value('select budget_state(active_subsidiary_id())value');
 assert.ok(!state.some(r=>String(r.headerId)===String(income.id)));
 const copy=await value('select budget_header_action($1)value',[JSON.stringify({id:income.id,action:'copy',year:2027,name:'TEST-COPY-'+Date.now(),percent:5})]);assert.deepEqual(copy.categorias,['Ingreso']);
 const check=await value('select budget_check_availability($1)value',[JSON.stringify({id_subsidiaria:opts.subsidiary.id,periodo:'2026-01',id_cuenta_contable:account.id,monto:1000000})]);assert.equal(check.controlActivo,false);assert.equal(check.disponible,true);
 await db.query('rollback to savepoint fixtures');
 const apply=process.argv.includes('--apply');await db.query(apply?'commit':'rollback');
 console.log(JSON.stringify({applied:apply,autoLoad:true,allResultCategories:true,preservedAmounts:true,noDuplicateAccounts:true,revenueNotBlocked:true,copyCategories:true,fixturesRolledBack:true}));
}catch(e){await db.query('rollback').catch(()=>{});throw e;}finally{await db.end();}
