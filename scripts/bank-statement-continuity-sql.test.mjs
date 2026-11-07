import assert from 'node:assert/strict';
import {test,before,after} from 'node:test';
import {readFile} from 'node:fs/promises';
import {setupBankStatementContinuity,applyBankStatementContinuity,bankStatementContinuityMigration,assumeSecurityUser,assumeSqlRole,beginIsolatedCase,deniedSql} from './fixtures/setup-bank-statement-continuity.mjs';
let db,beforeFunctions,afterFunctions,beforeRows,afterRows;
const targets=['reconciliation_private.before_import(bigint,date,numeric,numeric,jsonb)','public.save_bank_statement_metadata(bigint,jsonb)','public.delete_bank_statement(bigint)'];
const functions=async()=> (await db.query("select p.oid,n.nspname schema,p.proname,pg_get_function_identity_arguments(p.oid) args,md5(prosrc) md5,p.proowner,p.proacl::text acl,p.proconfig,p.prosecdef,p.provolatile from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname in('public','reconciliation_private') order by p.oid")).rows;
async function snapshot(){
 await db.exec('reset role');const out={};
 for(const table of ['bank_statement','bank_statement_line','bank_reconciliation','bank_reconciliation_match','bank_transaction','bank_account','quadratic_bank_reconciliations','quadratic_reconciliation_matches','quadratic_reconciliation_items'])
 out[table]=(await db.query(`select coalesce(jsonb_agg(to_jsonb(x) order by to_jsonb(x)::text),'[]'::jsonb) d from ${table} x`)).rows[0].d;
 return out;
}
before(async()=>{({db}=await setupBankStatementContinuity({apply:false}));beforeFunctions=await functions();beforeRows=await snapshot();await applyBankStatementContinuity(db);afterFunctions=await functions();afterRows=await snapshot();});
after(()=>db?.close());
const tx=async t=>{await db.exec('reset role;begin');t.after(()=>db.exec('rollback;reset role'));await assumeSecurityUser(db);};
const context=async(bank=1,date='2026-10-31')=>(await db.query('select bank_statement_balance_context($1,$2) d',[bank,date])).rows[0].d;
const payload=(date='2026-09-30',open=100,close=100,bank=1)=>({statement_date:date,bank_account_id:bank,opening_balance:open,closing_balance:close,source_file_name:'synthetic-continuity.csv'});
const save=async(p,id=null)=>(await db.query('select save_bank_statement_metadata($1,$2) d',[id,p])).rows[0].d;
const lines=(date='2026-10-15',amount=25)=>[{date,amount,reference:'SYNTHETIC-CONTINUITY'}];
const importSql='select import_bank_statement($1,$2,$3,$4,$5,$6) id';
const args=(date='2026-10-31',open=100,close=125,rows=lines(),bank=1)=>[bank,date,open,close,'synthetic-continuity.csv',rows];
const importFile=async(...values)=>(await db.query(importSql,args(...values))).rows[0].id;
async function rejectsUnchanged(statement,params,code){
 const before=await snapshot();await assumeSecurityUser(db);await deniedSql(db,statement,params,code);assert.deepEqual(await snapshot(),before);await assumeSecurityUser(db);
}
test('migration changes only three guarded bodies and adds four closed functions with no historical writes',async()=>{
 const prior=new Map(beforeFunctions.map(x=>[x.oid,x])),changed=afterFunctions.filter(x=>prior.has(x.oid)&&JSON.stringify(x)!==JSON.stringify(prior.get(x.oid))),added=afterFunctions.filter(x=>!prior.has(x.oid));
 assert.deepEqual(changed.map(x=>x.proname).sort(),['before_import','delete_bank_statement','save_bank_statement_metadata']);
 assert.equal(added.length,4);for(const x of changed)assert.deepEqual({...x,md5:null},{...prior.get(x.oid),md5:null});
 assert.deepEqual(afterRows,beforeRows);
 for(const signature of ['reconciliation_private.statement_balance_context(bigint,date)','reconciliation_private.assert_statement_balances(bigint,date,numeric,numeric,jsonb,boolean)','reconciliation_private.assert_statement_following(bigint,bigint,date,numeric,boolean)'])
 for(const role of ['anon','authenticated','service_role'])assert.equal((await db.query("select has_function_privilege($1,$2,'execute') ok",[role,signature])).rows[0].ok,false);
 for(const role of ['anon','service_role'])assert.equal((await db.query("select has_function_privilege($1,'public.bank_statement_balance_context(bigint,date)','execute') ok",[role])).rows[0].ok,false);
 assert.equal((await db.query("select has_function_privilege('authenticated','public.bank_statement_balance_context(bigint,date)','execute') ok")).rows[0].ok,true);
 for(const x of added){assert.equal(x.prosecdef,true);assert.deepEqual(x.proconfig,['search_path=pg_catalog, public, pg_temp']);}
});
test('first period has a null predecessor and context lookup itself performs no writes',async t=>{
 await tx(t);const before=await snapshot();await assumeSecurityUser(db);
 assert.deepEqual(await context(),{bankAccountId:1,statementDate:'2026-10-31',previousDate:'2026-09-30',previousStatement:null});
 assert.deepEqual(await snapshot(),before);
});
test('an open previous statement is authoritative and zero is not treated as missing',async t=>{
 await tx(t);const prior=await save(payload('2026-02-28',0,0));const ctx=await context(1,'2026-03-31');
 assert.deepEqual(ctx.previousStatement,{id:prior.statement_id,date:'2026-02-28',closingBalance:0});
 await rejectsUnchanged(importSql,args('2026-03-31',2,3,lines('2026-03-01',1)),'PBC01');
 await importFile('2026-03-31',0,1,lines('2026-03-01',1));
});
test('previous date uses the exact prior month end across leap years and ignores other accounts',async t=>{
 await tx(t);await save(payload('2024-02-29',12,12));await save(payload('2024-02-29',999,999,2));
 const result=await context(1,'2024-03-15');assert.equal(result.previousDate,'2024-02-29');assert.equal(result.previousStatement.closingBalance,12);
 assert.equal((await context(1,'2024-04-30')).previousStatement,null);
});
test('context requires create plus report view, current assigned role, and active company scope',async t=>{
 await tx(t);await assumeSecurityUser(db,1,3);await deniedSql(db,'select bank_statement_balance_context(1,\'2026-10-31\')');
 await assumeSecurityUser(db,1,2);await deniedSql(db,'select bank_statement_balance_context(1,\'2026-10-31\')');
 await assumeSecurityUser(db);await deniedSql(db,"select bank_statement_balance_context(3,'2026-10-31')");
 await db.exec("reset role;delete from role_access_matrix where role_id=1 and resource_key='reports:accounting-reports'");await assumeSecurityUser(db);await deniedSql(db,"select bank_statement_balance_context(1,'2026-10-31')");
 await assumeSqlRole(db,'anon');await deniedSql(db,"select bank_statement_balance_context(1,'2026-10-31')");
 await assumeSqlRole(db,'service_role');await deniedSql(db,"select bank_statement_balance_context(1,'2026-10-31')");
});
test('a matching continuous import retains native amounts, supplied precision and the original writer',async t=>{
 await tx(t);await save(payload());const id=await importFile();assert.equal(id,1);
 const actual=(await db.query('select opening_balance::text o,closing_balance::text c from bank_statement where statement_id=1')).rows[0];
 assert.deepEqual(actual,{o:'100.000000',c:'125.000000'});assert.equal((await db.query('select amount::text a from bank_statement_line where statement_id=1')).rows[0].a,'25.000000');
});
test('opening mismatch of two units fails atomically instead of overriding balances or matches',async t=>{
 await tx(t);await save(payload());await rejectsUnchanged(importSql,args('2026-10-31',98,123),'PBC01');
});
test('a predecessor changed after preview is read again under the import account lock',async t=>{
 await tx(t);await db.query('select delete_bank_statement(1)');const p=await save(payload());assert.equal((await context()).previousStatement.closingBalance,100);
 await save(payload('2026-09-30',100,101),p.statement_id);await rejectsUnchanged(importSql,args(),'PBC01');
});
test('closing must match opening plus rounded stored line amounts in cents',async t=>{
 await tx(t);await rejectsUnchanged(importSql,args('2026-10-31',100,124),'PBC02');
});
test('rounding uses six decimals per line and ties away from zero at the final cent',async t=>{
 await tx(t);await importFile('2026-04-30',0,.01,[{date:'2026-04-01',amount:'.0024996'},{date:'2026-04-02',amount:'.0024996'}]);
 assert.equal((await db.query("select sum(amount)::text a from bank_statement_line l join bank_statement s using(statement_id)where s.statement_date='2026-04-30'")).rows[0].a,'0.005000');
 await importFile('2026-05-31',.01,1.02,lines('2026-05-01','1.005'));
 await importFile('2026-07-31',0,-1.01,lines('2026-07-01','-1.005'));
 for(const [closing,amount]of [['.995',1],['1.005',1],['-.995',-1],['-1.005',-1]])
  await rejectsUnchanged(importSql,args('2025-02-28',0,closing,lines('2025-02-01',amount)),'PBC02');
 await importFile('2025-02-28',0,'.995001',lines('2025-02-01',1));
 await importFile('2025-02-28',0,'-.995001',lines('2025-02-01',-1));
});
test('a first-period opening inferred at six decimals is preserved',async t=>{
 await tx(t);const id=await importFile('2026-04-30','.005','1.01',lines('2026-04-01','1.005'));
 assert.equal((await db.query('select opening_balance::text o from bank_statement where statement_id=$1',[id])).rows[0].o,'0.005000');
});
test('previous-month and post-cutoff movement dates cannot enter a selected month',async t=>{
 await tx(t);for(const date of ['2026-09-30','2026-11-01'])await rejectsUnchanged(importSql,args('2026-10-31',100,125,lines(date)),'PBC03');
 await rejectsUnchanged(importSql,args('2026-10-15',100,125,lines('2026-10-16')),'PBC03');
});
test('invalid or nonfinite dates and amounts, storage overflow, and zero after round6 fail before writes',async t=>{
 await tx(t);for(const amount of ['NaN','Infinity','0.0000004','1000000000000000000'])await rejectsUnchanged(importSql,args('2026-04-30',0,0,lines('2026-04-01',amount)),'22023');
 await deniedSql(db,"select bank_statement_balance_context(1,'infinity')",[],'22023');
});
test('metadata summaries without lines preserve documentary closing while requiring predecessor continuity',async t=>{
 await tx(t);const row=await save(payload('2026-09-30',777,100));assert.equal(row.closing_balance,100);
 await rejectsUnchanged('select save_bank_statement_metadata($1,$2)',[null,payload('2026-11-30',124,5)],'PBC01');
});
test('metadata with persisted lines validates its net and does not recreate them',async t=>{
 await tx(t);await save(payload());await rejectsUnchanged('select save_bank_statement_metadata($1,$2)',[1,payload('2026-10-31',100,126)],'PBC02');
 const before=(await db.query('select statement_line_id from bank_statement_line where statement_id=1')).rows;await save(payload('2026-10-31',100,125),1);
 assert.deepEqual((await db.query('select statement_line_id from bank_statement_line where statement_id=1')).rows,before);
});
test('a preceding insert or closing change cannot break an already contiguous next statement',async t=>{
 await tx(t);await rejectsUnchanged('select save_bank_statement_metadata($1,$2)',[null,payload('2026-09-30',0,99)],'PBC04');
 const previous=await save(payload());await rejectsUnchanged('select save_bank_statement_metadata($1,$2)',[previous.statement_id,payload('2026-09-30',0,101)],'PBC04');
});
test('deleting, moving the date, or moving the account of a predecessor cannot orphan the next month',async t=>{
 await tx(t);const previous=await save(payload());
 await rejectsUnchanged('select delete_bank_statement($1)',[previous.statement_id],'PBC04');
 await rejectsUnchanged('select save_bank_statement_metadata($1,$2)',[previous.statement_id,payload('2026-09-29',100,100)],'PBC04');
 await rejectsUnchanged('select save_bank_statement_metadata($1,$2)',[previous.statement_id,payload('2026-09-30',100,100,2)],'PBC04');
});
test('matching downstream balances allow a predecessor documentary edit without changing the next month',async t=>{
 await tx(t);const previous=await save(payload());const next=(await db.query('select to_jsonb(s) d from bank_statement s where statement_id=1')).rows[0].d;
 await save({...payload(),source_file_name:'synthetic-renamed.csv'},previous.statement_id);
 assert.deepEqual((await db.query('select to_jsonb(s) d from bank_statement s where statement_id=1')).rows[0].d,next);
});
test('a terminal statement with no following dependency can still be deleted through its protected API',async t=>{
 await tx(t);assert.deepEqual((await db.query('select delete_bank_statement(1) d')).rows[0].d,{success:true});assert.equal((await db.query('select count(*)::int n from bank_statement where statement_id=1')).rows[0].n,0);
});
test('closed periods remain immutable and the context may still read an earlier closed statement',async t=>{
 await tx(t);const prior=await save(payload());await db.exec("reset role;insert into fiscal_periods(fiscal_period_id,subsidiary_id,start_date,end_date,is_closed)values(9,1,'2026-09-01','2026-09-30',false);insert into bank_reconciliation(reconciliation_date,bank_account_id,fiscal_period_id,status)values('2026-09-30',1,9,'CERRADA')");await assumeSecurityUser(db);
 assert.equal((await context()).previousStatement.id,prior.statement_id);
 await rejectsUnchanged('select save_bank_statement_metadata($1,$2)',[prior.statement_id,payload()],'55000');
 await rejectsUnchanged(importSql,args('2026-09-30',100,100,[]),'55000');
});
test('matched lines and their protected metadata cannot be replaced despite an open period',async t=>{
 await tx(t);await db.exec('reset role');
 const movement=(await db.query("insert into bank_transaction(bank_account_id,tran_date,amount,tran_type,reference_number,reconciliation_status)values(1,'2026-10-15',25,'SYNTHETIC','SYNTHETIC-MATCH','CONCILIADO')returning bank_tran_id")).rows[0].bank_tran_id;
 const reconciliation=(await db.query("insert into bank_reconciliation(reconciliation_date,bank_account_id,fiscal_period_id,status)values('2026-10-31',1,10,'ABIERTA')returning reconciliation_id")).rows[0].reconciliation_id;
 const line=(await db.query('select statement_line_id from bank_statement_line where statement_id=1')).rows[0].statement_line_id;
 await db.query("insert into bank_reconciliation_match(reconciliation_id,bank_tran_id,statement_line_id,match_type,matched_by)values($1,$2,$3,'MANUAL',1)",[reconciliation,movement,line]);
 await db.exec("update bank_statement_line set reconciliation_status='CONCILIADO' where statement_id=1");await assumeSecurityUser(db);
 await rejectsUnchanged('select save_bank_statement_metadata($1,$2)',[1,payload('2026-10-31',100,125)],'55000');await rejectsUnchanged(importSql,args(),'55000');await rejectsUnchanged('select delete_bank_statement(1)',[],'55000');
});
test('private source and dependency guards fail before adding functions when the reviewed baseline drifts',async()=>{
 const fixture=await setupBankStatementContinuity({apply:false}),probe=fixture.db;
 try{const sql=(await readFile(new URL('../supabase/migrations/'+bankStatementContinuityMigration,import.meta.url),'utf8')).replace(/\r\n/g,'\n');
  for(const signature of targets){await probe.exec('begin');const d=(await probe.query('select pg_get_functiondef($1::regprocedure) d',[signature])).rows[0].d;await probe.exec(d.replace('AS $function$','AS $function$\n-- Synthetic drift'));await assert.rejects(probe.exec(sql),e=>e.code==='P0001'&&/Unexpected/.test(e.message));await probe.exec('rollback');assert.equal((await probe.query("select to_regprocedure('public.bank_statement_balance_context(bigint,date)') f")).rows[0].f,null);}
 }finally{await probe.close();}
});
