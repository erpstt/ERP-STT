import assert from'node:assert/strict';
import {test,before,after}from'node:test';
import {performance}from'node:perf_hooks';
import {readFile}from'node:fs/promises';
import {setupPayablesAgingInvoiceType,applyPayablesAgingInvoiceType,seedAdditionalPayableInvoices,payablesAgingInvoiceTypeMigration,agingBaselineMd5,assumeSecurityUser,assumeSqlRole,deniedSql}from'./fixtures/setup-payables-aging-invoice-type.mjs';
let db,ids,oldFunctions,newFunctions,beforeRows,afterRows,beforeAcl,afterAcl,crossCurrencyBaseline;
const base={subsidiaryIds:[1],dateTo:'2026-10-31',agingCurrencyMode:'LOCAL',page:1,pageSize:250};
const cases=[['AP',{}],['AP',{agingCurrencyMode:'ORIGINAL'}],['AP',{consolidated:true}],['AP',{costCenterId:41}],['AP',{bookId:1}],['AP',{agingEntityId:20}],['AP',{onlyPending:false}],['AR',{}],['AR',{agingCurrencyMode:'ORIGINAL'}],['AR',{consolidated:true}]];
const baseline=new Map(),scheduledBaseline=new Map();
const tables=['supplier_invoice','invoice','suppliers','customers','supplier_payment','customer_payment','supplier_payment_application','customer_payment_application','supplier_credit_note','supplier_debit_note','credit_note','debit_note','transaction','journal','journal_line','gl_impact'];
async function snapshot(){await db.exec('reset role');const out={};for(const table of tables)out[table]=(await db.query(`select count(*)::int count,md5(coalesce(jsonb_agg(to_jsonb(t)order by to_jsonb(t)::text),'[]'::jsonb)::text)hash from public."${table}"t`)).rows[0];return out;}
const functions=async probe=>(await probe.query("select p.oid,n.nspname schema,p.proname,p.proacl::text acl,p.proowner,p.proconfig,p.prosecdef,p.provolatile,md5(p.prosrc)md5 from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname in('public','report_delivery_private')order by p.oid")).rows;
const acl=async()=>(await db.query("select c.oid,c.relacl::text acl,c.relrowsecurity,c.relforcerowsecurity from pg_class c where c.relnamespace='public'::regnamespace and c.relkind='r'order by c.oid")).rows;
async function report(kind='AP',filters={},scheduled=false){await assumeSecurityUser(db);if(scheduled)await db.exec('reset role');return(await db.query(`select ${scheduled?'report_delivery_private.':''}run_aging_report($1,$2)report`,[kind,{...base,...filters}])).rows[0].report;}
const stripNew=report=>{const x=structuredClone(report);delete x.invoiceTypeTotals;delete x.unallocatedAdvancesByEntity;if(x.summary){delete x.summary.typeFilterActive;delete x.summary.unallocatedAdvancesExcluded;}for(const row of x.rows??[]){delete row.invoice_type_code;delete row.invoice_type_label;}return x;};
before(async()=>{({db,ids}=await setupPayablesAgingInvoiceType({apply:false}));oldFunctions=await functions(db);beforeRows=await snapshot();beforeAcl=await acl();for(const[kind,filters]of cases){const key=JSON.stringify([kind,filters]);baseline.set(key,await report(kind,filters));scheduledBaseline.set(key,await report(kind,filters,true));}await db.exec("reset role;begin;insert into supplier_payment_application(payment_id,invoice_id,application_date,amount)values(3,101,'2026-10-20',0.1)");crossCurrencyBaseline=await report('AP',{agingCurrencyMode:'ORIGINAL'});await db.exec('rollback;reset role');await applyPayablesAgingInvoiceType(db);newFunctions=await functions(db);afterRows=await snapshot();afterAcl=await acl();});
after(()=>db?.close());
async function tx(t){await db.exec('reset role;begin');t.after(()=>db.exec('rollback;reset role'));await assumeSecurityUser(db);}
const totalsByCode=(r,code)=>r.invoiceTypeTotals.filter(x=>x.invoiceTypeCode===code);
const sum=(items,key)=>items.reduce((n,x)=>n+Number(x[key]),0);

