import assert from 'node:assert/strict';
import {before,after,test} from 'node:test';
import {PGlite} from '@electric-sql/pglite';
import {setupFinancialStatementPresentation,applyFinancialStatementPresentationMigration,addPresentationJournal} from './fixtures/setup-financial-statement-presentation.mjs';
import {assertIsolatedTestArgs} from './lib/migration-preview.mjs';
assertIsolatedTestArgs();
const db=new PGlite();
const filters={subsidiaryIds:[1],bookId:1,dateFrom:'2026-01-01',dateTo:'2026-02-28',page:1,pageSize:500,excludeZero:true};
const usd=async(kind='balance-sheet',extra={})=>(await db.query('select public.run_financial_statement_presentation($1,$2)data',[kind,{...filters,presentationCurrency:'USD',...extra}])).rows[0].data;
const legacy=async(kind='balance-sheet',extra={},matrix=false)=>(await db.query(matrix?'select public.run_income_statement_matrix($1)data':'select public.run_accounting_report($1,$2)data',matrix?[{...filters,...extra}]:[kind,{...filters,...extra}])).rows[0].data;
const metadata=async()=>(await db.query("select oid,pronamespace::regnamespace::text,proname,prosrc,proowner,proacl::text,proconfig,provolatile,prosecdef,proparallel from pg_proc where proname in('run_accounting_report','run_accounting_report_before_intercompany_loans','run_income_statement_matrix')order by oid")).rows;
const stored=async()=>(await db.query(`select jsonb_build_object('gl',(select jsonb_agg(to_jsonb(g)order by gl_impact_id)from gl_impact g),'journal',(select jsonb_agg(to_jsonb(j)order by journal_id)from journal j),'lines',(select jsonb_agg(to_jsonb(l)order by journal_line_id)from journal_line l),'rates',(select jsonb_agg(to_jsonb(r)order by rate_id)from consolidated_exchange_rates r))data`)).rows[0].data;
let metadataBefore,storedBefore,localBalance,localIncome,localMatrix;
async function assume({role=10,sid=1,user=1,uid='00000000-0000-0000-0000-000000000001'}={}){
 await db.exec('reset role');for(const[k,v]of Object.entries({'fixture.uid':uid,'fixture.user':user,'fixture.role':role,'fixture.sid':sid}))await db.query('select set_config($1,$2,false)',[k,String(v)]);await db.exec('set role authenticated');
}
async function tx(t){await db.exec('reset role;begin');t.after(()=>db.exec('rollback;reset role'));await assume();}
async function rejects(operation,expected){await db.exec('savepoint expected_error');try{await assert.rejects(operation,expected);}finally{await db.exec('rollback to expected_error');}}
const close=(actual,expected)=>assert.ok(Math.abs(actual-expected)<.00001,`${actual} differs from ${expected}`);
before(async()=>{await setupFinancialStatementPresentation(db);await assume();localBalance=await legacy();localIncome=await legacy('income-statement');localMatrix=await legacy('income-statement',{columnView:'ACCOUNTING_PERIOD'},true);await db.exec('reset role');metadataBefore=await metadata();storedBefore=await stored();await applyFinancialStatementPresentationMigration(db);});
after(()=>db.close());

test('LOCAL is the unchanged default and delegates the existing TOTAL and matrix calculations',async t=>{
 await tx(t);
 for(const[kind,expected,extra]of[['balance-sheet',localBalance,{}],['income-statement',localIncome,{}],['income-statement',localMatrix,{columnView:'ACCOUNTING_PERIOD'}]]){
  for(const mode of[undefined,'LOCAL']){
   const actual=(await db.query('select public.run_financial_statement_presentation($1,$2)data',[kind,{...filters,...extra,...(mode?{presentationCurrency:mode}:{})}])).rows[0].data;assert.deepEqual(actual,expected);
  }
 }
});

