import assert from 'node:assert/strict';
import {before,after,test} from 'node:test';
import {PGlite} from '@electric-sql/pglite';
import {setupOpeningSupplierPaymentTransaction,applyOpeningSupplierTransaction,seedImportedOpening} from './fixtures/setup-opening-supplier-payment-transaction.mjs';
import {assertIsolatedTestArgs} from './lib/migration-preview.mjs';
assertIsolatedTestArgs();
const db=new PGlite();let oldDefinition,metadataBefore,wrappersBefore;
const target='supplier_payment_private.invoice_basis(bigint,bigint)';
const q=async(sql,p=[])=>(await db.query(sql,p)).rows[0]?.d;
async function assume(){await db.exec("reset role;insert into user_role_sessions values('fixture',1,1)on conflict(session_id)do update set user_id=1,role_id=1;insert into user_company_sessions values('fixture',1,1)on conflict(session_id)do update set user_id=1,subsidiary_id=1");await db.query("select set_config('request.jwt.claims',$1,false)",[JSON.stringify({sub:'00000000-0000-0000-0000-000000000001',session_id:'fixture'})]);await db.exec('set role authenticated');}
async function tx(t){await db.exec('reset role;begin');t.after(()=>db.exec('rollback;reset role'));}
const payload=(i,rate=i.rate)=>({supplier_id:10,account_id:i.bankId,date:'2026-10-31',period_id:10,location_id:1,rate,reference:'SYN-NULL-TX',memo:'Synthetic imported opening settlement',applications:[{invoice_id:i.invoiceId,amount:i.amount}],advances:[]});
const save=p=>q('select save_supplier_payment_with_advances($1,null)d',[p]);
async function denied(p){await db.exec('savepoint rejection');try{await assert.rejects(save(p),e=>e.code==='55000');}finally{await db.exec('rollback to rejection;release rejection');}}
const history=i=>q(`select jsonb_build_object('invoices',(select jsonb_agg(to_jsonb(x)order by invoice_id)from supplier_invoice x where journal_id=$1),'journal',(select to_jsonb(x)from journal x where journal_id=$1),'lines',(select jsonb_agg(to_jsonb(x)order by journal_line_id)from journal_line x where journal_id=$1),'gl',(select jsonb_agg(to_jsonb(x)order by gl_impact_id)from gl_impact x where transaction_id=$2))d`,[i.journalId,i.transactionId]);
const metadata=async()=>(await db.query('select oid,proowner,proacl::text,proconfig,provolatile,prosecdef,proisstrict,proparallel from pg_proc where oid=$1::regprocedure',[target])).rows;
const wrappers=async()=>(await db.query("select oid,md5(prosrc)md5 from pg_proc where oid<>$1::regprocedure and pronamespace in('public'::regnamespace,'supplier_payment_private'::regnamespace)order by oid",[target])).rows;
before(async()=>{await setupOpeningSupplierPaymentTransaction(db);oldDefinition=await q('select pg_get_functiondef($1::regprocedure)d',[target]);metadataBefore=await metadata();wrappersBefore=await wrappers();await applyOpeningSupplierTransaction(db);});
after(()=>db.close());
for(const[currencyId,rate,paymentRate]of[[1,1,1],[2,160,170]])test(`${currencyId===1?'local':'foreign'} imported opening with NULL invoice transaction settles through the real engine without rewriting shared source`,async t=>{
 await tx(t);const i=await seedImportedOpening(db,{currencyId,rate});const before=await history(i);assert.equal(before.invoices.length,2);assert.ok(before.invoices.every(x=>x.transaction_id===null));
 // Reproduce the published helper's rejection using the actual import INSERT.
 await db.exec(oldDefinition);await assume();await denied(payload(i,paymentRate));await db.exec('reset role');await applyOpeningSupplierTransaction(db);await assume();
 const result=await save(payload(i,paymentRate));await db.exec('reset role');assert.deepEqual(await history(i),before);
 const impacts=(await db.query('select account_id,debit_amount::float8 debit,credit_amount::float8 credit,debit_fx::float8 debit_fx,credit_fx::float8 credit_fx,original_currency_id from gl_impact where transaction_id=(select transaction_id from supplier_payment where payment_id=$1)order by account_id',[result.id])).rows;
 const ap=impacts.find(x=>x.account_id===301);assert.equal(ap.debit,i.amount*rate);assert.equal(ap.debit_fx,i.amount);assert.equal(ap.original_currency_id,currencyId);
 assert.equal(await q('select (credit_amount-$2::numeric)::float8 d from gl_impact where transaction_id=$1 and opening_balance_line_id=42',[i.transactionId,ap.debit]),0);
 assert.equal(impacts.reduce((s,x)=>s+x.debit-x.credit,0),0);
 if(currencyId===2)assert.equal(impacts.find(x=>x.account_id===702).debit,1000);else assert.ok(!impacts.some(x=>[701,702].includes(x.account_id)));
 assert.deepEqual(await metadata(),metadataBefore);assert.deepEqual(await wrappers(),wrappersBefore);
});
test('wrong non-NULL transaction, missing opening keys, ordinary NULL transaction and foreign-company journal remain denied atomically',async t=>{
 await tx(t);const i=await seedImportedOpening(db);const before=await history(i);const other=(await db.query('insert into "transaction"(tran_number,tran_date,transaction_type_id,subsidiary_id,currency_id,exchange_rate,fiscal_period_id,total_amount)values(\'SYN-OTHER-TX\',\'2026-10-31\',2,1,1,1,10,100)returning transaction_id')).rows[0].transaction_id;
 const variants=[['update supplier_invoice set transaction_id=$2 where invoice_id=$1',[i.invoiceId,other]],['update supplier_invoice set opening_balance_line_id=null where invoice_id=$1',[i.invoiceId]],['update supplier_invoice set opening_run_id=null where invoice_id=$1',[i.invoiceId]],['update supplier_invoice set is_opening_balance=false where invoice_id=$1',[i.invoiceId]],['update "transaction"set subsidiary_id=2 where transaction_id=$1',[i.transactionId]]];
 for(const[sql,args]of variants){await db.exec('reset role;savepoint variant');await db.query(sql,args);await assume();await denied(payload(i));await db.exec('rollback to variant;release variant');}
 await db.exec('reset role');assert.deepEqual(await history(i),before);assert.equal(await q('select count(*)d from supplier_payment'),0);assert.equal(await q('select balance::float8 d from bank_account where bank_account_id=1'),1000);
});
