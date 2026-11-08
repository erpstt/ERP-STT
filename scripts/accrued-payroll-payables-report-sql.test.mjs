import assert from'node:assert/strict';
import{before,after,test}from'node:test';
import{performance}from'node:perf_hooks';
import{PGlite}from'@electric-sql/pglite';
import{setupAccruedPayrollPayablesReport,applyAccruedPayrollPayablesReport,assumeSecurityUser,assumeSqlRole,beginIsolatedCase,deniedSql,seedAccruedPayrollJournal,seedAccruedPayrollPayment,seedAccruedPayrollOpening,seedAccruedPayrollStoredReversal,seedUnattributedAccruedPayroll}from'./fixtures/setup-accrued-payroll-payables-report.mjs';
import{assertIsolatedTestArgs}from'./lib/migration-preview.mjs';
assertIsolatedTestArgs();
const db=new PGlite(),filters={subsidiaryIds:[1],dateFrom:'2026-10-10',dateTo:'2026-10-31'};let beforeFunctions,beforeData,beforeSecurity;
const q=async(sql,p=[])=>(await db.query(sql,p)).rows[0]?.d;
const report=(extra={})=>q('select public.run_accrued_payroll_payables_report($1)d',[{...filters,...extra}]);
const functions=()=>q("select jsonb_agg(jsonb_build_array(oid,oid::regprocedure::text,proowner,proacl::text,proconfig,prosecdef,provolatile,md5(prosrc))order by oid)d from pg_proc where pronamespace in('public'::regnamespace,'supplier_payment_private'::regnamespace,'supplier_invoice_private'::regnamespace,'report_template_private'::regnamespace)and proname<>'run_accrued_payroll_payables_report'");
const security=()=>q("select jsonb_agg(jsonb_build_array(c.oid,c.relname,c.relowner,c.relacl::text,c.relrowsecurity,c.relforcerowsecurity)order by c.oid)d from pg_class c where c.relnamespace='public'::regnamespace and c.relkind in('r','p')");
const snapshot=()=>q(`select jsonb_build_object(
 'gl',(select md5(coalesce(jsonb_agg(to_jsonb(r)order by gl_impact_id),'[]')::text)from gl_impact r),
 'jl',(select md5(coalesce(jsonb_agg(to_jsonb(r)order by journal_line_id),'[]')::text)from journal_line r),
 'j',(select md5(coalesce(jsonb_agg(to_jsonb(r)order by journal_id),'[]')::text)from journal r),
 't',(select md5(coalesce(jsonb_agg(to_jsonb(r)order by transaction_id),'[]')::text)from "transaction"r),
 'check',(select md5(coalesce(jsonb_agg(to_jsonb(r)order by check_id),'[]')::text)from bank_check r),
 'bank',(select md5(coalesce(jsonb_agg(to_jsonb(r)order by bank_account_id),'[]')::text)from bank_account r),
 'opening',(select md5(coalesce(jsonb_agg(to_jsonb(r)order by id),'[]')::text)from opening_balance_lines r),
 'accounts',(select md5(coalesce(jsonb_agg(to_jsonb(r)order by account_id),'[]')::text)from chart_accounts r),
 'departments',(select md5(coalesce(jsonb_agg(to_jsonb(r)order by department_id),'[]')::text)from departments r),
 'costs',(select md5(coalesce(jsonb_agg(to_jsonb(r)order by cost_center_id),'[]')::text)from cost_centers r))d`);
async function tx(t){await beginIsolatedCase(db,t);await assumeSecurityUser(db);}
async function ownerRead(fn){await db.exec('reset role');const r=await fn();await assumeSecurityUser(db);return r;}
const leaf=(r,currency=2,department=21,cost=null)=>r.leafTotals.find(x=>x.currencyId===currency&&x.departmentId===department&&x.costCenterId===cost);
before(async()=>{await setupAccruedPayrollPayablesReport(db);await db.exec('reset role');beforeFunctions=await functions();beforeData=await snapshot();beforeSecurity=await security();await applyAccruedPayrollPayablesReport(db);});
after(()=>db.close());