test('migration preserves all business rows and table security, changes exactly seven guarded calculations and adds only six private helpers',async()=>{
 const old=new Map(oldFunctions.map(f=>[f.oid,f])),modified=newFunctions.filter(f=>old.has(f.oid)&&f.md5!==old.get(f.oid).md5),added=newFunctions.filter(f=>!old.has(f.oid));assert.equal(modified.length,7);assert.equal(added.length,6);for(const f of newFunctions.filter(f=>old.has(f.oid)))assert.deepEqual({...f,md5:null},{...old.get(f.oid),md5:null});assert.deepEqual(afterRows,beforeRows);assert.deepEqual(afterAcl,beforeAcl);
 for(const f of added){assert.equal(f.schema,'report_delivery_private');assert.equal(f.acl,'{postgres=X/postgres}');for(const role of ['anon','authenticated','service_role'])assert.equal((await db.query("select has_function_privilege($1,$2::oid,'execute')ok",[role,f.oid])).rows[0].ok,false);assert.ok(f.proconfig.some(x=>x.startsWith('search_path=pg_catalog')));}assert.equal(added.filter(f=>f.prosecdef).length,1);
});

test('ALL and omitted AP filters preserve every published amount, application, bucket, currency and reconciliation number',async()=>{
 for(const[kind,filters]of cases.filter(([kind])=>kind==='AP')){const key=JSON.stringify([kind,filters]),r=await report(kind,filters);assert.deepEqual(stripNew(r),baseline.get(key));assert.deepEqual(stripNew(await report(kind,{...filters,payableInvoiceType:'ALL'})),baseline.get(key));}
});

test('AR remains byte-equivalent with and without an unrelated AP filter in local, original and consolidated modes',async()=>{
 for(const[kind,filters]of cases.filter(([kind])=>kind==='AR')){const key=JSON.stringify([kind,filters]);assert.deepEqual(await report(kind,filters),baseline.get(key));assert.deepEqual(await report(kind,{...filters,payableInvoiceType:'NOT_AN_AP_TYPE'}),baseline.get(key));}
});

test('scheduled private calculations retain the same ALL financial results and the new type filter',async()=>{
 for(const[kind,filters]of cases){const actual=await report(kind,filters,true);assert.deepEqual(kind==='AP'?stripNew(actual):actual,scheduledBaseline.get(JSON.stringify([kind,filters])));}
 const selected=await report('AP',{payableInvoiceType:'CARD'},true);assert.deepEqual(selected,await report('AP',{payableInvoiceType:'CARD'}));
});

test('all five canonical header types are explicit and unknown or null legacy values remain OTHER rather than standard',async()=>{
 const r=await report();const byId=new Map(r.rows.map(x=>[x.document_id,x]));for(const[code,id]of Object.entries(ids.invoiceIds))for(const value of Array.isArray(id)?id:[id])assert.equal(byId.get(value).invoice_type_code,code);assert.equal(byId.get(101).invoice_type_label,'Estándar');assert.equal(byId.get(105).invoice_type_label,'Activos Fijos');assert.equal(byId.get(107).invoice_type_label,'Otros / sin tipo');assert.equal(sum(totalsByCode(r,'OTHER'),'pending'),130);
});

test('each selected type filters complete documents, totals, buckets and summary before pagination',async()=>{
 for(const code of ['STANDARD','EXPENSE','CARD','PETTY_CASH','FIXED_ASSET','OTHER']){const r=await report('AP',{payableInvoiceType:code,pageSize:10});assert.ok(r.rows.length);assert.ok(r.rows.every(x=>x.invoice_type_code===code));assert.ok(r.invoiceTypeTotals.every(x=>x.invoiceTypeCode===code));assert.equal(sum(r.invoiceTypeTotals,'documentCount'),r.total);assert.equal(sum(r.invoiceTypeTotals,'pending'),r.summary.subledger);assert.equal(r.summary.advances,0);assert.equal(r.summary.netBalance,r.summary.subledger);assert.equal(r.summary.controlBalance,null);assert.equal(r.summary.difference,null);assert.equal(r.summary.reconciliationAvailable,false);assert.equal(r.summary.reconciliationReason,'INVOICE_TYPE_FILTER');assert.equal(r.summary.typeFilterActive,true);assert.equal(r.summary.unallocatedAdvancesExcluded,true);assert.deepEqual(r.unallocatedAdvancesByEntity,[]);assert.ok(r.rows.every(x=>x.entity_advances===0));}
});

