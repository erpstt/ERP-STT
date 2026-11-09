import assert from'node:assert/strict';
import{readFile}from'node:fs/promises';
import{PGlite}from'@electric-sql/pglite';
import{setupSupplierAdvancesReport}from'./setup-supplier-advances-report.mjs';
import{assumeSecurityUser}from'./isolated-role-template-security.mjs';
import{functionsIn}from'./setup-audit-raw-security.mjs';
export{assumeSecurityUser,assumeSqlRole,deniedSql}from'./isolated-role-template-security.mjs';
const read=p=>readFile(new URL(p,import.meta.url),'utf8');
const migration=name=>read('../../supabase/migrations/'+name);
export const fxExecutionBatchMigration='20261109194509_batch_fx_revaluation_journal_gl_sync.sql';
export async function applyFxExecutionBatch(db){await db.exec('reset role;begin');try{await db.exec((await migration(fxExecutionBatchMigration)).replace(/\r\n/g,'\n'));await db.exec('commit');}catch(e){await db.exec('rollback');delete e.query;throw e;}}
async function installFinancialAudit(db){
 await db.exec(await migration('20260807080000_create_audit_catalogs.sql'));
 await db.exec("alter table auth.users add column if not exists raw_app_meta_data jsonb default '{\"actor_type\":\"HUMAN\",\"actor_source\":\"Synthetic FX fixture\"}';alter table activity_log add column if not exists activity_id bigint generated always as identity primary key");
 const central=await migration('20260826160000_enable_central_auditing.sql');await db.exec(central.slice(0,central.indexOf('create or replace function')));
 const parts=[['20260826160000_enable_central_auditing.sql',['audit_request_ip','audit_primary_key','install_audit_trigger']],['20260913090000_actor_audit_engine.sql',['resolve_audit_actor','stamp_actor_audit','reject_audit_mutation','reject_audit_truncate','install_actor_audit']],['20261026113000_redact_audit_secrets.sql',['audit_field_is_sensitive','audit_redact_jsonb','audit_redact_json_text','capture_row_audit']]];
 for(const[file,names]of parts)for(const name of names){const matches=functionsIn(await migration(file)).filter(x=>x.name===name);assert.equal(matches.length,1);await db.exec(matches[0].sql);}
 for(const name of['journal','journal_line','gl_impact','number_sequences','fx_revaluation_runs'])await db.query('select public.install_actor_audit($1::regclass)',[name]);
}
function definition(source,name){
 const marker=new RegExp('create(?: or replace)? function '+name.replaceAll('.','\\.')+'\\(','i'),start=source.search(marker);assert.ok(start>=0,'Missing published '+name);
 const tail=source.slice(start),tag=/\bas\s+(\$[a-z0-9_]*\$)/i.exec(tail);assert.ok(tag,'Missing body '+name);
 const open=tag.index+tag[0].length,end=tail.indexOf(tag[1],open);assert.ok(end>=open);return tail.slice(0,end+tag[1].length)+';';
}
async function canonicalBody(db,signature,expected){
 const row=(await db.query('select pg_get_functiondef(oid) definition,md5(prosrc) hash from pg_proc where oid=$1::regprocedure',[signature])).rows[0];
 if(row.hash!==expected){
  let found=false;for(const crlf of[false,true]){
   let sql=row.definition.replace(/\r\n/g,'\n');if(crlf)sql=sql.replace(/\n/g,'\r\n');await db.exec(sql);
   if((await db.query('select md5(prosrc)hash from pg_proc where oid=$1::regprocedure',[signature])).rows[0].hash===expected){found=true;break;}
  }
  // This published historical trigger has two LF-only edited lines inside its
  // otherwise CRLF body. Preserve that exact source fingerprint on every OS.
  if(!found&&signature==='public.fx_protect_journals()'){
   const sql=row.definition.replace(/\r\n/g,'\n').replace(/\n/g,'\r\n').replace(/(if managed and current_setting[^\r\n]+)\r\n/g,'$1\n').replace(/(select exists\(select 1 from journal[^\r\n]+)\r\n/g,'$1\n');await db.exec(sql);
   found=(await db.query('select md5(prosrc)hash from pg_proc where oid=$1::regprocedure',[signature])).rows[0].hash===expected;
  }assert.ok(found,'Published function body differs beyond reviewed EOL serialization: '+signature);
 }
}
/** Synthetic data with current A06/session/device, actual manual/GL writers,
 * actual FX functions, and the protected runtime sequence path. No .env, real
 * actor, captured business rows or production connection is used. */
export async function setupFxExecutionProgress(){
 const db=new PGlite();try{
  await setupSupplierAdvancesReport(db);await db.exec('reset role');
  await db.exec(await read('./fx-revaluation-tables.sql'));
  await db.exec(await read('./fx-revaluation-reference-columns.sql'));
  await db.exec(`alter table fx_revaluation_runs alter column run_id set not null;alter table fx_revaluation_runs alter column run_id add generated always as identity;alter table fx_revaluation_runs add primary key(run_id);alter table fx_revaluation_settings add primary key(subsidiary_id);
   alter table journal add column if not exists created_by bigint;
   alter table journal_line add column if not exists fx_source_key text;
   create table if not exists invoice(invoice_id bigint primary key,invoice_number text,customer_id bigint,transaction_id bigint,currency_id bigint,subsidiary_id bigint,invoice_date date,opening_run_id bigint,opening_balance_line_id bigint);
   create table if not exists credit_note(invoice_id bigint,transaction_id bigint,note_date date);
   create table if not exists debit_note(invoice_id bigint,transaction_id bigint,note_date date);
   create table if not exists customer_payment(payment_id bigint primary key,payment_number text,transaction_id bigint,payment_date date,currency_id bigint);
   create table if not exists customer_payment_application(payment_id bigint,invoice_id bigint,amount numeric,application_date date);
   create table if not exists solicitudes_pago(numero text);
   create unique index fx_revaluation_posted_unique on fx_revaluation_runs(subsidiary_id,fiscal_period_id,currency_id)where status='CONTABILIZADO';
   alter table chart_accounts add column if not exists pending_fx_revaluation boolean default false,add column if not exists pending_fx_revaluation_override boolean;
   update chart_accounts set pending_fx_revaluation=false;
   insert into chart_accounts(account_id,account_number,account_name,category,accepts_entries,is_inactive,pending_fx_revaluation,nature,financial_statement)values
    (2601,'111990','Synthetic FX monetary asset','Activo',true,false,true,'Deudora','Balance General'),
    (2602,'422002','Synthetic unrealized FX gain','Ingreso',true,false,false,'Acreedora','Estado de Resultados'),
    (2603,'632002','Synthetic unrealized FX loss','Gasto',true,false,false,'Deudora','Estado de Resultados');
   insert into account_subsidiaries values(2601,1,true),(2602,1,true),(2603,1,true);
   insert into fiscal_periods(fiscal_period_id,subsidiary_id,start_date,end_date,is_closed,gl_closed,is_inactive)values(13,1,'2026-11-01','2026-11-30',false,false,false);
   insert into transaction_types(transaction_type_id,abbreviation,name)values(71,'DIF_CAM','Synthetic FX differential');
   insert into exchange_rates(exchange_rate_id,from_currency_id,to_currency_id,effective_date,spot_rate)values(9001,2,1,'2026-10-31',159.674);
   insert into role_access_matrix(role_id,resource_key,can_view,can_create,can_edit,can_delete)values(1,'accounting:fx-revaluation',true,true,false,false),(2,'accounting:fx-revaluation',false,true,false,false),(3,'accounting:fx-revaluation',true,false,false,false);
   set check_function_bodies=off;`);
  await db.exec(await read('./fx-revaluation-original-functions.sql'));
  await db.exec('set check_function_bodies=on');
  await db.exec(await read('./fx-revaluation-defaults-triggers.sql'));
  await db.exec(await migration('20261101084601_secure_fx_revaluation.sql'));
  // Reproduce the deployed canonical bodies, including intentional historical
  // CRLF. These are strict expected MD5s, not alternative product guards.
  const originals={
   'fx_revaluation_private.fx_post_journal(bigint,date,integer,text)':'a9b4d8849df82b49aa6175ef81ad8e4b',
   'fx_revaluation_private.fx_execute(jsonb)':'21565358b312c8314878e07cbf60eb85',
   'fx_revaluation_private.fx_exposures(date,bigint)':'7b74399c1e4d31d4bc2efa3748eb09df',
   'fx_revaluation_private.fx_calculate(date,bigint,numeric)':'b0c62b85dbac4ee8adda1ae6da654c3d',
   'fx_revaluation_private.check_journal(bigint,bigint)':'56cebe4ad20904517ad53340f6eb1bdb',
   'public.sync_journal_gl_impacts(bigint)':'c6d71f38184b146e970940155556fae4',
   'public.sync_journal_gl_impacts_trigger()':'f9fe5b9f1704666e265e0e4f9926ea9d',
   'public.fx_local_only_gl()':'9d8e0bde91089f3874e02a4cc38847b4',
   'public.fx_protect_journals()':'8f9b7de072f90ff31c0082f8298cb70d',
   'public.fx_prepare(jsonb)':'4acce9c0ad7d0bee28db5e47bc04db90',
   'public.fx_execute(jsonb)':'d7628859173d2fd5ea6eefc4bba68320'
  };for(const[s,h]of Object.entries(originals))await canonicalBody(db,s,h);
  const core=await migration('20260806100000_create_core_catalogs.sql'),table=core.match(/create table if not exists public\.number_sequences \([\s\S]*?\n\);/i)?.[0];assert.ok(table);await db.exec(table);
  const numbering=await migration('20260827230000_expand_number_sequences.sql'),seedAt=numbering.indexOf('insert into public.number_sequences');assert.ok(seedAt>0);await db.exec(numbering.slice(0,seedAt));
  const sequence=await read('./sequence-original-functions.sql');await db.exec(definition(sequence,'public.next_transaction_number'));
  await canonicalBody(db,'public.next_transaction_number(bigint,bigint)','a11bbe0d1a12107a60f7d213ef2e08e9');
  const expansion=(await migration('20261101213845_secure_number_sequence_catalog.sql')).replace(/\r\n/g,'\n');
  const end=expansion.indexOf('create function sequence_security_private.allowed(');assert.ok(end>0);await db.exec(expansion.slice(0,end));
  await db.exec(definition(expansion,'sequence_security_private.member'));
  const activation=(await migration('20261101214356_activate_number_sequence_boundary_after_server.sql')).replace(/\r\n/g,'\n');
  await db.exec(definition(activation,'sequence_security_private.guard'));
  const wrap=activation.match(/do \$wrap\$[\s\S]*?end \$wrap\$;/)?.[0];assert.ok(wrap);
  const selected=wrap.match(/\('(?:fx_revaluation_private\.fx_post_journal\(bigint,date,integer,text\)|next_transaction_number\(bigint,bigint\))',[^\n]+\)/g);assert.equal(selected?.length,2);
  const bounded=wrap.replace(/for r in select \*from\(values[\s\S]*?\)v\(signature,inner_name,expected_hash\)loop/,'for r in select *from(values\n'+selected.join(',\n')+'\n)v(signature,inner_name,expected_hash)loop');
  assert.notEqual(bounded,wrap);await db.exec(bounded);
  const trigger=activation.match(/create trigger sequence_boundary_guard[^;]+;/)?.[0];assert.ok(trigger);await db.exec(trigger);
  await db.exec('revoke all on all functions in schema sequence_security_private from public,anon,authenticated,service_role');
  await canonicalBody(db,'fx_revaluation_private.fx_post_journal(bigint,date,integer,text)','1a565305abef709b193253f01b4eb274');
  await installFinancialAudit(db);
  await db.exec(`create table fixture_fx_metrics(name text primary key,value bigint not null default 0);insert into fixture_fx_metrics(name)values('syncCalls'),('glInsertRows');
   create function fixture_count_fx_sync()returns trigger language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$begin update fixture_fx_metrics set value=value+1 where name=case when tg_op='DELETE'then'syncCalls'else'glInsertRows'end;return null;end$$;
   create trigger fixture_count_sync after delete on gl_impact for each statement execute function fixture_count_fx_sync();
   create trigger fixture_count_gl_insert after insert on gl_impact for each row execute function fixture_count_fx_sync();`);
  await assumeSecurityUser(db);await db.query('select public.fx_save_settings($1)',[{gain_account_id:2602,loss_account_id:2603,gain_taxable:false,loss_deductible:false,tax_note:'Synthetic FX execution test'}]);
  return{db,ids:{subsidiaryId:1,foreignSubsidiaryId:2,localCurrencyId:1,foreignCurrencyId:2,accountId:2601,gainAccountId:2602,lossAccountId:2603,periodId:10,reversalPeriodId:13},currentFunctions:{...originals,'fx_revaluation_private.fx_post_journal(bigint,date,integer,text)':'1a565305abef709b193253f01b4eb274'}};
 }catch(error){await db.close();delete error.query;throw error;}
}
export async function seedFxExecutionExposure(db,{amount=100,rate=150,date='2026-10-01',accountId=2601}={}){
 await assumeSecurityUser(db);return(await db.query('select public.create_journal_entry($1)id',[{journal_type:'Asiento de Diario General',journal_date:date,subsidiary_id:1,currency_id:2,exchange_rate:rate,fiscal_period_id:10,memo:'Synthetic FX exposure',location_id:1,lines:[{account_id:accountId,debit:amount,credit:0,entity_type:'Ninguna'},{account_id:2602,debit:0,credit:amount,entity_type:'Ninguna'}]}])).rows[0].id;
}
export async function seedFxExecutionBatch(db,{count=67}={}){
 assert.ok(Number.isSafeInteger(count)&&count>0&&count<=200);await assumeSecurityUser(db);await db.exec('reset role');
 await db.exec(`insert into chart_accounts(account_id,account_number,account_name,category,accepts_entries,is_inactive,pending_fx_revaluation,nature,financial_statement)
  select 2610+n,'11199'||n,'Synthetic FX source account '||n,'Activo',true,false,true,'Deudora','Balance General'from generate_series(1,6)n;
  insert into account_subsidiaries select 2610+n,1,true from generate_series(1,6)n;
  insert into customers(customer_id,company_name)values(99001,'Synthetic FX receivable customer');`);
 for(let n=0;n<count;n++){
  const jid=await seedFxExecutionExposure(db,{accountId:n%7===0?2601:2610+n%7,amount:100+n,rate:150});await db.exec('reset role');
  await db.query("insert into invoice(invoice_id,invoice_number,customer_id,transaction_id,currency_id,subsidiary_id,invoice_date)select $1,$2,99001,transaction_id,2,1,'2026-10-01'from journal where journal_id=$3",[99001+n,'SYN-FX-INVOICE-'+n,jid]);
 }
 await db.exec('update fixture_fx_metrics set value=0');await assumeSecurityUser(db);
}
export const fxExecutionPayload=()=>({date:'2026-10-31',currencyId:2,rate:159.674,autoReverse:true});
