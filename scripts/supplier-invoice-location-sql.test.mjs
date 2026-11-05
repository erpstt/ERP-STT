import assert from'node:assert/strict';
import{before,after,test}from'node:test';
import{randomUUID}from'node:crypto';
import{PGlite}from'@electric-sql/pglite';
import{setupSupplierInvoiceLocation,applySupplierInvoiceLocationMigration}from'./fixtures/setup-supplier-invoice-location.mjs';
import{assertIsolatedTestArgs}from'./lib/migration-preview.mjs';
assertIsolatedTestArgs();
const db=new PGlite();let metadataBefore,wrappersBefore,storedBefore,reproducedLocation;
const invoice={invoice_number:'SYN-LOCATION',invoice_type:'Factura estándar',supplier_id:10,payment_term_id:1,invoice_date:'2026-10-31',fiscal_period_id:10,currency_id:1,exchange_rate:1,memo:'Synthetic selected location',lines:[{account_id:203,quantity:2,unit_price:50,tax_code_id:1,tax_rate:13,department_id:21}]};
const q=async(sql,p=[])=>(await db.query(sql,p)).rows[0]?.d;
const save=(p=invoice,id=null)=>q('select save_supplier_invoice($1,$2)d',[p,id]);
async function assume(user=1,role=1,sid=1){await db.exec('reset role');await db.query("insert into user_role_sessions values('fixture',$1,$2)on conflict(session_id)do update set user_id=$1,role_id=$2",[user,role]);await db.query("insert into user_company_sessions values('fixture',$1,$2)on conflict(session_id)do update set user_id=$1,subsidiary_id=$2",[user,sid]);await db.query("select set_config('request.jwt.claims',$1,false)",[JSON.stringify({sub:`00000000-0000-0000-0000-${String(user).padStart(12,'0')}`,session_id:'fixture'})]);await db.exec('set role authenticated');}
async function tx(t){await db.exec('reset role;begin');t.after(()=>db.exec('rollback;reset role'));await assume();}
async function denied(sql,p=[],code='42501'){await db.exec('savepoint denial');try{await assert.rejects(db.query(sql,p),e=>e.code===code);}finally{await db.exec('rollback to denial;release denial');}}
const metadata=async()=>(await db.query("select oid,oid::regprocedure::text signature,proowner,proacl::text,proconfig,provolatile,prosecdef,proisstrict,proparallel from pg_proc where oid in('public.save_supplier_invoice(jsonb,bigint)'::regprocedure,'supplier_invoice_private.prepare(jsonb,bigint)'::regprocedure,'supplier_invoice_private.prepare_before_receipt(jsonb,bigint)'::regprocedure,'supplier_invoice_private.save_supplier_invoice_without_withholding(jsonb,bigint)'::regprocedure,'supplier_invoice_private.save_supplier_invoice_without_budget_before_payable_routing(jsonb,bigint)'::regprocedure,'purchase_receipt_private.invoice_binding(jsonb)'::regprocedure)order by oid")).rows;
const wrappers=async()=>(await db.query("select oid,prosrc from pg_proc where oid in('public.save_supplier_invoice(jsonb,bigint)'::regprocedure,'supplier_invoice_private.prepare(jsonb,bigint)'::regprocedure,'purchase_receipt_private.invoice_binding(jsonb)'::regprocedure)order by oid")).rows;
const stored=()=>q("select jsonb_build_object('invoice',(select jsonb_agg(to_jsonb(x)order by invoice_id)from supplier_invoice x),'journal',(select jsonb_agg(to_jsonb(x)order by journal_id)from journal x),'lines',(select jsonb_agg(to_jsonb(x)order by journal_line_id)from journal_line x),'gl',(select jsonb_agg(to_jsonb(x)order by gl_impact_id)from gl_impact x),'stock',(select jsonb_agg(to_jsonb(x))from stock_movements x))d");
async function checkLocation(id,expected,total=113){
 await db.exec('reset role');const header=(await db.query('select location_id,journal_id,transaction_id from supplier_invoice where invoice_id=$1',[id])).rows[0];assert.equal(header.location_id,expected);
 assert.equal(await q('select location_id d from journal where journal_id=$1',[header.journal_id]),expected);
 assert.deepEqual((await db.query('select distinct location_id from journal_line where journal_id=$1',[header.journal_id])).rows,[{location_id:expected}]);
 assert.deepEqual((await db.query('select sum(debit_amount)::float8 debit,sum(credit_amount)::float8 credit from gl_impact where transaction_id=$1',[header.transaction_id])).rows[0],{debit:total,credit:total});
 await assume();return header;
}
before(async()=>{
 await setupSupplierInvoiceLocation(db);await db.exec('begin');await assume();const baseline=await save({...invoice,location_id:2});await db.exec('reset role');reproducedLocation=await q('select location_id d from supplier_invoice where invoice_id=$1',[baseline.invoiceId]);await db.exec('rollback');
 metadataBefore=await metadata();wrappersBefore=await wrappers();storedBefore=await stored();await applySupplierInvoiceLocationMigration(db);
});
after(()=>db.close());