test('the new report is empty safely and migration preserves every old engine, financial row and table security boundary',async t=>{
 await tx(t);const r=await report();assert.equal(r.totalRows,0);assert.equal(r.movementCount,0);assert.equal(r.summary.differenceLocal,0);assert.match(r.dataFingerprint,/^[0-9a-f]{32}$/);
 assert.equal(r.group.code,'223');assert.equal(r.localCurrency.code,'JMD');
 await db.exec('reset role');assert.deepEqual(await functions(),beforeFunctions);assert.deepEqual(await snapshot(),beforeData);assert.deepEqual(await security(),beforeSecurity);
 const grants=(await db.query("select p.oid::regprocedure::text signature,p.prosecdef,has_function_privilege('anon',p.oid,'execute')anon,has_function_privilege('authenticated',p.oid,'execute')auth,has_function_privilege('service_role',p.oid,'execute')service,p.proconfig from pg_proc p where p.oid in('public.run_accrued_payroll_payables_report(jsonb)'::regprocedure,'accrued_payroll_report_private.source_rows(bigint,date,bigint)'::regprocedure)order by p.prosecdef")).rows;
 assert.deepEqual(grants.map(x=>[x.prosecdef,x.anon,x.auth,x.service,x.proconfig]),[[false,false,false,false,['search_path=pg_catalog, public, pg_temp']],[true,false,true,false,['search_path=pg_catalog, public, pg_temp']]]);
});

test('real payroll and bank transfers roll forward prior liability and retain original currency and each posted historical local amount',async t=>{
 await tx(t);
 await seedAccruedPayrollJournal(db,{date:'2026-10-01',currencyId:2,rate:150});
 await seedAccruedPayrollJournal(db,{date:'2026-10-12',currencyId:2,rate:150});
 await seedAccruedPayrollPayment(db,{currencyId:2,rate:160});
 const r=await report(),l=leaf(r);
 assert.equal(r.totalRows,3);assert.equal(r.movementCount,2);assert.deepEqual(r.rows.map(x=>x.rowKind),['opening','movement','movement']);
 assert.equal(r.rows[0].date,filters.dateFrom);assert.equal(r.rows[0].journalId,null);assert.match(r.rows[0].sourceKey,/^opening:/);
 assert.deepEqual([l.openingOriginal,l.payrollOriginal,l.paymentOriginal,l.otherOriginal,l.closingOriginal],[100,100,30,0,170]);
 assert.deepEqual([l.openingLocal,l.payrollLocal,l.paymentLocal,l.otherLocal,l.closingLocal],[15000,15000,4800,0,25200]);
 assert.equal(r.rows.at(-1).runningBalanceLocal,25200);assert.equal(r.rows.at(-1).runningBalanceOriginal,170);
 assert.equal(r.summary.controlOpeningLocal,15000);assert.equal(r.summary.controlDebitLocal,4800);assert.equal(r.summary.controlCreditLocal,15000);assert.equal(r.summary.controlClosingLocal,25200);assert.equal(r.summary.differenceLocal,0);
});

test('an exact multiset projects identical GL components once per journal line and preserves separate departments and cost centers',async t=>{
 await tx(t);await seedAccruedPayrollJournal(db,{date:'2026-10-12',currencyId:2,rate:150,lines:[{credit:100,departmentId:20,costCenterId:40,note:'Synthetic CC40'},{credit:100,departmentId:20,costCenterId:41,note:'Synthetic CC41'},{credit:100,departmentId:21,note:'Synthetic different department'}]});
 const r=await report();assert.equal(r.totalRows,3);assert.equal(new Set(r.rows.map(x=>x.sourceKey)).size,3);assert.ok(r.rows.every(x=>x.sourceKey.startsWith('JL:')&&x.qualityReason===null));
 assert.deepEqual(new Set(r.rows.map(x=>[x.departmentId,x.costCenterId].join(':'))),new Set(['20:40','20:41','21:']));
 assert.equal(r.leafTotals.length,3);assert.equal(r.departmentTotals.length,2);assert.equal(r.currencyTotals[0].closingOriginal,300);assert.equal(r.summary.controlClosingLocal,45000);assert.equal(r.summary.differenceLocal,0);
});

test('group scope follows group_code 223 and descendants rather than account prefixes and mixed native currencies are never summed',async t=>{
 await tx(t);await db.exec("reset role;update chart_accounts set account_number='999999'where account_id=802;update chart_accounts set account_number='223999'where account_id=803");await assumeSecurityUser(db);
 await seedAccruedPayrollJournal(db,{date:'2026-10-12',lines:[{accountId:801,credit:10,departmentId:21},{accountId:802,credit:20,departmentId:21},{accountId:803,credit:30,departmentId:21}]});
 await seedAccruedPayrollJournal(db,{date:'2026-10-12',currencyId:2,rate:150,lines:[{accountId:801,credit:2,departmentId:21}]});
 const r=await report();assert.equal(r.movementCount,3);assert.equal(r.rows.some(x=>x.accountId===803),false);assert.ok(r.rows.some(x=>x.accountId===802));
 assert.equal(r.accountTotals.find(x=>x.accountId===801).closingOriginal,null);assert.equal(r.accountTotals.find(x=>x.accountId===801).closingLocal,310);
 assert.equal(r.filterOptions.accounts.some(x=>x.id===803),false);assert.equal(r.summary.controlClosingLocal,330);assert.equal(r.summary.differenceLocal,0);
});

