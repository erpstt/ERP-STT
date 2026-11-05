import assert from'node:assert/strict';
import{before,after,test}from'node:test';
import{randomUUID}from'node:crypto';
import{PGlite}from'@electric-sql/pglite';
import{setupSupplierInvoicePerformance,applySupplierInvoicePerformanceMigration}from'./fixtures/setup-supplier-invoice-performance.mjs';
import{assertIsolatedTestArgs}from'./lib/migration-preview.mjs';
assertIsolatedTestArgs();
const db=new PGlite();let baseline,metadataBefore,otherSourcesBefore;
const invoice={invoice_number:'SYN-PERF',invoice_type:'Factura estándar',supplier_id:10,payment_term_id:1,invoice_date:'2026-10-31',fiscal_period_id:10,currency_id:1,exchange_rate:1,location_id:2,memo:'Synthetic invoice performance',lines:[{account_id:203,quantity:2,unit_price:50,tax_code_id:1,tax_rate:13,department_id:21}]};
const q=async(sql,p=[])=>(await db.query(sql,p)).rows[0]?.d;
const save=(p=invoice,id=null)=>q('select save_supplier_invoice($1,$2)d',[p,id]);
const context=()=>q("select coalesce(current_setting('nexo.defer_journal_gl_sync',true),'')d");
const setContext=v=>db.query("select set_config('nexo.defer_journal_gl_sync',$1,true)",[v]);
async function assume(user=1,role=1,sid=1){await db.exec('reset role');await db.query("insert into user_role_sessions values('fixture',$1,$2)on conflict(session_id)do update set user_id=$1,role_id=$2",[user,role]);await db.query("insert into user_company_sessions values('fixture',$1,$2)on conflict(session_id)do update set user_id=$1,subsidiary_id=$2",[user,sid]);await db.query("select set_config('request.jwt.claims',$1,false)",[JSON.stringify({sub:`00000000-0000-0000-0000-${String(user).padStart(12,'0')}`,session_id:'fixture'})]);await db.exec('set role authenticated');}
async function tx(t){await db.exec('reset role;begin');t.after(()=>db.exec('rollback;reset role'));await assume();}
async function denied(sql,p=[],code='42501'){await db.exec('savepoint denial');try{await assert.rejects(db.query(sql,p),e=>e.code===code);}finally{await db.exec('rollback to denial;release denial');}}
const counts=()=>q("select jsonb_build_array((select count(*)from supplier_invoice),(select count(*)from supplier_invoice_line),(select count(*)from journal),(select count(*)from journal_line),(select count(*)from gl_impact))d");
const metadata=async()=>(await db.query("select oid,proowner,proacl::text,proconfig,provolatile,prosecdef,proisstrict,proparallel,prorettype from pg_proc where oid='public.save_supplier_invoice(jsonb,bigint)'::regprocedure")).rows;
const otherSources=async()=>(await db.query("select oid::regprocedure::text signature,prosrc,proconfig,proacl::text from pg_proc where oid in('public.sync_journal_gl_impacts_trigger()'::regprocedure,'public.sync_journal_gl_impacts(bigint)'::regprocedure,'public.budget_run(text,jsonb,bigint)'::regprocedure,'purchase_receipt_private.invoice_engine(jsonb,bigint)'::regprocedure,'supplier_invoice_private.save_supplier_invoice_without_budget(jsonb,bigint)'::regprocedure,'supplier_invoice_private.save_supplier_invoice_without_budget_before_payable_routing(jsonb,bigint)'::regprocedure,'supplier_invoice_private.save_supplier_invoice_without_withholding(jsonb,bigint)'::regprocedure)order by oid")).rows;
async function snapshot(id){
 await db.exec('reset role');
 const result=await q(`select jsonb_build_object(
 'header',jsonb_build_array(i.invoice_type,i.subsidiary_id,i.supplier_id,i.currency_id,i.exchange_rate::text,i.location_id,i.total_amount::text,i.subtotal_amount::text,i.tax_total::text,i.withholding_total::text,i.payable_amount::text,i.payable_account_id,i.purchase_receipt_document_id is not null),
 'journal',(select jsonb_build_array(journal_type,subsidiary_id,currency_id,exchange_rate::text,fiscal_period_id,location_id,journal_date,status)from journal where journal_id=i.journal_id),
 'lines',(select jsonb_agg(jsonb_build_object('row',to_jsonb(l)-'journal_line_id'-'journal_id','debitExact',l.debit::text,'creditExact',l.credit::text)order by journal_line_id)from journal_line l where l.journal_id=i.journal_id),
 'gl',(select jsonb_agg(jsonb_build_array(account_id,subsidiary_id,fiscal_period_id,accounting_book_id,debit_amount::text,credit_amount::text,debit_fx::text,credit_fx::text,posting_date)order by account_id,debit_amount,credit_amount,debit_fx,credit_fx)from gl_impact where transaction_id=i.transaction_id),
 'difference',(select sum(debit_amount-credit_amount)::text from gl_impact where transaction_id=i.transaction_id))d from supplier_invoice i where invoice_id=$1`,[id]);
 await assume();return result;
}
async function precise(){await db.exec('reset role;insert into entity_withholding_rules(supplier_id,subsidiary_id,tax_code_id)values(10,1,2)');await assume();const r=await save({...invoice,currency_id:2,exchange_rate:'160.123456',lines:[{...invoice.lines[0],quantity:1,unit_price:'12.3456'},{...invoice.lines[0],quantity:1,unit_price:'0.1234'},{account_id:203,quantity:1,unit_price:'9.8765',tax_rate:0,department_id:21}]});return snapshot(r.invoiceId);}
async function edited(){const r=await save({...invoice,lines:Array.from({length:10},()=>({account_id:203,quantity:1,unit_price:10,tax_rate:0,department_id:21}))});await save({...invoice,lines:[{...invoice.lines[0],quantity:1,unit_price:25}]},r.invoiceId);return snapshot(r.invoiceId);}
async function routed(){const rows=[];for(const type of['Factura estándar','Factura Expense','Factura Caja Chica'])rows.push(await snapshot((await save({...invoice,invoice_type:type})).invoiceId));await db.exec('reset role;update suppliers set is_intercompany=true where supplier_id=10');await assume();rows.push(await snapshot((await save()).invoiceId));return rows;}
const assetPayload={...invoice,invoice_type:'Factura Activos Fijos',lines:[{...invoice.lines[0],account_id:201,department_id:null,es_activo_fijo:true}]};
async function asset(){const saved=await save(assetPayload);const accounting=await snapshot(saved.invoiceId);await db.exec('reset role');const proposals=await q("select jsonb_agg(jsonb_build_array(status,account_id,currency_id,amount_local::text,amount_foreign::text,department_id,cost_center_id,class_id,journal_line_id is not null,gl_impact_id is not null)order by account_id,amount_local)d from activos_fijos_propuestas where transaction_id=(select transaction_id from supplier_invoice where invoice_id=$1)",[saved.invoiceId]);await assume();return{accounting,proposals};}
async function receipt(){
 const head={date:'2026-10-31',supplier_id:10,currency_id:1,rate:1,period_id:10,location_id:2,status:'BORRADOR'},line={product_id:1,account_id:203,department_id:21,quantity:2,unit_cost:50,tax_code_id:1,tax_rate:13};
 const order=await q('select save_purchase_document($1,null)d',[{...head,type:'ORDER',lines:[line]}]);const workflow=await q("select wf_start_entity('PURCHASE_ORDER',$1,'{}')d",[order.id]);await assume(2,4);await q("select wf_act($1,'APROBAR',null,null)d",[workflow.id]);await assume();const source=await q('select purchase_document_detail($1)d',[order.id]);
 const received=await q('select save_purchase_document($1,null)d',[{...head,type:'RECEIPT',status:'RECIBIDO',operationId:randomUUID(),source_id:order.id,lines:[{...line,source_line_id:source.lines[0].line_id}]}]);await db.exec('reset role');const stock=await q('select jsonb_agg(to_jsonb(x))d from stock_movements x');await assume();
 const saved=await save({...invoice,purchase_receipt_document_id:received.id});const result=await snapshot(saved.invoiceId);await db.exec('reset role');assert.deepEqual(await q('select jsonb_agg(to_jsonb(x))d from stock_movements x'),stock);await assume();return result;
}
before(async()=>{
 await setupSupplierInvoicePerformance(db);metadataBefore=await metadata();otherSourcesBefore=await otherSources();baseline={};
 for(const[name,run]of Object.entries({precise,edited,routed,receipt,asset})){await db.exec('begin');try{await assume();baseline[name]=await run();}finally{await db.exec('rollback;reset role');}}
 assert.equal(await context(),'');await applySupplierInvoicePerformanceMigration(db);
});
after(()=>db.close());