test('a second selected location replaces the reproduced first-location behavior in header, journal and every line without changing GL amounts',async t=>{
 await tx(t);assert.equal(reproducedLocation,1,'The original engine ignores the explicit second location');const r=await save({...invoice,location_id:2});await checkLocation(r.invoiceId,2);
 await db.exec('reset role;insert into entity_withholding_rules(supplier_id,subsidiary_id,tax_code_id)values(10,1,2)');await assume();
 const retained=await save({...invoice,invoice_number:'SYN-LOCATION-WITHHOLDING',location_id:2});assert.equal(retained.withholdingAtInvoice,2);assert.equal(retained.payableTotal,111);await checkLocation(retained.invoiceId,2);
});

test('editing with an omitted location preserves the actual selection and an explicit valid change updates all accounting dimensions',async t=>{
 await tx(t);const r=await save({...invoice,location_id:2});const changed={...invoice,lines:[{...invoice.lines[0],unit_price:60}]};await save(changed,r.invoiceId);await checkLocation(r.invoiceId,2,135.6);await save({...changed,location_id:1},r.invoiceId);await checkLocation(r.invoiceId,1,135.6);
});

test('explicit empty, invalid or foreign locations are rejected atomically',async t=>{
 await tx(t);await db.exec('reset role');const before=await stored();await assume();
 for(const location_id of[null,'',0,-1,'wrong',1.5,{},[],9007199254740992])await denied('select save_supplier_invoice($1,null)',[{...invoice,location_id}],'22023');
 for(const location_id of[9,999])await denied('select save_supplier_invoice($1,null)',[{...invoice,location_id}]);await db.exec('reset role');assert.deepEqual(await stored(),before);
});

test('omitted creation keeps the historical default while owned and explicitly shared locations remain available',async t=>{
 await tx(t);await checkLocation((await save()).invoiceId,1);await checkLocation((await save({...invoice,location_id:3})).invoiceId,3);await checkLocation((await save({...invoice,location_id:'4'})).invoiceId,4);
});

test('receipt conversion preserves its location and rejects a conflicting explicit choice without touching stock or posting a partial invoice',async t=>{
 await tx(t);const head={date:'2026-10-31',supplier_id:10,currency_id:1,rate:1,period_id:10,location_id:2,status:'BORRADOR'},line={product_id:1,account_id:203,department_id:21,quantity:2,unit_cost:50,tax_code_id:1,tax_rate:13};
 const order=await q('select save_purchase_document($1,null)d',[{...head,type:'ORDER',lines:[line]}]);const workflow=await q("select wf_start_entity('PURCHASE_ORDER',$1,'{}')d",[order.id]);await assume(2,4);await q("select wf_act($1,'APROBAR',null,null)d",[workflow.id]);await assume();const source=await q('select purchase_document_detail($1)d',[order.id]);
 const receipt=await q('select save_purchase_document($1,null)d',[{...head,type:'RECEIPT',status:'RECIBIDO',operationId:randomUUID(),source_id:order.id,lines:[{...line,source_line_id:source.lines[0].line_id}]}]);
 await db.exec('reset role');const before=await q('select jsonb_agg(to_jsonb(x))d from stock_movements x');await assume();const p={...invoice,purchase_receipt_document_id:receipt.id};await denied('select save_supplier_invoice($1,null)',[{...p,location_id:1}]);const saved=await save(p);await checkLocation(saved.invoiceId,2);
 await db.exec('reset role');assert.deepEqual(await q('select jsonb_agg(to_jsonb(x))d from stock_movements x'),before);
});

