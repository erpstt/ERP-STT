import assert from 'node:assert/strict';
import {before,after,test} from 'node:test';
import {setupBankReconciliationEmptyMonthClose,applyBankReconciliationEmptyMonthClose,seedEmptyMonthBaseline,assumeSecurityUser,assumeSqlRole,deniedSql} from './fixtures/setup-bank-reconciliation-empty-month-close.mjs';
import {assertIsolatedTestArgs} from './lib/migration-preview.mjs';
assertIsolatedTestArgs();

let db,beforeFunctions,beforeTables,preFix;
const modified=new Set(['close_bank_reconciliation(bigint,date,numeric)','run_bank_reconciliation_report(jsonb)','bank_reconciliation_options()']);
const financial=['bank_account','bank_transaction','bank_statement','bank_statement_line','bank_reconciliation_match','quadratic_bank_reconciliations','quadratic_reconciliation_items','quadratic_reconciliation_matches','transaction','journal','journal_line','gl_impact'];
const audit=['audit_log','change_log','event_log','deleted_records','activity_log'];
const q=async(sql,args=[])=>(await db.query(sql,args)).rows[0]?.d;
const report=(bank=2,cutoff='2026-10-31')=>q('select public.run_bank_reconciliation_report($1)d',[{bankAccountId:bank,dateFrom:cutoff.slice(0,7)+'-01',dateTo:cutoff,bankView:'WORKSPACE',page:1,pageSize:50}]);
const closingContext=async(bank=2,cutoff='2026-10-31')=>(await report(bank,cutoff)).closingContext;
const close=(bank=2,cutoff='2026-10-31',adjustment=0)=>q('select public.close_bank_reconciliation($1,$2,$3)d',[bank,cutoff,adjustment]);
const functions=()=>q("select jsonb_agg(jsonb_build_object('id',oid,'signature',oid::regprocedure::text,'owner',proowner,'acl',proacl::text,'config',proconfig,'definer',prosecdef,'volatility',provolatile,'md5',md5(prosrc))order by oid)d from pg_proc where pronamespace in('public'::regnamespace,'reconciliation_private'::regnamespace)");
async function rows(name){assert.match(name,/^[a-z_]+$/);return q('select coalesce(jsonb_agg(to_jsonb(r)order by to_jsonb(r)::text),\'[]\')d from public."'+name+'"r');}
async function snapshot(names=financial){const result={};for(const name of names)result[name]=await rows(name);return result;}
async function owner(fn){await db.exec('reset role');const result=await fn();await assumeSecurityUser(db);return result;}
async function tx(t){await db.exec('reset role;begin');t.after(async()=>{try{await db.exec('rollback');}finally{await db.exec('reset role');}});await assumeSecurityUser(db);}
async function rejects(run,code){await db.exec('savepoint denied_close');try{await assert.rejects(run,error=>{assert.equal(error.code,code);return true;});}finally{await db.exec('rollback to savepoint denied_close;release savepoint denied_close');}}
async function baseline(options){const result=await seedEmptyMonthBaseline(db,options);await assumeSecurityUser(db);return result;}
async function movement(amount,{date='2026-10-15',status='CONCILIADO',type='SYNTHETIC',reference='SYNTHETIC-EMPTY-MONTH',opening=false}={}){return owner(()=>q("insert into bank_transaction(bank_account_id,tran_date,value_date,amount,tran_type,reference_number,reconciliation_status,is_opening_balance)values(2,$1,$1,$2,$3,$4,$5,$6)returning bank_tran_id d",[date,amount,type,reference,status,opening]));}
async function exactStatement(amount=5399.02){return owner(()=>q("insert into bank_statement(statement_date,bank_account_id,opening_balance,closing_balance,source_file_name)values('2026-10-31',2,5399.02,$1,'synthetic-exact-current.csv')returning statement_id d",[amount]));}
async function storedClosed({balance=5399.02,books=balance,difference=0,date='2026-09-30',period=9,closedAt='2026-09-30T18:00:00Z',closedBy=1}={}){return owner(()=>q("insert into bank_reconciliation(reconciliation_date,bank_account_id,fiscal_period_id,status,book_balance,statement_balance,transit_payments,transit_deposits,bank_adjustments,difference,closed_at,closed_by)values($1,2,$2,'CERRADA',$3,$4,0,0,0,$5,$6,$7)returning reconciliation_id d",[date,period,books,balance,difference,closedAt,closedBy]));}

