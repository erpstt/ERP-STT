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
const canary='SYNTHETIC-P105-DO-NOT-READ-OR-PRINT';
const operators=[
 {
  "file": "apply-bank-check-migration.mjs",
  "sql": "20260903100000_bank_checks_transfers_transaction.sql"
 },
 {
  "file": "apply-bank-check-periods.mjs",
  "sql": "20260903110000_bank_check_periods.sql"
 },
 {
  "file": "apply-bank-deposit-management-migration.mjs",
  "sql": "20260902150000_manage_bank_deposits.sql"
 },
 {
  "file": "apply-bank-deposit-migration.mjs",
  "sql": "20260902130000_bank_deposit_transaction.sql"
 },
 {
  "file": "apply-bank-transfer-migration.mjs",
  "sql": "20260902090000_bank_account_transfers.sql"
 },
 {
  "file": "apply-transfer-balance-fix.mjs",
  "sql": "20260903130000_fix_transfer_gl_balance.sql"
 },
 {
  "file": "apply-supplier-payment-batches.mjs",
  "sql": "20261003120000_supplier_payment_batches.sql"
 },
 {
  "file": "apply-customer-payment-bank-fee.mjs",
  "sql": "20261026130000_customer_payment_bank_fee.sql"
 },
 {
  "file": "apply-customer-payment-edit-options.mjs",
  "sql": "20260930164000_customer_payment_edit_options.sql"
 },
 {
  "file": "apply-customer-payment-exchange-rate-integrity.mjs",
  "sql": "20261026140000_customer_payment_exchange_rate_integrity.sql"
 }
];
function environment(){
 const env={};for(const key of['SystemRoot','WINDIR','COMSPEC','PATHEXT','PATH','Path','TEMP','TMP'])if(process.env[key])env[key]=process.env[key];
 return{...env,SUPABASE_URL:'https://synthetic-production-p105.supabase.co',SUPABASE_DB_HOST:'synthetic-production-p105.supabase.co',SUPABASE_DB_USER:'postgres.synthetic-p105',SUPABASE_DB_PORT:'5432',SUPABASE_DB_PASSWORD:canary,SUPABASE_SERVICE_ROLE_KEY:canary,PGPASSWORD:canary,ERP_TEST_PASSWORD:canary,SMTP_PASSWORD:canary};
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

test('ten financial migration operators return only the fixed SQL manifest from a different working directory',async()=>{
 for(const {file,sql}of operators){
  const bytes=await readFile(new URL('../supabase/migrations/'+sql,import.meta.url));
  const expected={name:sql,bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')};
  for(const args of[[],['--dry-run']]){
   const result=run(file,args);assert.equal(result.status,0,result.stderr);assert.equal(result.stderr,'');
   const preview=JSON.parse(result.stdout);assert.equal(preview.mode,'preview');assert.equal(preview.entrypoint,'scripts/'+file);safeState(preview);assert.equal(preview.executionSupported,false);assert.deepEqual(preview.files,[expected]);
   assert.ok(!result.stdout.includes('grant execute on function'));assert.ok(!result.stdout.includes('create or replace function'));assert.ok(!Object.hasOwn(preview,'reportSnapshot'));assert.ok(!Object.hasOwn(preview,'applied'));
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
 for(const {file}of operators)for(const args of[['--apply'],['--apply=true'],['--help','--apply'],['--dry-run','--apply'],['--apply','--project-ref='+canary]]){
  const result=run(file,args);assert.equal(result.status,2);assert.equal(result.stdout,'');
  const failure=JSON.parse(result.stderr);assert.equal(failure.mode,'blocked');assert.equal(failure.code,'APPLY_DISABLED');safeState(failure);
 }
});

test('connection destinations and credentials are rejected without reflecting their values',()=>{
 for(const {file}of operators)for(const args of[['--project-ref='+canary],['--password='+canary],['--host=synthetic-production-p105.supabase.co'],['--target='+canary],['--live']]){
  const result=run(file,args);assert.equal(result.status,2);assert.equal(result.stdout,'');
  const failure=JSON.parse(result.stderr);assert.equal(failure.code,'INVALID_ARGUMENTS');safeState(failure);
  assert.ok(!result.stderr.includes('synthetic-production-p105.supabase.co'));
 }
});

test('fixed operators reject SQL overrides, traversal, extra files and repeated preview options',()=>{
 for(const {file,sql}of operators)for(const args of[[sql],['../'+sql],['C:\\synthetic-private\\'+canary+'.sql'],[sql,sql],['--dry-run','--dry-run'],['--help','-h']]){
  const result=run(file,args);assert.equal(result.status,2);assert.equal(result.stdout,'');
  const failure=JSON.parse(result.stderr);assert.equal(failure.code,'INVALID_ARGUMENTS');safeState(failure);
 }
});
