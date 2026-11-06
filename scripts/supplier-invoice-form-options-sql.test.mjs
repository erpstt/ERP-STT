import assert from'node:assert/strict';
import{before,after,test}from'node:test';
import{PGlite}from'@electric-sql/pglite';
import{setupSupplierInvoiceFormOptions,applySupplierInvoiceFormOptions}from'./fixtures/setup-supplier-invoice-form-options.mjs';
import{assertIsolatedTestArgs}from'./lib/migration-preview.mjs';
assertIsolatedTestArgs();
const db=new PGlite(),q=async(sql,p=[])=>(await db.query(sql,p)).rows[0]?.d;
const keys=['accounts','accountGroups','taxes','taxTypes','departments','classes','costs','creditors','related','customers','suppliers','paymentTerms','periods','currencies','rates','countries','subsidiaries','locations','invoices','invoiceLines'];
let beforeFunctions;
const functions=async()=>(await db.query("select oid,oid::regprocedure::text signature,md5(prosrc)md5,proowner,proacl::text,proconfig,prosecdef,provolatile from pg_proc where oid=any($1::oid[])order by oid",[beforeFunctions?.map(x=>x.oid)??(await db.query("select oid from pg_proc where pronamespace not in('pg_catalog'::regnamespace,'information_schema'::regnamespace)and pronamespace::regnamespace::text not like'pg_%'")).rows.map(x=>x.oid)])).rows;
async function assume(role=1,sid=1,user=1){await db.exec('reset role');await db.query("insert into user_role_sessions values('fixture',$1,$2)on conflict(session_id)do update set user_id=$1,role_id=$2",[user,role]);await db.query("insert into user_company_sessions values('fixture',$1,$2)on conflict(session_id)do update set user_id=$1,subsidiary_id=$2",[user,sid]);await db.query("select set_config('request.jwt.claims',$1,false)",[JSON.stringify({sub:`00000000-0000-0000-0000-${String(user).padStart(12,'0')}`,session_id:'fixture',role:'authenticated'})]);await db.exec('set role authenticated');}
async function tx(t){await db.exec('reset role;begin');t.after(()=>db.exec('rollback;reset role'));await assume();}
async function denied(sql,p=[],code='42501'){await db.exec('savepoint denied');try{await assert.rejects(db.query(sql,p),e=>e.code===code);}finally{await db.exec('rollback to denied;release denied');}}
const options=(id=null)=>q('select supplier_invoice_form_options($1)d',[id]);
const input={invoice_number:'SYN-OPTIONS',invoice_type:'Factura estándar',supplier_id:10,payment_term_id:1,invoice_date:'2026-10-31',fiscal_period_id:10,currency_id:1,exchange_rate:1,memo:'Synthetic exact invoice',lines:[{account_id:203,quantity:2,unit_price:50,amount:100,tax_rate:0,department_id:21}]};
async function invoice(extra={}){return(await q('select save_supplier_invoice($1,null)d',[{...input,...extra}])).invoiceId;}
before(async()=>{await setupSupplierInvoiceFormOptions(db);beforeFunctions=await functions();await applySupplierInvoiceFormOptions(db);});
after(()=>db.close());

test('invoice creator without entity-master grants receives the complete scoped form bundle without master maintenance data',async t=>{
 await tx(t);await assume(2);assert.equal((await q('select supplier_invoice_access()d')).canCreate,true);await denied("select entity_master_list('suppliers')");
 const d=await options();assert.deepEqual(Object.keys(d).sort(),[...keys,'context'].sort());for(const key of keys)assert.ok(Array.isArray(d[key]),key);assert.deepEqual(d.context,{subsidiaryId:1,invoiceId:null});assert.deepEqual(d.invoices,[]);assert.deepEqual(d.invoiceLines,[]);
 const supplier=d.suppliers.find(s=>s.supplier_id===10);assert.ok(supplier);assert.deepEqual(supplier.subsidiary_ids,[1]);assert.equal(supplier.company_name,'Synthetic visible supplier');for(const field of['tax_id','email','phone','address','payment_iban','payment_bank_id','_actions','_revision','created_by_email'])assert.equal(Object.hasOwn(supplier,field),false,field);
 assert.ok(d.locations.some(l=>l.location_id===1));assert.ok(d.locations.some(l=>l.location_id===501));assert.ok(!d.locations.some(l=>l.location_id===502));assert.ok(d.locations.every(l=>JSON.stringify(l.subsidiary_ids)==='[1]'));assert.equal(d.subsidiaries.length,1);assert.equal(d.subsidiaries[0].subsidiary_id,1);assert.ok(d.accounts.some(a=>a.account_id===203));assert.ok(d.periods.some(p=>p.fiscal_period_id===10));
});