test('balance USD applies closing to assets and historical to equity, and adds a virtual translation difference',async t=>{
 await tx(t);const data=await usd(),cash=data.rows.find(r=>r.account_id===1),capital=data.rows.find(r=>r.account_id===3),adjustment=data.rows.find(r=>r.is_presentation_adjustment);
 close(cash.closing,178.75);close(capital.closing,-80);close(data.summary.currentPeriodResult,63.6);close(data.summary.exerciseResult,63.6);close(data.summary.translationAdjustment,35.15);close(adjustment.closing,-35.15);
 assert.equal(adjustment.account_id,null);assert.equal(adjustment.category,'Patrimonio');assert.equal(data.summary.sourceBalanced,true);assert.equal(data.summary.balanced,true);assert.equal(data.summary.localBalanceDifference,0);
 assert.equal(data.consolidated,false);assert.equal(data.presentationCurrencyCode,'USD');assert.equal(data.localCurrencyCode,'JMD');assert.equal(data.conversionBasis,'CONSOLIDATED_RATES');
 assert.ok(data.ratesUsed.some(r=>r.period==='2026-01'&&r.rateType==='PROMEDIO'&&r.rate===.006));assert.ok(data.ratesUsed.some(r=>r.period==='2026-02'&&r.rateType==='CIERRE'&&r.rate===.00625));
});

test('income TOTAL converts each month at its stored average rather than the closing or last average rate',async t=>{
 await tx(t);const data=await usd('income-statement'),revenue=data.rows.find(r=>r.account_id===4),expense=data.rows.find(r=>r.account_id===5);
 close(revenue.credit,86);close(expense.debit,22.4);close(data.summary.periodResult,63.6);assert.notEqual(data.summary.periodResult,12600*.005);
 assert.equal(data.periodMovementOnly,true);assert.equal(revenue.opening,0);close(revenue.closing,-86);assert.ok(data.ratesUsed.every(r=>r.rateType==='PROMEDIO'));
});

test('matrix accounting periods and all dimension columns reconcile to canonical TOTAL including an ordinary foreign journal',async t=>{
 await tx(t);const total=await usd('income-statement');
 for(const columnView of['ACCOUNTING_PERIOD','DEPARTMENT','CLASS','LOCATION','COST_CENTER']){
  const matrix=await usd('income-statement',{columnView});close(matrix.summary.periodResult,total.summary.periodResult);
  for(const expected of total.rows){const row=matrix.rows.find(r=>r.account_id===expected.account_id);close(row.debit,expected.debit);close(row.credit,expected.credit);close(Object.values(row.dimensions).reduce((a,b)=>a+b,0),row.amount);}
  if(columnView==='ACCOUNTING_PERIOD'){const row=matrix.rows.find(r=>r.account_id===4);close(row.dimensions['2026-01'],6);close(row.dimensions['2026-02'],80);assert.equal(matrix.columns.length,2);}
 }
});

test('a selected partial month does not need rates for earlier history and respects the requested dates',async t=>{
 await tx(t);await db.exec("reset role;delete from consolidated_exchange_rates where period='2026-01'");await assume();
 const data=await usd('income-statement',{dateFrom:'2026-02-10',dateTo:'2026-02-20'});close(data.summary.periodResult,60);assert.deepEqual(data.ratesUsed.map(r=>r.period),['2026-02']);
 await rejects(()=>usd('balance-sheet'),/2026-01/);
});

test('USD functional companies use identity without holding, rates, or access to another company',async t=>{
 await tx(t);await db.exec('reset role;delete from consolidated_exchange_rates;update subsidiaries set is_active=false where subsidiary_id=99');await assume({sid:2});
 const data=await usd('balance-sheet',{subsidiaryIds:[2],bookId:2});close(data.rows.find(r=>r.account_id===1).closing,50);assert.equal(data.localCurrencyCode,'USD');assert.equal(data.summary.translationAdjustment,0);assert.ok(data.ratesUsed.every(r=>r.rateType==='IDENTIDAD'&&r.rate===1));
});

test('missing, zero, negative, nonfinite, duplicate, and wrong-scope rates fail explicitly instead of falling back',async t=>{
 await tx(t);
 for(const value of[null,'0','-1','NaN','Infinity','-Infinity']){
  await db.exec('reset role;savepoint rate_case');await db.query("update consolidated_exchange_rates set average_rate=$1 where period='2026-02'",[value]);await assume();await rejects(()=>usd('income-statement'),/tasa PROMEDIO válida/);await db.exec('rollback to rate_case');
 }
 for(const sql of["delete from consolidated_exchange_rates where period='2026-02'","update consolidated_exchange_rates set source_subsidiary_id=3 where period='2026-02'","update consolidated_exchange_rates set holding_subsidiary_id=3 where period='2026-02'","update consolidated_exchange_rates set from_currency_id=3 where period='2026-02'","update consolidated_exchange_rates set to_currency_id=3 where period='2026-02'","insert into consolidated_exchange_rates select 999,holding_subsidiary_id,source_subsidiary_id,period,from_currency_id,to_currency_id,closing_rate,average_rate,historical_rate,is_locked from consolidated_exchange_rates where period='2026-02'"]){
  await db.exec('reset role;savepoint rate_case');await db.exec(sql);await assume();await rejects(()=>usd('income-statement'),/tasa PROMEDIO válida/);await db.exec('rollback to rate_case');
 }
});

