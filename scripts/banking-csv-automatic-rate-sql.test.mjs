import assert from'node:assert/strict';
import{before,after,test}from'node:test';
import{PGlite}from'@electric-sql/pglite';
import{setupCheckCsvAutomaticRate,applyCheckCsvAutomaticRate}from'./fixtures/setup-check-csv-automatic-rate.mjs';
import{assertIsolatedTestArgs}from'./lib/migration-preview.mjs';
assertIsolatedTestArgs();const db=new PGlite(),q=async(sql,p=[])=>(await db.query(sql,p)).rows[0]?.d;
const row={documento_referencia:'AUTO-CHECK',tipo_movimiento:'CHEQUE',fecha:'2026-10-10',cuenta_bancaria:'DEMO-A',moneda:'USD',referencia_bancaria:'SYN-REF',beneficiario:'Synthetic recipient',ubicacion:'',nota_documento:'Synthetic automatic rate',numero_cuenta:'103',importe:'10',nota_linea:'Synthetic expense',tipo_entidad:'',identificacion_entidad:'',departamento:'',centro_costos:'',clase:'',acreedor_financiero:'',compania_relacionada:''};
const foreign=(patch={})=>({...row,documento_referencia:'AUTO-FX',cuenta_bancaria:'SYN-FOREIGN',moneda:'CRC',...patch});
const deposit={...row,documento_referencia:'DEPOSIT-COMPAT',tipo_cambio:'1',metodo_pago:'TRANSFERENCIA'};delete deposit.tipo_movimiento;delete deposit.beneficiario;
const legacy={...row,documento_referencia:'OLD-RECEIPT',tipo_cambio:'1'};
let oldMetadata,depositBefore,legacyResult;
async function assume(role=1,sid=1){await db.exec('reset role');await db.query("insert into user_role_sessions values('fixture',1,$1)on conflict(session_id)do update set user_id=1,role_id=$1",[role]);await db.query("insert into user_company_sessions values('fixture',1,$1)on conflict(session_id)do update set user_id=1,subsidiary_id=$1",[sid]);await db.query("select set_config('request.jwt.claims',$1,false)",[JSON.stringify({sub:'00000000-0000-0000-0000-000000000001',session_id:'fixture',role:'authenticated'})]);await db.exec('set role authenticated');}
const preview=(rows,kind='CHECKS')=>q('select banking_csv_preview($1,$2,1)d',[kind,rows]);
const confirm=(rows,p,kind='CHECKS')=>q('select banking_csv_import($1,$2,1,$3,$4,$5)d',[kind,rows,p.context,p.fingerprint,p.validationDigest]);
async function snapshot(){await db.exec('reset role');const s=await q("select jsonb_build_object('checks',(select count(*)from bank_check),'deposits',(select count(*)from bank_deposit),'transactions',(select count(*)from public.\"transaction\"),'journals',(select count(*)from journal),'lines',(select count(*)from journal_line),'gl',(select count(*)from gl_impact),'bankTransactions',(select count(*)from bank_transaction),'receipts',(select count(*)from banking_csv_private.imports),'references',(select count(*)from banking_csv_private.documents),'balances',(select jsonb_agg(jsonb_build_array(bank_account_id,balance)order by bank_account_id)from bank_account),'sequences',(select jsonb_object_agg(sequencename,last_value)from pg_sequences where schemaname='public'))d");await db.exec('set role authenticated');return s;}
async function tx(t){await db.exec('reset role;begin');t.after(()=>db.exec('rollback;reset role'));await assume();}
async function rejected(fn,code){await db.exec('savepoint rejected');try{await assert.rejects(fn,e=>e.code===code);}finally{await db.exec('rollback to rejected;release rejected');}}
const metadata=async()=>(await db.query("select oid,oid::regprocedure::text signature,md5(prosrc)md5,proowner,proacl::text acl,proconfig,prosecdef,provolatile from pg_proc where oid=any($1::oid[])order by oid",[oldMetadata?.map(x=>x.oid)??(await db.query("select oid from pg_proc where pronamespace not in('pg_catalog'::regnamespace,'information_schema'::regnamespace)and pronamespace::regnamespace::text not like'pg_%'")).rows.map(x=>x.oid)])).rows;
before(async()=>{await setupCheckCsvAutomaticRate(db);await assume();const p=await preview([legacy]);assert.equal(p.valid,true);legacyResult=await confirm([legacy],p);assert.equal(legacyResult.created,1);depositBefore=await preview([deposit],'DEPOSITS');await db.exec('reset role');oldMetadata=await metadata();await applyCheckCsvAutomaticRate(db);});
after(()=>db.close());

