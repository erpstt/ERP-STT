import assert from 'node:assert/strict';
import {test,before,after} from 'node:test';
import {readFile} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
const db=new PGlite();
const bank='banking:bank-accounts',book='accounting:accounting-books';
before(async()=>{
 await db.exec(`create role anon;create role authenticated;create role service_role bypassrls;create schema auth;
 create function auth.uid()returns uuid language sql stable as $$select nullif(current_setting('fixture.uid',true),'')::uuid$$;
 create function app_user_id()returns bigint language sql stable as $$select nullif(current_setting('fixture.user',true),'')::bigint$$;
 create function app_active_role_id()returns bigint language sql stable as $$select nullif(current_setting('fixture.role',true),'')::bigint$$;
 create function active_subsidiary_id()returns bigint language sql stable as $$select nullif(current_setting('fixture.sid',true),'')::bigint$$;
 create function active_subsidiary_id_without_report_context()returns bigint language sql stable as $$select active_subsidiary_id()$$;
 create table users(user_id bigint primary key,is_active boolean);insert into users values(1,true),(2,true),(3,false);
 create table user_roles(user_id bigint,role_id bigint);insert into user_roles select 1,x from generate_series(10,16)x;insert into user_roles values(2,99),(3,10);
 create table user_subsidiaries(user_id bigint,subsidiary_id bigint);insert into user_subsidiaries values(1,1),(1,2),(2,1),(3,1);
 create table grants(role_id bigint,resource text,v boolean,c boolean,e boolean,d boolean);
 insert into grants values(10,'${bank}',true,false,false,false),(11,'${book}',true,false,false,false),(12,'${book}',true,true,false,false),(13,'${book}',true,false,true,false),(14,'${book}',true,false,false,true),(15,'${book}',false,true,true,true),(16,'reports:accounting-reports',true,false,false,false);
 create function app_is_admin()returns boolean language sql stable as $$select app_user_id()=2$$;
 create function security_assert_role_access(r text,a text)returns void language plpgsql stable security definer set search_path=public as $$begin if app_is_admin()then return;end if;if not exists(select 1 from grants where role_id=app_active_role_id()and resource=r and case a when'view'then v when'create'then c when'edit'then e when'delete'then d else false end)then raise exception using errcode='42501';end if;end$$;
 create table bank_account(bank_account_id bigint primary key,subsidiary_id bigint,account_number text,balance numeric);
 create table accounting_books(accounting_book_id bigint primary key,subsidiary_id bigint,book_name text);
 insert into bank_account values(1,1,'SYNTHETIC-ONE',10),(2,2,'SYNTHETIC-TWO',20);insert into accounting_books values(1,1,'Synthetic one'),(2,2,'Synthetic two');
 alter table bank_account enable row level security;alter table accounting_books enable row level security;
 create policy company_select on bank_account for select to authenticated using(app_is_admin()or subsidiary_id=active_subsidiary_id_without_report_context());
 create policy company_select on accounting_books for select to authenticated using(app_is_admin()or subsidiary_id=active_subsidiary_id_without_report_context());
 create policy company_insert on accounting_books for insert to authenticated with check(app_is_admin()or subsidiary_id=active_subsidiary_id_without_report_context());
 create policy company_update on accounting_books for update to authenticated using(app_is_admin()or subsidiary_id=active_subsidiary_id_without_report_context())with check(app_is_admin()or subsidiary_id=active_subsidiary_id_without_report_context());
 create policy company_delete on accounting_books for delete to authenticated using(app_is_admin()or subsidiary_id=active_subsidiary_id_without_report_context());
 grant select on bank_account to authenticated;grant all on bank_account,accounting_books to anon;grant select,insert,update,delete on accounting_books to authenticated;
 create schema report_template_private;revoke all on schema report_template_private from public;
 `);
 const previous=await readFile('supabase/migrations/20261103032056_secure_financial_reports_pdf_templates.sql','utf8');
 const enter=previous.match(/create function report_template_private.enter[\s\S]*?end\$\$;/)[0];await db.exec(enter);
 // Stand-ins model the unchanged SECURITY DEFINER report/operational RPC architecture.
 await db.exec(`create function synthetic_report_lookup()returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$declare sid bigint;begin sid:=report_template_private.enter('reports:accounting-reports','view');return jsonb_build_object('accounts',(select count(*)from bank_account where subsidiary_id=sid),'books',(select count(*)from accounting_books where subsidiary_id=sid));end$$;revoke all on function synthetic_report_lookup()from public;grant execute on function synthetic_report_lookup()to authenticated;`);
 await db.exec('begin;'+await readFile('supabase/migrations/20261103221257_secure_financial_catalog_direct_access.sql','utf8')+'commit;');
});
after(()=>db.close());
async function assume(user=1,role=10,sid=1,uid=true){await db.exec('reset role');await db.query("select set_config('fixture.user',$1,false),set_config('fixture.role',$2,false),set_config('fixture.sid',$3,false),set_config('fixture.uid',$4,false)",[String(user??''),String(role??''),String(sid??''),uid?'00000000-0000-4000-8000-000000000001':'']);await db.exec('set role authenticated');}
async function tx(t){await db.exec('reset role;begin');t.after(()=>db.exec('rollback;reset role'));}
async function reject(sql){await db.exec('savepoint denied');try{await assert.rejects(db.exec(sql),e=>e.code==='42501');}finally{await db.exec('rollback to savepoint denied;release savepoint denied');}}
const counts=async()=>(await db.query('select (select count(*)from bank_account)::int bank,(select count(*)from accounting_books)::int book')).rows[0];
test('bank and book permissions are independent; reports do not grant raw catalog access',async t=>{await tx(t);for(const[role,expected]of [[10,{bank:1,book:0}],[11,{bank:0,book:1}],[16,{bank:0,book:0}],[15,{bank:0,book:0}]]){await assume(1,role);assert.deepEqual(await counts(),expected);}});
test('missing, inactive, revoked role/company and absent Auth identity all hide both catalogs',async t=>{await tx(t);for(const c of [[null,null,null,false],[1,999,1],[1,10,99],[3,10,1],[1,10,1,false],[2,99,2]]){await assume(...c);assert.deepEqual(await counts(),{bank:0,book:0});}await assume(1,10);await db.exec('reset role;delete from user_roles where user_id=1 and role_id=10;set role authenticated');assert.deepEqual(await counts(),{bank:0,book:0});});
test('assigned company switch works; administrator is scoped and validates selected context',async t=>{await tx(t);await assume(1,10,2);assert.equal((await db.query('select bank_account_id from bank_account')).rows[0].bank_account_id,2);await assume(2,99,1);assert.deepEqual(await counts(),{bank:1,book:1});await assume(2,98,1);assert.deepEqual(await counts(),{bank:0,book:0});});
test('book creation requires view and create; reader cannot insert or mutate banks',async t=>{await tx(t);for(const role of [10,11,13,14,15,16]){await assume(1,role);await reject("insert into accounting_books values(9,1,'Synthetic new')");}await assume(1,12);await db.exec("insert into accounting_books values(9,1,'Synthetic new')");await reject("insert into accounting_books values(10,2,'Foreign')");await reject("insert into accounting_books values(11,null,'No company')");await reject("insert into bank_account values(9,1,'SYN',0)");});
test('book edit checks old and new company and keeps independent action grants',async t=>{await tx(t);await assume(1,11);assert.equal((await db.query("update accounting_books set book_name='Denied'where accounting_book_id=1 returning *")).rows.length,0);await assume(1,13);assert.equal((await db.query("update accounting_books set book_name='Updated'where accounting_book_id=1 returning *")).rows[0].book_name,'Updated');await reject('update accounting_books set subsidiary_id=2 where accounting_book_id=1');assert.equal((await db.query("update accounting_books set book_name='Denied'where accounting_book_id=2 returning *")).rows.length,0);});
test('book delete needs its own grant; bank writes stay revoked',async t=>{await tx(t);await assume(1,13);assert.equal((await db.query('delete from accounting_books where accounting_book_id=1 returning *')).rows.length,0);await assume(1,14);assert.equal((await db.query('delete from accounting_books where accounting_book_id=2 returning *')).rows.length,0);assert.equal((await db.query('delete from accounting_books where accounting_book_id=1 returning *')).rows.length,1);await reject('delete from bank_account');await reject('update bank_account set balance=999');});
test('anonymous privileges and private helper are closed; invalid helper parameters deny',async t=>{await tx(t);await assume();assert.equal((await db.query("select finance_catalog_private.allowed(null,null) v")).rows[0].v,false);assert.equal((await db.query("select finance_catalog_private.allowed('security:users','view') v")).rows[0].v,false);await db.exec('reset role;set role anon');await reject('select * from accounting_books');await reject('select * from bank_account');await reject("select finance_catalog_private.allowed('banking:bank-accounts','view')");await db.exec('reset role;set role service_role');await reject("select finance_catalog_private.allowed('banking:bank-accounts','view')");});
test('authorized definer report lookups retain company scope without raw catalog grants',async t=>{await tx(t);await assume(1,16);assert.deepEqual(await counts(),{bank:0,book:0});assert.deepEqual((await db.query('select synthetic_report_lookup() d')).rows[0].d,{accounts:1,books:1});await assume(1,16,2);assert.deepEqual((await db.query('select synthetic_report_lookup() d')).rows[0].d,{accounts:1,books:1});await assume(1,10);await reject('select synthetic_report_lookup()');});
