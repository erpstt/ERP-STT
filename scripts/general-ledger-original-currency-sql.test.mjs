import assert from 'node:assert/strict';
import {before,after,test} from 'node:test';
import {PGlite} from '@electric-sql/pglite';
import {setupGeneralLedgerOriginalCurrency,applyLedgerOriginalCurrencyMigration} from './fixtures/setup-general-ledger-original-currency.mjs';
import {assertIsolatedTestArgs} from './lib/migration-preview.mjs';
assertIsolatedTestArgs();
const db=new PGlite(),fields=['original_currency_code','original_exchange_rate','original_debit','original_credit'];
const filters={subsidiaryIds:[1],bookId:1,dateFrom:'2026-09-01',dateTo:'2026-09-30',page:1,pageSize:500};
let baseline,baselineTrial,metadataBefore,storedBefore;
const report=async(extra={},kind='general-ledger',schema='public',name='run_accounting_report')=>(await db.query(`select ${schema}.${name}($1,$2)data`,[kind,{...filters,...extra}])).rows[0].data;
const metadata=async()=>(await db.query("select oid,proowner,proacl::text,proconfig,provolatile,prosecdef,proisstrict,proparallel from pg_proc where proname='run_accounting_report_before_intercompany_loans'order by oid")).rows;
const stored=async()=>(await db.query(`select jsonb_build_object('transactions',(select jsonb_agg(to_jsonb(t)order by transaction_id)from "transaction"t),'journals',(select jsonb_agg(to_jsonb(t)order by journal_id)from journal t),'lines',(select jsonb_agg(to_jsonb(t)order by journal_line_id)from journal_line t),'impacts',(select jsonb_agg(to_jsonb(t)order by gl_impact_id)from gl_impact t),'opening',(select jsonb_agg(to_jsonb(t)order by id)from opening_balance_lines t))data`)).rows[0].data;
async function assume(role=10,sid=1){await db.exec('reset role');for(const[k,v]of Object.entries({'fixture.uid':'00000000-0000-0000-0000-000000000001','fixture.user':'1','fixture.role':role,'fixture.sid':sid}))await db.query('select set_config($1,$2,false)',[k,String(v)]);await db.exec('set role authenticated');}
async function tx(t){await db.exec('reset role;begin');t.after(()=>db.exec('rollback;reset role'));await assume();}
const row=async label=>(await report()).rows.find(item=>item.transaction_number==='SYN-'+label);
const fx=item=>Object.fromEntries(fields.map(field=>[field,item[field]]));
const strip=report=>({...report,rows:report.rows.map(item=>Object.fromEntries(Object.entries(item).filter(([key])=>!fields.includes(key))))});
before(async()=>{await setupGeneralLedgerOriginalCurrency(db);await assume();baseline=await report();baselineTrial=await report({},'trial-balance');await db.exec('reset role');metadataBefore=await metadata();storedBefore=await stored();await applyLedgerOriginalCurrencyMigration(db);});
after(()=>db.close());

test('ordinary foreign and local documents expose stored original amounts and the applied source rate',async t=>{
 await tx(t);assert.deepEqual(fx(await row('ORDINARY-USD')),{original_currency_code:'USD',original_exchange_rate:5,original_debit:0,original_credit:20});
 assert.deepEqual(fx(await row('LOCAL')),{original_currency_code:'CRC',original_exchange_rate:1,original_debit:0,original_credit:88});
});

test('stored source precision is retained and original principal is never reconstructed from local/rate',async t=>{
 await tx(t);const actual=await row('PRECISION');assert.equal(actual.original_credit,1.234299);assert.equal(actual.original_exchange_rate,3.123456789012);
 assert.notEqual(actual.credit/actual.original_exchange_rate,actual.original_credit,'The rounded local amount cannot reproduce the stored original exactly');
 assert.equal((await row('JOURNAL-RATE')).original_exchange_rate,4.123456789012);
});

test('mixed-currency opening rows use exact line currency and historical rate rather than header rate one',async t=>{
 await tx(t);await db.exec('reset role;update journal_line set original_currency_id=3,historical_exchange_rate=2.4 where journal_line_id=3;update opening_balance_lines set currency_id=3,historical_rate=2.4 where id=3;update gl_impact set original_currency_id=3,credit_fx=41.666667 where gl_impact_id=97');await assume();
 const entries=(await report()).rows.filter(item=>item.transaction_number==='SYN-OPENING-1'),usd=entries.find(item=>item.id===99),eur=entries.find(item=>item.id===97);
 assert.deepEqual(fx(usd),{original_currency_code:'USD',original_exchange_rate:5,original_debit:0,original_credit:20});assert.equal(eur.original_currency_code,'EUR');assert.equal(eur.original_exchange_rate,2.4);assert.equal(eur.original_credit,41.666667);
 await db.exec('reset role;update journal_line set historical_exchange_rate=null where journal_line_id=3');await assume();assert.equal((await report()).rows.find(item=>item.id===97).original_exchange_rate,2.4,'The exact opening snapshot supplies the historical rate when its journal rate is absent');
});