test('CHECKS canonical identity ignores absent, blank and arbitrary legacy rate values before fingerprint and header comparison',async t=>{
 await tx(t);const baseline=await snapshot(),plain=await preview([row]);assert.equal(plain.valid,true);for(const value of['','99','1.234567890123','not-a-used-rate']){const p=await preview([{...row,tipo_cambio:value}]);assert.equal(p.fingerprint,plain.fingerprint);assert.equal(p.validationDigest,plain.validationDigest);assert.deepEqual(p.entries,plain.entries);}
 const grouped=await preview([{...row,tipo_cambio:'5'},{...row,tipo_cambio:'9'}]);assert.equal(grouped.valid,true);assert.equal(grouped.entries[0].lineCount,2);assert.deepEqual(await snapshot(),baseline);
});

test('local checks always use one and preserve real bank, journal and GL amounts without any rate catalog dependency',async t=>{
 await tx(t);await db.exec('reset role;delete from exchange_rates');await assume();const data=[{...row,tipo_cambio:'999'}],p=await preview(data);assert.equal(p.valid,true);assert.equal(p.entries[0].exchangeRate,'1');assert.equal(p.entries[0].rateSource,'LOCAL');assert.equal(p.entries[0].rateDate,null);const result=await confirm(data,p);assert.equal(result.created,1);await db.exec('reset role');assert.equal(Number(await q('select exchange_rate d from bank_check where check_id=$1',[result.entries[0].documentId])),1);assert.equal(Number(await q('select sum(g.debit_amount-g.credit_amount)d from gl_impact g join bank_check h on h.transaction_id=g.transaction_id where h.check_id=$1',[result.entries[0].documentId])),0);
});

test('foreign checks prefer latest eligible direct quote over a newer inverse and never use future quotes',async t=>{
 await tx(t);const data=[foreign({importe:'100.123456',tipo_cambio:'1'})],p=await preview(data);assert.deepEqual(p.errors,[]);assert.equal(p.entries[0].exchangeRate,'160.1234567890');assert.equal(p.entries[0].rateDate,'2026-10-09');assert.equal(p.entries[0].rateSource,'DIRECT');assert.equal(p.entries[0].localAmount,'16032.113880');const result=await confirm(data,p);await db.exec('reset role');const h=(await db.query('select *from bank_check where check_id=$1',[result.entries[0].documentId])).rows[0];assert.equal(h.exchange_rate,'160.1234567890');assert.equal(h.amount,'100.123456');const gl=(await db.query('select sum(debit_amount)::text d,sum(credit_amount)::text c,sum(debit_fx)::text df,sum(credit_fx)::text cf from gl_impact where transaction_id=$1',[h.transaction_id])).rows[0];assert.deepEqual(gl,{d:'16032.113880',c:'16032.113880',df:'100.123456',cf:'100.123456'});
});

