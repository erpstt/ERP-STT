import assert from 'node:assert/strict';
import {test,before,after} from 'node:test';
import {PGlite} from '@electric-sql/pglite';
import {setupJournalFormLoading} from './fixtures/setup-journal-form-loading.mjs';
const db=new PGlite();let installation;
before(async()=>installation=await setupJournalFormLoading(db));after(()=>db.close());
async function tx(t){await db.exec('reset role;begin');t.after(()=>db.exec('rollback;reset role'));}
async function assume(user=1,role=1,sid=1){
 await db.exec('reset role');
 await db.query("insert into user_role_sessions values('fixture',$1,$2) on conflict(session_id) do update set user_id=$1,role_id=$2",[user,role]);
 await db.query("insert into user_company_sessions values('fixture',$1,$2) on conflict(session_id) do update set user_id=$1,subsidiary_id=$2",[user,sid]);
 await db.query("select set_config('request.jwt.claims',$1,false)",[JSON.stringify({sub:`00000000-0000-0000-0000-${String(user).padStart(12,'0')}`,session_id:'fixture'})]);
 await db.exec('set role authenticated');
}
async function denied(sql,args=[],code='42501'){
 await db.exec('savepoint denial');try{await assert.rejects(db.query(sql,args),error=>error.code===code,sql);}
 finally{await db.exec('rollback to savepoint denial;release savepoint denial');}
}
const payload={journal_type:'Asiento de Diario General',journal_date:'2026-10-10',currency_id:1,fiscal_period_id:10,exchange_rate:1,memo:'Synthetic',lines:[{account_id:101,debit:100,credit:0},{account_id:102,debit:0,credit:100}]};
const options=async(section='header',id=null)=>(await db.query('select manual_journal_form_options($1,$2) data',[section,id])).rows[0].data;
const create=async()=>(await db.query('select create_journal_entry($1) id',[payload])).rows[0].id;

test('header is a small authorized projection scoped to the active subsidiary',async t=>{
 await tx(t);await assume();const d=await options();
 assert.deepEqual(Object.keys(d).sort(),['transactionTypes','subsidiaries','locations','currencies','periods','rates'].sort());
 assert.deepEqual(d.transactionTypes.map(x=>x.abbreviation),['ASI_DIA','ASI_PEN','ASI_NOM','ASI_LIQ']);
 assert.deepEqual(d.subsidiaries.map(x=>x.subsidiary_id),[1]);assert.deepEqual(d.subsidiaries[0].allowed_currency_ids,[2]);
 assert.deepEqual(d.locations.map(x=>x.location_id),[1]);assert.deepEqual(d.periods.map(x=>x.fiscal_period_id),[10]);
 assert.equal(d.rates.length,1);assert.equal(d.rates[0].to_currency_id,1);
 assert.ok(JSON.stringify(d).length<3000);assert.ok(!JSON.stringify(d).includes('file_data'));
});

test('line catalogs expose only usable scoped references and no bank or private contact fields',async t=>{
 await tx(t);await assume();const d=await options('lines');
 assert.deepEqual(Object.keys(d).sort(),['accounts','taxes','taxTypes','departments','classes','costs','creditors','related','customers','suppliers','employees','countries'].sort());
 assert.ok(d.accounts.some(x=>x.account_id===101));assert.ok(!d.accounts.some(x=>x.account_id===104));
 assert.deepEqual(d.customers.map(x=>x.customer_id),[10]);assert.deepEqual(d.suppliers.map(x=>x.supplier_id),[10]);
 assert.deepEqual(d.employees.map(x=>x.employee_id),[10]);assert.deepEqual(d.taxes.map(x=>x.tax_code_id),[1]);assert.deepEqual(d.taxTypes.map(x=>x.tax_type_id),[1]);
 assert.ok(!d.departments.some(x=>x.department_id===22));assert.ok(d.departments.every(x=>x.subsidiary_ids.includes(1)));
 const raw=JSON.stringify(d);assert.doesNotMatch(raw,/SECRET BANK DATA|private@example|payment_iban|file_data|created_by/);
 await denied('select * from journal_support');
});

test('new and existing forms require distinct create or edit actions, not a different assigned role',async t=>{
 await tx(t);await assume();const id=await create();
 await assume(1,2);await denied("select manual_journal_form_options('header',null)");assert.equal((await options('header',id)).subsidiaries[0].subsidiary_id,1);
 await assume(1,3);await denied("select manual_journal_form_options('header',null)");await denied('select manual_journal_form_detail($1)',[id]);
 await assume(2,4);await denied("select manual_journal_form_options('lines',null)");await denied('select manual_journal_form_supports($1)',[id]);
 await assume();await db.exec('reset role;update role_access_matrix set can_edit=false where role_id=1');await assume();
 await denied('select manual_journal_form_detail($1)',[id]);
});

