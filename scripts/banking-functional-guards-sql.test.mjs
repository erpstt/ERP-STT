import assert from'node:assert/strict';import{before,after,test}from'node:test';import{readFile}from'node:fs/promises';import{PGlite}from'@electric-sql/pglite';import{setupBankingCsvImport}from'./fixtures/setup-banking-csv-import.mjs';import{assertIsolatedTestArgs}from'./lib/migration-preview.mjs';
assertIsolatedTestArgs();
const db=new PGlite(),migration='20261105185448_enforce_bank_base_currency_rate_and_check_location.sql';let reproduction,oldMeta,oldSources,oldRows;
const q=async(sql,p=[])=>(await db.query(sql,p)).rows[0]?.d;
async function actor(role=1,sid=1){await db.exec('reset role');await db.query("insert into user_role_sessions values('fixture',1,$1)on conflict(session_id)do update set user_id=1,role_id=$1",[role]);await db.query("insert into user_company_sessions values('fixture',1,$1)on conflict(session_id)do update set user_id=1,subsidiary_id=$1",[sid]);await db.query("select set_config('request.jwt.claims',$1,false)",[JSON.stringify({sub:'00000000-0000-0000-0000-000000000001',session_id:'fixture'})]);await db.exec('set role authenticated');}
async function tx(t){await db.exec('reset role;begin');t.after(()=>db.exec('rollback;reset role'));await actor();}
async function denied(sql,p=[],code='42501'){await db.exec('savepoint denial');try{await assert.rejects(db.query(sql,p),e=>e.code===code);}finally{await db.exec('rollback to denial;release denial');}}
const check={payment_type:'CHEQUE',bank_account_id:1,currency_id:1,exchange_rate:1,payment_date:'2026-10-10',fiscal_period_id:10,location_id:1,bank_reference:'SYN-FUNCTIONAL',beneficiary:'Synthetic beneficiary',lines:[{amount:100,account_id:103}]};
const deposit={bank_account_id:1,currency_id:1,exchange_rate:1,deposit_date:'2026-10-10',fiscal_period_id:10,location_id:1,bank_reference:'SYN-FUNCTIONAL',lines:[{amount:100,account_id:103,payment_method_id:1}]};
const saveCheck=(p=check,id=null)=>q('select save_bank_check_transfer($1,$2)d',[p,id]);const saveDeposit=(p=deposit)=>q('select save_bank_deposit($1)d',[p]);
const targets=['bank_check_private.validate_payload(jsonb,bigint,bank_check)','bank_deposit_private.validate_payload(jsonb,bigint,bigint)'];
const metadata=async()=>(await db.query('select oid,proowner,proacl::text,proconfig,provolatile,prosecdef,proisstrict,proparallel from pg_proc where oid in(select x::regprocedure from unnest($1::text[])x)order by oid',[targets])).rows;
const otherSources=async()=>(await db.query("select oid,prosrc,proacl::text,proconfig from pg_proc where pronamespace in('public'::regnamespace,'bank_check_private'::regnamespace,'bank_deposit_private'::regnamespace,'bank_transfer_private'::regnamespace)and oid not in(select x::regprocedure from unnest($1::text[])x)order by oid",[targets])).rows;
const rows=()=>q("select jsonb_build_object('accounts',(select jsonb_agg(to_jsonb(x)order by bank_account_id)from bank_account x),'checks',(select jsonb_agg(to_jsonb(x)order by check_id)from bank_check x),'deposits',(select jsonb_agg(to_jsonb(x)order by deposit_id)from bank_deposit x),'journal',(select jsonb_agg(to_jsonb(x)order by journal_id)from journal x),'lines',(select jsonb_agg(to_jsonb(x)order by journal_line_id)from journal_line x),'gl',(select jsonb_agg(to_jsonb(x)order by gl_impact_id)from gl_impact x),'movements',(select jsonb_agg(to_jsonb(x)order by bank_tran_id)from bank_transaction x))d");
async function impacts(result){await db.exec('reset role');const resultRows=(await db.query('select account_id,sum(debit_amount)::float8 debit,sum(credit_amount)::float8 credit,sum(debit_fx)::float8 debit_fx,sum(credit_fx)::float8 credit_fx from gl_impact where transaction_id=(select transaction_id from journal where journal_id=$1)group by account_id order by account_id',[result.journalId])).rows;await actor();return resultRows;}
before(async()=>{await setupBankingCsvImport(db);reproduction=[];for(const[kind,save,p]of[['check',saveCheck,check],['deposit',saveDeposit,deposit]]){await db.exec('begin');await actor();const saved=await save({...p,exchange_rate:2});reproduction.push({kind,gl:await impacts(saved)});await db.exec('rollback;reset role');}oldMeta=await metadata();oldSources=await otherSources();oldRows=await rows();await db.exec('begin');try{await db.exec((await readFile(new URL('../supabase/migrations/'+migration,import.meta.url),'utf8')).replace(/\r\n/g,'\n'));await db.exec('commit');}catch(e){await db.exec('rollback');delete e.query;throw e;}});
after(()=>db.close());

