import assert from 'node:assert/strict';
import {before,after,test} from 'node:test';
import {readFile} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
import {setupSupplierPaymentAdvanceVisibility,applySupplierPaymentAdvanceVisibility,supplierPaymentAdvanceVisibilityTargets,assumeSecurityUser,assumeSqlRole,beginIsolatedCase,deniedSql,seedSupplierAdvanceSource,seedSupplierAdvanceApplication} from './fixtures/setup-supplier-payment-advance-visibility.mjs';
import {assertIsolatedTestArgs} from './lib/migration-preview.mjs';
assertIsolatedTestArgs();
const db=new PGlite();let baselineMetadata,baselineDefinitions,baselineUnchanged,baselineData,reproducedHidden=false,reproducedDenial=false,migration;
const expectedBefore=['f1de7f928d415f44614e93597b3dccf0','5f7a47109e9e4956634c071862246844','fa418c9b475004a826799c40a5e14c06'];
const q=async(sql,params=[])=>(await db.query(sql,params)).rows[0]?.d;
const list=()=>q('select public.supplier_available_advances()d');
const metadata=async()=>Promise.all(supplierPaymentAdvanceVisibilityTargets.map(async signature=>(await db.query('select oid,oid::regprocedure::text signature,proowner,proacl::text,proconfig,prosecdef,provolatile,proisstrict,proparallel,md5(prosrc)md5 from pg_proc where oid=$1::regprocedure',[signature])).rows[0]));
const otherSources=()=>q("select jsonb_agg(jsonb_build_array(oid,proowner,proacl::text,proconfig,prosecdef,provolatile,md5(prosrc))order by oid)d from pg_proc where oid in('public.supplier_available_advances()'::regprocedure,'public.save_supplier_payment_with_advances(jsonb,bigint)'::regprocedure,'supplier_payment_private.save_supplier_payment_with_advances(jsonb,bigint)'::regprocedure,'supplier_payment_private.advance_values(bigint,bigint)'::regprocedure,'supplier_payment_private.rebuild_historical_fx(bigint,numeric)'::regprocedure,'public.sync_journal_gl_impacts(bigint)'::regprocedure)");
const snapshot=()=>q(`select jsonb_build_object(
 'gl',(select coalesce(jsonb_agg(to_jsonb(r)order by gl_impact_id),'[]')from gl_impact r),
 'jl',(select coalesce(jsonb_agg(to_jsonb(r)order by journal_line_id),'[]')from journal_line r),
 'journal',(select coalesce(jsonb_agg(to_jsonb(r)order by journal_id),'[]')from journal r),
 'transaction',(select coalesce(jsonb_agg(to_jsonb(r)order by transaction_id),'[]')from "transaction" r),
 'payment',(select coalesce(jsonb_agg(to_jsonb(r)order by payment_id),'[]')from supplier_payment r),
 'advance',(select coalesce(jsonb_agg(to_jsonb(r)order by application_id),'[]')from supplier_advance_application r),
 'invoice',(select coalesce(jsonb_agg(to_jsonb(r)order by invoice_id),'[]')from supplier_invoice r),
 'invoiceLines',(select coalesce(jsonb_agg(to_jsonb(r)order by line_id),'[]')from supplier_invoice_line r),
 'bank',(select coalesce(jsonb_agg(to_jsonb(r)order by bank_account_id),'[]')from bank_account r),
 'bankTransactions',(select coalesce(jsonb_agg(to_jsonb(r)order by bank_tran_id),'[]')from bank_transaction r),
 'accounts',(select coalesce(jsonb_agg(to_jsonb(r)order by account_id),'[]')from chart_accounts r),
 'groups',(select coalesce(jsonb_agg(to_jsonb(r)order by group_id),'[]')from account_group r)
)d`);
async function ownerRead(run){await db.exec('reset role');const result=await run();await assumeSecurityUser(db);return result;}
async function tx(t){await beginIsolatedCase(db,t);await assumeSecurityUser(db);}
async function deniedRun(run,code){await db.exec('savepoint denied_advance');try{await assert.rejects(run,error=>{assert.equal(error.code,code);return true;});}finally{await db.exec('rollback to denied_advance;release denied_advance');}}
const sourceBalance=source=>q('select jsonb_build_array(sum(debit_amount-credit_amount),sum(debit_fx-credit_fx))d from gl_impact where account_id=$1',[source.accountId]);
async function balanced(payment){return ownerRead(async()=>{const difference=await q('select sum(debit_amount-credit_amount)d from gl_impact where transaction_id=(select transaction_id from supplier_payment where payment_id=$1)',[payment.id]);assert.equal(Number(difference),0);});}

