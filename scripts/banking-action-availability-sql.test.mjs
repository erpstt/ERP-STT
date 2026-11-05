import assert from 'node:assert/strict';
import {before,after,test} from 'node:test';
import {PGlite} from '@electric-sql/pglite';
import {setupBankingFunctional,applyBankingMigration} from './fixtures/setup-banking-functional.mjs';
import {assertIsolatedTestArgs} from './lib/migration-preview.mjs';
assertIsolatedTestArgs();
const db=new PGlite(),filters={dateFrom:'2026-10-01',dateTo:'2026-10-31'},kinds=['check','deposit','fee','transfer'];
const names={check:'bank_check',deposit:'bank_deposit',fee:'bank_fee',transfer:'bank_transfer'};
const q=async(sql,p=[])=>(await db.query(sql,p)).rows[0]?.d;
async function actor(role=1,sid=1,user=1){await db.exec('reset role');await db.query("insert into user_role_sessions values('fixture',$1,$2)on conflict(session_id)do update set user_id=$1,role_id=$2",[user,role]);await db.query("insert into user_company_sessions values('fixture',$1,$2)on conflict(session_id)do update set user_id=$1,subsidiary_id=$2",[user,sid]);await db.query("select set_config('request.jwt.claims',$1,false)",[JSON.stringify({sub:`00000000-0000-0000-0000-${String(user).padStart(12,'0')}`,session_id:'fixture'})]);await db.exec('set role authenticated');}
async function tx(t){await db.exec('reset role;begin');t.after(()=>db.exec('rollback;reset role'));await actor();}
async function denied(sql,p=[],code='42501'){await db.exec('savepoint denial');try{await assert.rejects(db.query(sql,p),e=>e.code===code);}finally{await db.exec('rollback to denial;release denial');}}
const reportName=kind=>kind==='transfer'?'run_bank_transfer_report':names[kind]+'_report';
const report=kind=>q(`select public.${reportName(kind)}($1)d`,[filters]);
const options=kind=>q(`select public.${names[kind]}_options()d`);
const actions={canEdit:true,canDelete:true},none={canEdit:false,canDelete:false};
const check={payment_type:'CHEQUE',bank_account_id:1,currency_id:1,exchange_rate:1,payment_date:'2026-10-10',fiscal_period_id:10,location_id:1,bank_reference:'SYN-ACTIONS',beneficiary:'Synthetic recipient',lines:[{amount:100,account_id:103}]};
const deposit={bank_account_id:1,currency_id:1,exchange_rate:1,deposit_date:'2026-10-10',fiscal_period_id:10,location_id:1,bank_reference:'SYN-ACTIONS',lines:[{amount:100,account_id:103,payment_method_id:1}]};
async function documents(){return{check:await q('select save_bank_check_transfer($1,null)d',[check]),deposit:await q('select save_bank_deposit($1)d',[deposit]),fee:await q('select save_bank_fee($1)d',[{bank_account_id:1,fee_date:'2026-10-10',amount:10,reference:'SYN-ACTIONS'}])};}
const targets=kinds.flatMap(kind=>[`public.${names[kind]}_options()`,`public.${reportName(kind)}(jsonb)`]);
const metadata=async()=>(await db.query('select oid,proowner,proacl::text,proconfig,provolatile,prosecdef,proisstrict,proparallel from pg_proc where oid in(select x::regprocedure from unnest($1::text[])x)order by oid',[targets])).rows;
let oldMeta,oldSources,oldOptions={};
before(async()=>{await setupBankingFunctional(db);await applyBankingMigration(db,'20261105185448_enforce_bank_base_currency_rate_and_check_location.sql');await actor();for(const kind of kinds)oldOptions[kind]=await options(kind);await db.exec('reset role');oldMeta=await metadata();oldSources=(await db.query("select oid,prosrc from pg_proc where pronamespace in('bank_check_private'::regnamespace,'bank_deposit_private'::regnamespace,'bank_fee_private'::regnamespace,'bank_transfer_private'::regnamespace)order by oid")).rows;await applyBankingMigration(db,'20261105190638_expose_banking_action_availability.sql');});
after(()=>db.close());

