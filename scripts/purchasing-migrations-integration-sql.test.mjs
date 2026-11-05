import assert from'node:assert/strict';
import{before,after,test}from'node:test';
import{readFile,mkdir,writeFile}from'node:fs/promises';
import{resolve,dirname}from'node:path';
import{createHash}from'node:crypto';
import{PGlite}from'@electric-sql/pglite';
import{setupSupplierInvoicePerformance,applySupplierInvoicePerformanceMigration}from'./fixtures/setup-supplier-invoice-performance.mjs';
import{fxTargets,applySupplierPaymentHistoricalFx}from'./fixtures/setup-supplier-payment-historical-fx.mjs';
import{assertIsolatedTestArgs}from'./lib/migration-preview.mjs';
assertIsolatedTestArgs();
const db=new PGlite();
const migrationNames=['20261105170818_preserve_supplier_invoice_selected_location.sql','20261105170823_defer_supplier_invoice_row_gl_sync.sql','20261105170828_correct_supplier_payment_historical_fx_settlement.sql','20261105170834_preserve_supplier_note_historical_tax_rate.sql'];
const guardedTargets={
 'supplier_invoice_private.prepare_before_receipt(jsonb,bigint)':'13472ce2deac522ef3c442d5d4efb55b',
 'supplier_invoice_private.save_supplier_invoice_without_withholding(jsonb,bigint)':'d62a7083f4d185535ba5606ccd044867',
 'supplier_invoice_private.save_supplier_invoice_without_budget_before_payable_routing(jsonb,bigint)':'4b4681f77a5ed6c52548eaac61b91c47',
 'public.save_supplier_invoice(jsonb,bigint)':'0798d0d741c5a5fa04f19842b26e2d47',
 'supplier_payment_private.apply_supplier_payment_payable_accounts(bigint,numeric)':'f8f5c0bf6e5216fee6a067ba93b261fe',
 'supplier_payment_private.available(bigint,bigint)':'b4c8e1e0247f1a96e2872b664cc72a14',
 'supplier_payment_private.lock_source(bigint)':'d435eae86b8b9af8f9e8438b73ff6e41',
 'supplier_payment_private.save_supplier_payment_without_withholding(jsonb,bigint)':'98ecc7a910bb817d33e1d7ecf52340e1',
 'public.validate_supplier_payment_application_payable()':'a3c165891c1e8de945aab1ce0396d7d5',
 'supplier_payment_private.supplier_payment_options()':'2aa324099b1f50618502df0f77262ab3',
 'supplier_note_private.prepare(text,jsonb,bigint)':'ce31f4c60422df3fc999e4754efa158f'
};
const helpers=['supplier_invoice_private.resolve_location(jsonb,bigint)','supplier_payment_private.invoice_basis(bigint,bigint)','supplier_payment_private.invoice_values(bigint,bigint)','supplier_payment_private.advance_values(bigint,bigint)','supplier_payment_private.validate_historical_payment(bigint,bigint)','supplier_payment_private.rebuild_historical_fx(bigint,numeric)'];
const q=async(sql,p=[])=>(await db.query(sql,p)).rows[0]?.d;
async function assume(){await db.exec("reset role;insert into user_role_sessions values('fixture',1,1)on conflict(session_id)do update set user_id=1,role_id=1;insert into user_company_sessions values('fixture',1,1)on conflict(session_id)do update set user_id=1,subsidiary_id=1");await db.query("select set_config('request.jwt.claims',$1,false)",[JSON.stringify({sub:'00000000-0000-0000-0000-000000000001',session_id:'fixture'})]);await db.exec('set role authenticated');}
async function tx(t){await db.exec('reset role;begin');t.after(()=>db.exec('rollback;reset role'));await assume();await db.query("select set_config('nexo.defer_journal_gl_sync','off',true)");}
const context=()=>q("select current_setting('nexo.defer_journal_gl_sync',true)d");
const invoicePayload=(currency,rate,tax=0)=>({invoice_number:'SYN-COMBINED',invoice_type:'Factura estándar',supplier_id:10,payment_term_id:1,invoice_date:'2026-10-31',fiscal_period_id:10,currency_id:currency,exchange_rate:rate,location_id:2,memo:'Synthetic combined migrations',lines:[{account_id:203,quantity:1,unit_price:100,...(tax?{tax_code_id:1}:{}),tax_rate:tax,department_id:21}]});
const notePayload=(id,currency,rate,amount,tax=0)=>({invoice_id:id,note_number:'SYN-COMBINED-NC',note_date:'2026-10-31',fiscal_period_id:10,currency_id:currency,exchange_rate:rate,memo:'Synthetic combined credit',lines:[{account_id:203,amount,...(tax?{tax_code_id:1}:{}),tax_rate:tax,department_id:21}]});
const invoice=p=>q('select save_supplier_invoice($1,null)d',[p]);
const credit=(p,id=null)=>q("select save_supplier_note('CREDIT',$1,$2)d",[p,id]);
const payment=(id,amount,bank,rate)=>q('select save_supplier_payment_with_advances($1,null)d',[{supplier_id:10,account_id:bank,date:'2026-10-31',period_id:10,location_id:2,rate,reference:'SYN-COMBINED-PAY',applications:[{invoice_id:id,amount}],advances:[]}]);
async function sourceGL(ids){await db.exec('reset role');const result=(await db.query('select g.* from gl_impact g where transaction_id in(select transaction_id from journal where journal_id=any($1::bigint[]))order by gl_impact_id',[ids])).rows;await assume();return result;}
async function checkPayment(saved,expected){
 await db.exec('reset role');
 const rows=(await db.query('select account_id,debit_amount::text debit,credit_amount::text credit,debit_fx::text debit_fx,credit_fx::text credit_fx,original_currency_id from gl_impact where transaction_id=(select transaction_id from supplier_payment where payment_id=$1)order by account_id',[saved.id])).rows;
 assert.deepEqual(rows.map(r=>[r.account_id,Number(r.debit),Number(r.credit),Number(r.debit_fx),Number(r.credit_fx),r.original_currency_id]),expected);
 assert.equal(rows.reduce((n,r)=>n+Number(r.debit)-Number(r.credit),0),0);
 assert.deepEqual((await db.query('select sum(debit_amount-credit_amount)::float8 local,sum(debit_fx-credit_fx)::float8 native from gl_impact where account_id=301')).rows[0],{local:0,native:0});
 const allLocations=(await db.query('select distinct l.location_id from journal_line l join journal j using(journal_id)where j.transaction_id in(select transaction_id from supplier_invoice union all select transaction_id from supplier_credit_note union all select transaction_id from supplier_payment)')).rows;
 assert.deepEqual(allLocations,[{location_id:2}]);await assume();assert.equal(await context(),'off');
}
async function functionManifest(){
 const result=[];
 for(const signature of[...Object.keys(guardedTargets),...helpers]){
  const row=(await db.query(`select oid,proowner owner_oid,proowner::regrole::text owner,proacl::text acl,proconfig config,prosecdef security_definer,provolatile volatility,proisstrict strict,proparallel parallel,prorettype result_type,prosrc source,md5(prosrc)source_md5,md5(replace(prosrc,E'\\r\\n',E'\\n'))source_md5_lf,pg_get_functiondef(oid)definition from pg_proc where oid=to_regprocedure($1)`,[signature])).rows[0];
  result.push({signature,kind:Object.hasOwn(guardedTargets,signature)?'guarded_target':'private_helper',expected_pre_migration_md5:guardedTargets[signature]??null,exists:Boolean(row),...(row??{})});
 }
 return result;
}
before(async()=>{
 // This base already installs the location patch and the real receipt/payment
 // stack. Add only FX columns, precision and synthetic configuration, not a
 // second base fixture or another journal trigger.
 await setupSupplierInvoicePerformance(db);
 await db.exec(`alter table journal add column if not exists is_opening_balance boolean default false,add column if not exists fx_revaluation_run_id bigint;
 alter table journal_line add column if not exists historical_exchange_rate numeric(24,10),add column if not exists original_currency_id bigint,add column if not exists opening_balance_line_id bigint;
 alter table gl_impact add column if not exists original_currency_id bigint,add column if not exists opening_balance_line_id bigint;
 alter table journal_line alter column debit type numeric(24,6),alter column credit type numeric(24,6),alter column debit_fx type numeric(24,6),alter column credit_fx type numeric(24,6);
 alter table gl_impact alter column debit_amount type numeric(24,6),alter column credit_amount type numeric(24,6),alter column debit_fx type numeric(24,6),alter column credit_fx type numeric(24,6);
 insert into subsidiary_currencies(subsidiary_id,currency_id)select 1,2 where not exists(select 1 from subsidiary_currencies where subsidiary_id=1 and currency_id=2);
 update bank_account set currency_id=2,balance=100000 where bank_account_id=2;
 insert into chart_accounts(account_id,account_number,account_name,category,accepts_entries)values(701,'422001','Synthetic realized gain','Ingreso',true),(702,'632001','Synthetic realized loss','Gasto',true);
 insert into account_subsidiaries values(701,1,true),(702,1,true);`);
 for(const target of[...fxTargets,'supplier_note_private.prepare(text,jsonb,bigint)']){const definition=await q('select pg_get_functiondef($1::regprocedure)d',[target]);await db.exec(definition.replace(/\r\n/g,'\n'));}
 assert.equal(await q("select count(*)::int d from pg_trigger where tgrelid='journal_line'::regclass and tgname='journal_line_gl_impact_sync'and not tgisinternal"),1);
 const before=await functionManifest();await applySupplierInvoicePerformanceMigration(db);await applySupplierPaymentHistoricalFx(db);
 const tax=(await readFile(new URL('../supabase/migrations/'+migrationNames[3],import.meta.url),'utf8')).replace(/\r\n/g,'\n');await db.exec('begin');try{await db.exec(tax);await db.exec('commit');}catch(error){await db.exec('rollback');throw error;}
 const after=await functionManifest();assert.equal(after.filter(f=>f.exists).length,17);
 for(const signature of Object.keys(guardedTargets)){const old=before.find(f=>f.signature===signature),current=after.find(f=>f.signature===signature);for(const key of['oid','owner_oid','owner','acl','config','security_definer','volatility','strict','parallel','result_type'])assert.deepEqual(current[key],old[key],signature+' '+key);}
 for(const signature of helpers)for(const role of['anon','authenticated','service_role'])assert.equal(await q('select has_function_privilege($1,$2,\'EXECUTE\')d',[role,signature]),false);
 const migrations=[];for(const name of migrationNames){const source=await readFile(new URL('../supabase/migrations/'+name,import.meta.url),'utf8');migrations.push({name,sha256_lf:createHash('sha256').update(source.replace(/\r\n/g,'\n')).digest('hex')});}
 const output=resolve('.local-tools/purchasing-combined-functions.json');await mkdir(dirname(output),{recursive:true});await writeFile(output,JSON.stringify({synthetic:true,before_basis:'Location migration already installed by setupSupplierInvoicePerformance; other three migrations not yet applied.',guarded_target_count:11,private_helper_count:6,migrations,before,after},null,2)+'\n');
});
after(()=>db.close());