before(async()=>{
 await setupSupplierPaymentAdvanceVisibility(db);await db.exec('reset role');
 baselineMetadata=await metadata();assert.deepEqual(baselineMetadata.map(row=>row.md5),expectedBefore);
 baselineDefinitions=await Promise.all(supplierPaymentAdvanceVisibilityTargets.map(signature=>q('select pg_get_functiondef($1::regprocedure)d',[signature])));
 baselineUnchanged=await otherSources();baselineData=await snapshot();
 await db.exec('begin');try{
  const source=await seedSupplierAdvanceSource(db,{amount:15000,rate:1,currencyId:1,date:'2026-10-10'});
  reproducedHidden=!(await list()).some(row=>row.id===source.sourceLineId);
  await deniedRun(()=>seedSupplierAdvanceApplication(db,source,{amount:5000,paymentRate:1,invoiceRate:1}),'55000');reproducedDenial=true;
 }finally{await db.exec('rollback;reset role');}
 migration=(await readFile(new URL('../supabase/migrations/20261108220513_allow_supplier_account_115004_advances.sql',import.meta.url),'utf8')).replace(/\r\n/g,'\n');
 await applySupplierPaymentAdvanceVisibility(db);
});
after(()=>db.close());

test('the reproduced 15000 JMD advance outside the legacy group is visible with its existing API shape after only the account predicate changes',async t=>{
 await tx(t);assert.equal(reproducedHidden,true);assert.equal(reproducedDenial,true);
 const source=await seedSupplierAdvanceSource(db,{amount:15000,rate:1,currencyId:1,date:'2026-10-10'});
 const row=(await list()).find(row=>row.id===source.sourceLineId);
 assert.ok(row);assert.equal(row.original,15000);assert.equal(row.used,0);assert.equal(row.available,15000);assert.equal(row.currencyCode,'JMD');assert.equal(row.accountId,601);assert.equal(row.supplierId,10);
 const group=await ownerRead(()=>q('select g.group_name d from chart_accounts a join account_group g on g.group_id=a.account_group_id where account_id=601'));
 assert.equal(group,'Otras Cuentas por Cobrar');
});

test('partial and full real applications consume only the available advance, leave zero net cash and retain balanced native/local GL',async t=>{
 await tx(t);const source=await seedSupplierAdvanceSource(db,{amount:15000,rate:1,currencyId:1});
 const bankBefore=await ownerRead(()=>q('select balance d from bank_account where bank_account_id=1'));
 const partial=await seedSupplierAdvanceApplication(db,source,{amount:5000,paymentRate:1,invoiceRate:1});
 assert.equal(partial.payment.cashTotal,0);assert.equal(partial.payment.advanceTotal,5000);await balanced(partial.payment);
 assert.deepEqual(await ownerRead(()=>sourceBalance(source)),[10000,10000]);
 assert.equal((await list()).find(row=>row.id===source.sourceLineId).available,10000);
 const full=await seedSupplierAdvanceApplication(db,source,{amount:10000,paymentRate:1,invoiceRate:1});
 assert.equal(full.payment.cashTotal,0);await balanced(full.payment);
 assert.deepEqual(await ownerRead(()=>sourceBalance(source)),[0,0]);
 assert.equal((await list()).some(row=>row.id===source.sourceLineId),false);
 assert.equal(await ownerRead(()=>q('select balance d from bank_account where bank_account_id=1')),bankBefore);
 const before=await ownerRead(snapshot);
 await deniedRun(()=>seedSupplierAdvanceApplication(db,source,{amount:1,paymentRate:1,invoiceRate:1}),'55000');
 assert.deepEqual(await ownerRead(snapshot),before);
});

test('115004 outside the legacy group keeps historical FX amounts when a USD advance is applied at a different payment rate',async t=>{
 await tx(t);const source=await seedSupplierAdvanceSource(db,{amount:100,rate:150,currencyId:2});
 const applied=await seedSupplierAdvanceApplication(db,source,{amount:30,paymentRate:170,invoiceRate:160});
 assert.equal(applied.payment.cashTotal,0);await balanced(applied.payment);
 assert.deepEqual(await ownerRead(()=>sourceBalance(source)),[10500,70]);
 const credit=await ownerRead(()=>q('select jsonb_build_array(sum(credit_amount),sum(credit_fx))d from gl_impact where account_id=601 and transaction_id=(select transaction_id from supplier_payment where payment_id=$1)',[applied.payment.id]));
 assert.deepEqual(credit,[4500,30]);assert.equal((await list()).find(row=>row.id===source.sourceLineId).available,70);
});