before(async()=>{
 const fixture=await setupBankReconciliationEmptyMonthClose({apply:false});db=fixture.db;
 await db.exec('begin');try{await baseline();const summary=(await report()).summary;await db.exec('savepoint old_close');let code;try{await close();}catch(error){code=error.code;}await db.exec('rollback to savepoint old_close;release savepoint old_close');preFix={summary,code,headers:await owner(()=>rows('bank_reconciliation'))};}finally{await db.exec('rollback;reset role');}
 beforeFunctions=await functions();beforeTables=await snapshot([...financial,'bank_reconciliation','fiscal_periods']);await applyBankReconciliationEmptyMonthClose(db);
});
after(()=>db?.close());

test('the prior-statement failure is reproduced on real old engines; migration changes only its three guarded wrappers and adds one private read helper',async t=>{
 await tx(t);assert.equal(preFix.summary.bookBalance,5399.02);assert.equal(preFix.summary.statementBalance,5399.02);assert.equal(preFix.code,'P0001');assert.equal(preFix.headers.length,0);
 await db.exec('reset role');const afterFunctions=await functions(),byId=new Map(afterFunctions.map(row=>[row.id,row]));assert.equal(afterFunctions.length,beforeFunctions.length+1);
 for(const old of beforeFunctions){const current=byId.get(old.id);assert.ok(current,'Preserve existing OID '+old.signature);if(modified.has(old.signature)){const{md5:oldMd5,...prior}=old,{md5:currentMd5,...present}=current;assert.notEqual(currentMd5,oldMd5);assert.deepEqual(present,prior);}else assert.deepEqual(current,old);}
 assert.deepEqual(await snapshot([...financial,'bank_reconciliation','fiscal_periods']),beforeTables);
 const helper=(await db.query("select prosecdef,provolatile,proconfig,has_function_privilege('anon',oid,'execute')anon,has_function_privilege('authenticated',oid,'execute')authenticated,has_function_privilege('service_role',oid,'execute')service from pg_proc where oid='reconciliation_private.bank_closing_context(bigint,date,numeric)'::regprocedure")).rows[0];assert.equal(helper.prosecdef,false);assert.equal(helper.provolatile,'v');assert.ok(helper.proconfig.includes('search_path=pg_catalog, public, pg_temp'));assert.equal(helper.anon,false);assert.equal(helper.authenticated,false);assert.equal(helper.service,false);
});

test('an empty October closes from its exact September statement without inventing a statement, match, bank movement or journal and records the real actor',async t=>{
 await tx(t);const source=await baseline(),prior=await owner(()=>snapshot([...financial,...audit]));const context=await closingContext();assert.equal(context.canClose,true);assert.equal(context.mode,'NO_MOVEMENTS');assert.equal(context.noMovements,true);assert.equal(context.sourceDate,'2026-09-30');assert.equal(context.sourceKind,'STATEMENT');assert.equal(context.sourceStatementId,source.statementId);assert.equal(Number(context.balance),5399.02);
 const headers=await q("select current_setting('request.headers',true)::jsonb d");await db.query("select set_config('request.headers',$1,true)",[JSON.stringify({...headers,'x-audit-actor-email':'forged@example.invalid','x-audit-actor-type':'AI_AGENT'})]);const id=await close();const current=await owner(()=>snapshot([...financial,...audit]));for(const name of financial)assert.deepEqual(current[name],prior[name],name);
 const header=await owner(()=>q('select to_jsonb(r)d from bank_reconciliation r where reconciliation_id=$1',[id]));assert.equal(header.status,'CERRADA');assert.equal(header.reconciliation_date,'2026-10-31');assert.equal(header.fiscal_period_id,10);assert.equal(Number(header.book_balance),5399.02);assert.equal(Number(header.statement_balance),5399.02);assert.equal(Number(header.difference),0);assert.equal(header.closed_by,1);assert.ok(header.closed_at);
 const events=current.event_log.filter(row=>!prior.event_log.some(old=>old.event_id===row.event_id));assert.equal(events.length,1);assert.equal(events[0].event_type,'BANK_RECONCILIATION_EMPTY_MONTH_CLOSE');assert.equal(events[0].actor_type,'HUMAN');assert.equal(events[0].created_by_email,'synthetic-1@example.invalid');assert.ok(current.audit_log.length>prior.audit_log.length);
 await rejects(()=>close(),'55000');
});

