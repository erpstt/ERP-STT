import assert from 'node:assert/strict';
import {before,after,test} from 'node:test';
import {performance} from 'node:perf_hooks';
import {PGlite} from '@electric-sql/pglite';
import {setupSupplierAdvancesPending,applySupplierAdvancesPending,assumeSecurityUser,assumeSqlRole,beginIsolatedCase,deniedSql,seedSupplierAdvanceSource,seedSupplierAdvanceApplication,seedSupplierAdvanceManualLines,seedSupplierAdvanceOpening,seedSupplierAdvanceStoredReversal,seedUnattributedSupplierAdvance,seedSupplierAdvancesPendingPayment,seedSupplierAdvancesPendingOpeningReversal} from './fixtures/setup-supplier-advances-pending-report.mjs';
import {assertIsolatedTestArgs} from './lib/migration-preview.mjs';
assertIsolatedTestArgs();
const db=new PGlite(),filters={subsidiaryIds:[1],dateTo:'2026-10-31'};let baselineFunctions,baselineData,baselineTables,publicMetadata;
const q=async(sql,args=[])=>(await db.query(sql,args)).rows[0]?.d;
const report=(extra={})=>q('select run_supplier_advances_report($1)d',[{...filters,...extra}]);
const functions=()=>q("select jsonb_agg(jsonb_build_array(oid,oid::regprocedure::text,proowner,proacl::text,proconfig,prosecdef,provolatile,md5(prosrc))order by oid)d from pg_proc where pronamespace in('public'::regnamespace,'supplier_payment_private'::regnamespace,'supplier_invoice_private'::regnamespace,'report_template_private'::regnamespace,'supplier_advances_report_private'::regnamespace)and proname not in('run_supplier_advances_report','grant_sources','pending_sources')");
const tables=()=>q("select jsonb_agg(jsonb_build_array(oid,relname,relowner,relacl::text,relrowsecurity,relforcerowsecurity)order by oid)d from pg_class where relnamespace='public'::regnamespace and relkind in('r','p')");
const snapshot=()=>q(`select jsonb_build_object(
 'gl',(select md5(coalesce(jsonb_agg(to_jsonb(r)order by gl_impact_id),'[]')::text)from gl_impact r),
 'jl',(select md5(coalesce(jsonb_agg(to_jsonb(r)order by journal_line_id),'[]')::text)from journal_line r),
 'j',(select md5(coalesce(jsonb_agg(to_jsonb(r)order by journal_id),'[]')::text)from journal r),
 't',(select md5(coalesce(jsonb_agg(to_jsonb(r)order by transaction_id),'[]')::text)from "transaction"r),
 'apps',(select md5(coalesce(jsonb_agg(to_jsonb(r)order by application_id),'[]')::text)from supplier_advance_application r),
 'p',(select md5(coalesce(jsonb_agg(to_jsonb(r)order by payment_id),'[]')::text)from supplier_payment r),
 'pa',(select md5(coalesce(jsonb_agg(to_jsonb(r)order by application_id),'[]')::text)from supplier_payment_application r),
 'inv',(select md5(coalesce(jsonb_agg(to_jsonb(r)order by invoice_id),'[]')::text)from supplier_invoice r),
 'il',(select md5(coalesce(jsonb_agg(to_jsonb(r)order by line_id),'[]')::text)from supplier_invoice_line r),
 'bank',(select md5(coalesce(jsonb_agg(to_jsonb(r)order by bank_account_id),'[]')::text)from bank_account r),
 'bt',(select md5(coalesce(jsonb_agg(to_jsonb(r)order by bank_tran_id),'[]')::text)from bank_transaction r),
 'opening',(select md5(coalesce(jsonb_agg(to_jsonb(r)order by id),'[]')::text)from opening_balance_lines r),
 'accounts',(select md5(coalesce(jsonb_agg(to_jsonb(r)order by account_id),'[]')::text)from chart_accounts r),
 'vendors',(select md5(coalesce(jsonb_agg(to_jsonb(r)order by supplier_id),'[]')::text)from suppliers r))d`);
