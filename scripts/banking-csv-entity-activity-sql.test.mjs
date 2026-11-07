import assert from 'node:assert/strict';
import {before,after,test} from 'node:test';
import {PGlite} from '@electric-sql/pglite';
import {setupBankingCsvEntityActivity,applyBankingCsvEntityActivity,bankingCsvEntityActivitySql} from './fixtures/setup-banking-csv-entity-activity.mjs';
import {assertIsolatedTestArgs} from './lib/migration-preview.mjs';
assertIsolatedTestArgs();
const db=new PGlite(),q=async(sql,params=[])=>(await db.query(sql,params)).rows[0]?.d;
const row={documento_referencia:'SYN-ENTITY-ACTIVITY',tipo_movimiento:'TRANSFERENCIA',fecha:'2026-10-10',cuenta_bancaria:'DEMO-A',moneda:'USD',referencia_bancaria:'SYN-REF',beneficiario:'Synthetic recipient',numero_cuenta:'103',importe:'10',tipo_entidad:'CLIENTE',identificacion_entidad:'SYN-CUSTOMER-10'};
let functionsBefore,repro;
const functions=async()=>(await db.query("select oid,oid::regprocedure::text signature,md5(prosrc)source_md5,proowner,proacl::text acl,proconfig,prosecdef,provolatile from pg_proc where oid=any($1::oid[])order by oid",[functionsBefore?.map(f=>f.oid)??(await db.query("select oid from pg_proc where pronamespace not in('pg_catalog'::regnamespace,'information_schema'::regnamespace)and pronamespace::regnamespace::text not like'pg_%'")).rows.map(f=>f.oid)])).rows;
async function assume(role=1,sid=1){
 await db.exec('reset role');
 await db.query("insert into user_role_sessions values('fixture',1,$1)on conflict(session_id)do update set user_id=1,role_id=$1",[role]);
 await db.query("insert into user_company_sessions values('fixture',1,$1)on conflict(session_id)do update set user_id=1,subsidiary_id=$1",[sid]);
 await db.query("select set_config('request.jwt.claims',$1,false)",[JSON.stringify({sub:'00000000-0000-0000-0000-000000000001',session_id:'fixture',role:'authenticated'})]);await db.exec('set role authenticated');
}
const lookup=(kind,value,sid=1)=>q('select banking_csv_private.lookup($1,$2,$3)d',[kind,value,sid]);
const preview=(rows,kind='CHECKS',sid=1)=>q('select banking_csv_preview($1,$2,$3)d',[kind,rows,sid]);
async function snapshot(){
 await db.exec('reset role');
 return q(`select jsonb_build_object(
 'bankAccounts',(select jsonb_agg(to_jsonb(x)order by bank_account_id)from bank_account x),
 'checks',(select jsonb_agg(to_jsonb(x)order by to_jsonb(x)::text)from bank_check x),
 'deposits',(select jsonb_agg(to_jsonb(x)order by to_jsonb(x)::text)from bank_deposit x),
 'bankTransactions',(select jsonb_agg(to_jsonb(x)order by to_jsonb(x)::text)from bank_transaction x),
 'transactions',(select jsonb_agg(to_jsonb(x)order by to_jsonb(x)::text)from public."transaction" x),
 'journals',(select jsonb_agg(to_jsonb(x)order by to_jsonb(x)::text)from journal x),
 'journalLines',(select jsonb_agg(to_jsonb(x)order by to_jsonb(x)::text)from journal_line x),
 'gl',(select jsonb_agg(to_jsonb(x)order by to_jsonb(x)::text)from gl_impact x),
 'receipts',(select jsonb_agg(to_jsonb(x)order by id)from banking_csv_private.imports x),
 'references',(select jsonb_agg(to_jsonb(x)order by reference)from banking_csv_private.documents x),
 'sequences',(select jsonb_object_agg(sequencename,last_value)from pg_sequences where schemaname='public'))d`);
}
async function tx(t){await db.exec('reset role;begin');t.after(()=>db.exec('rollback;reset role'));}
async function rejects(sql,params=[],code='22023'){await db.exec('savepoint denied');try{await assert.rejects(typeof sql==='function'?sql():db.query(sql,params),error=>error.code===code);}finally{await db.exec('rollback to denied;release denied');}}
before(async()=>{
 await setupBankingCsvEntityActivity(db);functionsBefore=await functions();const baseline=await snapshot();
 let directCode;try{await lookup('CLIENTE','SYN-CUSTOMER-10');}catch(error){directCode=error.code;}
 await assume();const beforePreview=await preview([row]);const after=await snapshot();
 repro={directCode,beforePreview,baseline,after};await applyBankingCsvEntityActivity(db);
});
after(()=>db.close());