test('consecutive empty months use the immediately previous real closed reconciliation without fabricating statement history',async t=>{
 await tx(t);await baseline();const first=await close(),before=await owner(()=>snapshot());const context=await closingContext(2,'2026-11-30');assert.equal(context.canClose,true);assert.equal(context.mode,'NO_MOVEMENTS');assert.equal(context.sourceKind,'CLOSED_RECONCILIATION');assert.equal(context.sourceDate,'2026-10-31');assert.equal(context.sourceReconciliationId,first);const second=await close(2,'2026-11-30');assert.notEqual(second,first);assert.deepEqual(await owner(()=>snapshot()),before);assert.equal((await owner(()=>rows('bank_reconciliation'))).filter(row=>row.bank_account_id===2&&row.status==='CERRADA').length,2);
});

test('two agreeing prior sources are accepted while conflicting balances or an unverified closed predecessor fail closed',async t=>{
 await tx(t);await baseline();await storedClosed();let context=await closingContext();assert.equal(context.canClose,true);assert.equal(context.sourceKind,'STATEMENT_AND_CLOSED_RECONCILIATION');
 await db.exec('savepoint conflict;reset role');await db.exec("insert into bank_statement(statement_date,bank_account_id,opening_balance,closing_balance)values('2026-09-30',2,1,1)").then(()=>assert.fail('Duplicate statement should be unique'),error=>assert.equal(error.code,'23505'));await db.exec('rollback to savepoint conflict;release savepoint conflict');
 // A stored historical snapshot is intentionally inconsistent; protections are
 // never disabled and this is not an attempt to repair historical records.
 await db.exec('rollback;begin');await assumeSecurityUser(db);await baseline();await storedClosed({balance:5398.02});await assumeSecurityUser(db);context=await closingContext();assert.equal(context.canClose,false);await rejects(()=>close(),'PBN01');
 await db.exec('rollback;begin');await assumeSecurityUser(db);await baseline({withStatement:false});await storedClosed({closedAt:null});context=await closingContext();assert.equal(context.canClose,false);await rejects(()=>close(),'PBN01');
 for(const invalid of[{books:null},{difference:0.01},{books:5398.02}]){await db.exec('rollback;begin');await assumeSecurityUser(db);await baseline({withStatement:false});await storedClosed(invalid);context=await closingContext();assert.equal(context.canClose,false);await rejects(()=>close(),'PBN01');}
 await db.exec('rollback;begin');await assumeSecurityUser(db);await baseline({amount:5399.024,withStatement:false});await storedClosed({books:5399.024,balance:5399.02,difference:0.004});const verified=await report();context=verified.closingContext;assert.equal(context.canClose,true);assert.equal(context.sourceKind,'CLOSED_RECONCILIATION');assert.equal(verified.summary.statementBalance,context.balance);assert.equal(context.balance,5399.02);assert.equal(Number(verified.summary.difference),0.004);assert.equal(Number((Number(verified.summary.bookBalance)+Number(verified.summary.transitPayments)-Number(verified.summary.transitDeposits)-Number(verified.summary.statementBalance)).toFixed(6)),0.004);const sourceOnly=await owner(()=>snapshot());assert.equal(sourceOnly.bank_statement.filter(row=>row.bank_account_id===2).length,0);const carried=await close();assert.equal(Number(await owner(()=>q('select difference d from bank_reconciliation where reconciliation_id=$1',[carried]))),0.004);assert.deepEqual(await owner(()=>snapshot()),sourceOnly);
});

test('zero is a valid verified prior balance; missing, noncontiguous or non-month-end baselines are never replaced by implicit zero',async t=>{
 await tx(t);await baseline({amount:0});assert.equal((await closingContext()).canClose,true);assert.ok(await close());
 for(const options of[{withStatement:false},{date:'2026-08-31'},{date:'2026-09-29'}]){await db.exec('rollback;begin');await assumeSecurityUser(db);await baseline(options);const context=await closingContext();assert.equal(context.canClose,false);await rejects(()=>close(),'PBN01');}
});

