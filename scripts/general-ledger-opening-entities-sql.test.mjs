import assert from 'node:assert/strict';
import {before,after,test} from 'node:test';
import {PGlite} from '@electric-sql/pglite';
import {setupGeneralLedgerOpeningEntities,applyLedgerEntityMigration} from './fixtures/setup-general-ledger-opening-entities.mjs';
import {assertIsolatedTestArgs} from './lib/migration-preview.mjs';
assertIsolatedTestArgs();

const db=new PGlite();let baseline,baselineTrial,metadataBefore,tablesBefore;
const baseFilters={subsidiaryIds:[1],bookId:1,dateFrom:'2026-09-01',dateTo:'2026-09-30',accountId:1,page:1,pageSize:500};
const report=async(filters={},kind='general-ledger',schema='public',name='run_accounting_report')=>(await db.query(`select ${schema}.${name}($1,$2) data`,[kind,{...baseFilters,...filters}])).rows[0].data;
const metadata=async()=>(await db.query(`select n.nspname,p.proname,p.oid,p.proowner,p.proacl::text,p.proconfig,p.provolatile,p.prosecdef,p.proisstrict,p.proparallel
 from pg_proc p join pg_namespace n on n.oid=p.pronamespace where p.proname='run_accounting_report_before_intercompany_loans'order by n.nspname`)).rows;
const tables=async()=>(await db.query(`select jsonb_build_object(
 'journal',(select jsonb_agg(to_jsonb(t)order by journal_id)from journal t),
 'lines',(select jsonb_agg(to_jsonb(t)order by journal_line_id)from journal_line t),
 'impacts',(select jsonb_agg(to_jsonb(t)order by gl_impact_id)from gl_impact t),
 'openingLines',(select jsonb_agg(to_jsonb(t)order by id)from opening_balance_lines t),
 'openingRuns',(select jsonb_agg(to_jsonb(t)order by id)from opening_balance_runs t),
 'customers',(select jsonb_agg(to_jsonb(t)order by customer_id)from customers t),
 'centers',(select jsonb_agg(to_jsonb(t)order by cost_center_id)from cost_centers t)) data`)).rows[0].data;
async function assume(user=1,role=10,sid=1){await db.exec('reset role');for(const[k,v]of Object.entries({'fixture.uid':`00000000-0000-0000-0000-${String(user).padStart(12,'0')}`,'fixture.user':user,'fixture.role':role,'fixture.sid':sid}))await db.query('select set_config($1,$2,false)',[k,String(v)]);await db.exec('set role authenticated');}
async function tx(t){await db.exec('reset role;begin');t.after(()=>db.exec('rollback;reset role'));await assume();}
async function rejected(sql,args=[],code='42501'){await db.exec('savepoint rejected');try{await assert.rejects(db.query(sql,args),error=>error.code===code);}finally{await db.exec('rollback to savepoint rejected;release savepoint rejected');}}
const bySource=rows=>new Map(rows.map(row=>[100-Number(row.id),row]));

before(async()=>{await setupGeneralLedgerOpeningEntities(db);await assume();baseline=await report();baselineTrial=await report({accountId:null},'trial-balance');await db.exec('reset role');metadataBefore=await metadata();tablesBefore=await tables();await applyLedgerEntityMigration(db);});
after(()=>db.close());

test('opening GL movements resolve each exact center and its customer, including equal amounts',async t=>{
 await tx(t);assert.equal(baseline.rows.length,11);assert.ok(baseline.rows.every(row=>row.cost_center==='EQUU-0001'&&row.entity_name===''));
 const actual=await report(),rows=bySource(actual.rows),centers=['EQUU-0001','EQUU-0002','GLOB-0001','GLOB-0002','GLOB-0003','GLOB-0004','GLOB-0005','ZTE-0001','—','—','—'];
 assert.equal(actual.rows.length,11);assert.equal(actual.total,11);
 for(let source=1;source<=11;source++){const row=rows.get(source);assert.equal(row.cost_center,centers[source-1]);assert.equal(row.concept,`Synthetic line ${source}`);assert.equal(row.entity_name,source<=2?'Synthetic customer A':source<=7?'Synthetic customer B':source===8?'Synthetic customer C':'');assert.equal(row.entity_type,source<=8?'Cliente':'—');}
 assert.deepEqual(actual.rows.map(({entity_name,entity_type,cost_center,concept,...row})=>row),baseline.rows.map(({entity_name,entity_type,cost_center,concept,...row})=>row));assert.deepEqual(actual.summary,baseline.summary);
});