test('shared opening journals retain their stored types, NULL transaction links, exact source keys and historical amounts',async()=>{
 const r=await report('AP',{agingCurrencyMode:'ORIGINAL'}),byId=new Map(r.rows.map(x=>[x.document_id,x]));assert.equal(byId.get(201).invoice_type_code,'STANDARD');assert.equal(byId.get(202).invoice_type_code,'EXPENSE');assert.equal(byId.get(201).pending,80);assert.equal(byId.get(202).pending,20);
 const scoped=await report('AP',{payableInvoiceType:'EXPENSE',costCenterId:42});assert.deepEqual(scoped.rows.map(x=>x.document_id).sort(),[102,202]);await db.exec('reset role');assert.deepEqual((await db.query('select invoice_id,transaction_id,opening_balance_line_id from supplier_invoice where invoice_id in(201,202)order by invoice_id')).rows,[{invoice_id:201,transaction_id:null,opening_balance_line_id:501},{invoice_id:202,transaction_id:null,opening_balance_line_id:502}]);
});

test('notes and cross-type payment applications keep their invoice classification and unchanged published valuation',async()=>{
 const local=await report('AP',{payableInvoiceType:'STANDARD'}),original=await report('AP',{payableInvoiceType:'CARD',agingCurrencyMode:'ORIGINAL'});const standard=local.rows.find(x=>x.document_id===101),card=original.rows.find(x=>x.document_id===103);assert.equal(standard.pending,85);assert.equal(standard.applied_amount,20);assert.equal(card.pending,78);assert.equal(card.applied_amount,25);assert.deepEqual(standard.applications,baseline.get(JSON.stringify(['AP',{}])).rows.find(x=>x.document_id===101).applications);assert.deepEqual(card.applications,baseline.get(JSON.stringify(['AP',{agingCurrencyMode:'ORIGINAL'}])).rows.find(x=>x.document_id===103).applications);assert.equal((await report('AP',{payableInvoiceType:'EXPENSE'})).rows.find(x=>x.document_id===102).pending,190);
});

test('cross-currency applications preserve the existing ORIGINAL valuation and reconciliation suppression for ALL',async t=>{
 await tx(t);await db.exec("reset role;insert into supplier_payment_application(payment_id,invoice_id,application_date,amount)values(3,101,'2026-10-20',0.1)");const all=await report('AP',{agingCurrencyMode:'ORIGINAL'});assert.deepEqual(stripNew(all),crossCurrencyBaseline);assert.equal(all.summary.reconciliationReason,'CROSS_CURRENCY');assert.equal(all.summary.reconciliationAvailable,false);assert.equal(all.rows.find(x=>x.document_id===101).pending,68);const selected=await report('AP',{agingCurrencyMode:'ORIGINAL',payableInvoiceType:'STANDARD'});assert.equal(selected.rows.find(x=>x.document_id===101).pending,68);assert.equal(selected.summary.reconciliationReason,'INVOICE_TYPE_FILTER');assert.equal(selected.summary.reconciliationAvailable,false);assert.equal(selected.summary.controlBalance,null);
});

test('unallocated advance metadata includes advance-only suppliers and never assigns a type or duplicates the global deduction',async()=>{
 for(const mode of ['LOCAL','ORIGINAL']){const r=await report('AP',{agingCurrencyMode:mode});assert.ok(r.unallocatedAdvancesByEntity.some(x=>x.entityId===ids.advanceOnlySupplierId&&x.amount===40));assert.ok(r.rows.every(x=>x.entity_id!==ids.advanceOnlySupplierId));assert.ok(r.unallocatedAdvancesByEntity.every(x=>!Object.hasOwn(x,'invoiceTypeCode')));const seen=new Set();for(const a of r.unallocatedAdvancesByEntity){const key=[a.subsidiaryId,a.entityId,a.currencyId].join('|');assert.equal(seen.has(key),false);seen.add(key);}for(const c of r.summary.currencyBreakdown)assert.equal(sum(r.unallocatedAdvancesByEntity.filter(x=>x.currencyId===c.currencyId),'amount'),c.advances);}
});

