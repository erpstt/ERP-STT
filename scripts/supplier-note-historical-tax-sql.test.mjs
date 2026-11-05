import assert from 'node:assert/strict';
import {before,after,test} from 'node:test';
import {readFile} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
import {setupSupplierNoteSecurity} from './fixtures/setup-supplier-note-security.mjs';
import {assertIsolatedTestArgs} from './lib/migration-preview.mjs';
assertIsolatedTestArgs();
const db=new PGlite();
export const historicalTaxMigration='20261105170834_preserve_supplier_note_historical_tax_rate.sql';
const migration=()=>readFile(new URL('../supabase/migrations/'+historicalTaxMigration,import.meta.url),'utf8').then(s=>s.replace(/\r\n/g,'\n'));
const q=async(sql,p=[])=>(await db.query(sql,p)).rows[0]?.d;
let oldDefinition,metadataBefore,oldSource;
const metadata=async()=>(await db.query("select oid,proowner,proacl::text,proconfig,provolatile,prosecdef,proisstrict,proparallel from pg_proc where oid='supplier_note_private.prepare(text,jsonb,bigint)'::regprocedure")).rows;
const financialState=()=>q("select jsonb_build_object('notes',(select count(*)from supplier_note_line),'journals',(select count(*)from journal),'gl',(select count(*)from gl_impact),'roles',(select jsonb_agg(to_jsonb(r)order by role_id,resource_key)from role_access_matrix r))d");
async function assume(user=1,role=1,sid=1){await db.exec('reset role');await db.query("insert into user_role_sessions values('fixture',$1,$2)on conflict(session_id)do update set user_id=$1,role_id=$2",[user,role]);await db.query("insert into user_company_sessions values('fixture',$1,$2)on conflict(session_id)do update set user_id=$1,subsidiary_id=$2",[user,sid]);await db.query("select set_config('request.jwt.claims',$1,false)",[JSON.stringify({sub:`00000000-0000-0000-0000-${String(user).padStart(12,'0')}`,session_id:'fixture'})]);await db.exec('set role authenticated');}
async function tx(t){await db.exec('reset role;begin');t.after(()=>db.exec('rollback;reset role'));await assume();}
async function denied(sql,p=[],code='42501'){await db.exec('savepoint denial');try{await assert.rejects(db.query(sql,p),e=>e.code===code);}finally{await db.exec('rollback to denial;release denial');}}
const invoice={invoice_number:'SYN-TAX-INVOICE',invoice_type:'Factura estándar',supplier_id:10,payment_term_id:1,invoice_date:'2026-10-31',fiscal_period_id:10,currency_id:1,exchange_rate:1,memo:'Synthetic tax snapshot',lines:[{account_id:203,quantity:2,unit_price:50,tax_code_id:1,tax_rate:13,department_id:21}]};
async function seed(){return(await q('select save_supplier_invoice($1,null)d',[invoice])).invoiceId;}
const payload=(id,rate=13)=>({invoice_id:id,note_number:'SYN-TAX-NOTE',note_date:'2026-10-31',fiscal_period_id:10,currency_id:1,exchange_rate:1,memo:'Synthetic note',lines:[{account_id:203,amount:10,tax_code_id:1,tax_rate:rate,department_id:21}]});
const save=(kind,p,id=null)=>q('select save_supplier_note($1,$2,$3)d',[kind,p,id]);
async function setTax(rate){await db.exec('reset role');await db.query('update tax_codes set rate_percentage=$1 where tax_code_id=1',[rate]);await assume();}
async function historic(kind){const id=await seed();await setTax(5);const p=payload(id,5),note=await save(kind,p);await setTax(13);return{p,note};}
before(async()=>{await setupSupplierNoteSecurity(db);await db.exec("do $$begin execute replace(pg_get_functiondef('supplier_note_private.prepare(text,jsonb,bigint)'::regprocedure),E'\\r\\n',E'\\n');end$$;");oldDefinition=await q("select pg_get_functiondef('supplier_note_private.prepare(text,jsonb,bigint)'::regprocedure)d");oldSource=await q("select prosrc d from pg_proc where oid='supplier_note_private.prepare(text,jsonb,bigint)'::regprocedure");metadataBefore=await metadata();const data=await financialState();await db.exec(await migration());assert.deepEqual(await financialState(),data);});
after(()=>db.close());

test('tax patch preserves existing function identity, execution grants, attributes, and unrelated financial behavior',async t=>{
 await tx(t);await db.exec('reset role');assert.deepEqual(await metadata(),metadataBefore);
 const source=await q("select prosrc d from pg_proc where oid='supplier_note_private.prepare(text,jsonb,bigint)'::regprocedure");
 assert.notEqual(source,oldSource);assert.ok(source.includes('history.note_kind=k and history.note_id=nid'));
 await db.exec('savepoint drift');try{await assert.rejects(db.exec(await migration()),e=>e.code==='P0001');}finally{await db.exec('rollback to drift;release drift');}
});

for(const kind of ['CREDIT','DEBIT'])test(`${kind} note round-trips its own five-percent snapshot after the catalog changes to thirteen`,async t=>{
 await tx(t);const {p,note}=await historic(kind);assert.equal(note.total,10.5);
 await db.exec('reset role');await db.exec(oldDefinition);await assume();await denied('select save_supplier_note($1,$2,$3)',[kind,p,note.noteId],'22023');
 await db.exec('reset role');await db.exec(await migration());await assume();
 const result=await save(kind,{...p,memo:'Updated description only'},note.noteId);assert.equal(result.noteId,note.noteId);assert.equal(result.total,10.5);
 await db.exec('reset role');const stored=(await db.query('select tax_rate::float8 rate,tax_amount::float8 tax,gross_amount::float8 gross from supplier_note_line where note_kind=$1 and note_id=$2',[kind,note.noteId])).rows;
 assert.deepEqual(stored,[{rate:5,tax:0.5,gross:10.5}]);
 const sums=(await db.query('select sum(debit_amount)::float8 debit,sum(credit_amount)::float8 credit from gl_impact where transaction_id=(select transaction_id from journal where journal_id=$1)',[result.journalId])).rows[0];assert.deepEqual(sums,{debit:10.5,credit:10.5});
});

test('new notes and arbitrary rates still require the current authorized tax configuration',async t=>{
 await tx(t);const id=await seed();await denied('select save_supplier_note($1,$2,null)',['DEBIT',payload(id,5)],'22023');
 const note=await save('DEBIT',payload(id));assert.equal(note.total,11.3);
 await denied('select save_supplier_note($1,$2,$3)',['DEBIT',payload(id,6),note.noteId],'22023');
});

test('changing the original date requires the current rate while missing edit and wrong-company access remain denied',async t=>{
 await tx(t);const {p,note}=await historic('DEBIT');
 await denied('select save_supplier_note($1,$2,$3)',['DEBIT',{...p,note_date:'2026-10-30'},note.noteId],'22023');
 await assume(1,3);await denied('select save_supplier_note($1,$2,$3)',['DEBIT',p,note.noteId]);
 await assume(1,1,2);await denied('select save_supplier_note($1,$2,$3)',['DEBIT',p,note.noteId]);
 await assume();const current={...p,note_date:'2026-10-30',lines:[{...p.lines[0],tax_rate:13}]};assert.equal((await save('DEBIT',current,note.noteId)).total,11.3);
});