test('read access, active role, selected company scope, one-company mode, and private ACLs remain mandatory',async t=>{
 await tx(t);await rejects(()=>usd('balance-sheet',{subsidiaryIds:[3]}),/empresa autorizada/);await rejects(()=>usd('balance-sheet',{subsidiaryIds:[1,2]}),/empresa autorizada/);await rejects(()=>usd('balance-sheet',{consolidated:true}),/sin consolidación/);
 await assume({role:20});await rejects(()=>usd(),error=>error.code==='42501');await assume({uid:''});await rejects(()=>usd(),error=>error.code==='42501');await assume();
 await rejects(()=>db.query("select report_delivery_private.run_financial_statement_presentation('balance-sheet',$1,1)",[filters]),error=>error.code==='42501');
 await db.exec('reset role');const acl=(await db.query("select has_function_privilege('anon','public.run_financial_statement_presentation(text,jsonb)','EXECUTE')anon,has_function_privilege('authenticated','public.run_financial_statement_presentation(text,jsonb)','EXECUTE')authenticated,has_function_privilege('service_role','public.run_financial_statement_presentation(text,jsonb)','EXECUTE')service")).rows[0];assert.deepEqual(acl,{anon:false,authenticated:true,service:false});
});

test('dimension filters, book scope, and empty zero rows do not introduce foreign balances or require irrelevant rates',async t=>{
 await tx(t);const total=await usd('income-statement',{departmentId:10}),matrix=await usd('income-statement',{columnView:'DEPARTMENT',departmentId:10});close(total.summary.periodResult,3.6);close(matrix.summary.periodResult,3.6);
 const typed=await usd('income-statement',{columnView:'DEPARTMENT',departmentType:'ADMINISTRATIVO'});close(typed.summary.periodResult,60);
 await db.exec('reset role;delete from consolidated_exchange_rates');await assume();const empty=await usd('income-statement',{bookId:4});assert.deepEqual(empty.rows,[]);assert.deepEqual(empty.ratesUsed,[]);assert.equal(empty.summary.periodResult,0);
});

test('a preexisting local imbalance remains visible after the virtual presentation adjustment',async t=>{
 await tx(t);await db.exec('reset role');await addPresentationJournal(db,{id:1100,date:'2026-02-22',lines:[{account:1,debit:100}]});await assume();
 const data=await usd();assert.equal(data.summary.sourceBalanced,false);close(data.summary.localBalanceDifference,100);assert.equal(data.summary.balanced,false);close(data.summary.translationAdjustment,35.15);
 const sum=data.rows.reduce((n,r)=>n+r.closing,0)-data.summary.exerciseResult;close(sum,.625);
});

test('reversals use their actual posting month average and never a current market rate',async t=>{
 await tx(t);await db.exec('reset role');await addPresentationJournal(db,{id:1101,date:'2026-02-22',lines:[{account:1,credit:600},{account:4,debit:1000},{account:5,credit:400}]});await db.exec('update journal set reversed_from_journal_id=1001 where journal_id=1101');await assume();
 const total=await usd('income-statement'),matrix=await usd('income-statement',{columnView:'ACCOUNTING_PERIOD'});close(total.summary.periodResult,60.6);close(matrix.summary.periodResult,60.6);assert.ok(total.ratesUsed.every(r=>['2026-01','2026-02'].includes(r.period)));
});

test('public and trusted owner-scoped calculations agree without changing original functions or any stored financial rows',async t=>{
 await tx(t);const interactive=await usd();await db.exec('reset role');const privateData=(await db.query("select report_delivery_private.run_financial_statement_presentation('balance-sheet',$1,1)data",[{...filters,presentationCurrency:'USD'}])).rows[0].data;assert.deepEqual(privateData,interactive);
 await rejects(()=>db.query("select report_delivery_private.run_financial_statement_presentation('balance-sheet',$1,2)",[{...filters,presentationCurrency:'USD'}]),/empresa autorizada/);
 assert.deepEqual(await metadata(),metadataBefore);assert.deepEqual(await stored(),storedBefore);
});