test('four option catalogs expose the common oracle permissions without changing their existing fields',async t=>{
 await tx(t);for(const role of[1,2,3]){await actor(role);for(const kind of kinds){const actual=await options(kind);assert.deepEqual(actual.access,{canView:true,canCreate:role!==3,canEdit:role===1&&kind!=='transfer',canDelete:role===1&&kind!=='transfer'});delete actual.access;assert.deepEqual(actual,oldOptions[kind]);}}
});

test('check options load a shared default location when the active company has no owned location',async t=>{
 await tx(t);await db.exec('reset role;update locations set subsidiary_id=2 where location_id=1;delete from location_subsidiaries where location_id=1 and subsidiary_id=1');
 const legacy=await q('select bank_check_private.bank_check_options()d');assert.equal(legacy.location,null);await actor();
 const shared=await options('check');assert.deepEqual(shared.location,{id:3,name:'Synthetic shared location'});delete shared.access;delete shared.location;delete legacy.location;assert.deepEqual(shared,legacy);
 const saved=await q('select save_bank_check_transfer($1,null)d',[{...check,location_id:3}]);assert.ok(saved.checkId);
 await db.exec("reset role;insert into locations(location_id,name,subsidiary_id)values(9,'Synthetic owned location',1)");const ownLegacy=await q('select bank_check_private.bank_check_options()d');await actor();const owned=await options('check');assert.deepEqual(owned.location,{id:9,name:'Synthetic owned location'});delete owned.access;assert.deepEqual(owned,ownLegacy);
 await db.exec('reset role;update locations set subsidiary_id=2 where location_id=9;delete from location_subsidiaries where location_id=3 and subsidiary_id=1');await actor();assert.equal((await options('check')).location,null);
});

test('authorized reports preserve every existing field and only annotate the currently returned rows',async t=>{
 await tx(t);await documents();await q('select create_bank_transfer($1)d',[{transferDate:'2026-10-10',sourceAccountId:1,destinationAccountId:2,sourceAmount:5,destinationAmount:5}]);
 for(const kind of kinds){const actual=await report(kind);assert.equal(actual.rows.length,1);assert.deepEqual(actual.rows[0]._actions,kind==='transfer'?none:actions);for(const row of actual.rows)delete row._actions;await db.exec('reset role');const baseline=await q(`select ${names[kind]}_private.${reportName(kind)}($1)d`,[filters]);assert.deepEqual(actual,baseline);await actor();}
});

test('reader and creator roles see documents while their unavailable edit/delete actions remain false',async t=>{
 await tx(t);const docs=await documents();for(const role of[2,3]){await actor(role);for(const kind of['check','deposit','fee'])assert.deepEqual((await report(kind)).rows[0]._actions,none);await denied('select delete_bank_check_transfer($1)',[docs.check.checkId]);await denied('select update_bank_deposit($1,$2)',[docs.deposit.depositId,deposit]);await denied('select delete_bank_fee($1)',[docs.fee.id]);}
});

test('closed periods and reconciled movements hide actions with the same existing writer blockers',async t=>{
 await tx(t);const docs=await documents();await db.exec('reset role;update fiscal_periods set gl_closed=true where fiscal_period_id=10');await actor();for(const kind of['check','deposit','fee'])assert.deepEqual((await report(kind)).rows[0]._actions,none);await denied('select delete_bank_check_transfer($1)',[docs.check.checkId],'55000');await denied('select delete_bank_deposit($1)',[docs.deposit.depositId],'55000');await denied('select delete_bank_fee($1)',[docs.fee.id],'55000');
 await db.exec("reset role;update fiscal_periods set gl_closed=false where fiscal_period_id=10;update bank_transaction set reconciliation_status='CONCILIADO'");await actor();for(const kind of['check','deposit','fee'])assert.deepEqual((await report(kind)).rows[0]._actions,none);await denied('select delete_bank_check_transfer($1)',[docs.check.checkId],'55000');await denied('select delete_bank_deposit($1)',[docs.deposit.depositId],'55000');await denied('select delete_bank_fee($1)',[docs.fee.id],'55000');
});