test('detail returns only the selected manual journal and its own lines',async t=>{
 await tx(t);await assume();const id=await create(),other=await create();
 const d=(await db.query('select manual_journal_form_detail($1) data',[id])).rows[0].data;
 assert.equal(d.journal.journal_id,id);assert.equal(d.lines.length,2);assert.ok(d.lines.every(x=>x.journal_id===id&&x.journal_id!==other));
 assert.equal(d.journal.memo,'Synthetic');assert.equal(d.journal.exchange_rate,1);assert.ok(!('supports' in d));
 await denied('select manual_journal_form_detail(0)',[],'22023');await denied('select manual_journal_form_detail(null)',[],'22023');
 await denied('select manual_journal_form_detail(999999)');
});

test('detail, options and lazy supports reject foreign subsidiaries and automatic or terminal journals',async t=>{
 await tx(t);await assume();const id=await create();
 await db.exec(`reset role;update journal set subsidiary_id=2 where journal_id=${id}`);await assume();
 for(const sql of ['select manual_journal_form_detail($1)','select manual_journal_form_supports($1)',"select manual_journal_form_options('lines',$1)"])await denied(sql,[id]);
 await db.exec(`reset role;update journal set subsidiary_id=1,journal_type='Automatic' where journal_id=${id}`);await assume();await denied('select manual_journal_form_detail($1)',[id]);
 await db.exec(`reset role;update journal set journal_type='Asiento de Diario General',status='ANULADO' where journal_id=${id}`);await assume();await denied('select manual_journal_form_supports($1)',[id]);
});

test('attachments are requested separately and only for the authorized selected journal',async t=>{
 await tx(t);await assume();const id=await create(),other=await create();
 await db.exec('reset role');await db.query("insert into journal_support values(1,$1,'Archivo','Own document',null,'own.txt','text/plain',10,'data:text/plain;base64,T1dO'),(2,$2,'Archivo','Other document',null,'other.txt','text/plain',10,'OTHER SECRET')",[id,other]);await assume();
 assert.ok(!JSON.stringify(await options()).includes('T1dO'));assert.ok(!JSON.stringify(await options('lines',id)).includes('T1dO'));
 const d=(await db.query('select manual_journal_form_supports($1) data',[id])).rows[0].data;
 assert.equal(d.length,1);assert.equal(d[0].journal_id,id);assert.equal(d[0].file_data,'data:text/plain;base64,T1dO');assert.doesNotMatch(JSON.stringify(d),/OTHER SECRET|Other document/);
});

test('role or membership revocation denies fresh option and support reads',async t=>{
 await tx(t);await assume();const id=await create();
 await db.exec('reset role;delete from user_subsidiaries where user_id=1 and subsidiary_id=1');await assume();await denied("select manual_journal_form_options('header',null)");await denied('select manual_journal_form_supports($1)',[id]);
});

test('new schema usage leaves every pre-existing private helper closed and ACL unchanged',async t=>{
 await tx(t);
 const current=(await db.query('select oid,proname,proacl::text,prosecdef,proconfig from pg_proc where oid=any($1) order by oid',[installation.acl.map(x=>x.oid)])).rows;
 assert.deepEqual(current,installation.acl);
 const old=(await db.query("select p.proname,has_function_privilege('authenticated',p.oid,'execute') allowed from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='journal_entry_private' and p.oid=any($1)",[installation.acl.map(x=>x.oid)])).rows;
 assert.ok(old.every(x=>x.allowed===false));
 await assume();await denied("select journal_entry_private.create_journal_entry('{}')");await denied('select journal_entry_private.form_context(null)');
 await denied('delete from journal');await denied('truncate journal_line');
});

test('anonymous and service roles cannot call any new RPC or private projection',async t=>{
 await tx(t);
 for(const role of ['anon','service_role']){await db.exec('reset role;set role '+role);for(const sql of ["select manual_journal_form_options('header',null)",'select manual_journal_form_detail(1)','select manual_journal_form_supports(1)',"select journal_entry_private.form_options('lines',null)"])await denied(sql);}
});

test('read projections cannot create accounting records and reject unsupported sections',async t=>{
 await tx(t);await assume();const before=(await db.query('select count(*) n from journal')).rows[0].n;
 await options();await options('lines');await denied("select manual_journal_form_options('unknown',null)",[],'22023');
 assert.equal((await db.query('select count(*) n from journal')).rows[0].n,before);
});
