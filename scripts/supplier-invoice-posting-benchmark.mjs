// Synthetic PGlite diagnostic only. No database URL, environment or remote client.
import assert from'node:assert/strict';
import{performance}from'node:perf_hooks';
import{PGlite}from'@electric-sql/pglite';
import{setupSupplierInvoiceLocation,applySupplierInvoiceLocationMigration}from'./fixtures/setup-supplier-invoice-location.mjs';
import{applySupplierInvoicePerformanceMigration}from'./fixtures/setup-supplier-invoice-performance.mjs';
import{assertIsolatedTestArgs}from'./lib/migration-preview.mjs';
assertIsolatedTestArgs();
const db=new PGlite();
async function assume(){
 await db.exec("reset role;insert into user_role_sessions values('fixture',1,1)on conflict(session_id)do update set user_id=1,role_id=1;insert into user_company_sessions values('fixture',1,1)on conflict(session_id)do update set user_id=1,subsidiary_id=1");
 await db.query("select set_config('request.jwt.claims',$1,false)",[JSON.stringify({sub:'00000000-0000-0000-0000-000000000001',session_id:'fixture'})]);
 await db.exec('set role authenticated');
}
const payload=n=>({invoice_number:'SYN-BENCH-'+n,invoice_type:'Factura estándar',supplier_id:10,payment_term_id:1,invoice_date:'2026-10-31',fiscal_period_id:10,currency_id:1,exchange_rate:1,location_id:2,lines:Array.from({length:n},(_,i)=>({account_id:203,quantity:1,unit_price:10,tax_rate:0,department_id:21,note:'Synthetic benchmark line '+i}))});
async function run(n,count=false){
 await db.exec('reset role;begin');
 try{
  await assume();const started=performance.now();
  const saved=(await db.query('select save_supplier_invoice($1,null)d',[payload(n)])).rows[0].d;
  const elapsedMs=performance.now()-started;await db.exec('reset role');
  const total=(await db.query('select count(*)::integer lines from journal_line where journal_id=$1',[saved.journalId])).rows[0].lines;
  const balances=(await db.query('select sum(debit_amount)::float8 debit,sum(credit_amount)::float8 credit from gl_impact where transaction_id=(select transaction_id from journal where journal_id=$1)',[saved.journalId])).rows[0];
  assert.equal(total,n+1);assert.deepEqual(balances,{debit:10*n,credit:10*n});
  const work=count?(await db.query("select(select count(*)from synthetic_sync_calls)::integer \"syncCalls\",count(*)filter(where operation='INSERT')::integer \"glInsertStatements\",coalesce(sum(affected)filter(where operation='INSERT'),0)::integer \"glRowsInserted\",coalesce(sum(affected)filter(where operation='DELETE'),0)::integer \"glRowsDeleted\" from synthetic_gl_work")).rows[0]:{};
  const projection=(await db.query('select jsonb_agg(jsonb_build_array(account_id,subsidiary_id,fiscal_period_id,accounting_book_id,debit_amount::text,credit_amount::text,debit_fx::text,credit_fx::text,posting_date)order by account_id,debit_amount,credit_amount,debit_fx,credit_fx)projection from gl_impact where transaction_id=(select transaction_id from journal where journal_id=$1)',[saved.journalId])).rows[0].projection;
  return{sourceLines:n,journalLines:total,elapsedMs:Number(elapsedMs.toFixed(2)),...work,projection};
 }finally{await db.exec('rollback;reset role');}
}
try{
 await setupSupplierInvoiceLocation(db);
 const baselineEngine=(await db.query("select md5(prosrc) md5 from pg_proc where oid='supplier_invoice_private.save_supplier_invoice_without_withholding(jsonb,bigint)'::regprocedure")).rows[0].md5;
 await applySupplierInvoiceLocationMigration(db);
 const sources=(await db.query("select oid::regprocedure::text signature,md5(prosrc) md5,md5(replace(prosrc,E'\\r\\n',E'\\n')) md5_lf from pg_proc where oid in('public.save_supplier_invoice(jsonb,bigint)'::regprocedure,'sync_journal_gl_impacts_trigger()'::regprocedure,'sync_journal_gl_impacts(bigint)'::regprocedure,'supplier_invoice_private.save_supplier_invoice_without_withholding(jsonb,bigint)'::regprocedure,'supplier_invoice_private.save_supplier_invoice_without_budget_before_payable_routing(jsonb,bigint)'::regprocedure)order by signature")).rows;
 const syncDefinition=(await db.query("select pg_get_functiondef('public.sync_journal_gl_impacts(bigint)'::regprocedure)definition")).rows[0].definition;
 // Only the separate work-count phase instruments entry to the real sync body.
 // The original function definition is restored before every timed phase.
 const instrumentedSync=syncDefinition.replace(/\bbegin\b/i,'begin\n insert into public.synthetic_sync_calls values(target_journal_id);');
 assert.notEqual(instrumentedSync,syncDefinition);
 await db.exec(`create table synthetic_gl_work(operation text,affected bigint);create table synthetic_sync_calls(journal_id bigint);
 create function synthetic_count_gl_insert()returns trigger language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$begin insert into synthetic_gl_work select 'INSERT',count(*)from synthetic_added;return null;end$$;
 create function synthetic_count_gl_delete()returns trigger language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$begin insert into synthetic_gl_work select 'DELETE',count(*)from synthetic_removed;return null;end$$;`);
 async function timed(){await run(1);const rows=[];for(const n of[1,10,50]){const trials=[];for(let i=0;i<3;i++)trials.push((await run(n)).elapsedMs);rows.push({sourceLines:n,trialsMs:trials,medianMs:[...trials].sort((a,b)=>a-b)[1]});}return rows;}
 async function counted(){
  await db.exec(instrumentedSync);
  await db.exec(`create trigger synthetic_count_gl_insert after insert on gl_impact referencing new table as synthetic_added for each statement execute function synthetic_count_gl_insert();create trigger synthetic_count_gl_delete after delete on gl_impact referencing old table as synthetic_removed for each statement execute function synthetic_count_gl_delete();`);
  const rows=[];try{for(const n of[1,10,50]){const{elapsedMs,...work}=await run(n,true);rows.push(work);}}finally{await db.exec('drop trigger synthetic_count_gl_insert on gl_impact;drop trigger synthetic_count_gl_delete on gl_impact');await db.exec(syncDefinition);}return rows;
 }
 const before={timings:await timed(),work:await counted()};
 await applySupplierInvoicePerformanceMigration(db);
 const after={timings:await timed(),work:await counted()};
 for(let i=0;i<before.work.length;i++){assert.deepEqual(after.work[i].projection,before.work[i].projection);delete before.work[i].projection;delete after.work[i].projection;}
 const speedup=before.timings.map((row,i)=>({sourceLines:row.sourceLines,medianSpeedup:Number((row.medianMs/after.timings[i].medianMs).toFixed(2))}));
 const entryPointAfter=(await db.query("select md5(prosrc)md5 from pg_proc where oid='public.save_supplier_invoice(jsonb,bigint)'::regprocedure")).rows[0].md5;
 console.log(JSON.stringify({synthetic:true,engine:'PGlite, shared CPU; timings are diagnostic, not production SLA or HTTP latency',baselineSupplierInvoiceEngineMD5:baselineEngine,sources,entryPointAfter,identicalGLSnapshots:true,before,after,speedup},null,2));
}catch(e){console.error(JSON.stringify({message:e.message,code:e.code,where:e.where}));process.exitCode=1;}finally{await db.close();}