test('rounding an aggregate bank leg differently from its native lines is rejected before any write on create and edit',async t=>{
 await tx(t);const rounding={bank_account_id:5,currency_id:2,exchange_rate:'0.3333333333'};
 const badCheck={...check,...rounding,lines:[{amount:1,account_id:103},{amount:1,account_id:103}]};
 const badDeposit={...deposit,...rounding,lines:[{amount:1,account_id:103,payment_method_id:1},{amount:1,account_id:103,payment_method_id:1}]};
 await db.exec('reset role');const beforeCreate=await rows();await actor();
 await denied('select save_bank_check_transfer($1,null)',[badCheck],'22023');
 await denied('select save_bank_deposit($1)',[badDeposit],'22023');
 await db.exec('reset role');assert.deepEqual(await rows(),beforeCreate);await actor();
 const c=await saveCheck({...check,...rounding,lines:[{amount:3,account_id:103}]}),d=await saveDeposit({...deposit,...rounding,lines:[{amount:3,account_id:103,payment_method_id:1}]});
 await db.exec('reset role');const beforeEdit=await rows();await actor();
 await denied('select save_bank_check_transfer($1,$2)',[badCheck,c.checkId],'22023');
 await denied('select update_bank_deposit($1,$2)',[d.depositId,badDeposit],'22023');
 await db.exec('reset role');assert.deepEqual(await rows(),beforeEdit);
});

test('six-decimal bank precision accepts balanced adjacent foreign amounts without changing their inputs',async t=>{
 await tx(t);const foreign={bank_account_id:5,currency_id:2,exchange_rate:'0.3333333333'};
 for(const[kind,save,p]of[['check',saveCheck,check],['deposit',saveDeposit,deposit]]){
  const saved=await save({...p,...foreign,lines:[{amount:3,account_id:103,payment_method_id:1},{amount:3,account_id:103,payment_method_id:1}]});
  const gl=await impacts(saved);assert.equal(gl.reduce((s,x)=>s+x.debit-x.credit,0),0);
  const bank=gl.find(x=>x.account_id===105);assert.equal(bank[kind==='check'?'credit':'debit'],2);assert.equal(bank[kind==='check'?'credit_fx':'debit_fx'],6);
 }
});

test('rates beyond ten decimals and native amounts beyond six decimals never silently change stored monetary input',async t=>{
 await tx(t);await db.exec('reset role');const before=await rows();await actor();
 for(const[kind,p]of[['check',check],['deposit',deposit]]){
  const sql=kind==='check'?'select save_bank_check_transfer($1,null)':'select save_bank_deposit($1)';
  for(const amount of[1,999999])await denied(sql,[{...p,bank_account_id:5,currency_id:2,exchange_rate:'1.00000000005',lines:[{amount,account_id:103,payment_method_id:1}]}],'22023');
  await denied(sql,[{...p,bank_account_id:5,currency_id:2,exchange_rate:'0.00000000001',lines:[{amount:1,account_id:103,payment_method_id:1}]}],'22023');
  await denied(sql,[{...p,lines:[{amount:'1.0000001',account_id:103,payment_method_id:1}]}],'22023');
 }
 await db.exec('reset role');assert.deepEqual(await rows(),before);
});