test('opening-only shared journals retain exact per-line historical currency and dimensions, including defensive NULL transaction metadata',async t=>{
 await tx(t);const source=await seedAccruedPayrollOpening(db);const before=await ownerRead(snapshot);const r=await report();
 assert.equal(r.totalRows,2);assert.equal(r.movementCount,0);assert.ok(r.rows.every(x=>x.rowKind==='opening'&&x.journalId===null&&x.date===filters.dateFrom));
 assert.deepEqual(r.leafTotals.map(x=>x.closingLocal),[15000,14000]);assert.equal(r.currencyTotals[0].closingOriginal,200);assert.equal(r.summary.controlOpeningLocal,29000);assert.equal(r.summary.differenceLocal,0);
 assert.ok(source.entries.every(e=>r.leafTotals.some(x=>x.departmentId===e.departmentId&&x.costCenterId===e.costCenterId)));assert.deepEqual(await ownerRead(snapshot),before);
});

test('a corrupt opening posting date falls back to unknown dimensions without losing the independent GL opening control',async t=>{
 await tx(t);const source=await seedAccruedPayrollOpening(db);await db.exec('reset role');await db.query("update gl_impact set posting_date='2026-10-01'where gl_impact_id=$1",[source.entries[0].glId]);await assumeSecurityUser(db);
 const r=await report();assert.equal(r.summary.controlOpeningLocal,29000);assert.equal(r.summary.reportedOpeningLocal,29000);assert.equal(r.summary.differenceLocal,0);assert.equal(r.summary.unattributedOpeningCount,1);
 assert.ok(r.rows.some(x=>x.rowKind==='opening'&&x.departmentId===null&&x.costCenterId===null&&x.qualityReason));
});

test('unidentified prior-only GL remains visible and warns even when there are no period movements or known native units',async t=>{
 await tx(t);await seedUnattributedAccruedPayroll(db,{date:'2026-10-01',creditLocal:7});const r=await report();
 assert.equal(r.totalRows,1);assert.equal(r.movementCount,0);assert.equal(r.summary.unattributedMovementCount,0);assert.equal(r.summary.unattributedOpeningCount,1);
 assert.equal(r.rows[0].openingLocal,7);assert.equal(r.rows[0].openingOriginal,null);assert.equal(r.rows[0].runningBalanceOriginal,null);assert.ok(r.rows[0].qualityReason);assert.ok(r.leafTotals[0].qualityReason);assert.equal(r.summary.differenceLocal,0);
});

test('a failed whole-bucket proof retains each actual GL row rather than partially assigning or multiplying journal dimensions',async t=>{
 await tx(t);const source=await seedAccruedPayrollJournal(db,{date:'2026-10-12',lines:[{credit:10,departmentId:20,costCenterId:40},{credit:20,departmentId:21}]});
 await db.exec('reset role');await db.query('update gl_impact set credit_amount=credit_amount+1 where gl_impact_id=$1',[source.gl.find(x=>x.account_id===801).gl_impact_id]);await assumeSecurityUser(db);
 const r=await report();assert.equal(r.movementCount,2);assert.ok(r.rows.every(x=>x.sourceKey.startsWith('GL:')&&x.departmentId===null&&x.costCenterId===null));
 assert.equal(r.summary.controlClosingLocal,31);assert.equal(r.summary.reportedClosingLocal,31);assert.equal(r.summary.differenceLocal,0);assert.equal(r.summary.unattributedMovementCount,2);
});

test('reversal reads preserve now-annulled originals before reversal date and classify unmatched journal types as other rather than fictional payments',async t=>{
 await tx(t);const source=await seedAccruedPayrollJournal(db,{date:'2026-10-12'});await seedAccruedPayrollStoredReversal(db,source);
 const before=await report();assert.equal(before.leafTotals[0].closingLocal,100);assert.equal(before.rows[0].movementType,'payroll');
 const after=await report({dateTo:'2026-11-30'});assert.equal(after.movementCount,2);assert.equal(after.leafTotals[0].payrollLocal,100);assert.equal(after.leafTotals[0].otherLocal,-100);assert.equal(after.leafTotals[0].closingLocal,0);assert.equal(after.summary.differenceLocal,0);
 await seedAccruedPayrollJournal(db,{date:'2026-10-13',kind:'Asiento de Diario General',lines:[{credit:5,departmentId:21}]});assert.equal((await report()).rows.find(x=>x.date==='2026-10-13').movementType,'other');
});