test('inverse is used only without a dated direct quote and its reciprocal is rounded to ten decimals',async t=>{
 await tx(t);await db.exec("reset role;delete from exchange_rates where from_currency_id=2 and to_currency_id=1;update exchange_rates set spot_rate=3 where from_currency_id=1 and to_currency_id=2");await assume();const data=[foreign({importe:'3'})],p=await preview(data);assert.equal(p.valid,true);assert.equal(p.entries[0].exchangeRate,'0.3333333333');assert.equal(p.entries[0].rateDate,'2026-10-10');assert.equal(p.entries[0].rateSource,'INVERSE');assert.equal(p.entries[0].localAmount,'1.000000');assert.equal((await confirm(data,p)).created,1);
});

test('missing, future-only and unrelated-pair catalogs fail clearly without imports or consumed sequences',async t=>{
 await tx(t);for(const scenario of['missing','future','other-pair']){await db.exec('reset role;delete from exchange_rates');if(scenario==='future')await db.exec("insert into exchange_rates(from_currency_id,to_currency_id,effective_date,spot_rate)values(2,1,'2026-10-11',100),(1,2,'2026-10-11',0.01)");if(scenario==='other-pair')await db.exec("insert into exchange_rates(from_currency_id,to_currency_id,effective_date,spot_rate)values(2,3,'2026-10-01',100)");await assume();const baseline=await snapshot(),data=[foreign()],p=await preview(data);assert.equal(p.valid,false,scenario);assert.equal(p.errors[0].field,'moneda');assert.match(p.errors[0].message,/No existe un tipo de cambio vigente/);assert.equal((await confirm(data,p)).created,0);assert.deepEqual(await snapshot(),baseline);}
});

test('bank currency mismatch is reported before quote lookup and invalid direct quotes do not silently fall back',async t=>{
 await tx(t);await db.exec('reset role;delete from exchange_rates');await assume();const mismatched=await preview([foreign({moneda:'USD'})]);assert.equal(mismatched.valid,false);assert.match(mismatched.errors[0].message,/moneda del archivo no coincide/);await db.exec("reset role;insert into exchange_rates(from_currency_id,to_currency_id,effective_date,spot_rate)values(2,1,'2026-10-09','NaN'),(1,2,'2026-10-10',0.01)");await assume();const baseline=await snapshot(),p=await preview([foreign()]);assert.equal(p.valid,false);assert.match(p.errors[0].message,/positivo y finito/);assert.deepEqual(await snapshot(),baseline);
});

test('catalog value changes after preview require revalidation before any writer runs',async t=>{
 await tx(t);const data=[foreign()],p=await preview(data);assert.equal(p.valid,true);await db.exec("reset role;update exchange_rates set spot_rate=161 where from_currency_id=2 and to_currency_id=1 and effective_date='2026-10-09'");await assume();const baseline=await snapshot();await rejected(()=>confirm(data,p),'55000');assert.deepEqual(await snapshot(),baseline);assert.notEqual((await preview(data)).validationDigest,p.validationDigest);
});

test('same numeric rate from another effective date or source row still changes the validation digest',async t=>{
 await tx(t);const data=[foreign()],first=await preview(data);await db.exec("reset role;insert into exchange_rates(from_currency_id,to_currency_id,effective_date,spot_rate)values(2,1,'2026-10-10',160.1234567890)");await assume();const next=await preview(data);assert.equal(next.entries[0].exchangeRate,first.entries[0].exchangeRate);assert.notEqual(next.validationDigest,first.validationDigest);await rejected(()=>confirm(data,first),'55000');await db.exec("reset role;delete from exchange_rates where from_currency_id=2 and to_currency_id=1 and effective_date='2026-10-10';insert into exchange_rates(from_currency_id,to_currency_id,effective_date,spot_rate)values(2,1,'2026-10-10',160.1234567890)");await assume();const replacement=await preview(data);assert.deepEqual(replacement.entries,next.entries);assert.notEqual(replacement.validationDigest,next.validationDigest);await rejected(()=>confirm(data,next),'55000');
});