test('an initially unset context preserves the exact baseline FX, tax, withholding and precision projection',async t=>{
 await tx(t);assert.equal(await context(),'');const actual=await precise();assert.deepEqual(actual,baseline.precise);assert.equal(Number(actual.difference),0);assert.equal(await context(),'');
});
test('editing removes old impacts and produces the exact baseline final journal and GL',async t=>{
 await tx(t);const actual=await edited();assert.deepEqual(actual,baseline.edited);assert.equal(actual.lines.length,2);assert.equal(actual.gl.length,3);assert.equal(Number(actual.difference),0);
});
test('all four payable routes retain their baseline accounts, totals and final GL',async t=>{
 await tx(t);const actual=await routed();assert.deepEqual(actual,baseline.routed);assert.deepEqual(actual.map(x=>x.header[11]),[301,303,304,302]);for(const row of actual)assert.equal(Number(row.difference),0);
});
test('receipt conversion preserves its accounting projection and does not duplicate stock',async t=>{
 await tx(t);assert.deepEqual(await receipt(),baseline.receipt);assert.equal(await context(),'');
});
test('fixed-asset invoice proposals remain identical and capitalization still protects the source',async t=>{
 await tx(t);assert.deepEqual(await asset(),baseline.asset);assert.equal(baseline.asset.proposals.length,1);await db.exec('reset role');const proposal=(await db.query("select proposal_id,transaction_id from activos_fijos_propuestas where transaction_id=(select transaction_id from supplier_invoice where invoice_number='SYN-PERF'and invoice_type='Factura Activos Fijos')")).rows[0];const id=await q('select invoice_id d from supplier_invoice where transaction_id=$1',[proposal.transaction_id]);await assume();await db.query('select process_fixed_asset_proposals($1)',[{action:'CAPITALIZE',ids:[proposal.proposal_id],date:'2026-10-31',name:'Synthetic performance PPE',category_id:1,location_id:1}]);await setContext('off');await denied('select save_supplier_invoice($1,$2)',[assetPayload,id],'55000');assert.equal(await context(),'off');
});
test('existing caller on and off values are restored while explicit final synchronizations still complete',async t=>{
 await tx(t);for(const flag of['on','off']){await setContext(flag);const saved=await save({...invoice,invoice_number:'SYN-CALLER-'+flag});const actual=await snapshot(saved.invoiceId);assert.equal(await context(),flag);assert.equal(Number(actual.difference),0);assert.equal(actual.gl.length,3);}
 await setContext('off');const saved=await save();await db.exec('reset role');await db.query('update journal_line set debit=debit+1,debit_fx=debit_fx+1 where journal_id=$1 and debit>0',[saved.journalId]);assert.equal(await q('select sum(debit_amount-credit_amount)::float8 d from gl_impact where transaction_id=(select transaction_id from supplier_invoice where invoice_id=$1)',[saved.invoiceId]),1.13,'Ordinary row synchronization still updates principal and 13% tax after the invoice returns');
});
test('a failure during actual final GL posting rolls back the invoice and restores the caller context',async t=>{
 await tx(t);await db.exec("reset role;create function synthetic_reject_invoice_gl()returns trigger language plpgsql as $$begin if new.account_id=203 then raise exception 'Synthetic final GL write failure';end if;return new;end$$;create trigger synthetic_reject_invoice_gl before insert on gl_impact for each row execute function synthetic_reject_invoice_gl()");const before=await counts();await assume();
 for(const flag of['','off','on']){await setContext(flag);await denied('select save_supplier_invoice($1,null)',[invoice],'P0001');assert.equal(await context(),flag);await db.exec('reset role');assert.deepEqual(await counts(),before);await assume();}
});
test('HARD budget failure restores the context and leaves no document or stale impacts',async t=>{
 await tx(t);await db.exec("reset role;update fixture_budget set mode='HARD_LOCK'");const before=await counts();await assume();await setContext('on');await denied('select save_supplier_invoice($1,null)',[invoice],'PT422');assert.equal(await context(),'on');await db.exec('reset role');assert.deepEqual(await counts(),before);
});
test('SOFT budget pending restores context, rolls back GL and permits exactly one approved retry',async t=>{
 await tx(t);await db.exec("reset role;update fixture_budget set mode='SOFT_LOCK'");const before=await counts();await assume();await setContext('off');const pending=await save();assert.equal(pending.budgetPending,true);assert.equal(await context(),'off');await db.exec('reset role');assert.deepEqual(await counts(),before);assert.deepEqual(await q('select payload d from budget_overrides where id=$1',[pending.budgetRequestId]),invoice);await db.query("update budget_overrides set status='APROBADO'where id=$1",[pending.budgetRequestId]);await assume();const saved=await save();assert.ok(saved.invoiceId);assert.equal(await context(),'off');assert.equal(Number((await snapshot(saved.invoiceId)).difference),0);await denied('select save_supplier_invoice($1,null)',[invoice],'P0001');assert.equal(await context(),'off');
});
test('permissions, metadata and every financial engine and global trigger remain unchanged',async t=>{
 await tx(t);await setContext('off');for(const args of[[1,3,1],[1,5,1],[3,1,2]]){await assume(...args);await denied('select save_supplier_invoice($1,null)',[invoice]);assert.equal(await context(),'off');}await db.exec('reset role');assert.deepEqual(await metadata(),metadataBefore);assert.deepEqual(await otherSources(),otherSourcesBefore);
});