test('inconsistent source pointers and matched fees are not offered as editable records',async t=>{
 await tx(t);const docs=await documents();await db.exec('reset role');await db.query("update journal set journal_number='SYN-BROKEN' where journal_id=$1",[docs.check.journalId]);await db.query("update journal set status='BORRADOR' where journal_id=$1",[docs.deposit.journalId]);await db.query('insert into bank_reconciliation_match(bank_tran_id,statement_line_id)select bank_tran_id,1 from bank_transaction where transaction_id=(select transaction_id from bank_fee where fee_id=$1)',[docs.fee.id]);await actor();for(const kind of['check','deposit','fee'])assert.deepEqual((await report(kind)).rows[0]._actions,none);await denied('select delete_bank_check_transfer($1)',[docs.check.checkId]);await denied('select delete_bank_deposit($1)',[docs.deposit.depositId]);await denied('select delete_bank_fee($1)',[docs.fee.id],'55000');
});

test('admin access comes from the common oracle and never bypasses identity, active-role or company membership',async t=>{
 await tx(t);await actor(5,1,4);for(const kind of kinds)assert.deepEqual((await options(kind)).access,{canView:true,canCreate:true,canEdit:kind!=='transfer',canDelete:kind!=='transfer'});
 for(const[user,role,sid]of[[1,5,1],[2,4,1],[3,1,2]]){await actor(role,sid,user);for(const kind of kinds)await denied(`select public.${names[kind]}_options()`);}
 await db.exec('reset role;delete from user_subsidiaries where user_id=4 and subsidiary_id=1');await actor(5,1,4);for(const kind of kinds)await denied(`select public.${names[kind]}_options()`);
 for(const role of['anon','service_role']){await db.exec(`reset role;set role ${role}`);for(const kind of kinds)await denied(`select public.${names[kind]}_options()`);}
});

test('foreign fee create/edit/delete uses real GL posting, exact six-decimal originals and native balance restoration',async t=>{
 await tx(t);await db.exec("reset role;insert into exchange_rates values(2,1,'2026-10-10',160)");await actor();const p={bank_account_id:5,fee_date:'2026-10-10',amount:12.345678,reference:'SYN-FX-FEE'};const saved=await q('select save_bank_fee($1)d',[p]);await db.exec('reset role');let gl=(await db.query('select sum(debit_amount)::float8 debit,sum(credit_amount)::float8 credit,sum(debit_fx)::float8 debit_fx,sum(credit_fx)::float8 credit_fx from gl_impact where transaction_id=(select transaction_id from bank_fee where fee_id=$1)',[saved.id])).rows[0];assert.deepEqual(gl,{debit:1975.30848,credit:1975.30848,debit_fx:12.345678,credit_fx:12.345678});await actor();assert.deepEqual((await report('fee')).rows[0]._actions,actions);const edited=await q('select update_bank_fee($1,$2)d',[saved.id,{...p,amount:20}]);await q('select delete_bank_fee($1)d',[edited.id]);await db.exec('reset role');assert.equal(await q('select balance::float8 d from bank_account where bank_account_id=5'),1000);assert.equal(await q('select count(*)::int d from gl_impact where account_id in(103,105)'),0);
});

test('OID, ACL, fixed configuration and private posting engines are preserved, helper remains inaccessible and read-only',async t=>{
 await tx(t);await db.exec('reset role');assert.deepEqual(await metadata(),oldMeta);assert.deepEqual((await db.query("select oid,prosrc from pg_proc where pronamespace in('bank_check_private'::regnamespace,'bank_deposit_private'::regnamespace,'bank_fee_private'::regnamespace,'bank_transfer_private'::regnamespace)order by oid")).rows,oldSources);const helper=await q("select jsonb_build_object('volatility',provolatile,'definer',prosecdef,'source',prosrc)d from pg_proc where oid='banking_action_private.annotate_report(jsonb,text)'::regprocedure");assert.equal(helper.volatility,'s');assert.equal(helper.definer,false);assert.doesNotMatch(helper.source,/for\s+update|lock_source|\b(insert|update|delete)\s+(into|from|public\.)/i);for(const role of['authenticated','anon','service_role'])assert.equal(await q("select has_function_privilege($1,'banking_action_private.annotate_report(jsonb,text)','EXECUTE')d",[role]),false);
});