test('location support does not reopen protected history, change role guards or expose private helpers',async t=>{
 await tx(t);const r=await save({...invoice,location_id:2});await db.exec('reset role');await db.query('insert into supplier_payment_application(invoice_id,amount)values($1,1)',[r.invoiceId]);await assume();await denied('select save_supplier_invoice($1,$2)',[{...invoice,location_id:1},r.invoiceId],'55000');
 await assume(1,3);await denied('select save_supplier_invoice($1,null)',[{...invoice,location_id:2}]);await denied('select supplier_invoice_private.resolve_location($1,null)',[{location_id:2}]);
});

test('positive foreign invoice, credit note and supplier payment retain native amounts, balanced local GL and selected location',async t=>{
 await tx(t);const inv=await save({...invoice,currency_id:2,exchange_rate:160,location_id:2});await checkLocation(inv.invoiceId,2,18080);
 const note=await q("select save_supplier_note('CREDIT',$1,null)d",[{invoice_id:inv.invoiceId,note_number:'SYN-FX-NOTE',note_date:'2026-10-31',fiscal_period_id:10,currency_id:2,exchange_rate:160,lines:[{account_id:203,amount:10,tax_code_id:1,tax_rate:13,department_id:21}]}]);assert.equal(note.total,11.3);
 const payment=await q('select save_supplier_payment_with_advances($1,null)d',[{date:'2026-10-31',period_id:10,supplier_id:10,account_id:2,rate:160,location_id:2,reference:'SYN-FX-PAYMENT',applications:[{invoice_id:inv.invoiceId,amount:101.7}],advances:[]}]);
 await db.exec('reset role');for(const[journal,total,native]of[[note.journalId,1808,11.3],[payment.journalId,16272,101.7]]){
  assert.equal(await q('select location_id d from journal where journal_id=$1',[journal]),2);assert.deepEqual((await db.query('select sum(debit_amount)::float8 debit,sum(credit_amount)::float8 credit,sum(debit_fx)::float8 debit_fx,sum(credit_fx)::float8 credit_fx from gl_impact where transaction_id=(select transaction_id from journal where journal_id=$1)',[journal])).rows[0],{debit:total,credit:total,debit_fx:native,credit_fx:native});
 }
 assert.equal(await q('select sum(g.debit_amount-g.credit_amount)::float8 d from gl_impact g where g.account_id=$1',[inv.payableAccountId]),0);
});

test('the migration preserves existing wrapper sources, OIDs, owner, ACL, configuration and all historical rows',async t=>{
 await tx(t);await db.exec('reset role');assert.deepEqual(await metadata(),metadataBefore);assert.deepEqual(await wrappers(),wrappersBefore);assert.deepEqual(await stored(),storedBefore);
});