async function tx(t){await db.exec('reset role;begin');t.after(async()=>{try{await db.exec('rollback');}finally{await db.exec('reset role');}});await assumeSecurityUser(db);}
async function ownerRead(fn){await db.exec('reset role');const r=await fn();await assumeSecurityUser(db);return r;}
// Deliberate stored-state anomalies are seeded only under the isolated owner.
// Disabling local row triggers does not replace any calculation or claim that
// the protected writers would permit these corrupt/legacy historical states.
async function stored(sql,args=[]){await db.exec("reset role;set local session_replication_role='replica'");try{await db.query(sql,args);}finally{await db.exec("set local session_replication_role='origin'");await assumeSecurityUser(db);}}
const sourceRow=(r,source)=>r.rows.find(row=>row.sourceLineId===source.sourceLineId);
before(async()=>{await setupSupplierAdvancesPending(db);await db.exec('reset role');baselineFunctions=await functions();baselineData=await snapshot();baselineTables=await tables();publicMetadata=(await db.query("select oid,proowner,proacl::text,proconfig,prosecdef,provolatile from pg_proc where oid='run_supplier_advances_report(jsonb)'::regprocedure")).rows[0];await applySupplierAdvancesPending(db);});
after(()=>db.close());

test('only the existing report body and two private read helpers change; all engines, tables and financial rows remain intact',async t=>{
 await tx(t);const r=await report();assert.equal(r.reportMode,'UNAPPLIED_ADVANCES');assert.equal(r.total,0);assert.equal(r.book.id,1);assert.equal(r.context.bookId,null);assert.equal(r.effectiveBookId,1);assert.equal(r.summary.reconciliationAvailable,false);assert.equal(r.summary.differenceLocal,null);
 await db.exec('reset role');assert.deepEqual(await functions(),baselineFunctions);assert.deepEqual(await snapshot(),baselineData);assert.deepEqual(await tables(),baselineTables);
 assert.deepEqual((await db.query("select oid,proowner,proacl::text,proconfig,prosecdef,provolatile from pg_proc where oid='run_supplier_advances_report(jsonb)'::regprocedure")).rows[0],publicMetadata);
 const grants=(await db.query("select prosecdef,has_function_privilege('anon',oid,'execute')anon,has_function_privilege('authenticated',oid,'execute')auth,has_function_privilege('service_role',oid,'execute')service,proconfig from pg_proc where oid in('supplier_advances_report_private.grant_sources(bigint,bigint)'::regprocedure,'supplier_advances_report_private.pending_sources(bigint,date,bigint,bigint,bigint)'::regprocedure)")).rows;
 assert.equal(grants.length,2);for(const g of grants)assert.deepEqual(g,{prosecdef:false,anon:false,auth:false,service:false,proconfig:['search_path=pg_catalog, public, pg_temp']});
});

test('an unapplied real 15000 JMD source is a pending source, never a raw GL movement list',async t=>{
 await tx(t);const source=await seedSupplierAdvanceSource(db,{amount:15000,rate:1,currencyId:1});const r=await report(),row=sourceRow(r,source);
 assert.equal(r.total,1);assert.match(row.rowId,/^JL:\d+:BOOK:1$/);assert.deepEqual([row.advanceOriginal,row.appliedOriginal,row.pendingOriginal,row.advanceLocal,row.appliedLocal,row.pendingLocal],[15000,0,15000,15000,0,15000]);assert.deepEqual(r.exceptions,[]);assert.equal(r.summary.unlinkedMovementCount,0);
});

test('partial historical FX leaves exactly the source remainder and full application excludes the source even with legacy onlyNonzero false',async t=>{
 await tx(t);const source=await seedSupplierAdvanceSource(db,{amount:100,rate:150,currencyId:2});await seedSupplierAdvanceApplication(db,source,{amount:30,paymentRate:170,invoiceRate:160});let r=await report(),row=sourceRow(r,source);
 assert.deepEqual([row.advanceOriginal,row.appliedOriginal,row.pendingOriginal,row.advanceLocal,row.appliedLocal,row.pendingLocal],[100,30,70,15000,4500,10500]);assert.equal(r.summary.unlinkedMovementCount,0);
 await seedSupplierAdvanceApplication(db,source,{amount:70,paymentRate:175,invoiceRate:160});r=await report({onlyNonzero:false});assert.equal(r.total,0);assert.equal(r.summary.pendingLocal,0);assert.equal(r.summary.unlinkedMovementCount,0);assert.deepEqual(r.exceptions,[]);
});

