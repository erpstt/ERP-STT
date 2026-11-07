import assert from'node:assert/strict';
import{before,after,test}from'node:test';
import{PGlite}from'@electric-sql/pglite';
import{createHash}from'node:crypto';
import{setupJournalCsvAutomaticRate,applyDepositCsvAutomaticRate,applyJournalCsvAutomaticRate}from'./fixtures/setup-journal-csv-automatic-rate.mjs';
import{assertIsolatedTestArgs}from'./lib/migration-preview.mjs';
assertIsolatedTestArgs();
const db=new PGlite(),q=async(sql,p=[])=>(await db.query(sql,p)).rows[0]?.d;
const base={asiento_referencia:'AUTO-JOURNAL',tipo_asiento:'ASI_DIA',fecha:'2026-10-10',moneda:'USD',nota_asiento:'Synthetic automatic quote',numero_cuenta:'103',debito:'100.123456',credito:'0',nota_linea:'Synthetic debit',mes_servicio:''};
const rows=(patch={})=>[{...base,...patch},{...base,...patch,numero_cuenta:'101',debito:'0',credito:'100.123456',nota_linea:'Synthetic credit'}];
const foreign=(patch={})=>rows({moneda:'CRC',...patch});
async function assume(role=1,sid=1){await db.exec('reset role');await db.query("insert into user_role_sessions values('fixture',1,$1)on conflict(session_id)do update set user_id=1,role_id=$1",[role]);await db.query("insert into user_company_sessions values('fixture',1,$1)on conflict(session_id)do update set user_id=1,subsidiary_id=$1",[sid]);await db.query("select set_config('request.jwt.claims',$1,false)",[JSON.stringify({sub:'00000000-0000-0000-0000-000000000001',session_id:'fixture',role:'authenticated'})]);await db.exec('set role authenticated');}
const preview=data=>q('select journal_csv_preview($1,1)d',[data]);
const confirm=(data,p)=>q('select journal_csv_import($1,1,$2,$3,$4)d',[data,p.context,p.fingerprint,p.validationDigest]);
async function rejected(fn,code){await db.exec('savepoint expected_error');try{await assert.rejects(fn,e=>e.code===code);}finally{await db.exec('rollback to expected_error;release expected_error');}}
async function tx(t){await db.exec('reset role;begin');t.after(()=>db.exec('rollback;reset role'));await assume();}
async function snapshot(){await db.exec('reset role');const result=await q("select jsonb_build_object('journals',(select count(*)from journal),'lines',(select count(*)from journal_line),'gl',(select count(*)from gl_impact),'transactions',(select count(*)from public.\"transaction\"),'receipts',(select count(*)from journal_csv_imports),'v2',(select count(*)from journal_csv_private.imports),'refs',(select count(*)from journal_csv_private.documents),'bank',(select jsonb_agg(jsonb_build_array(bank_account_id,balance)order by bank_account_id)from bank_account),'sequences',(select jsonb_object_agg(sequencename,last_value)from pg_sequences where schemaname='public'))d");await db.exec('set role authenticated');return result;}
let beforeMetadata;
const metadata=async()=>(await db.query("select oid,oid::regprocedure::text signature,md5(prosrc)md5,proowner,proacl::text acl,proconfig,prosecdef,provolatile from pg_proc where oid=any($1::oid[])order by oid",[beforeMetadata?.map(x=>x.oid)??(await db.query("select oid from pg_proc where pronamespace not in('pg_catalog'::regnamespace,'information_schema'::regnamespace)and pronamespace::regnamespace::text not like'pg_%'")).rows.map(x=>x.oid)])).rows;
before(async()=>{
 await setupJournalCsvAutomaticRate(db);await assume();
 const legacy=rows({asiento_referencia:'HISTORICAL-REFERENCE',tipo_cambio:'1'});
 assert.equal((await q('select import_journal_csv($1,false,1)d',[legacy])).created,1);
 await db.exec('reset role');await applyDepositCsvAutomaticRate(db);beforeMetadata=await metadata();await applyJournalCsvAutomaticRate(db);
});
after(()=>db.close());