test('new confirmed receipts remain idempotent across changed/omitted legacy rate columns and later catalog changes',async t=>{
 await tx(t);const data=[foreign()],p=await preview(data),result=await confirm(data,p);assert.equal(result.created,1);const baseline=await snapshot();await db.exec('reset role;delete from exchange_rates');await assume();const replay=[{...foreign(),tipo_cambio:'7'}],again=await confirm(replay,p);assert.equal(again.created,0);assert.equal(again.alreadyImported,true);assert.equal(again.receiptId,result.receiptId);const recovered=await preview(replay);assert.equal(recovered.alreadyImported,true);assert.equal(recovered.entries[0].exchangeRate,'160.1234567890');assert.deepEqual(await snapshot(),baseline);
});

test('a pre-migration receipt cannot repost through either legacy or new CHECKS shape',async t=>{
 await tx(t);const baseline=await snapshot();for(const data of[[{...legacy,tipo_cambio:'99'}],[Object.fromEntries(Object.entries(legacy).filter(([k])=>k!=='tipo_cambio'))]]){const p=await preview(data);assert.equal(p.valid,false);assert.match(p.errors[0].message,/referencia ya fue importada/i);const result=await confirm(data,p);assert.equal(result.created,0);assert.equal(result.valid,false);assert.deepEqual(await snapshot(),baseline);}assert.equal(legacyResult.created,1);
});

test('DEPOSITS retains byte-equivalent preview hashes, explicit rates and receipt behavior',async t=>{
 await tx(t);const p=await preview([deposit],'DEPOSITS');assert.deepEqual(p,depositBefore);assert.equal(Object.hasOwn(p.entries[0],'exchangeRate'),false);assert.equal(Object.hasOwn(p.entries[0],'rateDate'),false);assert.equal(Object.hasOwn(p.entries[0],'rateSource'),false);const result=await confirm([deposit],p,'DEPOSITS');assert.equal(result.created,1);const bad=await preview([{...deposit,documento_referencia:'DEPOSIT-INVALID',tipo_cambio:'2'}],'DEPOSITS');assert.equal(bad.valid,false);assert.equal(bad.errors[0].field,'tipo_cambio');assert.match(bad.errors[0].message,/moneda local requiere/);
});

test('automatic-rate precision failures and mixed valid/invalid documents remain atomic',async t=>{
 await tx(t);await db.exec("reset role;update exchange_rates set spot_rate=0.3333333333 where from_currency_id=2 and to_currency_id=1 and effective_date='2026-10-09'");await assume();let baseline=await snapshot(),data=[foreign({importe:'1'}),foreign({importe:'1'})],p=await preview(data);assert.equal(p.valid,false);assert.equal(p.errors[0].field,'importe');assert.match(p.errors[0].message,/redondeo local/);assert.equal((await confirm(data,p)).created,0);assert.deepEqual(await snapshot(),baseline);await db.exec('reset role;delete from exchange_rates');await assume();baseline=await snapshot();data=[row,foreign()];p=await preview(data);assert.equal(p.valid,false);assert.equal((await confirm(data,p)).created,0);assert.deepEqual(await snapshot(),baseline);
});

test('only three reviewed bodies change, their OIDs/ACL/config stay intact, and private helpers expose no new permissions',async t=>{
 await tx(t);await db.exec('reset role');const current=await metadata(),expected=new Set(['banking_csv_private.build_batch(text,jsonb,bigint)','banking_csv_preview(text,jsonb,bigint)','banking_csv_import(text,jsonb,bigint,jsonb,text,text)']);assert.deepEqual(current.filter((x,i)=>x.md5!==oldMetadata[i].md5).map(x=>x.signature).sort(),[...expected].sort());for(let i=0;i<current.length;i++)assert.deepEqual({...current[i],md5:null},{...oldMetadata[i],md5:null});await assume();await rejected(()=>db.query("select banking_csv_private.canonical_rows('CHECKS','[]')"),'42501');await assume(3);await rejected(()=>preview([row]),'42501');await db.exec('reset role;set role service_role');await rejected(()=>preview([row]),'42501');
});