test('two same-vendor sources share one payment credit without sharing or duplicating each source consumption',async t=>{
 await tx(t);const a=await seedSupplierAdvanceSource(db,{amount:100,rate:150,currencyId:2}),b=await seedSupplierAdvanceSource(db,{amount:100,rate:151,currencyId:2});const payment=await seedSupplierAdvancesPendingPayment(db,{sources:[{...a,appliedAmount:30},{...b,appliedAmount:20}]});
 assert.equal(payment.gl.length,1);assert.equal(Number(payment.gl[0].credit_amount),7520);const r=await report();assert.equal(r.total,2);assert.deepEqual([sourceRow(r,a).pendingOriginal,sourceRow(r,a).pendingLocal],[70,10500]);assert.deepEqual([sourceRow(r,b).pendingOriginal,sourceRow(r,b).pendingLocal],[80,12080]);assert.equal(r.supplierTotals.length,1);assert.equal(r.supplierTotals[0].pendingOriginal,150);assert.equal(r.summary.pendingLocal,22580);assert.deepEqual(r.exceptions,[]);
});

test('identical source amounts in one real journal retain independent journal-line source identities',async t=>{
 await tx(t);const journal=await seedSupplierAdvanceManualLines(db,{rate:1,currencyId:1,lines:[{supplierId:10,debit:100},{supplierId:10,debit:100}]});const r=await report();assert.equal(r.total,2);assert.equal(new Set(r.rows.map(row=>row.sourceLineId)).size,2);assert.ok(r.rows.every(row=>row.pendingOriginal===100));assert.equal(r.supplierTotals[0].pendingOriginal,200);assert.equal(r.summary.unlinkedMovementCount,0);assert.ok(journal);
});

test('payment economic dates define the cutoff and applied_at is audit-only, including six-decimal backdated cumulative rounding',async t=>{
 await tx(t);const source=await seedSupplierAdvanceSource(db,{amount:3,rate:.3333333333,currencyId:2});const later=await seedSupplierAdvancesPendingPayment(db,{sources:[{...source,appliedAmount:1}],date:'2026-10-31',paymentRate:.3333333333,invoiceRate:.3333333333});const earlier=await seedSupplierAdvancesPendingPayment(db,{sources:[{...source,appliedAmount:1}],date:'2026-10-15',paymentRate:.3333333333,invoiceRate:.3333333333});
 assert.ok(later.transactionId<earlier.transactionId);assert.equal(Number(earlier.gl[0].credit_amount),.333334);
 const before=await report({dateTo:'2026-10-20'});assert.deepEqual([sourceRow(before,source).appliedOriginal,sourceRow(before,source).appliedLocal,sourceRow(before,source).pendingOriginal,sourceRow(before,source).pendingLocal],[1,.333334,2,.666666]);
 await stored("update supplier_advance_application set applied_at='2035-01-01T00:00:00Z'");const after=await report({dateTo:'2026-10-20'});assert.deepEqual(after.rows,before.rows);assert.equal(after.dataFingerprint,before.dataFingerprint);
 assert.equal(sourceRow(await report(),source).pendingOriginal,1);assert.equal(sourceRow(await report({dateTo:'2026-10-10'}),source).pendingOriginal,3);
});

test('opening sources with shared journal and legacy NULL transactions retain their exact supplier, historical currency and value',async t=>{
 await tx(t);const opening=await seedSupplierAdvanceOpening(db);const before=await ownerRead(snapshot),r=await report();assert.equal(r.total,3);assert.equal(r.summary.pendingLocal,23205);assert.ok(opening.entries.every(entry=>r.rows.some(row=>row.sourceLineId===entry.journalLineId&&row.supplierId===entry.supplierId&&row.pendingOriginal===entry.amount)));assert.deepEqual(await ownerRead(snapshot),before);
 await stored('update gl_impact set debit_amount=debit_amount+1 where gl_impact_id=$1',[opening.entries[0].glId]);const invalid=await report();assert.equal(invalid.total,2);assert.equal(invalid.rows.some(row=>row.sourceLineId===opening.entries[0].journalLineId),false);assert.equal(invalid.summary.unresolvedSourceCount,1);assert.ok(invalid.exceptions.some(e=>e.reason==='SOURCE_UNVERIFIED'));
});

