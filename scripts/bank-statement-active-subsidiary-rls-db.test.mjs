import assert from 'node:assert/strict';
import {test,before,after} from 'node:test';
import {assertIsolatedTestArgs} from './lib/migration-preview.mjs';
assertIsolatedTestArgs();
const {isolatedBankStatementDatabase,assumeSecurityUser,assumeSqlRole,beginIsolatedCase,deniedSql}=await import('./fixtures/isolated-bank-statement-security.mjs');
let db,manifest;
before(async()=>{({db,manifest}=await isolatedBankStatementDatabase());});
after(async()=>{if(db)await db.close();});
const value=async(sql,params=[])=>(await db.query(sql,params)).rows[0]?.value;
const ids=async(table,key)=>(await db.query('select '+key+' from public.'+table+' order by '+key)).rows.map(row=>Number(row[key]));
const options=async()=>(await db.query('select * from bank_statement_account_options() order by bank_account_id')).rows;
const save=async(payload,id=null)=>value('select save_bank_statement_metadata($1,$2) value',[id,payload]);
const remove=id=>value('select delete_bank_statement($1) value',[id]);
const payload=(overrides={})=>({statement_date:'2026-11-01',bank_account_id:1,opening_balance:125,closing_balance:130,source_file_name:'synthetic-new.csv',...overrides});
async function tx(t){await beginIsolatedCase(db,t);}
async function hidden(){assert.deepEqual(await ids('bank_statement','statement_id'),[]);assert.deepEqual(await ids('bank_statement_line','statement_line_id'),[]);}
async function deniedLifecycle(){
 await deniedSql(db,'select bank_statement_account_options()');
 await deniedSql(db,'select save_bank_statement_metadata(null,$1)',[payload()]);
 await deniedSql(db,'select delete_bank_statement(1)');
}

test('fixture installs current C04 SELECT policies, closed direct writes and actual A06/session boundaries',async t=>{
 await tx(t);
 assert.ok(manifest.length>20);assert.ok(manifest.every(item=>/^[a-f0-9]{64}$/.test(item.sha256)));
 assert.ok(!manifest.some(item=>item.source==='20261026115000_bank_statement_active_subsidiary_rls.sql'));
 assert.equal(await value("select count(*)::int value from role_access_matrix where resource_key='legacy:all'"),0);
 assert.deepEqual((await db.query("select tablename,policyname,cmd from pg_policies where schemaname='public' and tablename in('bank_statement','bank_statement_line') order by tablename")).rows,[{tablename:'bank_statement',policyname:'statement_read',cmd:'SELECT'},{tablename:'bank_statement_line',policyname:'statement_line_read',cmd:'SELECT'}]);
 for(const role of['anon','authenticated','service_role'])for(const table of['bank_statement','bank_statement_line']){
  assert.equal(await value("select has_table_privilege($1,$2,'INSERT,UPDATE,DELETE') value",[role,table]),false);
 }
 assert.equal(await value("select has_function_privilege('authenticated','reconciliation_private.identity()','EXECUTE') value"),false);
 assert.equal(await value("select has_function_privilege('authenticated','reconciliation_private.can_read(text,bigint)','EXECUTE') value"),true);
 for(const signature of['save_bank_statement_metadata(bigint,jsonb)','delete_bank_statement(bigint)']){
  assert.equal(await value("select has_function_privilege('authenticated',$1,'EXECUTE') value",[signature]),true);
  assert.equal(await value("select has_function_privilege('service_role',$1,'EXECUTE') value",[signature]),false);
 }
});

test('administrator is scoped to the active company, including options and statement lines',async t=>{
 await tx(t);await assumeSecurityUser(db,4,5,1);
 assert.deepEqual((await options()).map(row=>Number(row.bank_account_id)),[1,2,4]);
 assert.deepEqual(await ids('bank_statement','statement_id'),[1]);assert.deepEqual(await ids('bank_statement_line','statement_line_id'),[1]);
 assert.equal(await value('select bank_statement_in_active_subsidiary(1) value'),true);assert.equal(await value('select bank_statement_in_active_subsidiary(2) value'),false);
 await assumeSecurityUser(db,4,5,2);
 assert.deepEqual((await options()).map(row=>Number(row.bank_account_id)),[3]);
 assert.deepEqual(await ids('bank_statement','statement_id'),[2]);assert.deepEqual(await ids('bank_statement_line','statement_line_id'),[2]);
});