test('read-only and edit-only roles cannot bootstrap creation but may load only an exact existing invoice',async t=>{
 await tx(t);const id=await invoice();await assume(3);await denied('select supplier_invoice_form_options(null)');let d=await options(id);assert.deepEqual(d.invoices.map(x=>x.invoice_id),[id]);assert.ok(d.invoiceLines.length);assert.ok(d.invoiceLines.every(x=>x.invoice_id===id));
 await db.exec("reset role;insert into roles values(501,'Synthetic editor',false);insert into user_roles values(1,501);insert into role_access_matrix values(501,'purchasing:supplier-invoices',true,false,true,false);insert into role_permissions select 501,permission_id from permissions where code='purchasing:supplier-invoice:update'");await assume(501);assert.equal((await q('select supplier_invoice_access()d')).canEdit,true);await denied('select supplier_invoice_form_options(null)');d=await options(id);assert.equal(d.invoices.length,1);
});

test('missing, malformed and foreign invoices never fall back to a create bundle or expose another company',async t=>{
 await tx(t);const id=await invoice();for(const bad of[0,-1,9007199254740992])await denied('select supplier_invoice_form_options($1)',[bad],'22023');await denied('select supplier_invoice_form_options(99999999)');await assume(1,2);await denied('select supplier_invoice_form_options($1)',[id]);
 await assume(999);await denied('select supplier_invoice_form_options(null)');await assume();await db.exec('reset role;update users set is_active=false where user_id=1;set role authenticated');await denied('select supplier_invoice_form_options(null)');
});

test('current choices exclude inactive or foreign dimensions and closed periods; own/shared references remain usable',async t=>{
 await tx(t);await db.exec("reset role;update fiscal_periods set ap_closed=true where fiscal_period_id=10;update departments set is_inactive=true where department_id=21");await assume();const d=await options();assert.ok(!d.periods.some(x=>x.fiscal_period_id===10));assert.ok(!d.departments.some(x=>x.department_id===21));assert.ok(d.creditors.some(x=>x.financial_creditor_id===501));assert.ok(!d.creditors.some(x=>x.financial_creditor_id===502));assert.ok(d.related.some(x=>x.related_company_id===501));assert.ok(!d.related.some(x=>x.related_company_id===502));assert.ok(d.customers.every(c=>Object.keys(c).every(k=>['customer_id','department_id','is_active','is_inactive','subsidiary_ids'].includes(k))));
});

test('selected-invoice history retains only referenced inactive accounts/dimensions/period and no other invoices or audit fields',async t=>{
 await tx(t);const selected=await invoice(),other=await invoice({invoice_number:'SYN-OTHER'});await db.exec("reset role;update chart_accounts set is_inactive=true where account_id=203;update departments set is_inactive=true where department_id=21;update fiscal_periods set gl_closed=true where fiscal_period_id=10");await assume(3);const d=await options(selected);assert.ok(d.accounts.some(a=>a.account_id===203&&a.is_inactive));assert.ok(d.departments.some(a=>a.department_id===21&&a.is_inactive));assert.ok(d.periods.some(a=>a.fiscal_period_id===10&&a.gl_closed));assert.deepEqual(d.invoices.map(x=>x.invoice_id),[selected]);assert.ok(!JSON.stringify(d.invoices).includes('SYN-OTHER'));assert.ok(d.invoiceLines.every(l=>l.invoice_id===selected));assert.ok(!d.invoiceLines.some(l=>l.invoice_id===other));assert.equal(Object.hasOwn(d.invoices[0],'created_by_email'),false);
});

test('foreign exchange choices use only current company allowed currencies and the matching local target',async t=>{
 await tx(t);await db.exec('reset role;insert into subsidiary_currencies(subsidiary_id,currency_id)values(1,2)on conflict do nothing');await assume();const d=await options();assert.ok(d.currencies.some(c=>c.currency_id===2));assert.ok(d.subsidiaries[0].allowed_currency_ids.includes(2));assert.deepEqual(d.rates.map(r=>[r.from_currency_id,r.to_currency_id,Number(r.spot_rate)]),[[2,1,160]]);assert.ok(d.rates.every(r=>Object.keys(r).length===4));
});