test('every current-month ERP or statement activity blocks the fallback, including zero, net-zero, opening and partial headers',async t=>{
 await tx(t);for(const entries of[[{amount:0}],[{amount:2},{amount:-2}],[{amount:0,type:'SALDO_INICIAL',opening:true}]]){
  await db.exec('savepoint current_activity');await baseline();for(const {amount,...options}of entries)await movement(amount,options);const before=await owner(()=>snapshot([...financial,'bank_reconciliation']));const context=await closingContext();assert.equal(context.canClose,false);await rejects(()=>close(),'PBN02');assert.deepEqual(await owner(()=>snapshot([...financial,'bank_reconciliation'])),before);await db.exec('rollback to savepoint current_activity;release savepoint current_activity');await assumeSecurityUser(db);
 }
 for(const kind of['PARTIAL_HEADER','DATED_LINE']){await db.exec('savepoint statement_activity');const source=await baseline();if(kind==='PARTIAL_HEADER')await owner(()=>db.exec("insert into bank_statement(statement_date,bank_account_id,opening_balance,closing_balance)values('2026-10-15',2,5399.02,5399.02)"));else await owner(()=>db.query("insert into bank_statement_line(statement_id,bank_date,reference,amount,source_row)values($1,'2026-10-15','SYNTHETIC-OUT-OF-PERIOD',1,1)",[source.statementId]));const prior=await owner(()=>snapshot([...financial,'bank_reconciliation']));assert.equal((await closingContext()).canClose,false);await rejects(()=>close(),'PBN02');assert.deepEqual(await owner(()=>snapshot([...financial,'bank_reconciliation'])),prior);await db.exec('rollback to savepoint statement_activity;release savepoint statement_activity');await assumeSecurityUser(db);}
});

test('old transit items carry under the unchanged canonical books-plus-payments-minus-deposits formula without being matched',async t=>{
 await tx(t);await baseline();const pending=await movement(-3,{date:'2026-09-29',status:'PENDIENTE_EN_TRANSITO',type:'CHEQUE_EN_TRANSITO',opening:true});const context=await closingContext();assert.equal(context.canClose,true);const before=await owner(()=>snapshot());const id=await close();assert.deepEqual(await owner(()=>snapshot()),before);const header=await owner(()=>q('select to_jsonb(r)d from bank_reconciliation r where reconciliation_id=$1',[id]));assert.equal(Number(header.book_balance),5396.02);assert.equal(Number(header.transit_payments),3);assert.equal(Number(header.statement_balance),5399.02);assert.equal(Number(header.difference),0);assert.equal(await owner(()=>q('select reconciliation_status d from bank_transaction where bank_tran_id=$1',[pending])),'PENDIENTE_EN_TRANSITO');
});

test('exact statement closure preserves its normal real automatic match path and its existing adjustment semantics',async t=>{
 await tx(t);await baseline();const statement=await exactStatement(5409.02);await movement(10,{status:'PENDIENTE_EN_TRANSITO',reference:'SYNTHETIC-EXACT-MATCH'});await owner(()=>db.query("insert into bank_statement_line(statement_id,bank_date,value_date,reference,amount,source_row)values($1,'2026-10-15','2026-10-15','SYNTHETIC-EXACT-MATCH',10,1)",[statement]));const context=await closingContext();assert.equal(context.canClose,false);assert.equal(context.reason,'BALANCE_MISMATCH');const id=await close();assert.ok(id);assert.equal(await owner(()=>q('select count(*)::int d from bank_reconciliation_match where reconciliation_id=$1',[id])),1);
 await db.exec('rollback;begin');await assumeSecurityUser(db);await baseline();await exactStatement(5400.02);assert.ok(await close(2,'2026-10-31',1));
});

test('fallback mismatches and nonzero adjustments fail with explicit codes and nonfinite inputs retain existing numeric guards',async t=>{
 await tx(t);await baseline();await movement(1,{date:'2026-09-29'});assert.equal((await closingContext()).canClose,false);await rejects(()=>close(),'PBN04');
 await db.exec('rollback;begin');await assumeSecurityUser(db);await baseline();await rejects(()=>close(2,'2026-10-31',1),'PBN05');for(const value of['NaN','Infinity','-Infinity',null])await rejects(()=>close(2,'2026-10-31',value),'22023');
});