test('original currencies stay separate for both type subtotals and unallocated advances',async()=>{
 const r=await report('AP',{agingCurrencyMode:'ORIGINAL'});assert.equal(r.summary.mixedCurrencies,true);assert.equal(r.summary.subledger,null);const standard=totalsByCode(r,'STANDARD');assert.deepEqual(standard.map(t=>[t.currencyCode,t.pending]),[['CRC',80],['USD',85]]);for(const c of r.summary.currencyBreakdown)assert.equal(sum(r.invoiceTypeTotals.filter(x=>x.currencyId===c.currencyId),'pending'),c.subledger);const filtered=await report('AP',{agingCurrencyMode:'ORIGINAL',payableInvoiceType:'STANDARD'});assert.equal(filtered.summary.netBalance,null);for(const c of filtered.summary.currencyBreakdown){assert.equal(c.netBalance,c.subledger);assert.equal(c.advances,0);assert.equal(c.controlBalance,null);assert.equal(c.reconciliationAvailable,false);}
});

test('consolidated totals and unallocated entities use the existing USD closing conversion without revaluing rows twice',async()=>{
 for(const type of ['ALL','CARD']){const r=await report('AP',{consolidated:true,payableInvoiceType:type});assert.equal(r.currency,'USD');assert.ok(r.invoiceTypeTotals.every(x=>x.currencyCode==='USD'&&x.currencyId===1));assert.equal(sum(r.invoiceTypeTotals,'pending'),r.summary.subledger);assert.equal(sum(r.unallocatedAdvancesByEntity,'amount'),r.summary.advances);if(type==='CARD'){assert.equal(r.summary.advances,0);assert.equal(r.summary.controlBalance,null);assert.equal(r.summary.reconciliationAvailable,false);}else assert.deepEqual(stripNew(r),baseline.get(JSON.stringify(['AP',{consolidated:true}])));}
});

test('onlyPending:false retains fully settled invoices in their actual type with zero pending',async()=>{
 const r=await report('AP',{onlyPending:false,payableInvoiceType:'CARD',agingCurrencyMode:'ORIGINAL'});const paid=r.rows.find(x=>x.document_id===108);assert.ok(paid);assert.equal(paid.pending,0);assert.equal(paid.invoice_type_code,'CARD');assert.equal(sum(r.invoiceTypeTotals,'documentCount'),2);
});

test('1000 synthetic invoices keep type filtering, page totals and full-scope subtotals independent of the visible page',async t=>{
 await tx(t);await seedAdditionalPayableInvoices(db,{count:1000});const started=performance.now(),r=await report('AP',{payableInvoiceType:'STANDARD',page:2,pageSize:10});assert.equal(r.rows.length,10);assert.equal(r.total,202);assert.equal(sum(r.invoiceTypeTotals,'documentCount'),202);assert.equal(r.summary.subledger,12285);assert.equal(sum(r.invoiceTypeTotals,'pending'),12285);const empty=await report('AP',{payableInvoiceType:'STANDARD',page:999,pageSize:10});assert.equal(empty.rows.length,0);assert.equal(empty.total,202);assert.deepEqual(empty.invoiceTypeTotals,r.invoiceTypeTotals);assert.deepEqual(empty.summary,r.summary);t.diagnostic(JSON.stringify({sourceInvoices:1009,selectedDocuments:202,visibleRows:10,reportAndEmptyPageMs:Math.round(performance.now()-started)}));
});

test('entity/category/book/cost restrictions apply to metadata as well as document rows',async()=>{
 const advanceOnly=await report('AP',{agingEntityId:20});assert.equal(advanceOnly.rows.length,0);assert.deepEqual(advanceOnly.invoiceTypeTotals,[]);assert.equal(advanceOnly.unallocatedAdvancesByEntity.length,1);assert.equal(advanceOnly.unallocatedAdvancesByEntity[0].entityId,20);assert.equal(advanceOnly.summary.advances,40);const category=await report('AP',{supplierCategory:'NO_SUCH_CATEGORY'});assert.deepEqual(category.rows,[]);assert.deepEqual(category.invoiceTypeTotals,[]);assert.deepEqual(category.unallocatedAdvancesByEntity,[]);const cost=await report('AP',{costCenterId:42});assert.deepEqual(cost.unallocatedAdvancesByEntity,[]);assert.ok(cost.rows.every(x=>[102,202].includes(x.document_id)));
});

