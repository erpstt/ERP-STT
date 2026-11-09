import assert from 'node:assert/strict';
import {before,after,test} from 'node:test';
import {setupGeneralLedgerExport,applyGeneralLedgerExport,assumeGeneralLedgerUser,seedGeneralLedgerExportVolume} from './fixtures/setup-general-ledger-export.mjs';
const base={subsidiaryIds:[1],bookId:1,dateFrom:'2026-09-01',dateTo:'2026-09-30'};
let db;
const snapshot=async(filters={})=>(await db.query('select public.run_general_ledger_export($1)data',[{...base,...filters}])).rows[0].data;
const page=async(filters={})=>(await db.query('select public.run_accounting_report($1,$2)data',['general-ledger',{...base,page:1,pageSize:500,...filters}])).rows[0].data;
async function rejected(sql,args=[],code){await db.exec('savepoint expected_denial');try{await assert.rejects(db.query(sql,args),e=>!code||e.code===code);}finally{await db.exec('rollback to savepoint expected_denial;release savepoint expected_denial');}}
async function tx(t){await db.exec('reset role;begin');t.after(()=>db.exec('rollback;reset role'));await assumeGeneralLedgerUser(db);}
const functions=async()=>(await db.query("select p.oid,n.nspname||'.'||p.proname signature,p.proowner,p.proacl::text,p.proconfig,p.prosecdef,p.provolatile,p.proisstrict,p.proparallel,md5(p.prosrc)hash from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname in('public','report_template_private','report_delivery_private')order by p.oid")).rows;
async function stored(){const rows=(await db.query("select tablename from pg_tables where schemaname='public'order by tablename")).rows,out=[];for(const {tablename}of rows)out.push({table:tablename,...(await db.query('select count(*)count,md5(coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text),\'[]\')::text)hash from public.\"'+tablename+'\" t')).rows[0]});return out;}
before(async()=>{({db}=await setupGeneralLedgerExport({apply:false}));});
after(()=>db.close());

test('installation adds two guarded read functions and preserves all existing functions, data and privileges',async()=>{
 await db.exec('reset role');const old=await functions(),data=await stored();await applyGeneralLedgerExport(db);const current=await functions();
 assert.deepEqual(current.filter(f=>old.some(o=>o.oid===f.oid)),old);assert.equal(current.length-old.length,2);assert.deepEqual(await stored(),data);
 const acl=(await db.query("select n.nspname,p.proname,p.prosecdef,p.provolatile,p.proconfig,has_function_privilege('anon',p.oid,'execute')anon,has_function_privilege('authenticated',p.oid,'execute')auth,has_function_privilege('service_role',p.oid,'execute')service,exists(select 1 from aclexplode(p.proacl)a where a.grantee=0)pub from pg_proc p join pg_namespace n on n.oid=p.pronamespace where p.proname in('run_general_ledger_export','general_ledger_export_rows')order by n.nspname")).rows;
 assert.equal(acl.length,2);for(const f of acl){assert.equal(f.anon,false);assert.equal(f.service,false);assert.equal(f.pub,false);assert.equal(f.auth,f.nspname==='public');assert.equal(f.prosecdef,f.nspname==='public');assert.equal(f.provolatile,'s');assert.deepEqual(f.proconfig,['search_path=pg_catalog, public, pg_temp']);}
});

test('one snapshot contains over 500 rows and exactly equals all canonical pages including official running and account totals',async t=>{
 await tx(t);await seedGeneralLedgerExportVolume(db,{count:1200});await assumeGeneralLedgerUser(db);
 const full=await snapshot(),first=await page(),all=[...first.rows];assert.ok(full.total>1200);assert.equal(first.rows.length,500);
 for(let n=2;all.length<first.total;n++)all.push(...(await page({page:n})).rows);
 assert.equal(full.total,full.rows.length);assert.deepEqual(full.rows,all);assert.equal(new Set(full.rows.map(r=>r.id)).size,full.total);
 await db.exec('reset role');const direct=(await db.query('select sum(debit_amount)::float debit,sum(credit_amount)::float credit from gl_impact where subsidiary_id=1 and accounting_book_id=1 and posting_date between $1 and $2',[base.dateFrom,base.dateTo])).rows[0];
 assert.ok(Math.abs(full.summary.debit-direct.debit)<0.000001);assert.ok(Math.abs(full.summary.credit-direct.credit)<0.000001);assert.notDeepEqual(full.summary,first.summary,'The old page summary is not the complete export summary');
});