test('onlyNonzero keeps fully paid activity and negative balances while excluding only known zero prior-only leaves',async t=>{
 await tx(t);await seedAccruedPayrollJournal(db,{date:'2026-10-12'});await seedAccruedPayrollPayment(db,{lines:[{amount:100,departmentId:21}]});
 const paid=await report();assert.equal(paid.movementCount,2);assert.equal(paid.leafTotals[0].closingLocal,0);assert.equal(paid.leafTotals[0].payrollLocal,100);assert.equal(paid.leafTotals[0].paymentLocal,100);
 const emptyPeriod=await report({dateFrom:'2026-11-01',dateTo:'2026-11-30'});assert.equal(emptyPeriod.totalRows,0);
 const showZero=await report({dateFrom:'2026-11-01',dateTo:'2026-11-30',onlyNonzero:false});assert.equal(showZero.totalRows,1);assert.equal(showZero.rows[0].rowKind,'opening');
 await seedAccruedPayrollPayment(db,{lines:[{amount:1,departmentId:21}]});assert.equal((await report()).leafTotals[0].closingLocal,-1);
});

test('all analytic filters select complete leaves before pagination and mark the full-group ledger comparison unavailable',async t=>{
 await tx(t);await seedAccruedPayrollJournal(db,{date:'2026-10-12',currencyId:2,rate:150,lines:[{credit:10,departmentId:20,costCenterId:40},{accountId:802,credit:20,departmentId:20,costCenterId:41}]});
 const r=await report({accountId:801,currencyId:2,departmentId:20,costCenterId:40,pageSize:1});assert.equal(r.totalRows,1);assert.equal(r.leafTotals[0].closingLocal,1500);assert.equal(r.summary.controlClosingLocal,4500);assert.equal(r.summary.reconciliationAvailable,false);assert.equal(r.summary.reconciliationReason,'FILTERED_SELECTION');assert.equal(r.summary.differenceLocal,null);
 assert.equal(r.filterOptions.accounts.length,2);assert.ok(r.filterOptions.costCenters.some(x=>x.id===41));assert.equal((await report({departmentId:99999})).totalRows,0);
});

test('global rollups, stable fingerprints and full-group running values do not depend on the visible or empty requested page',async t=>{
 await tx(t);await seedAccruedPayrollJournal(db,{date:'2026-10-12',lines:Array.from({length:55},()=>({credit:1,departmentId:21}))});
 const a=await report({pageSize:50}),b=await report({page:2,pageSize:50}),c=await report({page:999,pageSize:50});
 assert.equal(a.totalRows,55);assert.equal(b.rows.length,5);assert.equal(c.rows.length,0);assert.equal(c.totalRows,55);assert.equal(b.rows[0].runningBalanceLocal,51);assert.equal(b.rows.at(-1).runningBalanceOriginal,55);
 assert.equal(a.dataFingerprint,b.dataFingerprint);assert.equal(b.dataFingerprint,c.dataFingerprint);assert.deepEqual(a.leafTotals,c.leafTotals);assert.equal(c.leafTotals[0].closingLocal,55);
});

test('changing a proven line note changes the complete data fingerprint even when controls and totals remain equal',async t=>{
 await tx(t);const source=await seedAccruedPayrollJournal(db,{date:'2026-10-12'});const a=await report();
 await db.exec('reset role');const prior=await q("select current_setting('nexo.defer_journal_gl_sync',true)d");await db.query("select set_config('nexo.defer_journal_gl_sync','on',true)");
 try{await db.query("update journal_line set note='Synthetic changed description'where journal_id=$1 and account_id=801",[source.journalId]);}finally{await db.query("select set_config('nexo.defer_journal_gl_sync',$1,true)",[prior??'']);}await assumeSecurityUser(db);
 const b=await report();assert.notEqual(a.dataFingerprint,b.dataFingerprint);assert.deepEqual(a.leafTotals,b.leafTotals);assert.deepEqual(a.summary,b.summary);
});