test('published schema without invented inactive columns reproduces 42703 masked as the CSV entity-row INTERNAL error',async t=>{
 await tx(t);assert.equal(repro.directCode,'42703');assert.equal(repro.beforePreview.valid,false);assert.deepEqual(repro.beforePreview.errors.map(e=>({row:e.row,field:e.field,code:e.code})),[{row:2,field:'identificacion_entidad',code:'INTERNAL'}]);assert.deepEqual(repro.after,repro.baseline);
 const flags=(await db.query("select table_name from information_schema.columns where table_schema='public'and table_name in('customers','suppliers')and column_name='is_inactive'")).rows;assert.deepEqual(flags,[]);
});

test('only the reviewed lookup body changes; its OID, ACL, owner, configuration and every other function remain intact',async t=>{
 await tx(t);const current=await functions(),changed=current.filter((f,i)=>f.source_md5!==functionsBefore[i].source_md5);assert.equal(changed.length,1);assert.equal(changed[0].signature,'banking_csv_private.lookup(text,text,bigint)');
 for(let i=0;i<current.length;i++)assert.deepEqual({...current[i],source_md5:null},{...functionsBefore[i],source_md5:null});
 const target=changed[0];assert.equal(target.prosecdef,true);assert.equal(target.provolatile,'v');assert.deepEqual(target.proconfig,['search_path=pg_catalog, public, pg_temp']);assert.equal(target.acl,'{postgres=X/postgres}');
 assert.deepEqual(await snapshot(),repro.baseline);
});

test('exact customer and supplier tax IDs resolve with no activity flag in both CHECKS and DEPOSITS previews',async t=>{
 await tx(t);assert.equal(await lookup('CLIENTE','SYN-CUSTOMER-10'),10);assert.equal(await lookup('PROVEEDOR','SYN-SUPPLIER-10'),10);const baseline=await snapshot();
 for(const kind of ['CHECKS','DEPOSITS'])for(const[type,id]of [['CLIENTE','SYN-CUSTOMER-10'],['PROVEEDOR','SYN-SUPPLIER-10']]){
  await assume();const data=[{...row,tipo_entidad:type,identificacion_entidad:id,...(kind==='DEPOSITS'?{tipo_cambio:'1',metodo_pago:'TRANSFERENCIA'}:{})}],result=await preview(data,kind);assert.equal(result.valid,true,JSON.stringify(result.errors));assert.deepEqual(result.errors,[]);assert.equal(result.entries.length,1);
 }
 assert.deepEqual(await snapshot(),baseline);
});

test('optional inactive flags still reject disabled customers and suppliers, while false and NULL preserve active behavior',async t=>{
 await tx(t);await db.exec('alter table customers add column is_inactive boolean;alter table suppliers add column is_inactive boolean');
 for(const[kind,table,id]of [['CLIENTE','customers','SYN-CUSTOMER-10'],['PROVEEDOR','suppliers','SYN-SUPPLIER-10']]){
  await db.exec(`update ${table} set is_inactive=true`);await rejects('select banking_csv_private.lookup($1,$2,1)',[kind,id]);await assume();const result=await preview([{...row,tipo_entidad:kind,identificacion_entidad:id}]);assert.equal(result.valid,false);assert.equal(result.errors[0].field,'identificacion_entidad');assert.equal(result.errors[0].code,'22023');await db.exec('reset role');
  for(const value of ['false','null']){await db.exec(`update ${table} set is_inactive=${value}`);assert.equal(await lookup(kind,id),10);}
 }
});