test('exact trace preserves ledger pagination, counts and all unfiltered totals',async t=>{
 await tx(t);const full=await report(),first=await report({page:1,pageSize:10}),second=await report({page:2,pageSize:10});
 assert.equal(first.total,11);assert.equal(second.total,11);assert.equal(first.rows.length,10);assert.equal(second.rows.length,1);
 assert.deepEqual([...first.rows,...second.rows],full.rows);
 const balanced=await report({accountId:null});assert.equal(balanced.total,12);assert.equal(balanced.summary.debit,1100);assert.equal(balanced.summary.credit,1100);
 await db.exec("reset role;update opening_balance_runs set status='REVERSED'where id=10");await assume();assert.deepEqual(await report(),full,'Historical reversed openings retain their original trace and customer names');
});

test('entity and center filters use the same resolved identity as the displayed row',async t=>{
 await tx(t);
 for(const[id,count]of[[31,2],[32,5],[33,1]]){const actual=await report({entityType:'Cliente',entityId:id});assert.equal(actual.rows.length,count);assert.ok(actual.rows.every(row=>row.entity_type==='Cliente'&&row.entity_name===`Synthetic customer ${id===31?'A':id===32?'B':'C'}`));}
 const center=await report({costCenterId:70,entityType:'Cliente',entityId:31});assert.equal(center.rows.length,1);assert.equal(center.rows[0].cost_center,'EQUU-0002');
 assert.equal((await report({entityType:'Proveedor',entityId:31})).rows.length,0);
 await db.exec("reset role;update journal_line set entity_type=case journal_line_id when 1 then ''else '   'end where journal_line_id in(1,2)");await assume();
 const emptyTypes=await report({entityType:'Cliente',entityId:31});assert.equal(emptyTypes.rows.length,2);assert.ok(emptyTypes.rows.every(row=>row.entity_type==='Cliente'));
});

test('explicit journal customer, supplier, employee or other identity is never inferred from its center',async t=>{
 await tx(t);await db.exec('reset role');
 await db.exec("update journal_line set entity_type='Cliente',customer_id=32 where journal_line_id=1;update journal_line set entity_type='Proveedor',supplier_id=81 where journal_line_id=2;update journal_line set entity_type='Empleado',employee_id=91 where journal_line_id=3");await assume();
 const rows=bySource((await report()).rows);assert.equal(rows.get(1).entity_name,'Synthetic customer B');assert.equal(rows.get(2).entity_name,'Synthetic supplier');assert.equal(rows.get(3).entity_name,'Synthetic Employee');
 for(const field of ['financial_creditor_id','related_company_id','tax_agency_id','other_name_id']){
  await db.exec('reset role;savepoint identity_case');await db.exec(`update journal_line set ${field}=101 where journal_line_id=4`);await assume();assert.equal(bySource((await report()).rows).get(4).entity_name,'',field);await db.exec('reset role;rollback to savepoint identity_case;release savepoint identity_case');
 }
 await db.exec("update journal_line set entity_type='Acreedor financiero'where journal_line_id=4");await assume();const explicit=bySource((await report()).rows).get(4);assert.equal(explicit.entity_name,'');assert.equal(explicit.entity_type,'Acreedor financiero');
});

test('inference is limited to matching GL opening, run, subsidiary, CLIENTE center and membership',async t=>{
 await tx(t);
 const cases=["update opening_balance_lines set source_type='AR'where id=1","update opening_balance_lines set source_type='AP'where id=1",
  'update opening_balance_lines set cost_center_id=70 where id=1','update opening_balance_lines set account_id=2 where id=1',
  'update opening_balance_runs set journal_id=999 where id=10','update opening_balance_runs set subsidiary_id=2 where id=10',
  'update cost_centers set subsidiary_id=2 where cost_center_id=69',"update cost_centers set cost_center_type='INTERNO'where cost_center_id=69",
  'delete from entity_subsidiaries where customer_id=31 and subsidiary_id=1','update cost_centers set customer_id=null where cost_center_id=69'];
 for(const sql of cases){await db.exec('reset role;savepoint scope_case');await db.exec(sql);await assume();assert.equal(bySource((await report()).rows).get(1).entity_name,'',sql);await db.exec('reset role;rollback to savepoint scope_case;release savepoint scope_case');}
 await db.exec('update cost_centers set is_inactive=true where cost_center_id=69');await assume();assert.equal(bySource((await report()).rows).get(1).entity_name,'Synthetic customer A','Historical inactive centers retain their identity');
});