test('opening reversals swap stored original sides and retain exact historical rate and currency',async t=>{
 await tx(t);assert.deepEqual(fx(await row('OPENING-REVERSAL')),{original_currency_code:'USD',original_exchange_rate:5,original_debit:20,original_credit:0});
});

test('historical customer payments prefer an unambiguous posted line or the effective GL rate over a different header rate',async t=>{
 await tx(t);for(const label of ['HISTORICAL-PAYMENT','EFFECTIVE-PAYMENT','NO-HEADER-RATE','AMBIGUOUS-HISTORICAL']){const actual=await row(label);assert.equal(actual.original_exchange_rate,4,label);assert.equal(actual.original_credit,100);assert.equal(actual.credit,400);}
 assert.deepEqual(fx(await row('ORIGINAL-CURRENCY-OVERRIDE')),{original_currency_code:'EUR',original_exchange_rate:2.4,original_debit:0,original_credit:100});
});

test('zero and NULL original values are distinct and foreign principal is not invented',async t=>{
 await tx(t);assert.equal((await row('FOREIGN-ZERO')).original_credit,0);assert.equal((await row('FOREIGN-ZERO')).original_exchange_rate,null);
 assert.equal((await row('FOREIGN-NULL')).original_credit,null);assert.equal((await row('FOREIGN-NULL')).original_exchange_rate,null);
 const local=await row('LOCAL-NULL');assert.equal(local.original_debit,null);assert.equal(local.original_credit,null);assert.equal(local.original_exchange_rate,1);
});

test('missing original currency metadata stays unknown rather than guessing the functional currency',async t=>{
 await tx(t);await db.exec('reset role;update "transaction"set currency_id=null where transaction_id=200;update journal set currency_id=null where journal_id=200');await assume();
 assert.deepEqual(fx(await row('ORDINARY-USD')),{original_currency_code:null,original_exchange_rate:null,original_debit:0,original_credit:20});
});

test('local-only FX revaluation and its reversal preserve zero foreign exposure with functional currency and rate one',async t=>{
 await tx(t);for(const label of ['FX-REVALUATION','FX-REVERSAL'])assert.deepEqual(fx(await row(label)),{original_currency_code:'CRC',original_exchange_rate:1,original_debit:0,original_credit:0});
});

test('adding four columns leaves every existing output, amount, row order, pagination and other report unchanged',async t=>{
 await tx(t);assert.deepEqual(strip(await report()),baseline);assert.deepEqual(await report({},'trial-balance'),baselineTrial);
 const first=await report({page:1,pageSize:10}),second=await report({page:2,pageSize:10});assert.equal(first.total,baseline.total);assert.equal(second.total,baseline.total);assert.deepEqual([...first.rows,...second.rows],(await report()).rows.slice(0,20));
});

test('both calculation copies return identical new fields without stored-row, ACL, OID or configuration changes',async t=>{
 await tx(t);const interactive=await report();await db.exec('reset role');assert.deepEqual(await report({},'general-ledger','report_delivery_private','run_accounting_report_before_intercompany_loans'),interactive);assert.deepEqual(await metadata(),metadataBefore);assert.deepEqual(await stored(),storedBefore);
 const hashes=(await db.query("select md5(prosrc)hash from pg_proc where proname='run_accounting_report_before_intercompany_loans'order by oid")).rows;assert.equal(hashes[0].hash,hashes[1].hash);
});

test('public permission checks and private ACL remain enforced',async t=>{
 await tx(t);for(const[role,sid]of[[20,1],[10,2]]){await assume(role,sid);await db.exec('savepoint denied');await assert.rejects(report(),error=>error.code==='42501');await db.exec('rollback to savepoint denied;release savepoint denied');}
 await assume();await db.exec('savepoint denied');await assert.rejects(report({},'general-ledger','report_delivery_private','run_accounting_report_before_intercompany_loans'),error=>error.code==='42501');await db.exec('rollback to savepoint denied;release savepoint denied');
});

test('source drift stops migration before either calculation is altered',async()=>{
 const isolated=new PGlite();try{await setupGeneralLedgerOriginalCurrency(isolated);await isolated.exec("create or replace function report_delivery_private.run_accounting_report_before_intercompany_loans(p_report text,p_filters jsonb default'{}')returns jsonb language plpgsql stable security definer set search_path=pg_catalog,public,pg_temp as $$begin return '{}'::jsonb;end$$");
 const before=(await isolated.query("select oid,md5(prosrc)hash from pg_proc where proname='run_accounting_report_before_intercompany_loans'order by oid")).rows;await assert.rejects(applyLedgerOriginalCurrencyMigration(isolated),/Unexpected ledger calculation/);assert.deepEqual((await isolated.query("select oid,md5(prosrc)hash from pg_proc where proname='run_accounting_report_before_intercompany_loans'order by oid")).rows,before);
 }finally{await isolated.close();}
});