test('all four migrations coexist for a USD invoice, another-rate credit and historical FX settlement',async t=>{
 await tx(t);const i=await invoice(invoicePayload(2,160)),n=await credit(notePayload(i.invoiceId,2,165,20));assert.equal(i.total,100);assert.equal(n.total,20);const history=await sourceGL([i.journalId,n.journalId]);const saved=await payment(i.invoiceId,80,2,170);assert.equal(saved.cashTotal,80);await checkPayment(saved,[[102,0,13600,0,80,2],[301,12700,0,80,0,2],[702,900,0,900,0,1]]);assert.deepEqual(await sourceGL([i.journalId,n.journalId]),history);
});
test('all four migrations preserve a local historical five-percent credit and settle its exact balance',async t=>{
 await tx(t);const i=await invoice(invoicePayload(1,1,13));assert.equal(i.total,113);await db.exec('reset role;update tax_codes set rate_percentage=5 where tax_code_id=1');await assume();const p=notePayload(i.invoiceId,1,1,10,5),n=await credit(p);assert.equal(n.total,10.5);await db.exec('reset role;update tax_codes set rate_percentage=13 where tax_code_id=1');await assume();const edited=await credit({...p,memo:'Synthetic description changed'},n.noteId);assert.equal(edited.noteId,n.noteId);assert.equal(edited.total,10.5);await db.exec('reset role');assert.deepEqual((await db.query("select amount::float8 amount,tax_rate::float8 rate,tax_amount::float8 tax,gross_amount::float8 gross from supplier_note_line where note_kind='CREDIT'and note_id=$1",[n.noteId])).rows,[{amount:10,rate:5,tax:.5,gross:10.5}]);await assume();const history=await sourceGL([i.journalId,n.journalId]);const saved=await payment(i.invoiceId,102.5,1,1);assert.equal(saved.cashTotal,102.5);await checkPayment(saved,[[101,0,102.5,0,102.5,1],[301,102.5,0,102.5,0,1]]);assert.deepEqual(await sourceGL([i.journalId,n.journalId]),history);
});