test('selected filters normalize ALL, whitespace and lowercase while invalid codes fail without financial writes',async t=>{
 await tx(t);const prior=await snapshot();for(const value of ['ALL',' all ','',null])assert.deepEqual(await report('AP',{payableInvoiceType:value}),await report());assert.deepEqual(await report('AP',{payableInvoiceType:' card '}),await report('AP',{payableInvoiceType:'CARD'}));await assumeSecurityUser(db);await deniedSql(db,"select run_aging_report('AP',$1)",[{...base,payableInvoiceType:'OPENING'}],'22023');assert.deepEqual(await snapshot(),prior);
});

test('active report permissions, assigned role and company scope protect public entry and every new metadata source',async t=>{
 await tx(t);await db.exec("reset role;insert into subsidiaries(subsidiary_id,name,is_active,currency_id)values(99,'Synthetic unauthorized company',true,1);insert into \"transaction\"values(9999,99,'SYN-FOREIGN-ADVANCE','2026-10-20',1,1,30,null);insert into supplier_payment values(99,'SYN-FOREIGN-ADVANCE',30,9999,1,1,999)");await assumeSecurityUser(db);await deniedSql(db,"select run_aging_report('AP',$1)",[{...base,subsidiaryIds:[99]}],'P0001');await db.exec('reset role');await deniedSql(db,'select report_delivery_private.payable_aging_advance_entities($1,true)',[{...base,subsidiaryIds:[99]}]);
 const consolidated=await report('AP',{consolidated:true});assert.ok(consolidated.rows.every(x=>x.subsidiary_id!==99));assert.ok(consolidated.unallocatedAdvancesByEntity.every(x=>x.subsidiaryId!==99));assert.equal(consolidated.summary.advances,baseline.get(JSON.stringify(['AP',{consolidated:true}])).summary.advances);
 for(const role of [2,999]){await assumeSecurityUser(db,1,role);await deniedSql(db,"select run_aging_report('AP',$1)",[base]);}
 for(const role of ['anon','service_role']){await assumeSqlRole(db,role);await deniedSql(db,"select run_aging_report('AP',$1)",[base]);}
 await assumeSecurityUser(db);await deniedSql(db,'select *from supplier_invoice');await deniedSql(db,'select report_delivery_private.payable_aging_advance_entities($1,true)',[base]);
});

test('private scheduled calculation also rejects an unauthorized company before returning metadata',async t=>{
 await tx(t);await db.exec("reset role;insert into subsidiaries(subsidiary_id,name,is_active,currency_id)values(99,'Synthetic unauthorized scheduled company',true,1)");await deniedSql(db,"select report_delivery_private.run_aging_report('AP',$1)",[{...base,subsidiaryIds:[99],payableInvoiceType:'STANDARD'}],'P0001');
});

test('all seven source guards abort atomically on drift before exposing helpers or altering data',async()=>{
 const{db:probe}=await setupPayablesAgingInvoiceType({apply:false});try{const sql=(await readFile(new URL('../supabase/migrations/'+payablesAgingInvoiceTypeMigration,import.meta.url),'utf8')).replace(/\r\n/g,'\n');for(const signature of Object.keys(agingBaselineMd5)){await probe.exec('begin');const definition=(await probe.query('select pg_get_functiondef($1::regprocedure)d',[signature])).rows[0].d;await probe.exec(definition.replace('AS $function$','AS $function$\n-- Synthetic guarded drift\n'));await assert.rejects(probe.exec(sql),e=>e.code==='P0001'&&/Unexpected payable aging/.test(e.message));await probe.exec('rollback');assert.equal((await probe.query("select to_regprocedure('report_delivery_private.payable_invoice_type_code(text)')helper")).rows[0].helper,null);}}finally{await probe.close();}
});