test('month-end, active own fiscal period and downstream protection rules remain authoritative',async t=>{
 await tx(t);await baseline();assert.equal((await closingContext(2,'2026-10-30')).canClose,false);await rejects(()=>close(2,'2026-10-30'),'PBN03');
 for(const field of['is_closed','is_inactive']){await db.exec('savepoint period_block;reset role');await db.exec('update fiscal_periods set '+field+'=true where fiscal_period_id=10');await assumeSecurityUser(db);assert.equal((await closingContext()).canClose,false);await rejects(()=>close(),'PBN03');await db.exec('rollback to savepoint period_block;release savepoint period_block');await assumeSecurityUser(db);}
 await db.exec("savepoint quadratic_protected;reset role;insert into quadratic_bank_reconciliations(subsidiary_id,bank_account_id,period_year,period_month,status,created_by)values(1,2,2026,11,'approved',1)");await assumeSecurityUser(db);assert.equal((await closingContext()).canClose,false);await rejects(()=>close(),'55000');await db.exec('rollback to savepoint quadratic_protected;release savepoint quadratic_protected');await assumeSecurityUser(db);
 await storedClosed({date:'2026-11-30',period:11,closedAt:'2026-11-30T18:00:00Z'});await rejects(()=>close(),'55000');
});

test('read-only roles can inspect their report but cannot close; anonymous, foreign-subsidiary and inactive identities cannot gain write authority',async t=>{
 await tx(t);await baseline();await assumeSecurityUser(db,1,3);assert.equal((await closingContext()).canClose,false);await deniedSql(db,"select close_bank_reconciliation(2,'2026-10-31',0)");
 for(const role of['anon','service_role']){await assumeSqlRole(db,role);await deniedSql(db,"select close_bank_reconciliation(2,'2026-10-31',0)");}
 await assumeSecurityUser(db);await deniedSql(db,"select close_bank_reconciliation(3,'2026-10-31',0)");await deniedSql(db,"select reconciliation_private.bank_closing_context(2,'2026-10-31',0)");
 await db.exec('reset role;update users set is_active=false where user_id=1;set role authenticated');await deniedSql(db,"select close_bank_reconciliation(2,'2026-10-31',0)");
});

test('fresh writer validation rejects activity inserted after a report preview and in the same outer SQL statement',async t=>{
 await tx(t);await baseline();assert.equal((await closingContext()).canClose,true);await movement(0);await rejects(()=>close(),'PBN02');
 await db.exec('rollback;begin');await assumeSecurityUser(db);await baseline();assert.equal((await closingContext()).canClose,true);await db.exec('reset role');
 // PGlite is one connection: this verifies command visibility and stale
 // authorization, not true multi-session scheduling or lock contention.
 await rejects(()=>q("with changed as(insert into bank_transaction(bank_account_id,tran_date,value_date,amount,tran_type,reference_number,reconciliation_status)values(2,'2026-10-15','2026-10-15',0,'SYNTHETIC','SYNTHETIC-SAME-QUERY','CONCILIADO')returning bank_tran_id)select public.close_bank_reconciliation(2,'2026-10-31',0)d from changed"),'PBN02');assert.equal(await q('select count(*)::int d from bank_reconciliation where bank_account_id=2'),0);
});

test('a late audit failure rolls back the new closed header and every earlier audit row without changing financial sources',async t=>{
 await tx(t);await baseline();const prior=await owner(()=>snapshot([...financial,'bank_reconciliation',...audit]));await db.exec('reset role');await db.exec("create function public.fail_empty_close_event()returns trigger language plpgsql as $$begin if new.event_type='BANK_RECONCILIATION_EMPTY_MONTH_CLOSE'then raise exception 'Synthetic late event failure';end if;return new;end$$;create trigger fail_empty_close_event before insert on event_log for each row execute function fail_empty_close_event()");await assumeSecurityUser(db);await rejects(()=>close(),'P0001');assert.deepEqual(await owner(()=>snapshot([...financial,'bank_reconciliation',...audit])),prior);
});