test('a fully verified opening reversal keeps the original pending before its own date and excludes it afterward despite shared opening keys',async t=>{
 await tx(t);const opening=await seedSupplierAdvanceOpening(db,{items:[{supplierId:10,amount:100,rate:150,currencyId:2}]});await seedSupplierAdvancesPendingOpeningReversal(db,opening);
 const before=await report();assert.equal(before.total,1);assert.equal(before.rows[0].pendingLocal,15000);assert.deepEqual(before.exceptions,[]);
 const after=await report({dateTo:'2026-11-30'});assert.equal(after.total,0);assert.deepEqual(after.exceptions,[]);assert.equal(after.summary.unlinkedMovementCount,0);
});

test('ordinary source reversals use stored amounts and reversal date rather than discarding a currently annulled source at every cutoff',async t=>{
 await tx(t);const source=await seedSupplierAdvanceSource(db,{amount:100,rate:150,currencyId:2});await seedSupplierAdvanceStoredReversal(db,source);assert.equal(sourceRow(await report(),source).pendingOriginal,100);const after=await report({dateTo:'2026-11-30'});assert.equal(after.total,0);assert.equal(after.summary.unlinkedMovementCount,0);
});

test('invalid or cancelled registered applications produce exceptions instead of inflating the advance to one hundred percent pending',async t=>{
 await tx(t);const source=await seedSupplierAdvanceSource(db,{amount:100,rate:150,currencyId:2});const payment=await seedSupplierAdvancesPendingPayment(db,{sources:[{...source,appliedAmount:30}]});await stored("update supplier_payment set status='ANULADO'where payment_id=$1",[payment.payment.id]);const r=await report();assert.equal(r.total,0);assert.equal(r.summary.unresolvedSourceCount,1);assert.ok(r.exceptions.some(e=>e.reason==='APPLICATION_HISTORY_UNVERIFIED'));
});

test('an invoice with invalid accounting origin invalidates its application without inventing a source-to-invoice line allocation',async t=>{
 // Conservative contract: cancelled/reversed payment or invoice history has
 // no canonical source-level restitution. Keep an explicit exception, not a
 // reconstructed historical availability or a silently restored 100% advance.
 await tx(t);const source=await seedSupplierAdvanceSource(db,{amount:100,rate:150,currencyId:2});const payment=await seedSupplierAdvancesPendingPayment(db,{sources:[{...source,appliedAmount:30}]});await stored("update journal set status='ANULADO'where journal_id=(select journal_id from supplier_invoice where invoice_id=$1)",[payment.invoice.invoiceId]);const r=await report();assert.equal(r.total,0);assert.equal(r.summary.unresolvedSourceCount,1);assert.ok(r.exceptions.some(e=>e.reason==='APPLICATION_HISTORY_UNVERIFIED'));
});

test('opening invoice headers with NULL transaction retain a verifiable exact journal, run, line and payable GL',async t=>{
 await tx(t);const source=await seedSupplierAdvanceSource(db,{amount:100,rate:1,currencyId:1});const payment=await seedSupplierAdvancesPendingPayment(db,{sources:[{...source,appliedAmount:30}],paymentRate:1,invoiceRate:1});
 await stored(`insert into opening_balance_runs(id,subsidiary_id,journal_id,status,opening_date)select 900,1,journal_id,'POSTED',invoice_date from supplier_invoice where invoice_id=$1`,[payment.invoice.invoiceId]);
 await stored(`insert into opening_balance_lines(id,run_id,source_type,account_id,currency_id,local_debit,local_credit,foreign_amount,historical_rate,document_number)select 900,900,'AP',payable_account_id,1,0,30,30,1,'SYN-LEGACY-OPEN-INVOICE'from supplier_invoice where invoice_id=$1`,[payment.invoice.invoiceId]);
 await stored('update supplier_invoice set is_opening_balance=true,opening_run_id=900,opening_balance_line_id=900,transaction_id=null where invoice_id=$1',[payment.invoice.invoiceId]);
 await stored('update journal set is_opening_balance=true where journal_id=(select journal_id from supplier_invoice where invoice_id=$1)',[payment.invoice.invoiceId]);
 await stored('update gl_impact set opening_balance_line_id=900 where transaction_id=(select transaction_id from journal where journal_id=(select journal_id from supplier_invoice where invoice_id=$1))and account_id=(select payable_account_id from supplier_invoice where invoice_id=$1)',[payment.invoice.invoiceId]);
 const r=await report();assert.equal(r.total,1);assert.equal(sourceRow(r,source).pendingOriginal,70);assert.deepEqual(r.exceptions,[]);
 await stored('update opening_balance_lines set currency_id=2 where id=900');const wrongOpeningCurrency=await report();assert.equal(wrongOpeningCurrency.total,0);assert.equal(wrongOpeningCurrency.summary.unresolvedSourceCount,1);assert.ok(wrongOpeningCurrency.exceptions.some(e=>e.reason==='APPLICATION_HISTORY_UNVERIFIED'));
});

