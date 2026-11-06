import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {test} from 'node:test';
import {PGlite} from '@electric-sql/pglite';
import {setupBankingCsvImport} from './fixtures/setup-banking-csv-import.mjs';
import {configureCheckCsvRateCatalog,applyCheckCsvAutomaticRate} from './fixtures/setup-check-csv-automatic-rate.mjs';
import {previewBankingCsv,importBankingCsv,parseBankingCsv,bankingCsvHeaders} from '../dist/modules/banking-catalogs/banking-csv.service.js';
import {primeRoleAccessCache,invalidateRoleAccessCaches} from '../dist/modules/security-catalogs/role-access-matrix.module.js';
import {assertIsolatedTestArgs} from './lib/migration-preview.mjs';
assertIsolatedTestArgs();
function checkCsv(rows,legacyRate){const headers=[...bankingCsvHeaders.CHECKS];if(legacyRate!==undefined)headers.splice(5,0,'tipo_cambio');const quote=value=>'"'+String(value??'').replaceAll('"','""')+'"';return headers.join(';')+'\r\n'+rows.map(row=>headers.map(key=>quote(key==='tipo_cambio'?legacyRate:row[key])).join(';')).join('\r\n');}

test('downloaded bank CSV templates traverse the real Node/SQL boundary with preview, context checks and lost-response recovery', {timeout:90000}, async t=>{
 const db=new PGlite(),originalFetch=globalThis.fetch,originalEnvironment={...process.env};
 const auth='Bearer synthetic-banking-csv-service-sql-bridge',origin='https://banking-csv-bridge.example.invalid';
 t.after(async()=>{globalThis.fetch=originalFetch;process.env={...originalEnvironment};invalidateRoleAccessCaches(auth);await db.close();});
 await setupBankingCsvImport(db);
 await db.exec("alter table payment_methods add column if not exists method_code text;update payment_methods set method_code=coalesce(method_code,'SYN-TRANSFER')");
 const migration=(await readFile(new URL('../supabase/migrations/20261105184055_add_banking_csv_atomic_import.sql',import.meta.url),'utf8')).replace(/\r\n/g,'\n');
 await db.exec('begin');try{await db.exec(migration);await db.exec('commit');}catch(cause){await db.exec('rollback');delete cause.query;throw cause;}
 await configureCheckCsvRateCatalog(db);await applyCheckCsvAutomaticRate(db);
 const actor=async role=>{
  await db.exec('reset role');
  await db.query("insert into user_role_sessions values('bridge-session',1,$1)on conflict(session_id)do update set role_id=$1",[role]);
  await db.exec("insert into user_company_sessions values('bridge-session',1,1)on conflict(session_id)do update set subsidiary_id=1");
  await db.query("select set_config('request.jwt.claims',$1,false)",[JSON.stringify({sub:'00000000-0000-0000-0000-000000000001',session_id:'bridge-session'})]);
 };
 await actor(1);
 Object.assign(process.env,{SUPABASE_URL:origin,SUPABASE_ANON_KEY:'synthetic-banking-public',SUPABASE_PUBLISHABLE_KEY:'synthetic-banking-public',SUPABASE_SERVICE_ROLE_KEY:'sb_secret_synthetic_banking_bridge'});
 await primeRoleAccessCache(auth,{isAdmin:false,grants:['banking:bank-checks','banking:bank-deposits'].map(resourceKey=>({resourceKey,canView:true,canCreate:true,canEdit:false,canDelete:false}))});
 const method=(await db.query('select method_code from payment_methods where payment_method_id=1')).rows[0].method_code;
 const template=async file=>(await readFile(new URL('../public/'+file,import.meta.url),'utf8')).replaceAll('REEMPLAZAR_CUENTA_BANCARIA','DEMO-A').replaceAll('REEMPLAZAR_CUENTA_CONTABLE','103').replaceAll('REEMPLAZAR_CODIGO_METODO',method).replaceAll('REEMPLAZAR_REFERENCIA','SYN-BANK-REF').replaceAll('REEMPLAZAR_BENEFICIARIO','Synthetic beneficiary').replaceAll('2026-11-05','2026-10-10').replaceAll(';CRC;',';USD;');
 const checks=await template('plantilla-cheques-transferencias.csv'),deposits=await template('plantilla-depositos-bancarios.csv');
 const checksLegacy=checkCsv(parseBankingCsv(checks,'CHECKS'),'not an authoritative exchange rate');
 const snapshot=async()=>{
  await db.exec('reset role');
  return (await db.query(`select jsonb_build_object('checks',(select count(*)from bank_check),'deposits',(select count(*)from bank_deposit),'journals',(select count(*)from journal),'transactions',(select count(*)from public."transaction"),'journalLines',(select count(*)from journal_line),'gl',(select count(*)from gl_impact),'receipts',(select count(*)from banking_csv_private.imports),'references',(select count(*)from banking_csv_private.documents),'balances',(select jsonb_agg(jsonb_build_array(bank_account_id,balance)order by bank_account_id)from bank_account),'sequences',(select jsonb_agg(jsonb_build_array(sequencename,last_value)order by sequencename)from pg_sequences where schemaname='public')) value`)).rows[0].value;
 };
 const calls=[];let loseNextImport=false;
 globalThis.fetch=async(input,init={})=>{
  const url=new URL(String(input)),body=JSON.parse(init.body),headers=new Headers(init.headers);
  assert.equal(url.origin,origin);assert.equal(init.method,'POST');assert.equal(headers.get('apikey'),'synthetic-banking-public');assert.equal(headers.get('authorization'),auth);
  calls.push(url.pathname);let sql,params;
  if(url.pathname==='/rest/v1/rpc/banking_csv_preview'){
   assert.deepEqual(Object.keys(body).sort(),['p_kind','p_rows','p_subsidiary_id']);sql='select banking_csv_preview($1,$2::jsonb,$3) value';params=[body.p_kind,JSON.stringify(body.p_rows),body.p_subsidiary_id];
  }else{
   assert.equal(url.pathname,'/rest/v1/rpc/banking_csv_import');sql='select banking_csv_import($1,$2::jsonb,$3,$4::jsonb,$5,$6) value';params=[body.p_kind,JSON.stringify(body.p_rows),body.p_subsidiary_id,JSON.stringify(body.p_expected_context),body.p_fingerprint,body.p_validation_digest];
  }
  await db.exec('set role authenticated');let value;
  try{value=(await db.query(sql,params)).rows[0].value;}
  catch(cause){return Response.json({code:cause.code,message:'Synthetic SQL refusal'},{status:cause.code==='42501'?403:400});}
  finally{await db.exec('reset role');}
  if(loseNextImport&&url.pathname.endsWith('/banking_csv_import')){loseNextImport=false;throw Error('Synthetic response lost after atomic commit');}
  return Response.json(value);
 };
 const initial=await snapshot(),preview=await previewBankingCsv(auth,'checks',{csv:checks,subsidiaryId:1});
 assert.equal(preview.valid,true,JSON.stringify(preview.errors));assert.equal(preview.entries.length,2);assert.ok(preview.previewToken);assert.deepEqual(await snapshot(),initial,'Preview must not change financial data, references, balances or numbering');
 assert.ok(preview.entries.every(entry=>entry.exchangeRate==='1'&&entry.rateDate===null&&entry.rateSource==='LOCAL'));
 const legacyPreview=await previewBankingCsv(auth,'checks',{csv:checksLegacy,subsidiaryId:1});assert.equal(legacyPreview.fingerprint,preview.fingerprint);assert.equal(legacyPreview.validationDigest,preview.validationDigest);assert.deepEqual(await snapshot(),initial);
 const importsBefore=calls.length;
 await assert.rejects(importBankingCsv(auth,'checks',{csv:checks,subsidiaryId:1,previewToken:preview.previewToken.slice(0,-1)+'!'}),cause=>cause.status===409);assert.equal(calls.length,importsBefore);
 await assert.rejects(importBankingCsv(auth,'checks',{csv:checks.replace('125.50','125.51'),subsidiaryId:1,previewToken:preview.previewToken}),cause=>cause.status===409);assert.deepEqual(await snapshot(),initial);
 await actor(2);await assert.rejects(importBankingCsv(auth,'checks',{csv:checks,subsidiaryId:1,previewToken:preview.previewToken}),cause=>cause.status===409);assert.deepEqual(await snapshot(),initial);await actor(1);
 loseNextImport=true;
 await assert.rejects(importBankingCsv(auth,'checks',{csv:checksLegacy,subsidiaryId:1,previewToken:preview.previewToken}),cause=>cause.status===503);
 const committed=await snapshot();assert.equal(committed.checks,initial.checks+2);assert.equal(committed.receipts,1);assert.equal(committed.references,2);
 const recovered=await importBankingCsv(auth,'checks',{csv:checks,subsidiaryId:1,previewToken:preview.previewToken});assert.equal(recovered.alreadyImported,true);assert.equal(recovered.created,0);assert.equal(recovered.entries.length,2);assert.deepEqual(await snapshot(),committed);
 const repeatPreview=await previewBankingCsv(auth,'checks',{csv:checkCsv(parseBankingCsv(checks,'CHECKS'),'another ignored legacy value'),subsidiaryId:1});assert.equal(repeatPreview.alreadyImported,true);assert.equal(repeatPreview.previewToken,undefined);assert.deepEqual(await snapshot(),committed);
 const depositPreview=await previewBankingCsv(auth,'deposits',{csv:deposits,subsidiaryId:1});assert.equal(depositPreview.valid,true,JSON.stringify(depositPreview.errors));assert.equal(depositPreview.entries.length,2);assert.deepEqual(await snapshot(),committed);
 assert.ok(depositPreview.entries.every(entry=>!Object.hasOwn(entry,'exchangeRate')&&!Object.hasOwn(entry,'rateDate')&&!Object.hasOwn(entry,'rateSource')));
 const result=await importBankingCsv(auth,'deposits',{csv:deposits,subsidiaryId:1,previewToken:depositPreview.previewToken});assert.equal(result.valid,true);assert.equal(result.created,2);
 const final=await snapshot();assert.equal(final.deposits,initial.deposits+2);assert.equal(final.checks,initial.checks+2);assert.equal(final.journals,initial.journals+4);assert.equal(final.receipts,2);assert.equal(final.references,4);
 assert.equal(Number((await db.query('select balance from bank_account where bank_account_id=1')).rows[0].balance),800);
 assert.equal(Number((await db.query('select coalesce(sum(debit_amount-credit_amount),0) value from gl_impact where transaction_id in(select transaction_id from bank_check union select j.transaction_id from journal j join bank_deposit d using(journal_id))')).rows[0].value),0);
 const foreignCsv=checkCsv([{...parseBankingCsv(checks,'CHECKS')[0],documento_referencia:'SYN-AUTO-FOREIGN',cuenta_bancaria:'SYN-FOREIGN',moneda:'CRC',importe:'100.123456'}]);
 const foreignPreview=await previewBankingCsv(auth,'checks',{csv:foreignCsv,subsidiaryId:1});assert.equal(foreignPreview.valid,true,JSON.stringify(foreignPreview.errors));assert.equal(foreignPreview.entries[0].exchangeRate,'160.1234567890');assert.equal(foreignPreview.entries[0].rateDate,'2026-10-09');assert.equal(foreignPreview.entries[0].rateSource,'DIRECT');assert.equal(foreignPreview.entries[0].localAmount,'16032.113880');const beforeForeignImport=await snapshot();
 await db.exec("update exchange_rates set spot_rate=160.2234567890 where from_currency_id=2 and to_currency_id=1 and effective_date='2026-10-09'");
 await assert.rejects(importBankingCsv(auth,'checks',{csv:foreignCsv,subsidiaryId:1,previewToken:foreignPreview.previewToken}),cause=>cause.status===409);assert.deepEqual(await snapshot(),beforeForeignImport);
 await db.exec("update exchange_rates set spot_rate=160.1234567890 where from_currency_id=2 and to_currency_id=1 and effective_date='2026-10-09';insert into exchange_rates(from_currency_id,to_currency_id,effective_date,spot_rate)values(2,1,'2026-10-10',160.1234567890)");
 const beforeMetadataOnlyImport=await snapshot();
 await assert.rejects(importBankingCsv(auth,'checks',{csv:foreignCsv,subsidiaryId:1,previewToken:foreignPreview.previewToken}),cause=>cause.status===409);assert.deepEqual(await snapshot(),beforeMetadataOnlyImport,'Changing only the catalog source/date still invalidates the signed validation without financial or sequence writes');
 const freshForeign=await previewBankingCsv(auth,'checks',{csv:foreignCsv,subsidiaryId:1});assert.equal(freshForeign.entries[0].exchangeRate,foreignPreview.entries[0].exchangeRate);assert.equal(freshForeign.entries[0].rateDate,'2026-10-10');const foreignResult=await importBankingCsv(auth,'checks',{csv:foreignCsv,subsidiaryId:1,previewToken:freshForeign.previewToken});assert.equal(foreignResult.created,1);assert.equal(foreignResult.entries[0].exchangeRate,'160.1234567890');assert.equal(foreignResult.entries[0].localAmount,'16032.113880');
 const foreignCommitted=await snapshot();const foreignReplay=await importBankingCsv(auth,'checks',{csv:checkCsv(parseBankingCsv(foreignCsv,'CHECKS'),'0'),subsidiaryId:1,previewToken:freshForeign.previewToken});assert.equal(foreignReplay.created,0);assert.equal(foreignReplay.alreadyImported,true);assert.deepEqual(await snapshot(),foreignCommitted);
 assert.equal(Number((await db.query('select coalesce(sum(debit_amount-credit_amount),0) value from gl_impact')).rows[0].value),0);
});