test('assigned non-admin role switches visibility only with its active authorized company',async t=>{
 await tx(t);await assumeSecurityUser(db,1,1,1);assert.deepEqual(await ids('bank_statement','statement_id'),[1]);
 const first=(await options())[0];assert.equal(first.bank_name,'Synthetic bank');assert.equal(first.account_number,'DEMO-A');assert.equal(first.currency_code,'USD');assert.equal(Number(first.subsidiary_id),1);
 await assumeSecurityUser(db,1,1,2);assert.deepEqual(await ids('bank_statement','statement_id'),[2]);assert.deepEqual((await options()).map(row=>Number(row.subsidiary_id)),[2]);
});

test('reader keeps scoped reads and options but cannot invoke any lifecycle mutation',async t=>{
 await tx(t);await assumeSecurityUser(db,1,3,1);assert.deepEqual(await ids('bank_statement','statement_id'),[1]);assert.equal((await options()).length,3);
 await deniedSql(db,'select save_bank_statement_metadata(null,$1)',[payload()]);
 await deniedSql(db,'select save_bank_statement_metadata(1,$1)',[payload({statement_date:'2026-10-31'})]);await deniedSql(db,'select delete_bank_statement(1)');
});

test('missing permission, unassigned role and unauthorized company cannot read or write',async t=>{
 await tx(t);
 for(const identity of[[2,4,1],[1,4,1],[3,1,2]]){await assumeSecurityUser(db,...identity);await hidden();await deniedLifecycle();}
});

test('revoked company membership invalidates existing context while other membership remains useful',async t=>{
 await tx(t);await db.exec('delete from user_subsidiaries where user_id=1 and subsidiary_id=1');
 await assumeSecurityUser(db,1,1,1);await hidden();await deniedLifecycle();
 await assumeSecurityUser(db,1,1,2);assert.deepEqual(await ids('bank_statement','statement_id'),[2]);
});

test('inactive user closes options and table visibility',async t=>{
 await tx(t);await db.exec('update users set is_active=false where user_id=1');
 await assumeSecurityUser(db,1,1,1);await hidden();await deniedLifecycle();
});

test('current device binding and ERP session revocation are honored by the banking predicates',async t=>{
 await tx(t);await assumeSecurityUser(db,1,1,1,2);await hidden();await deniedLifecycle();
 await db.exec('reset role;set role service_role');await db.query('select security_revoke_user_sessions(1)');
 await assumeSecurityUser(db,1,1,1);await hidden();await deniedLifecycle();
});

test('anonymous, service and identity-free sessions cannot use scoped bank statement data',async t=>{
 await tx(t);
 for(const role of['anon','service_role']){
  await assumeSqlRole(db,role);await deniedSql(db,'select * from bank_statement');await deniedSql(db,'select * from bank_statement_line');await deniedLifecycle();
 }
 await assumeSqlRole(db,'authenticated');await hidden();await deniedLifecycle();
});

test('direct header and line DML stays closed even for a scoped administrator',async t=>{
 await tx(t);await assumeSecurityUser(db,4,5,1);
 const statements=[
  "insert into bank_statement(statement_date,bank_account_id,opening_balance,closing_balance) values('2026-12-01',1,0,1)",
  'update bank_statement set closing_balance=1 where statement_id=1','delete from bank_statement where statement_id=1',
  "insert into bank_statement_line(statement_id,bank_date,reference,amount,source_row) values(1,'2026-10-15','SYNTHETIC',1,9)",
  "update bank_statement_line set description='Synthetic' where statement_line_id=1",'delete from bank_statement_line where statement_line_id=1'
 ];
 for(const statement of statements)await deniedSql(db,statement);
 await deniedSql(db,'select reconciliation_private.identity()');
});