test('missing exact trace does not borrow the first line and ordinary journals do not infer customers',async t=>{
 await tx(t);await db.exec('reset role;update gl_impact set opening_balance_line_id=999 where gl_impact_id=99');await assume();let first=bySource((await report()).rows).get(1);assert.equal(first.entity_name,'—');assert.equal(first.cost_center,'—');
 await db.exec('reset role;update gl_impact set opening_balance_line_id=null where gl_impact_id=99');await assume();first=bySource((await report()).rows).get(1);assert.equal(first.entity_name,'','An impact without an opening trace cannot infer an opening customer');
 await db.exec('reset role;update journal set is_opening_balance=false where journal_id=100;delete from opening_balance_runs');await assume();assert.ok((await report()).rows.every(row=>row.entity_name===''));
});

test('ordinary movements and existing blank employee output retain their baseline projection',async t=>{
 await tx(t);await db.exec('reset role;update "transaction"set customer_id=33 where transaction_id=100;update gl_impact set opening_balance_line_id=null');
 const expected=await report({entityType:'Cliente',entityId:33},'general-ledger','public','synthetic_baseline_ledger');await assume();const actual=await report({entityType:'Cliente',entityId:33});assert.deepEqual(actual,expected);assert.ok(actual.rows.every(row=>row.entity_name===''));
});

test('migration changes no stored rows, amounts, OIDs, ACL, owner, volatility or search path',async t=>{
 await tx(t);await db.exec('reset role');assert.deepEqual(await metadata(),metadataBefore);assert.deepEqual(await tables(),tablesBefore);
 await assume();assert.deepEqual(await report({accountId:null},'trial-balance'),baselineTrial);
 const publicResult=await report();await db.exec('reset role');const delivery=await report({},'general-ledger','report_delivery_private','run_accounting_report_before_intercompany_loans');assert.deepEqual(delivery,publicResult);
 const sources=(await db.query("select md5(prosrc)hash from pg_proc where proname='run_accounting_report_before_intercompany_loans'order by oid")).rows;assert.equal(sources[0].hash,sources[1].hash);
});

test('role, session and company checks remain in the public entry; private calculations stay closed',async t=>{
 await tx(t);await assume(1,20);await rejected('select run_accounting_report($1,$2)',['general-ledger',baseFilters]);
 await assume(1,10,2);await rejected('select run_accounting_report($1,$2)',['general-ledger',baseFilters]);
 await assume();await rejected('select public.run_accounting_report_before_intercompany_loans($1,$2)',['general-ledger',baseFilters]);await rejected('select report_delivery_private.run_accounting_report_before_intercompany_loans($1,$2)',['general-ledger',baseFilters]);
 await db.exec('reset role;set role anon');await rejected('select run_accounting_report($1,$2)',['general-ledger',baseFilters]);
});

test('drift in either copied source stops before changing either calculation',async()=>{
 const isolated=new PGlite();try{await setupGeneralLedgerOpeningEntities(isolated);await isolated.exec("create or replace function report_delivery_private.run_accounting_report_before_intercompany_loans(p_report text,p_filters jsonb default'{}')returns jsonb language plpgsql stable security definer set search_path=pg_catalog,public,pg_temp as $$begin return '{}'::jsonb;end$$");
  const before=(await isolated.query("select oid,md5(prosrc)hash from pg_proc where proname='run_accounting_report_before_intercompany_loans'order by oid")).rows;
  await assert.rejects(applyLedgerEntityMigration(isolated),/Unexpected ledger calculation/);
  assert.deepEqual((await isolated.query("select oid,md5(prosrc)hash from pg_proc where proname='run_accounting_report_before_intercompany_loans'order by oid")).rows,before);
 }finally{await isolated.close();}
});