test('four original currency fields retain historical precision, zero, NULL, opening trace and reversal semantics',async t=>{
 await tx(t);const legacy=await page(),full=await snapshot();assert.deepEqual(full.rows,legacy.rows);
 const find=label=>full.rows.find(r=>r.transaction_number==='SYN-'+label);
 assert.equal(find('PRECISION').original_exchange_rate,3.123456789012);assert.equal(find('PRECISION').original_credit,1.234299);
 assert.equal(find('FOREIGN-ZERO').original_credit,0);assert.equal(find('FOREIGN-NULL').original_credit,null);
 assert.equal(find('OPENING-REVERSAL').original_debit,20);assert.equal(find('OPENING-REVERSAL').original_exchange_rate,5);
});

test('current transfer_original bank-leg proof is preserved rather than replaced by the older currency calculation',async t=>{
 await tx(t);await db.exec(`reset role;
  insert into bank_account values(1,1,1,2),(2,1,2,1);
  insert into "transaction"values(900,'SYN-TRANSFER',1,null,null,1,1);
  insert into journal(journal_id,transaction_id,journal_number,subsidiary_id,memo,is_opening_balance,currency_id,exchange_rate,journal_date,journal_type)values(900,900,'SYN-TRANSFER-J',1,'Transfer',false,1,1,'2026-09-30','Transferencia bancaria');
  insert into bank_transfer values(900,900,1,1,2,10,50,1,5,50,50,1);
  insert into bank_transaction values(900,1,'TRF_BAN',-11),(900,2,'TRF_BAN',50);
  insert into gl_impact values(900,900,1,1,1,1,0,55,0,55,'2026-09-30',1,null);
 `);await assumeGeneralLedgerUser(db);const actual=(await snapshot()).rows.find(r=>r.id===900),legacy=(await page()).rows.find(r=>r.id===900);
 assert.deepEqual(actual,legacy);assert.equal(actual.original_currency_code,'USD');assert.equal(actual.original_exchange_rate,5);assert.equal(actual.original_credit,11);assert.equal(actual.credit,55);
});

test('account ranges, specific accounts, entity and cost-center filters exactly match the published selection',async t=>{
 await tx(t);
 for(const filters of [{accountId:1},{accountIds:[2]},{accountFrom:'110001',accountTo:'110001'},{entityType:'Cliente',entityId:31},{costCenterId:69},{entityType:'Proveedor',entityId:81},{accountId:999}])assert.deepEqual((await snapshot(filters)).rows,(await page(filters)).rows);
});

test('opening and final balances use the current full-period formula and no export page controls',async t=>{
 await tx(t);await db.exec("reset role;insert into gl_impact values(700,200,1,1,1,1,10,0,2,0,'2026-08-31',2,null)");await assumeGeneralLedgerUser(db);
 const full=await snapshot({accountId:1}),legacy=await page({accountId:1});assert.deepEqual(full.rows,legacy.rows);assert.ok(full.rows.every(r=>r.opening_balance===-10));
 const ignored=await snapshot({accountId:1,page:2147483647,pageSize:1});assert.deepEqual(ignored.rows,full.rows);assert.equal(ignored.snapshotFingerprint,full.snapshotFingerprint);
});