test('current metadata RPC creates, edits and deletes only its synthetic header and lines',async t=>{
 await tx(t);await assumeSecurityUser(db,1,1,1);const created=await save(payload()),id=Number(created.statement_id);assert.ok(id>2);assert.equal(Number(created.bank_account_id),1);
 const updated=await save(payload({closing_balance:131,source_file_name:'synthetic-edit.csv'}),id);assert.equal(Number(updated.closing_balance),131);assert.equal(updated.source_file_name,'synthetic-edit.csv');
 await db.exec('reset role');await db.query("insert into bank_statement_line(statement_id,bank_date,reference,amount,source_row) values($1,'2026-11-01','SYNTHETIC-DISPOSABLE',6,1)",[id]);
 await assumeSecurityUser(db,1,1,1);assert.deepEqual(await remove(id),{success:true});
 await db.exec('reset role');assert.deepEqual(await ids('bank_statement','statement_id'),[1,2]);assert.deepEqual(await ids('bank_statement_line','statement_line_id'),[1,2]);
 assert.deepEqual((await db.query('select balance::float8 value from bank_account order by bank_account_id')).rows.map(row=>row.value),[1000,1000,1000,1000]);
});

test('foreign target and destination bank are rejected even with lifecycle permissions',async t=>{
 await tx(t);await assumeSecurityUser(db,1,1,1);
 await deniedSql(db,'select save_bank_statement_metadata(null,$1)',[payload({bank_account_id:3})]);
 await deniedSql(db,'select save_bank_statement_metadata(2,$1)',[payload({statement_date:'2026-10-31'})]);
 await deniedSql(db,'select save_bank_statement_metadata(1,$1)',[payload({statement_date:'2026-10-31',bank_account_id:3})]);await deniedSql(db,'select delete_bank_statement(2)');
});

test('create-only and edit-only permissions cannot substitute for each other or delete',async t=>{
 await tx(t);await db.exec("insert into roles(role_id,role_name,is_system_role) values(6,'Synthetic creator',false);insert into user_roles(user_id,role_id) values(1,6);insert into role_access_matrix(role_id,resource_key,can_view,can_create,can_edit,can_delete) values(6,'banking:bank-statements',true,true,false,false)");
 await assumeSecurityUser(db,1,6,1);const created=await save(payload()),id=Number(created.statement_id);
 await deniedSql(db,'select save_bank_statement_metadata($1,$2)',[id,payload({closing_balance:132})]);await deniedSql(db,'select delete_bank_statement($1)',[id]);
 await assumeSecurityUser(db,1,2,1);assert.equal(Number((await save(payload({closing_balance:133}),id)).closing_balance),133);
 await deniedSql(db,'select save_bank_statement_metadata(null,$1)',[payload({bank_account_id:2})]);await deniedSql(db,'select delete_bank_statement($1)',[id]);
});

test('reconciled lines and parent usage continue to protect metadata and deletion',async t=>{
 await tx(t);await db.exec("update bank_statement_line set reconciliation_status='CONCILIADO' where statement_line_id=1");await assumeSecurityUser(db,1,1,1);
 await deniedSql(db,'select save_bank_statement_metadata(1,$1)',[payload({statement_date:'2026-10-31'})],'55000');await deniedSql(db,'select delete_bank_statement(1)',[],'55000');
 await db.exec("reset role;update bank_statement_line set reconciliation_status='PENDIENTE' where statement_line_id=1");await assumeSecurityUser(db,1,1,1);
 await deniedSql(db,'select save_bank_statement_metadata(1,$1)',[payload({statement_date:'2026-10-31',bank_account_id:2})],'55000');
 await db.exec("reset role;insert into bank_reconciliation(reconciliation_date,bank_account_id,fiscal_period_id,status) values('2026-10-31',1,10,'CERRADA')");
 await assumeSecurityUser(db,1,1,1);
 await deniedSql(db,'select save_bank_statement_metadata(1,$1)',[payload({statement_date:'2026-10-31'})],'55000');await deniedSql(db,'select delete_bank_statement(1)',[],'55000');
});

test('invalid finite balances and unauthorized payload fields fail without creating rows',async t=>{
 await tx(t);await assumeSecurityUser(db,1,1,1);
 for(const balance of[null,'NaN','Infinity','-Infinity'])await deniedSql(db,'select save_bank_statement_metadata(null,$1)',[payload({opening_balance:balance})],'22023');
 await deniedSql(db,'select save_bank_statement_metadata(null,$1)',[payload({subsidiary_id:2})],'22023');
 assert.deepEqual(await ids('bank_statement','statement_id'),[1]);
});
