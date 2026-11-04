import assert from 'node:assert/strict';
import {test} from 'node:test';
import {spawnSync} from 'node:child_process';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {assertIsolatedTestArgs} from './lib/migration-preview.mjs';

assertIsolatedTestArgs();
const preloader=new URL('./fixtures/operator-no-live-io.mjs',import.meta.url).href;
const cwd=fileURLToPath(new URL('./fixtures/',import.meta.url));
const canary='SYNTHETIC-P128-DO-NOT-READ-OR-PRINT';
const operators=[
 {
  "file": "apply-opening-bank-auxiliary.mjs",
  "sqls": [
   "20261021100000_opening_bank_auxiliary.sql",
   "20261021110000_opening_bank_zero_balance.sql"
  ]
 },
 {
  "file": "apply-opening-pending-auxiliary.mjs",
  "sqls": [
   "20261014110000_opening_pending_invoice_auxiliary.sql"
  ]
 },
 {
  "file": "apply-payment-request-tax-agency.mjs",
  "sqls": [
   "20261027090000_tax_agency_payment_requests.sql",
   "20261027101000_payment_request_tax_agency_reporting.sql"
  ]
 },
 {
  "file": "apply-pending-invoice-reclassification.mjs",
  "sqls": [
   "20261021120000_pending_invoice_annual_reclassification.sql"
  ]
 },
 {
  "file": "apply-pending-reversal-historical-fx-integrity.mjs",
  "sqls": [
   "20261021130000_pending_reversal_historical_fx_integrity.sql"
  ]
 },
 {
  "file": "apply-sales-invoice-intercompany-receivable-account.mjs",
  "sqls": [
   "20261020100000_sales_invoice_intercompany_receivable_account.sql"
  ]
 },
 {
  "file": "apply-supplier-invoice-payable-account-routing.mjs",
  "sqls": [
   "20261020110000_supplier_invoice_payable_account_routing.sql"
  ]
 }
];
function environment(){
 const env={};for(const key of['SystemRoot','WINDIR','COMSPEC','PATHEXT','PATH','Path','TEMP','TMP'])if(process.env[key])env[key]=process.env[key];
 return{...env,SUPABASE_URL:'https://synthetic-production-p128.supabase.co',SUPABASE_DB_HOST:'synthetic-production-p128.supabase.co',SUPABASE_DB_USER:'postgres.synthetic-p128',SUPABASE_DB_PORT:'5432',SUPABASE_DB_PASSWORD:canary,SUPABASE_SERVICE_ROLE_KEY:canary,PGPASSWORD:canary,ERP_TEST_PASSWORD:canary,SMTP_PASSWORD:canary};
}
function run(file,args=[]){
 const script=fileURLToPath(new URL('./'+file,import.meta.url));
 // spawnSync returns after the child exits; no temporary directory or cleanup
 // can race a running child. All live IO is blocked by the shared tripwire.
 const result=spawnSync(process.execPath,['--import',preloader,script,...args],{cwd,env:environment(),encoding:'utf8',timeout:5000,killSignal:'SIGKILL',maxBuffer:64*1024,stdio:['ignore','pipe','pipe'],windowsHide:true});
 if(result.error)throw result.error;
 assert.equal(result.signal,null,'Operator child must confirm normal exit');
 assert.ok(!result.stdout.includes(canary));assert.ok(!result.stderr.includes(canary));
 assert.ok(!result.stderr.includes('OPERATOR_GUARD_FORBIDDEN:'));
 return result;
}
function safeState(value){assert.equal(value.appliesSql,false);assert.equal(value.loadsEnvironment,false);assert.equal(value.opensConnections,false);}