test('the real requisition to quotation to approved order to receipt to invoice chain preserves source quantities and posts stock and GL once',async t=>{
 await tx(t);await db.exec('reset role');const effects=await q("select jsonb_build_array((select count(*)from gl_impact),(select count(*)from stock_movements))d");for(const resource of['purchasing:requisitions','purchasing:quotes'])await db.query('insert into role_access_matrix values(1,$1,true,true,true,true)',[resource]);await assume();
 const line={product_id:1,account_id:203,department_id:21,quantity:3,unit_cost:50,tax_code_id:1,tax_rate:13},head={date:'2026-10-31',supplier_id:10,currency_id:1,rate:1,period_id:10,location_id:2,status:'BORRADOR',lines:[line]};
 const req=await q('select save_purchase_document($1,null)d',[{...head,type:'REQUISITION',lines:[{...line,quantity:2}]}]);await q('select save_purchase_document($1,$2)d',[{...head,type:'REQUISITION',memo:'Synthetic requisition edited'},req.id]);const reqSource=await q("select purchase_document_source($1,'QUOTE')d",[req.id]);assert.equal(Number(reqSource.lines[0].quantity),3);
 const quotePayload={...head,type:'QUOTE',source_id:req.id};const quote=await q('select save_purchase_document($1,null)d',[quotePayload]);await q('select save_purchase_document($1,$2)d',[{...quotePayload,memo:'Synthetic quotation edited'},quote.id]);const quoteSource=await q("select purchase_document_source($1,'ORDER')d",[quote.id]);assert.equal(Number(quoteSource.lines[0].quantity),3);await denied('select save_purchase_document($1,$2)',[{...head,type:'REQUISITION'},req.id],'55000');
 const order=await q('select save_purchase_document($1,null)d',[{...head,type:'ORDER',source_id:quote.id}]);await denied('select save_purchase_document($1,$2)',[quotePayload,quote.id],'55000');const workflow=await q("select wf_start_entity('PURCHASE_ORDER',$1,'{}')d",[order.id]);await assume(2,4);await q("select wf_act($1,'APROBAR',null,null)d",[workflow.id]);await assume();const orderDetail=await q('select purchase_document_detail($1)d',[order.id]);assert.equal(orderDetail.header.status,'APROBADO');
 await db.exec('reset role');assert.deepEqual(await q("select jsonb_build_array((select count(*)from gl_impact),(select count(*)from stock_movements))d"),effects);await assume();
 const receiptPayload={...head,type:'RECEIPT',source_id:order.id,status:'RECIBIDO',operationId:randomUUID(),lines:[{...line,source_line_id:orderDetail.lines[0].line_id}]};const receipt=await q('select save_purchase_document($1,null)d',[receiptPayload]);assert.deepEqual(await q('select save_purchase_document($1,null)d',[receiptPayload]),receipt,'An identical operation cannot add stock again');const received=await q('select purchase_document_detail($1)d',[receipt.id]);assert.equal(received.lines[0].source_line_id,orderDetail.lines[0].line_id);assert.equal(Number(received.lines[0].quantity),3);
 const completed=await q('select purchase_document_detail($1)d',[order.id]);assert.equal(Number(completed.lines[0].quantity_remaining),0);await db.exec('reset role');assert.equal(await q('select count(*)d from gl_impact'),effects[0]);assert.equal(await q('select count(*)d from stock_movements'),effects[1]+1);
 const documents=(await db.query('select document_id,document_type,source_document_id,location_id,subsidiary_id,supplier_id,currency_id,exchange_rate::float8 rate,total_amount::float8 total from purchase_document where document_id=any($1::bigint[])order by document_id',[[req.id,quote.id,order.id,receipt.id]])).rows;assert.deepEqual(documents.map(d=>d.document_type),['REQUISITION','QUOTE','ORDER','RECEIPT']);assert.deepEqual(documents.map(d=>d.source_document_id),[null,req.id,quote.id,order.id]);for(const d of documents)assert.deepEqual([d.location_id,d.subsidiary_id,d.supplier_id,d.currency_id,d.rate,d.total],[2,1,10,1,1,169.5]);const dimensions=(await db.query('select account_id,department_id,cost_center_id,class_id,quantity::float8 quantity,unit_cost::float8 cost,tax_code_id,tax_rate::float8 tax from purchase_document_line where document_id=any($1::bigint[])order by document_id',[[req.id,quote.id,order.id,receipt.id]])).rows;assert.equal(dimensions.length,4);for(const d of dimensions)assert.deepEqual(d,{account_id:203,department_id:21,cost_center_id:null,class_id:null,quantity:3,cost:50,tax_code_id:1,tax:13});await assume();
 const invoicePayload={...invoice,invoice_number:'SYN-CONTINUOUS-CHAIN',purchase_receipt_document_id:receipt.id,location_id:2,lines:[{...invoice.lines[0],quantity:3}]};const saved=await save(invoicePayload);await checkLocation(saved.invoiceId,2,169.5);const report=await q("select purchase_document_report('{\"type\":\"RECEIPT\",\"from\":\"2026-01-01\",\"to\":\"2026-12-31\"}')d");assert.equal(report.rows.find(d=>d.id===receipt.id).actions.canInvoice,false);await denied('select save_supplier_invoice($1,null)',[invoicePayload],'55000');await denied('select supplier_invoice_receipt_source($1)',[receipt.id],'55000');await db.exec('reset role');assert.equal(await q('select count(*)d from supplier_invoice where purchase_receipt_document_id=$1',[receipt.id]),1);assert.equal(await q('select count(*)d from stock_movements'),effects[1]+1);
});