test('canonical journals ignore legacy rates and derived service fields before fingerprint and group consistency',async t=>{
 await tx(t);const data=rows(),p=await preview(data),baseline=await snapshot();assert.equal(p.valid,true);
 for(const value of['','999','not-a-rate','NaN']){const x=await preview(data.map((r,i)=>({...r,tipo_cambio:i?value:'1',mes_servicio:'1999-01',pais_servicio:'ignored'})));assert.equal(x.fingerprint,p.fingerprint);assert.equal(x.validationDigest,p.validationDigest);assert.deepEqual(x.entries,p.entries);}
 assert.deepEqual(await snapshot(),baseline);assert.deepEqual(Object.keys(p.context).sort(),['revision','roleId','sessionId','subsidiaryId','userId']);
});

test('local journals use one without quotes and post native precision through the real writer and GL synchronizer',async t=>{
 await tx(t);await db.exec('reset role;delete from exchange_rates');await assume();const data=rows({tipo_cambio:'99'}),p=await preview(data);assert.equal(p.valid,true);assert.equal(p.entries[0].exchangeRate,'1');assert.equal(p.entries[0].rateDate,null);assert.equal(p.entries[0].rateSource,'LOCAL');const result=await confirm(data,p);assert.equal(result.created,1);await db.exec('reset role');const g=(await db.query('select sum(debit_amount)::text d,sum(credit_amount)::text c,sum(debit_fx)::text df,sum(credit_fx)::text cf from gl_impact where transaction_id=(select transaction_id from journal where journal_id=$1)',[result.entries[0].journalId])).rows[0];assert.deepEqual(g,{d:'100.123456',c:'100.123456',df:'100.123456',cf:'100.123456'});
});

test('foreign journals use latest dated direct quote at ten decimals, not future or newer inverse quotes',async t=>{
 await tx(t);const data=foreign(),p=await preview(data);assert.equal(p.valid,true,JSON.stringify(p.errors));assert.equal(p.entries[0].exchangeRate,'160.1234567890');assert.equal(p.entries[0].rateDate,'2026-10-09');assert.equal(p.entries[0].rateSource,'DIRECT');const result=await confirm(data,p);assert.equal(result.created,1);await db.exec('reset role');const h=(await db.query('select *from journal where journal_id=$1',[result.entries[0].journalId])).rows[0];assert.equal(Number(h.exchange_rate),160.123456789);const gl=(await db.query('select sum(debit_amount)::text d,sum(credit_amount)::text c,sum(debit_fx)::text df,sum(credit_fx)::text cf from gl_impact where transaction_id=$1',[h.transaction_id])).rows[0];assert.deepEqual(gl,{d:'16032.113880',c:'16032.113880',df:'100.123456',cf:'100.123456'});assert.equal(result.entries[0].exchangeRate,p.entries[0].exchangeRate);
});

test('inverse quotes are only used without dated direct quotes and retain calculated ten-decimal rate',async t=>{
 await tx(t);await db.exec("reset role;delete from exchange_rates where from_currency_id=2 and to_currency_id=1;update exchange_rates set spot_rate=3 where from_currency_id=1 and to_currency_id=2");await assume();const data=foreign().map(r=>({...r,debito:r.debito==='0'?'0':'3',credito:r.credito==='0'?'0':'3'})),p=await preview(data);assert.equal(p.valid,true);assert.equal(p.entries[0].exchangeRate,'0.3333333333');assert.equal(p.entries[0].rateSource,'INVERSE');assert.equal((await confirm(data,p)).created,1);
});

test('missing, future-only, unrelated and invalid direct quotes never fabricate rates or write financial data',async t=>{
 await tx(t);for(const scenario of['missing','future','other','invalid']){await db.exec('reset role;delete from exchange_rates');if(scenario==='future')await db.exec("insert into exchange_rates(from_currency_id,to_currency_id,effective_date,spot_rate)values(2,1,'2026-10-11',100)");if(scenario==='other')await db.exec("insert into exchange_rates(from_currency_id,to_currency_id,effective_date,spot_rate)values(2,3,'2026-10-09',100)");if(scenario==='invalid')await db.exec("insert into exchange_rates(from_currency_id,to_currency_id,effective_date,spot_rate)values(2,1,'2026-10-09','NaN'),(1,2,'2026-10-09',0.01)");await assume();const baseline=await snapshot(),p=await preview(foreign());assert.equal(p.valid,false,scenario);assert.match(p.errors[0].message,/tipo de cambio vigente/i);assert.deepEqual(await snapshot(),baseline);}
});