test('real foreign-currency invoice with withholding loads its tax rule, accounting anchors and exact original values',async t=>{
 await tx(t);const agency=await q("select save_tax_catalog('tax-agencies',$1,null)d",[{agency_name:'Synthetic invoice agency',country_id:1,tax_id:'SYN-OPTIONS',subsidiary_ids:[1]}]);
 const type=await q("select save_tax_catalog('tax-types',$1,null)d",[{type_name:'Synthetic invoice withholding',country_id:1,applies_to:'Compras',is_indirect_tax:false,asset_account_id:305,liability_account_id:306}]);
 const tax=await q("select save_tax_catalog('tax-codes',$1,null)d",[{code_name:'Synthetic invoice withholding',country_id:1,tax_type_id:type.tax_type_id,tax_agency_id:agency.tax_agency_id,rate_percentage:2,is_withholding:true,is_purchase_creditable:false,is_import_tax:false,withholding_calculation_base:'Subtotal antes de impuestos',withholding_application_moment:'Al registrar la factura',subsidiary_ids:[1]}]);
 await db.exec('reset role;insert into subsidiary_currencies(subsidiary_id,currency_id)values(1,2)on conflict do nothing;insert into supplier_currencies(supplier_id,currency_id,is_primary)values(10,2,false);update suppliers set applies_withholding=true where supplier_id=10');await db.query('insert into entity_withholding_rules(supplier_id,subsidiary_id,tax_code_id)values(10,1,$1)',[tax.tax_code_id]);await assume();const id=await invoice({currency_id:2,exchange_rate:160});await assume(2);const d=await options(id),supplier=d.suppliers.find(x=>x.supplier_id===10);assert.deepEqual(supplier.withholding_rules,[{subsidiary_id:1,tax_code_id:tax.tax_code_id}]);assert.ok(d.taxes.some(t=>t.tax_code_id===tax.tax_code_id&&t.withholding_application_moment==='Al registrar la factura'));assert.ok(d.taxTypes.some(t=>t.tax_type_id===type.tax_type_id&&t.liability_account_id===306));assert.ok(d.accounts.some(a=>a.account_id===306));assert.equal(Number(d.invoices[0].exchange_rate),160);assert.equal(d.invoices[0].currency_id,2);assert.equal(Number(d.invoiceLines[0].amount),100);
 await db.exec('reset role');assert.equal(Number(await q('select sum(g.debit_amount-g.credit_amount)d from gl_impact g join supplier_invoice i on i.transaction_id=g.transaction_id where i.invoice_id=$1',[id])),0);assert.equal(Number(await q('select withholding_amount d from supplier_invoice_withholding where invoice_id=$1',[id])),2);
});

test('a shared opening journal never exposes inactive accounts belonging only to another invoice',async t=>{
 await tx(t);const selected=await invoice(),other=await invoice({invoice_number:'SYN-SHARED'});await db.exec('reset role');const headers=(await db.query('select invoice_id,journal_id from supplier_invoice where invoice_id=any($1::bigint[])order by invoice_id',[[selected,other]])).rows;
 await db.query('update supplier_invoice set journal_id=$1 where invoice_id=$2',[headers[0].journal_id,other]);await db.query('update supplier_invoice_line set account_id=305 where invoice_id=$1',[other]);await db.query('insert into journal_line(journal_id,account_id,debit,credit,debit_fx,credit_fx)values($1,305,0,0,0,0)',[headers[0].journal_id]);await db.exec('update chart_accounts set is_inactive=true where account_id=305');await assume(3);const d=await options(selected);assert.ok(!d.accounts.some(a=>a.account_id===305));assert.ok(d.invoiceLines.every(l=>l.invoice_id===selected));
});

test('RPC reads do not modify permissions, invoices, journals or GL and preserve every previous function attribute',async t=>{
 await tx(t);await db.exec('reset role');const snapshot=()=>q("select jsonb_build_object('roles',(select jsonb_agg(to_jsonb(x)order by role_id,resource_key)from role_access_matrix x),'invoices',(select count(*)from supplier_invoice),'journals',(select count(*)from journal),'gl',(select count(*)from gl_impact))d");const baseline=await snapshot();await assume(2);await options();await db.exec('reset role');assert.deepEqual(await snapshot(),baseline);assert.deepEqual(await functions(),beforeFunctions);
});

test('public RPC is authenticated-only and its projection helpers cannot be invoked by clients or service role',async t=>{
 await tx(t);await denied("select supplier_invoice_form_private.project('{}','{}')");await db.exec('reset role;set role anon');await denied('select supplier_invoice_form_options(null)');await db.exec('reset role;set role service_role');await denied('select supplier_invoice_form_options(null)');await db.exec('reset role');const meta=(await db.query("select prosecdef,provolatile,proconfig,proacl::text from pg_proc where oid='supplier_invoice_form_options(bigint)'::regprocedure")).rows[0];assert.equal(meta.prosecdef,true);assert.equal(meta.provolatile,'s');assert.deepEqual(meta.proconfig,['search_path=pg_catalog, public, pg_temp']);assert.match(meta.proacl,/authenticated=X/);assert.doesNotMatch(meta.proacl,/anon=X|service_role=X/);
});