test('reproduced functional-currency rate two no longer creates bank/GL discrepancies or partial records',async t=>{
 await tx(t);assert.equal(reproduction.length,2);for(const r of reproduction)assert.equal(r.gl.find(g=>g.account_id===101)[r.kind==='check'?'credit':'debit'],200);await db.exec('reset role');const old=await rows();await actor();for(const rate of[2,.5,'1.000001']){await denied('select save_bank_check_transfer($1,null)',[{...check,exchange_rate:rate}],'22023');await denied('select save_bank_deposit($1)',[{...deposit,exchange_rate:rate}],'22023');}await db.exec('reset role');assert.deepEqual(await rows(),old);
});
test('functional-currency rate one remains native and locally balanced in both directions',async t=>{
 await tx(t);const c=await saveCheck(),d=await saveDeposit();assert.deepEqual(await impacts(c),[{account_id:101,debit:0,credit:100,debit_fx:0,credit_fx:100},{account_id:103,debit:100,credit:0,debit_fx:100,credit_fx:0}]);assert.deepEqual(await impacts(d),[{account_id:101,debit:100,credit:0,debit_fx:100,credit_fx:0},{account_id:103,debit:0,credit:100,debit_fx:0,credit_fx:100}]);await db.exec('reset role');assert.equal(await q('select balance::float8 d from bank_account where bank_account_id=1'),1000);
});
test('foreign rates and six-decimal original amounts retain their exact local/native posting',async t=>{
 await tx(t);const value=12.345678,common={bank_account_id:5,currency_id:2,exchange_rate:160};const c=await saveCheck({...check,...common,lines:[{amount:value,account_id:103,entity_type:'Proveedor',entity_id:10,department_id:21}]});assert.deepEqual(await impacts(c),[{account_id:103,debit:1975.30848,credit:0,debit_fx:value,credit_fx:0},{account_id:105,debit:0,credit:1975.30848,debit_fx:0,credit_fx:value}]);const d=await saveDeposit({...deposit,...common,lines:[{amount:value,account_id:103,payment_method_id:1,entity_type:'Cliente',entity_id:10,department_id:20,cost_center_id:40,class_id:30}]});assert.deepEqual(await impacts(d),[{account_id:103,debit:0,credit:1975.30848,debit_fx:0,credit_fx:value},{account_id:105,debit:1975.30848,credit:0,debit_fx:value,credit_fx:0}]);await db.exec('reset role');assert.equal(await q('select balance::float8 d from bank_account where bank_account_id=5'),1000);
});
test('a location explicitly shared with the company is usable while foreign and unassigned locations are denied',async t=>{
 await tx(t);const c=await saveCheck({...check,location_id:3});await db.exec('reset role');assert.equal(await q('select location_id d from bank_check where check_id=$1',[c.checkId]),3);assert.deepEqual((await db.query('select distinct location_id from journal_line where journal_id=$1',[c.journalId])).rows,[{location_id:3}]);await actor();for(const location_id of[2,4,999])await denied('select save_bank_check_transfer($1,null)',[{...check,location_id}]);
});
test('free check editing preserves accounting identity and native bank restoration at a shared location',async t=>{
 await tx(t);const c=await saveCheck({...check,location_id:3}),edited=await saveCheck({...check,location_id:3,lines:[{amount:120,account_id:103}]},c.checkId);assert.equal(edited.checkId,c.checkId);assert.equal(edited.journalId,c.journalId);await db.exec('reset role');assert.equal(await q('select balance::float8 d from bank_account where bank_account_id=1'),880);await actor();await denied('select save_bank_check_transfer($1,$2)',[{...check,location_id:3,exchange_rate:2},c.checkId],'22023');await db.query('select delete_bank_check_transfer($1)',[c.checkId]);await db.exec('reset role');assert.equal(await q('select balance::float8 d from bank_account where bank_account_id=1'),1000);assert.deepEqual((await rows()).gl,oldRows.gl);
});
test('deposit shared-location editing and deletion retain their existing protected writer behavior',async t=>{
 await tx(t);const d=await saveDeposit({...deposit,location_id:3});await q('select update_bank_deposit($1,$2)d',[d.depositId,{...deposit,location_id:3,lines:[{amount:120,account_id:103,payment_method_id:1}]}]);await db.exec('reset role');assert.equal(await q('select balance::float8 d from bank_account where bank_account_id=1'),1120);await actor();await denied('select update_bank_deposit($1,$2)',[d.depositId,{...deposit,exchange_rate:2}],'22023');await db.query('select delete_bank_deposit($1)',[d.depositId]);await db.exec('reset role');assert.equal(await q('select balance::float8 d from bank_account where bank_account_id=1'),1000);assert.deepEqual((await rows()).gl,oldRows.gl);
});
test('guards preserve OID, ACL and attributes, unrelated engines/triggers, historical data and action/company permissions',async t=>{
 await tx(t);await db.exec('reset role');assert.deepEqual(await metadata(),oldMeta);assert.deepEqual(await otherSources(),oldSources);assert.deepEqual(await rows(),oldRows);await actor(3);await denied('select save_bank_check_transfer($1,null)',[check]);await denied('select save_bank_deposit($1)',[deposit]);await actor(1,2);await denied('select save_bank_check_transfer($1,null)',[check]);await denied('select save_bank_deposit($1)',[deposit]);await actor();for(const target of targets)assert.equal(await q("select has_function_privilege('authenticated',$1,'EXECUTE')d",[target]),false);
});