test('source date and row identity change proof even when the automatic numeric quote stays equal',async t=>{
 await tx(t);const data=foreign(),p=await preview(data);await db.exec("reset role;insert into exchange_rates(from_currency_id,to_currency_id,effective_date,spot_rate)values(2,1,'2026-10-10',160.1234567890)");await assume();const next=await preview(data);assert.equal(next.entries[0].exchangeRate,p.entries[0].exchangeRate);assert.notEqual(next.validationDigest,p.validationDigest);let baseline=await snapshot();await rejected(()=>confirm(data,p),'55000');assert.deepEqual(await snapshot(),baseline);
 await db.exec("reset role;delete from exchange_rates where from_currency_id=2 and to_currency_id=1 and effective_date='2026-10-10';insert into exchange_rates(from_currency_id,to_currency_id,effective_date,spot_rate)values(2,1,'2026-10-10',160.1234567890)");await assume();const replacement=await preview(data);assert.deepEqual(replacement.entries,next.entries);assert.notEqual(replacement.validationDigest,next.validationDigest);baseline=await snapshot();await rejected(()=>confirm(data,next),'55000');assert.deepEqual(await snapshot(),baseline);
});

test('a catalog amount change or disappearance after proof requires a new preview without consuming numbering',async t=>{
 await tx(t);const data=foreign(),p=await preview(data);await db.exec("reset role;update exchange_rates set spot_rate=161 where from_currency_id=2 and to_currency_id=1 and effective_date='2026-10-09'");await assume();let baseline=await snapshot();await rejected(()=>confirm(data,p),'55000');assert.deepEqual(await snapshot(),baseline);await db.exec('reset role;delete from exchange_rates');await assume();baseline=await snapshot();await rejected(()=>confirm(data,p),'55000');assert.deepEqual(await snapshot(),baseline);
});

test('complete resolved batches bind account, dimensions, period, type, notes and amounts, not merely UI totals',async t=>{
 await tx(t);const data=rows(),p=await preview(data);await db.exec("reset role;update chart_accounts set account_number='RENAMED'where account_id=103;insert into chart_accounts(account_id,account_number,account_name,category)values(106,'103','Synthetic replacement','Gasto');insert into account_subsidiaries values(106,1,true)");await assume();const next=await preview(data);assert.deepEqual(next.entries,p.entries);assert.notEqual(next.validationDigest,p.validationDigest);const baseline=await snapshot();await rejected(()=>confirm(data,p),'55000');assert.deepEqual(await snapshot(),baseline);
 const changed=rows({nota_asiento:'Changed memo'}),different=await preview(changed);assert.notEqual(different.fingerprint,p.fingerprint);await rejected(()=>confirm(changed,p),'22023');
});

test('closed periods, foreign accounts, unbalanced or mixed invalid journals fail in preview and remain atomic',async t=>{
 await tx(t);for(const data of[rows().map((x,i)=>i?{...x,credito:'1'}:x),rows().map((x,i)=>i?{...x,numero_cuenta:'104'}:x),[...rows(),...rows({asiento_referencia:'SECOND',moneda:'XXX'})]]){const baseline=await snapshot(),p=await preview(data);assert.equal(p.valid,false);await rejected(()=>confirm(data,p),'55000');assert.deepEqual(await snapshot(),baseline);}await db.exec('reset role;update fiscal_periods set gl_closed=true where fiscal_period_id=10');await assume();const baseline=await snapshot(),p=await preview(rows());assert.equal(p.valid,false);assert.deepEqual(await snapshot(),baseline);
});