test('book NULL retains all books while explicit books preserve native values and exact book metadata',async t=>{
 await tx(t);await db.exec('reset role;insert into gl_impact select 700,transaction_id,account_id,subsidiary_id,fiscal_period_id,10,debit_amount,credit_amount,debit_fx,credit_fx,posting_date,original_currency_id,opening_balance_line_id from gl_impact where gl_impact_id=200');await assumeGeneralLedgerUser(db);
 for(const bookId of [null,1,10]){const full=await snapshot({bookId});assert.deepEqual(full.rows,(await page({bookId})).rows);assert.equal(full.context.bookId,bookId);assert.equal(full.context.book?.id??null,bookId);}
 assert.equal((await snapshot({bookId:null})).total,(await snapshot({bookId:1})).total+1);
 await rejected('select public.run_general_ledger_export($1)',[{...base,bookId:2}],'42501');
});

test('authorized non-active subsidiary is allowed, multi-company and foreign-company requests are denied',async t=>{
 await tx(t);await rejected('select public.run_general_ledger_export($1)',[{...base,subsidiaryIds:[2]}]);
 await rejected('select public.run_general_ledger_export($1)',[{...base,subsidiaryIds:[1,2]}],'22023');
 await db.exec('reset role;insert into user_subsidiaries values(1,2)');await assumeGeneralLedgerUser(db,{sid:1});const selected=await snapshot({subsidiaryIds:[2],bookId:null});assert.equal(selected.context.subsidiary.id,2);assert.equal(selected.context.subsidiary.name,'Foreign company');assert.equal(selected.total,0);
});

test('empty results are complete and trusted metadata/fingerprint are stable across generatedAt and change for compensated values',async t=>{
 await tx(t);const empty=await snapshot({accountId:999});assert.deepEqual(empty.rows,[]);assert.equal(empty.total,0);assert.deepEqual(empty.summary,{debit:0,credit:0});assert.match(empty.snapshotFingerprint,/^[a-f0-9]{32}$/);
 const first=await snapshot(),second=await snapshot();assert.equal(first.snapshotFingerprint,second.snapshotFingerprint);assert.deepEqual(first.context.filters,{...base,accountId:null,accountIds:[],accountFrom:null,accountTo:null,entityType:null,entityId:null,costCenterId:null});
 await db.exec("reset role;update journal_line set note='Changed source note' where journal_line_id=200");await assumeGeneralLedgerUser(db);const changed=await snapshot();assert.deepEqual(changed.summary,first.summary);assert.notEqual(changed.snapshotFingerprint,first.snapshotFingerprint);
 await db.exec('reset role;update gl_impact set credit_amount=credit_amount+1 where gl_impact_id=200;update gl_impact set credit_amount=credit_amount-1 where gl_impact_id=201');await assumeGeneralLedgerUser(db);const compensated=await snapshot();assert.deepEqual(compensated.summary,changed.summary);assert.notEqual(compensated.snapshotFingerprint,changed.snapshotFingerprint);
});

test('public report VIEW and private helper ACL are enforced before any export context is disclosed',async t=>{
 await tx(t);await assumeGeneralLedgerUser(db,{role:20});await rejected('select public.run_general_ledger_export($1)',[base],'42501');await assumeGeneralLedgerUser(db);
 await rejected('select report_delivery_private.general_ledger_export_rows($1)',[base],'42501');
 await db.exec('reset role;set role anon');await rejected('select public.run_general_ledger_export($1)',[base],'42501');
 await db.exec('reset role;set role service_role');await rejected('select public.run_general_ledger_export($1)',[base],'42501');
});

test('source drift aborts installation before any new export function is added',async()=>{
 const isolated=await setupGeneralLedgerExport({apply:false});try{await isolated.db.exec("reset role;create or replace function report_delivery_private.run_accounting_report(p_report text,p_filters jsonb default'{}')returns jsonb language sql stable as $$select '{}'::jsonb$$");await assert.rejects(applyGeneralLedgerExport(isolated.db),/Unexpected complete ledger export dependency/);assert.equal((await isolated.db.query("select to_regprocedure('public.run_general_ledger_export(jsonb)') public_export,to_regprocedure('report_delivery_private.general_ledger_export_rows(jsonb)') private_export")).rows[0].public_export,null);}finally{await isolated.db.close();}
});
