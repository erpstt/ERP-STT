import assert from 'node:assert/strict';
import {before,after,test} from 'node:test';
import {PGlite} from '@electric-sql/pglite';
import {setupScheduledPresentation,applyScheduledPresentation} from './fixtures/setup-financial-presentation-scheduled.mjs';
import {assertIsolatedTestArgs} from './lib/migration-preview.mjs';
assertIsolatedTestArgs();
const db=new PGlite();
let baseline,metadataBefore,balancesBefore;
const metadata=async()=>(await db.query("select oid,proowner,proacl::text,proconfig,provolatile,prosecdef,proisstrict,proparallel from pg_proc where proname in('scheduled_report_validate_options','scheduled_report_manage','scheduled_report_snapshot_v2')order by oid")).rows;
async function assume(role='authenticated',email='one@example.invalid',sid=1,activeRole=10){
 await db.exec('reset role');
 await db.query("select set_config('request.jwt.claims',$1,false),set_config('fixture.sid',$2,false),set_config('fixture.role',$3,false)",[JSON.stringify({role,email}),String(sid),String(activeRole)]);
 await db.exec('set role '+role);
}
async function tx(t){await db.exec('reset role;begin');t.after(()=>db.exec('rollback;reset role'));await assume();}
const snapshot=async(kind='balance-sheet',options={},sid=1,owner=null)=>(await db.query('select scheduled_report_snapshot_v2($1,$2,$3,$4,$5)d',[sid,kind,'2026-10-31',options,owner])).rows[0].d;
const save=async(options={},report='balance-sheet')=>(await db.query("select scheduled_report_manage('save',$1)d",[{name:'Synthetic report',report,reportOptions:options}])).rows[0].d;
async function denied(action,match){await db.exec('savepoint rejected');try{await assert.rejects(action,match);}finally{await db.exec('rollback to savepoint rejected;release savepoint rejected');}}
before(async()=>{
 await setupScheduledPresentation(db);await assume();baseline=await snapshot();
 await db.exec('reset role');metadataBefore=await metadata();balancesBefore=(await db.query('select * from synthetic_balances')).rows;
 await applyScheduledPresentation(db);
});
after(()=>db.close());
test('SAVE preserves an explicitly selected currency and leaves absent options shape unchanged',async t=>{
 await tx(t);for(const currency of ['USD','LOCAL'])assert.equal((await save({presentationCurrency:currency,bookId:1})).report_options.presentationCurrency,currency);
 assert.deepEqual((await save({bookId:1})).report_options,{bookId:1,bankAccountId:null});
});
test('missing currency and explicit LOCAL preserve existing financial snapshot and currency',async t=>{
 await tx(t);assert.deepEqual(await snapshot(),baseline);assert.deepEqual(await snapshot('balance-sheet',{presentationCurrency:'LOCAL'}),baseline);
 assert.equal((await snapshot('cash-flow')).currency,'JMD');
});
test('USD routes both states to the private calculator with source filters and actual JWT actor',async t=>{
 await tx(t);for(const kind of ['balance-sheet','income-statement']){
  const value=await snapshot(kind,{presentationCurrency:'USD',bookId:1},1,4);
  assert.equal(value.currency,'USD');assert.equal(value.data.presentationCurrencyCode,'USD');assert.equal(value.data.receivedOwner,1);
  assert.deepEqual(value.data.receivedFilters.subsidiaryIds,[1]);assert.equal(value.data.receivedFilters.presentationCurrency,'USD');assert.equal(value.data.receivedFilters.bookId,1);
 }
});
test('worker USD preserves validated owner identity and restores JWT claims after success',async t=>{
 await tx(t);await assume('service_role','worker@example.invalid');const before=(await db.query("select current_setting('request.jwt.claims')v")).rows[0].v;
 const value=await snapshot('income-statement',{presentationCurrency:'USD'},1,4);assert.equal(value.data.receivedOwner,4);assert.equal(value.currency,'USD');
 assert.equal((await db.query("select current_setting('request.jwt.claims')v")).rows[0].v,before);
});
test('worker missing, inactive or foreign owner is rejected before presentation calculation',async t=>{
 await tx(t);await assume('service_role','worker@example.invalid');
 for(const owner of [null,2,3])await denied(()=>snapshot('balance-sheet',{presentationCurrency:'USD'},1,owner),/propietario/);
});
test('invalid currencies, unsupported USD reports and foreign accounting books are rejected',async t=>{
 await tx(t);for(const currency of ['EUR','usd','',123,{},[]])await denied(()=>save({presentationCurrency:currency}),/moneda local o USD/);
 await denied(()=>save({presentationCurrency:'USD'},'general-ledger'),/presentación en USD/);
 await denied(()=>snapshot('cash-flow',{presentationCurrency:'USD'}),/presentación en USD/);
 await denied(()=>snapshot('balance-sheet',{presentationCurrency:'USD',bookId:2}),/libro no pertenece/);
});
test('anonymous, unauthorized role, foreign company and direct private helper remain denied',async t=>{
 await tx(t);await assume('anon');await denied(()=>snapshot(),e=>e.code==='42501');
 await assume('authenticated','one@example.invalid',1,99);await denied(()=>snapshot(),e=>e.code==='42501');
 await assume();await denied(()=>snapshot('balance-sheet',{presentationCurrency:'USD'},2),/Sociedad no autorizada/);
 await denied(()=>db.query("select report_delivery_private.run_financial_statement_presentation('balance-sheet','{}',1)"),e=>e.code==='42501');
});
test('conversion errors restore worker claims and never return a local report labelled USD',async t=>{
 await tx(t);await assume('service_role','worker@example.invalid');await db.query("select set_config('fixture.fail','true',true)");
 const before=(await db.query("select current_setting('request.jwt.claims')v")).rows[0].v;
 await denied(()=>snapshot('balance-sheet',{presentationCurrency:'USD'},1,1),/Synthetic conversion failure/);
 assert.equal((await db.query("select current_setting('request.jwt.claims')v")).rows[0].v,before);
});
test('migration retains all target metadata and writes no saved schedule or balance',async t=>{
 await tx(t);await db.exec('reset role');assert.deepEqual(await metadata(),metadataBefore);assert.deepEqual((await db.query('select * from synthetic_balances')).rows,balancesBefore);assert.equal((await db.query('select count(*)::int n from scheduled_reports')).rows[0].n,0);
});
test('source drift aborts before any scheduled function changes',async()=>{
 const isolated=new PGlite();try{await setupScheduledPresentation(isolated);await isolated.exec("create or replace function scheduled_report_validate_options(p_sid bigint,p_kind text,p_options jsonb)returns void language plpgsql stable security definer set search_path=public,pg_temp as $$begin return;end$$");
 const before=(await isolated.query("select oid,md5(prosrc)hash from pg_proc where proname in('scheduled_report_validate_options','scheduled_report_manage','scheduled_report_snapshot_v2')order by oid")).rows;
 await assert.rejects(applyScheduledPresentation(isolated),/Unexpected scheduled report source/);
 assert.deepEqual((await isolated.query("select oid,md5(prosrc)hash from pg_proc where proname in('scheduled_report_validate_options','scheduled_report_manage','scheduled_report_snapshot_v2')order by oid")).rows,before);
 }finally{await isolated.close();}
});