test('lost-response recovery returns the stored result before quote resolution and never reposts changed legacy rate cells',async t=>{
 await tx(t);const data=foreign(),p=await preview(data),result=await confirm(data,p);assert.equal(result.created,1);const baseline=await snapshot();await db.exec('reset role;delete from exchange_rates');await assume();const replay=data.map(x=>({...x,tipo_cambio:'999'})),again=await confirm(replay,p);assert.equal(again.created,0);assert.equal(again.alreadyImported,true);assert.equal(again.receiptId,result.receiptId);const recovered=await preview(replay);assert.equal(recovered.alreadyImported,true);assert.equal(recovered.entries[0].exchangeRate,p.entries[0].exchangeRate);assert.deepEqual(await snapshot(),baseline);await assume(2);const changedRolePreview=await preview(replay),changedRoleReceipt=await confirm(replay,changedRolePreview);assert.equal(changedRoleReceipt.created,0);assert.deepEqual(changedRoleReceipt.context,changedRolePreview.context);assert.equal(changedRoleReceipt.context.roleId,2);assert.deepEqual(await snapshot(),baseline);
});

test('historical receipt references remain reserved through old and new shapes without rewriting history',async t=>{
 await tx(t);const baseline=await snapshot();for(const data of[rows({asiento_referencia:'HISTORICAL-REFERENCE',tipo_cambio:'999'}),rows({asiento_referencia:'HISTORICAL-REFERENCE'})]){const p=await preview(data);assert.equal(p.valid,false);assert.match(p.errors[0].message,/referencia.*ya fue importada/i);await rejected(()=>confirm(data,p),'55000');assert.deepEqual(await snapshot(),baseline);}
 const data=rows({asiento_referencia:'NEW-REFERENCE'}),p=await preview(data);await confirm(data,p);const before=await snapshot(),different=rows({asiento_referencia:'NEW-REFERENCE',nota_asiento:'Different file'}),blocked=await preview(different);assert.equal(blocked.valid,false);assert.deepEqual(await snapshot(),before);
});

test('overlapping confirmations converge on one receipt and one posting with fixed reference locks',async t=>{
 await tx(t);const data=rows({asiento_referencia:'OVERLAPPING-REQUESTS'}),p=await preview(data);const results=await Promise.all([confirm(data,p),confirm(data,p)]);assert.deepEqual(results.map(x=>x.created).sort(),[0,1]);assert.equal(results[0].receiptId,results[1].receiptId);await db.exec('reset role');assert.equal(await q("select count(*)::int d from journal_csv_private.documents where reference='OVERLAPPING-REQUESTS'"),1);assert.equal(await q("select count(*)::int d from journal where journal_id=$1",[results[0].entries[0].journalId]),1);
});

test('long references retain their full value with derived hash keys, safe retries and independent subsidiary scope',async t=>{
 await tx(t);const reference='SYN-LONG-'+Array.from({length:128},(_,i)=>createHash('sha256').update(String(i)).digest('hex')).join(''),data=rows({asiento_referencia:reference}),p=await preview(data);assert(reference.length>2048);assert.equal(p.valid,true);const result=await confirm(data,p);assert.equal(result.created,1);const baseline=await snapshot(),again=await confirm(data,p);assert.equal(again.created,0);assert.equal(again.receiptId,result.receiptId);assert.deepEqual(await snapshot(),baseline);await db.exec('reset role');const stored=(await db.query('select reference,reference_hash from journal_csv_private.documents where subsidiary_id=1')).rows[0];assert.equal(stored.reference,reference);assert.equal(stored.reference_hash,createHash('sha256').update(reference).digest('hex'));
 await db.exec("update fiscal_periods set start_date='2026-10-01',is_closed=false where fiscal_period_id=1;insert into account_subsidiaries values(101,2,true),(103,2,true)");await assume(1,2);const other=data.map(x=>({...x,moneda:'CRC'})),otherPreview=await q('select journal_csv_preview($1,2)d',[other]);assert.equal(otherPreview.valid,true);assert.equal(otherPreview.entries[0].rateSource,'LOCAL');const otherResult=await q('select journal_csv_import($1,2,$2,$3,$4)d',[other,otherPreview.context,otherPreview.fingerprint,otherPreview.validationDigest]);assert.equal(otherResult.created,1);assert.notEqual(otherResult.receiptId,result.receiptId);await db.exec('reset role');assert.equal(await q('select count(*)::int d from journal_csv_private.documents where reference=$1',[reference]),2);
});