test('many tiny dimension cells retain precision and reconcile to TOTAL at the cent',async t=>{
 await tx(t);await db.exec('reset role');
 await addPresentationJournal(db,{id:1102,date:'2026-02-22',lines:Array.from({length:200},(_,i)=>({account:4,credit:.01,department:1000+i}))});await assume();
 const total=await usd('income-statement'),matrix=await usd('income-statement',{columnView:'DEPARTMENT'}),revenue=matrix.rows.find(r=>r.account_id===4);
 close(matrix.summary.periodResult,63.61);close(matrix.summary.periodResult,total.summary.periodResult);close(Object.values(revenue.dimensions).reduce((n,x)=>n+x,0),revenue.amount);
 assert.equal(revenue.dimensions['1000'],.00005,'Do not round each small cell independently before summing');
});

test('pagination retains the same complete summary and the virtual row without dropping real accounts',async t=>{
 await tx(t);await db.exec('reset role');
 for(let i=0;i<15;i++)await db.query("insert into chart_accounts values($1,$2,'Synthetic paged asset','Deudora',2,'Activo',null)",[100+i,String(120000+i)]);
 await addPresentationJournal(db,{id:1103,date:'2026-02-22',lines:[...Array.from({length:15},(_,i)=>({account:100+i,debit:1})),{account:3,credit:15}]});await assume();
 const all=await usd(),first=await usd('balance-sheet',{pageSize:10}),second=await usd('balance-sheet',{pageSize:10,page:2});
 assert.equal(first.total,all.total);assert.deepEqual([...first.rows,...second.rows],all.rows);assert.deepEqual(first.summary,all.summary);assert.deepEqual(second.summary,all.summary);
 assert.equal(all.rows.filter(r=>r.is_presentation_adjustment).length,1);
});

test('an explicit exercise result preserves a small local profit even when its USD value is below the legacy display threshold',async t=>{
 await tx(t);await db.exec('reset role;delete from journal_line;delete from gl_impact;delete from journal;delete from "transaction"');
 await addPresentationJournal(db,{id:1104,date:'2026-02-01',lines:[{account:1,debit:100},{account:3,credit:90},{account:7,credit:10}]});
 await addPresentationJournal(db,{id:1105,date:'2026-02-22',lines:[{account:1,debit:.6},{account:4,credit:.6}]});await assume();
 const data=await usd();close(data.summary.currentPeriodResult,.003);
 // A USD-based .005 threshold would incorrectly substitute the formal .05.
 close(data.summary.exerciseResult,.003);close(data.summary.resultExercise,.05);
});

test('balance accepts an earlier cutoff despite a later hidden From date while income still rejects an inverted range',async t=>{
 await tx(t);await db.exec("reset role;insert into consolidated_exchange_rates values(3,99,1,'2025-12',1,2,.007,.0068,.005,true)");await assume();
 const hidden={dateFrom:'2026-01-01',dateTo:'2025-12-31'},actual=await usd('balance-sheet',hidden),annual=await usd('balance-sheet',{dateFrom:'2025-01-01',dateTo:'2025-12-31'});
 assert.deepEqual(actual,annual);close(actual.rows.find(r=>r.account_id===1).closing,112);assert.equal(actual.summary.sourceBalanced,true);
 const local=await legacy('balance-sheet',hidden);close(local.rows.find(r=>r.account_id===1).closing,16000);
 await rejects(()=>usd('income-statement',hidden),/fecha inicial no puede ser posterior/);
});

test('nonzero USD movements below one millionth survive TOTAL, matrix columns, dimensions, and summary with excludeZero',async t=>{
 await tx(t);await db.exec('reset role;delete from journal_line;delete from gl_impact;delete from journal;delete from "transaction"');
 await addPresentationJournal(db,{id:1106,date:'2026-02-22',lines:[{account:1,debit:.000001,department:10},{account:4,credit:.000001,department:10}]});await assume();
 for(const columnView of['TOTAL','DEPARTMENT']){
  const data=await usd('income-statement',{columnView,excludeZero:true});assert.equal(data.rows.length,1);assert.equal(data.rows[0].credit,5e-9);assert.equal(data.rows[0].amount,5e-9);assert.equal(data.summary.periodResult,5e-9);
  if(columnView==='DEPARTMENT'){assert.equal(data.rows[0].dimensions['10'],5e-9);assert.deepEqual(data.columns,[{id:'10',name:'Synthetic operations'}]);}
 }
});