test('subsidiary membership and per-company uniqueness remain mandatory, even when tax IDs overlap across companies',async t=>{
 await tx(t);await rejects('select banking_csv_private.lookup($1,$2,1)',['CLIENTE','SYN-CUSTOMER-11']);
 await db.exec("insert into customers(customer_id,company_name,tax_id)values(12,'Synthetic duplicate','SYN-CUSTOMER-10');insert into entity_subsidiaries(customer_id,subsidiary_id)values(12,2)");assert.equal(await lookup('CLIENTE','SYN-CUSTOMER-10',1),10);assert.equal(await lookup('CLIENTE','SYN-CUSTOMER-10',2),12);
 await db.exec('insert into entity_subsidiaries(customer_id,subsidiary_id)values(12,1)');await rejects('select banking_csv_private.lookup($1,$2,1)',['CLIENTE','SYN-CUSTOMER-10']);
 await db.exec("insert into suppliers(supplier_id,company_name,tax_id)values(12,'Synthetic supplier duplicate','SYN-SUPPLIER-10');insert into entity_subsidiaries(supplier_id,subsidiary_id)values(12,1)");await rejects('select banking_csv_private.lookup($1,$2,1)',['PROVEEDOR','SYN-SUPPLIER-10']);
 await db.exec('delete from entity_subsidiaries where supplier_id in(10,12)');await rejects('select banking_csv_private.lookup($1,$2,1)',['PROVEEDOR','SYN-SUPPLIER-10'], '22023');
});

test('tax IDs keep their exact text and leading zeros; missing values and internal IDs never become arbitrary entity matches',async t=>{
 await tx(t);assert.equal(await lookup('CLIENTE','  SYN-CUSTOMER-10  '),10);assert.equal(await lookup('CLIENTE',''),null);
 await db.exec("insert into customers(customer_id,company_name,tax_id)values(13,'Synthetic leading zeros','00000123');insert into entity_subsidiaries(customer_id,subsidiary_id)values(13,1)");assert.equal(await lookup('CLIENTE','00000123'),13);
 for(const value of ['123','ID:13','SYN-MISSING','syn-customer-10'])await rejects('select banking_csv_private.lookup($1,$2,1)',['CLIENTE',value]);
});

test('unrelated reference kinds keep their prior behavior and entity errors remain row-specific without financial or receipt writes',async t=>{
 await tx(t);for(const[kind,value,id]of [['bank','DEMO-A',1],['account','103',103],['currency','USD',1],['location','Synthetic shared location',3],['method','TRANSFERENCIA',1],['EMPLEADO','SYN-EMPLOYEE-10',10],['AGENCIA_TRIBUTARIA','SYN-AGENCY-1',1]])assert.equal(await lookup(kind,value),id);
 const baseline=await snapshot();await assume();const result=await preview([row,{...row,documento_referencia:'SYN-MISSING-ENTITY',identificacion_entidad:'SYN-MISSING'}]);assert.equal(result.valid,false);assert.equal(result.errors[0].row,3);assert.equal(result.errors[0].field,'identificacion_entidad');assert.equal(result.errors[0].code,'22023');assert.deepEqual(await snapshot(),baseline);
});

test('private helper grants and public view/create/company guards are unchanged; a mismatched source cannot be patched again',async t=>{
 await tx(t);await assume();await rejects('select banking_csv_private.lookup($1,$2,1)',['CLIENTE','SYN-CUSTOMER-10'],'42501');await rejects("select banking_csv_preview('CHECKS',$1,2)",[[row]],'42501');await assume(3);await rejects("select banking_csv_preview('CHECKS',$1,1)",[[row]],'42501');await db.exec('reset role;set role service_role');await rejects("select banking_csv_preview('CHECKS',$1,1)",[[row]],'42501');await db.exec('reset role');
 const baseline=await functions(),migration=await bankingCsvEntityActivitySql();await rejects(()=>db.exec(migration),[],'P0001');assert.deepEqual(await functions(),baseline);
});