test('current authorization, active company, accounting book and private function boundaries are enforced before parsing financial filters',async t=>{
 await tx(t);for(const role of['anon','service_role']){await assumeSqlRole(db,role);await deniedSql(db,'select run_accrued_payroll_payables_report($1)',[filters]);}
 await assumeSecurityUser(db,1,2,1);await deniedSql(db,'select run_accrued_payroll_payables_report($1)',[{invalid:true}]);await assumeSecurityUser(db);
 await deniedSql(db,'select accrued_payroll_report_private.source_rows(1,current_date,null)');await deniedSql(db,'select run_accrued_payroll_payables_report($1)',[{...filters,subsidiaryIds:[2]}]);await deniedSql(db,'select run_accrued_payroll_payables_report($1)',[{...filters,bookId:2}]);
 await assumeSecurityUser(db,1,3,1);assert.equal((await report()).totalRows,0);
});

test('invalid date ranges, IDs, account scope and unsolicited consolidation/presentation/filter keys fail without changing stored data',async t=>{
 await tx(t);await seedAccruedPayrollJournal(db,{date:'2026-10-12'});const before=await ownerRead(snapshot);
 for(const extra of[{dateFrom:'2026-02-30'},{dateTo:'2026-10-01'},{subsidiaryIds:[1,2]},{accountId:803},{currencyId:0},{departmentId:-1},{costCenterId:'wrong'},{onlyNonzero:null},{onlyNonzero:'false'},{page:2147483648},{pageSize:251},{movementType:'payroll'},{consolidated:true},{presentationCurrency:'USD'}])await deniedSql(db,'select run_accrued_payroll_payables_report($1)',[{...filters,...extra}],'22023');
 await report();await report({onlyNonzero:false});assert.deepEqual(await ownerRead(snapshot),before);
});

test('a bounded thousand-row ledger sample preserves full totals and unknown dimensions with a small page payload',async t=>{
 await tx(t);await seedUnattributedAccruedPayroll(db,{date:'2026-10-12',creditLocal:1,creditOriginal:1,debitOriginal:0,currencyId:2,count:1000});
 const start=performance.now(),r=await report({pageSize:10}),duration=performance.now()-start;
 assert.equal(r.totalRows,1000);assert.equal(r.movementCount,1000);assert.equal(r.rows.length,10);assert.equal(r.leafTotals[0].closingOriginal,1000);assert.equal(r.summary.controlClosingLocal,1000);assert.equal(r.summary.differenceLocal,0);assert.equal(r.summary.unattributedMovementCount,1000);
 t.diagnostic('Synthetic single-connection 1000 GL rows: '+duration.toFixed(1)+' ms; not production concurrency evidence.');
});

test('a proven bucket in two own books keeps unique journal-line book identities and each selected book reconciles independently',async t=>{
 await tx(t);const source=await seedAccruedPayrollJournal(db,{date:'2026-10-12',currencyId:2,rate:150,lines:[{credit:10,departmentId:21}]});
 // Synthetic persisted secondary-book state; this is not a posting-writer test.
 await db.exec('reset role');
 await db.query(`insert into gl_impact(transaction_id,account_id,subsidiary_id,fiscal_period_id,accounting_book_id,debit_amount,credit_amount,debit_fx,credit_fx,posting_date,original_currency_id,opening_balance_line_id)
  select transaction_id,account_id,subsidiary_id,fiscal_period_id,10,debit_amount,credit_amount,debit_fx,credit_fx,posting_date,original_currency_id,opening_balance_line_id
  from gl_impact where transaction_id=$1 and account_id=801 and accounting_book_id=1`,[source.transactionId]);
 await assumeSecurityUser(db);
 const all=await report(),primary=await report({bookId:1}),secondary=await report({bookId:10});
 assert.equal(all.movementCount,2);assert.equal(all.totalRows,2);assert.equal(new Set(all.rows.map(x=>x.sourceKey)).size,2);
 assert.deepEqual(new Set(all.rows.map(x=>x.bookId)),new Set([1,10]));assert.ok(all.rows.every(x=>x.sourceKey.startsWith('JL:')&&x.qualityReason===null));
 assert.equal(all.leafTotals[0].closingOriginal,20);assert.equal(all.leafTotals[0].closingLocal,3000);assert.equal(all.summary.controlClosingLocal,3000);assert.equal(all.summary.differenceLocal,0);
 for(const r of[primary,secondary]){assert.equal(r.totalRows,1);assert.equal(r.movementCount,1);assert.equal(r.leafTotals[0].closingOriginal,10);assert.equal(r.leafTotals[0].closingLocal,1500);assert.equal(r.summary.controlClosingLocal,1500);assert.equal(r.summary.differenceLocal,0);}
 assert.match(primary.rows[0].sourceKey,/:BOOK:1$/);assert.match(secondary.rows[0].sourceKey,/:BOOK:10$/);
});