test('seven opening and routing operators return the complete fixed SQL manifests in their original order',async()=>{
 for(const {file,sqls}of operators){
  const expected=await Promise.all(sqls.map(async name=>{
   const bytes=await readFile(new URL('../supabase/migrations/'+name,import.meta.url));
   return{name,bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')};
  }));
  for(const args of[[],['--dry-run']]){
   const result=run(file,args);assert.equal(result.status,0,result.stderr);assert.equal(result.stderr,'');
   const preview=JSON.parse(result.stdout);assert.equal(preview.mode,'preview');assert.equal(preview.entrypoint,'scripts/'+file);safeState(preview);assert.equal(preview.executionSupported,false);assert.deepEqual(preview.files,expected);
   assert.ok(!result.stdout.includes('grant execute on function'));assert.ok(!result.stdout.includes('create or replace function'));assert.ok(!Object.hasOwn(preview,'reportSnapshot'));assert.ok(!Object.hasOwn(preview,'applied'));assert.ok(!Object.hasOwn(preview,'alreadyInstalled'));
  }
 }
});

test('help remains available without reading environment, loading DB clients or claiming a remote check',()=>{
 for(const {file}of operators)for(const flag of['--help','-h']){
  const result=run(file,[flag]);assert.equal(result.status,0,result.stderr);assert.equal(result.stderr,'');
  const help=JSON.parse(result.stdout);assert.equal(help.mode,'help');safeState(help);assert.equal(help.executionSupported,false);assert.deepEqual(help.files,[]);
 }
});

test('apply is always blocked, including mixtures with help, dry-run and synthetic project secrets',()=>{
 for(const {file}of operators)for(const args of[['--apply'],['--apply=true'],['--help','--apply'],['--dry-run','--apply'],['--verify','--apply'],['--apply','--project-ref='+canary]]){
  const result=run(file,args);assert.equal(result.status,2);assert.equal(result.stdout,'');
  const failure=JSON.parse(result.stderr);assert.equal(failure.mode,'blocked');assert.equal(failure.code,'APPLY_DISABLED');safeState(failure);
 }
});

test('connection destinations, credentials and former live verification are rejected safely',()=>{
 for(const {file}of operators)for(const args of[['--project-ref='+canary],['--password='+canary],['--host=synthetic-production-p128.supabase.co'],['--target='+canary],['--live'],['--verify']]){
  const result=run(file,args);assert.equal(result.status,2);assert.equal(result.stdout,'');
  const failure=JSON.parse(result.stderr);assert.equal(failure.code,'INVALID_ARGUMENTS');safeState(failure);
  assert.ok(!result.stderr.includes('synthetic-production-p128.supabase.co'));
 }
});

test('fixed operators reject SQL overrides, traversal, extra files and repeated preview options',()=>{
 for(const {file,sqls}of operators)for(const args of[[sqls[0]],['../'+sqls[0]],['C:\\synthetic-private\\'+canary+'.sql'],[sqls[0],sqls.at(-1)],['--dry-run','--dry-run'],['--help','-h']]){
  const result=run(file,args);assert.equal(result.status,2);assert.equal(result.stdout,'');
  const failure=JSON.parse(result.stderr);assert.equal(failure.code,'INVALID_ARGUMENTS');safeState(failure);
 }
});

test('the retired data-dependent payment-request operator never offers a partial preview or executes its probes',()=>{
 const file='apply-payment-request-dimensions-routing-numbering.mjs';
 const variants=[[],['--help'],['-h'],['--verify'],['--dry-run'],['--apply'],['--apply=true'],['--help','--apply'],['--project-ref='+canary],['--password='+canary],['--host=synthetic-production-p128.supabase.co'],['--file='+canary],['../'+canary+'.sql'],['--live']];
 for(const args of variants){
  const result=run(file,args);assert.equal(result.status,2);assert.equal(result.stdout,'');
  const failure=JSON.parse(result.stderr);assert.equal(failure.mode,'blocked');assert.equal(failure.code,'OPERATOR_RETIRED');safeState(failure);assert.equal(failure.executionSupported,false);assert.match(failure.message,/escrituras/);assert.ok(!Object.hasOwn(failure,'files'));
 }
});