test('over-applied or GL-mismatched histories become bounded exceptions rather than negative or silently capped pending rows',async t=>{
 await tx(t);const source=await seedSupplierAdvanceSource(db,{amount:100,rate:150,currencyId:2});const payment=await seedSupplierAdvancesPendingPayment(db,{sources:[{...source,appliedAmount:30}]});await stored('update supplier_advance_application set amount=101 where payment_id=$1',[payment.payment.id]);const r=await report();assert.equal(r.total,0);assert.equal(r.summary.unresolvedSourceCount,1);assert.ok(r.exceptions.some(e=>e.reason==='SOURCE_OVERAPPLIED'));assert.ok(r.exceptions.every(e=>e.examples.length<=25));
});

test('unlinked manual credits and local-only revaluation movements warn without being assigned to any source as an application',async t=>{
 await tx(t);const source=await seedSupplierAdvanceSource(db,{amount:100,rate:1,currencyId:1});await seedSupplierAdvanceManualLines(db,{rate:1,currencyId:1,lines:[{supplierId:10,credit:10}]});await seedUnattributedSupplierAdvance(db,{local:2,native:0,currencyId:1});const r=await report();assert.equal(sourceRow(r,source).pendingOriginal,100);assert.equal(sourceRow(r,source).appliedOriginal,0);assert.equal(sourceRow(r,source).qualityReason,'UNLINKED_LEDGER_ACTIVITY');assert.equal(r.summary.pendingLocal,100);assert.equal(r.summary.controlBalanceLocal,92);assert.ok(r.summary.unlinkedMovementCount>=2);assert.equal(r.summary.reconciliationAvailable,false);
});

test('default book selects the unique principal without duplicate advances; explicit secondary book requires its own historical proof',async t=>{
 await tx(t);const source=await seedSupplierAdvanceSource(db,{amount:100,rate:150,currencyId:2});
 const applied=await seedSupplierAdvancesPendingPayment(db,{sources:[{...source,appliedAmount:30}]});
 // Synthetic persisted secondary-book state, after the real payment engine
 // has completed. This does not claim multi-book posting-writer coverage.
 await stored('insert into gl_impact(transaction_id,account_id,subsidiary_id,fiscal_period_id,accounting_book_id,debit_amount,credit_amount,debit_fx,credit_fx,posting_date,original_currency_id,opening_balance_line_id)select transaction_id,account_id,subsidiary_id,fiscal_period_id,10,debit_amount,credit_amount,debit_fx,credit_fx,posting_date,original_currency_id,opening_balance_line_id from gl_impact where accounting_book_id=1 and(transaction_id in($1,$2)or transaction_id=(select transaction_id from journal where journal_id=(select journal_id from supplier_invoice where invoice_id=$3)))',[source.transactionId,applied.transactionId,applied.invoice.invoiceId]);
 const primary=await report(),secondary=await report({bookId:10});assert.equal(primary.total,1);assert.equal(primary.summary.pendingLocal,10500);assert.equal(primary.context.bookId,null);assert.equal(primary.effectiveBookId,1);assert.equal(secondary.total,1);assert.equal(secondary.summary.pendingLocal,10500);assert.equal(secondary.book.id,10);assert.match(secondary.rows[0].sourceKey,/:BOOK:10$/);assert.notEqual(primary.rows[0].sourceKey,secondary.rows[0].sourceKey);
 // The source and payment exist in book 10, but its invoice AP entry no
 // longer does: it cannot borrow the principal book's remaining AP proof.
 await stored('delete from gl_impact where accounting_book_id=10 and transaction_id=(select transaction_id from journal where journal_id=(select journal_id from supplier_invoice where invoice_id=$1))and account_id=(select payable_account_id from supplier_invoice where invoice_id=$1)',[applied.invoice.invoiceId]);
 const wrongInvoiceBook=await report({bookId:10});assert.equal(wrongInvoiceBook.total,0);assert.equal(wrongInvoiceBook.summary.unresolvedSourceCount,1);assert.ok(wrongInvoiceBook.exceptions.some(e=>e.reason==='APPLICATION_HISTORY_UNVERIFIED'));
 await stored('update accounting_books set is_primary=true where accounting_book_id=10');await deniedSql(db,'select run_supplier_advances_report($1)',[filters],'22023');assert.equal((await report({bookId:1})).total,1);
});