test('current view and create permissions and active identity are rechecked before receipts, catalogs or writes',async t=>{
 await tx(t);await assume(3);const reader=await preview(rows());assert.equal(reader.valid,true);await rejected(()=>confirm(rows(),reader),'42501');await assume();const p=await preview(rows());await assume(2);await rejected(()=>confirm(rows(),p),'42501');await assume(1,2);await rejected(()=>preview(rows()),'42501');await assume();await db.exec("reset role;update role_access_matrix set can_view=false where role_id=1 and resource_key='accounting:journals'");await assume();await rejected(()=>preview(rows()),'42501');await db.exec('reset role;set role anon');await rejected(()=>preview(rows()),'42501');await db.exec('reset role;set role service_role');await rejected(()=>preview(rows()),'42501');
});

test('private core compares its expected digest before numbering and restores internal proof state on success and failure',async t=>{
 await tx(t);const data=rows(),p=await preview(data);await db.query("select set_config('nexo.journal_csv_expected_digest','previous-value',true)");await confirm(data,p);assert.equal(await q("select current_setting('nexo.journal_csv_expected_digest')d"),'previous-value');
 const next=rows({asiento_referencia:'OTHER-REFERENCE'});await db.exec('reset role');const built=await q('select journal_csv_private.build_batch($1,1)d',[next]);await db.query("select set_config('nexo.journal_csv_expected_digest','wrong-digest',true)");await db.exec('set role authenticated');const baseline=await snapshot();await db.exec('reset role');await rejected(()=>q('select journal_entry_private.import_journal_csv($1,false,1)d',[built.pricedRows]),'55000');await db.exec('set role authenticated');assert.deepEqual(await snapshot(),baseline);assert.equal(await q("select current_setting('nexo.journal_csv_expected_digest')d"),'wrong-digest');
});

test('legacy public preview uses automatic quotes while direct confirmation cannot bypass proof',async t=>{
 await tx(t);const data=foreign({tipo_cambio:'999'}),p=await q('select import_journal_csv($1,true,1)d',[data]);assert.equal(p.valid,true);assert.equal(p.entries[0].exchangeRate,'160.1234567890');const baseline=await snapshot();await rejected(()=>q('select import_journal_csv($1,false,1)d',[data]),'55000');await rejected(()=>q('select journal_entry_private.import_journal_csv($1,false,1)d',[data]),'42501');assert.deepEqual(await snapshot(),baseline);
});

test('only two reviewed journal CSV bodies change while all prior OIDs, ACLs, owners and configuration remain exact',async t=>{
 await tx(t);await db.exec('reset role');const current=await metadata(),changed=current.filter((x,i)=>x.md5!==beforeMetadata[i].md5).map(x=>x.signature).sort();assert.deepEqual(changed,['import_journal_csv(jsonb,boolean,bigint)','import_journal_csv_before_automatic_service_month(jsonb,boolean,bigint)']);for(let i=0;i<current.length;i++)assert.deepEqual({...current[i],md5:null},{...beforeMetadata[i],md5:null});const exposed=(await db.query("select p.oid::regprocedure::text signature,has_function_privilege('anon',p.oid,'execute')anon,has_function_privilege('authenticated',p.oid,'execute')authenticated,has_function_privilege('service_role',p.oid,'execute')service from pg_proc p where pronamespace='journal_csv_private'::regnamespace")).rows;assert.equal(exposed.length,3);assert(exposed.every(x=>!x.anon&&!x.authenticated&&!x.service));const rls=(await db.query("select relrowsecurity,relforcerowsecurity from pg_class where relnamespace='journal_csv_private'::regnamespace and relkind='r'")).rows;assert.equal(rls.length,2);assert(rls.every(x=>x.relrowsecurity&&x.relforcerowsecurity));
});