test('prepaid-expense descendants and unrelated receivables are both invisible and cannot be applied as supplier advances',async t=>{
 await tx(t);const legacy=await seedSupplierAdvanceSource(db,{accountId:602,amount:100,rate:1,currencyId:1});
 const unrelated=await seedSupplierAdvanceSource(db,{accountId:603,amount:100,rate:1,currencyId:1});
 const rows=await list();assert.equal(rows.some(row=>row.id===legacy.sourceLineId),false);assert.equal(rows.some(row=>row.id===unrelated.sourceLineId),false);
 const before=await ownerRead(snapshot);await deniedRun(()=>seedSupplierAdvanceApplication(db,unrelated,{amount:10,paymentRate:1,invoiceRate:1}),'55000');assert.deepEqual(await ownerRead(snapshot),before);
 await deniedRun(()=>seedSupplierAdvanceApplication(db,legacy,{amount:10,paymentRate:1,invoiceRate:1}),'55000');
 assert.deepEqual(await ownerRead(snapshot),before);
});

test('wrong supplier or currency, over-application, reversed source and inactive accounts remain rejected without financial side effects',async t=>{
 await tx(t);const source=await seedSupplierAdvanceSource(db,{amount:100,rate:1,currencyId:1});
 const before=await ownerRead(snapshot);
 await deniedRun(()=>seedSupplierAdvanceApplication(db,{...source,supplierId:20},{amount:10,paymentRate:1,invoiceRate:1}),'42501');
 await deniedRun(()=>seedSupplierAdvanceApplication(db,{...source,currencyId:2},{amount:10,paymentRate:170,invoiceRate:160}),'42501');
 await deniedRun(()=>seedSupplierAdvanceApplication(db,source,{amount:101,paymentRate:1,invoiceRate:1}),'55000');
 assert.deepEqual(await ownerRead(snapshot),before);
 await db.exec("reset role;savepoint inactive;update chart_accounts set is_inactive=true where account_id=601");await assumeSecurityUser(db);
 await deniedRun(()=>seedSupplierAdvanceApplication(db,source,{amount:10,paymentRate:1,invoiceRate:1}),'42501');
 await db.exec('reset role;rollback to inactive;release inactive;savepoint reversed');
 await db.query("update journal set status='ANULADO'where journal_id=$1",[source.journalId]);await assumeSecurityUser(db);
 assert.equal((await list()).some(row=>row.id===source.sourceLineId),false);
 await deniedRun(()=>seedSupplierAdvanceApplication(db,source,{amount:10,paymentRate:1,invoiceRate:1}),'42501');
 await db.exec('reset role;rollback to reversed;release reversed');await assumeSecurityUser(db);
 assert.deepEqual(await ownerRead(snapshot),before);
});

test('public authentication, role and company boundaries remain authoritative and private engines do not become callable by clients',async t=>{
 await tx(t);const source=await seedSupplierAdvanceSource(db,{amount:100,rate:1,currencyId:1});
 for(const role of['anon','service_role']){await assumeSqlRole(db,role);await deniedSql(db,'select supplier_available_advances()');}
 await assumeSecurityUser(db);for(const target of supplierPaymentAdvanceVisibilityTargets)await deniedSql(db,'select '+target.replace('jsonb,bigint,bigint',"'{}'::jsonb,null::bigint,null::bigint").replace('jsonb,bigint',"'{}'::jsonb,null::bigint"));
 await assumeSecurityUser(db,1,1,2);assert.equal((await list()).some(row=>row.id===source.sourceLineId),false);
 await deniedSql(db,'select save_supplier_payment_with_advances($1,null)',[{supplier_id:10,account_id:1,date:'2026-10-31',period_id:10,rate:1,applications:[{invoice_id:1,amount:10}],advances:[{advanceLineId:source.sourceLineId,amount:10}]}]);
});

test('exact three function attributes and every financial row remain unchanged while wrappers and historical FX engines keep their original bodies',async t=>{
 await tx(t);await db.exec('reset role');
 const current=await metadata();assert.deepEqual(current.map(({md5,...row})=>row),baselineMetadata.map(({md5,...row})=>row));
 assert.ok(current.every((row,index)=>row.md5!==baselineMetadata[index].md5));
 assert.deepEqual(await otherSources(),baselineUnchanged);assert.deepEqual(await snapshot(),baselineData);
});

test('unexpected source drift aborts the complete guarded patch without leaving the earlier functions partially replaced',async t=>{
 await tx(t);await db.exec('reset role');
 for(const definition of baselineDefinitions)await db.exec(definition);
 // The listing is deliberately the last target in the migration. Its drift
 // must roll back the first two replacements as well, not leave a partial fix.
 assert.equal(baselineDefinitions[0].split('with recursive advance_groups as(').length,2);
 await db.exec(baselineDefinitions[0].replace('with recursive advance_groups as(','/* synthetic late source drift */with recursive advance_groups as('));
 const before=await metadata();await db.exec('savepoint guarded_replay');
 try{await assert.rejects(db.exec(migration),error=>/Unexpected supplier advance eligibility source/.test(error.message));}
 finally{await db.exec('rollback to guarded_replay;release guarded_replay');}
 assert.deepEqual(await metadata(),before);
});