test('source-level supplier/currency filters, inactive historical suppliers, pagination and full-data fingerprint remain independent of the visible page',async t=>{
 await tx(t);await seedSupplierAdvanceManualLines(db,{rate:1,currencyId:1,lines:Array.from({length:55},()=>({supplierId:10,debit:1}))});const other=await seedSupplierAdvanceSource(db,{amount:10,rate:150,currencyId:2,supplierId:20});await stored('update suppliers set is_inactive=true where supplier_id=20');const a=await report({pageSize:50}),b=await report({page:2,pageSize:50}),empty=await report({page:99,pageSize:50});assert.equal(a.total,56);assert.equal(b.rows.length,6);assert.equal(empty.rows.length,0);assert.equal(a.dataFingerprint,b.dataFingerprint);assert.deepEqual(a.currencyTotals,empty.currencyTotals);const selected=await report({supplierId:20,currencyId:2});assert.equal(selected.total,1);assert.equal(sourceRow(selected,other).pendingOriginal,10);assert.ok(selected.filterOptions.suppliers.some(s=>s.id===20));
 await stored("update journal_line set note='Synthetic changed pending note'where journal_line_id=$1",[other.sourceLineId]);assert.notEqual((await report()).dataFingerprint,a.dataFingerprint);
});

test('authorization, active company, own book and private helpers are enforced before parsing financial filters',async t=>{
 await tx(t);for(const role of['anon','service_role']){await assumeSqlRole(db,role);await deniedSql(db,'select run_supplier_advances_report($1)',[filters]);}await assumeSecurityUser(db,1,2,1);await deniedSql(db,'select run_supplier_advances_report($1)',[{invalid:true}]);await assumeSecurityUser(db);await deniedSql(db,'select supplier_advances_report_private.grant_sources(1,1)');await deniedSql(db,'select supplier_advances_report_private.pending_sources(1,current_date,1,null,null)');await deniedSql(db,'select run_supplier_advances_report($1)',[{...filters,subsidiaryIds:[2]}]);await deniedSql(db,'select run_supplier_advances_report($1)',[{...filters,bookId:2}]);await assumeSecurityUser(db,1,3,1);assert.equal((await report()).total,0);
});

test('invalid filters and pure report reads never mutate saved balances, writers or master data',async t=>{
 await tx(t);await seedSupplierAdvanceSource(db,{amount:100,rate:1,currencyId:1});const before=await ownerRead(snapshot);for(const extra of[{dateTo:'2026-02-30'},{subsidiaryIds:[1,2]},{bookId:0},{supplierId:-1},{currencyId:'bad'},{onlyNonzero:null},{page:2147483648},{pageSize:251},{consolidated:true},{presentationCurrency:'USD'}])await deniedSql(db,'select run_supplier_advances_report($1)',[{...filters,...extra}],'22023');const start=performance.now();await report();await report({onlyNonzero:false});assert.deepEqual(await ownerRead(snapshot),before);assert.deepEqual(await ownerRead(functions),baselineFunctions);t.diagnostic('Isolated report read '+(performance.now()-start).toFixed(1)+' ms; not production concurrency evidence.');
});
