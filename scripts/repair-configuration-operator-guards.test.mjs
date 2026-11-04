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
const canary='SYNTHETIC-P145-DO-NOT-READ-OR-PRINT';
const hostname='synthetic-production-p145.supabase.co';
const operators=[
 {file:'activate-asset-proposals.mjs',sqls:['20260917140000_fixed_asset_capitalization_proposals.sql']},
 {file:'activate-budget-control.mjs',sqls:['20260921120000_budget_control.sql']},
 {file:'activate-customer-statements.mjs',sqls:['20260920140000_customer_statement_notifications.sql']},
 {file:'activate-payment-notifications.mjs',sqls:['20260920120000_supplier_payment_email_notifications.sql']}
];
const retired=[
 {file:'account-fx-inheritance.mjs',reason:/escrituras en cuentas y grupos/},
 {file:'configure-budget-categories.mjs',reason:/creaban, editaban, aprobaban y copiaban presupuestos/}
];
function environment(){
 const env={};for(const key of['SystemRoot','WINDIR','COMSPEC','PATHEXT','PATH','Path','TEMP','TMP'])if(process.env[key])env[key]=process.env[key];
 return{...env,SUPABASE_URL:'https://'+hostname,SUPABASE_DB_HOST:hostname,SUPABASE_DB_USER:'postgres.synthetic-p145',SUPABASE_DB_PORT:'5432',SUPABASE_DB_PASSWORD:canary,SUPABASE_SERVICE_ROLE_KEY:canary,PGPASSWORD:canary,ERP_TEST_PASSWORD:canary,SMTP_PASSWORD:canary,EMAIL_NOTIFICATIONS_ENABLED:'true'};
}
function run(file,args=[]){
 const script=fileURLToPath(new URL('./'+file,import.meta.url));
 // No temporary directory or cleanup: children confirm exit before returning.
 const result=spawnSync(process.execPath,['--import',preloader,script,...args],{cwd,env:environment(),encoding:'utf8',timeout:5000,killSignal:'SIGKILL',maxBuffer:64*1024,stdio:['ignore','pipe','pipe'],windowsHide:true});
 if(result.error)throw result.error;
 assert.equal(result.signal,null,'Operator child must confirm normal exit');
 for(const output of[result.stdout,result.stderr]){
  assert.ok(!output.includes(canary));assert.ok(!output.includes(hostname));
  assert.ok(!output.includes('OPERATOR_GUARD_FORBIDDEN:'));
 }
 return result;
}
function safeState(value){assert.equal(value.appliesSql,false);assert.equal(value.loadsEnvironment,false);assert.equal(value.opensConnections,false);}

test('four activators preview their entire fixed SQL files without claiming remote activation or checks',async()=>{
 for(const {file,sqls}of operators){
  const expected=await Promise.all(sqls.map(async name=>{
   const bytes=await readFile(new URL('../supabase/migrations/'+name,import.meta.url));
   return{name,bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')};
  }));
  for(const args of[[],['--dry-run']]){
   const result=run(file,args);assert.equal(result.status,0,result.stderr);assert.equal(result.stderr,'');
   const preview=JSON.parse(result.stdout);assert.equal(preview.mode,'preview');assert.equal(preview.entrypoint,'scripts/'+file);safeState(preview);assert.equal(preview.executionSupported,false);assert.deepEqual(preview.files,expected);
   for(const key of['activated','installed','alreadyInstalled','checks','reportAvailable','proposals','canManage','hasPrimaryBook','balanced','difference','smtpEnabled','queued','active_templates','approvedBudgets','permissions','applied'])assert.ok(!Object.hasOwn(preview,key));
   assert.ok(!result.stdout.includes('create function'));assert.ok(!result.stdout.includes('grant execute'));
  }
 }
});

test('help succeeds without environment, DB clients or live installation verification',()=>{
 for(const {file}of operators)for(const flag of['--help','-h']){
  const result=run(file,[flag]);assert.equal(result.status,0,result.stderr);assert.equal(result.stderr,'');
  const help=JSON.parse(result.stdout);assert.equal(help.mode,'help');assert.equal(help.entrypoint,'scripts/'+file);safeState(help);assert.equal(help.executionSupported,false);assert.deepEqual(help.files,[]);
 }
});

test('apply is blocked even when mixed with help, preview or synthetic secrets',()=>{
 for(const {file}of operators)for(const args of[['--apply'],['--apply=true'],['--help','--apply'],['--dry-run','--apply'],['--verify','--apply'],['--apply','--project-ref='+canary]]){
  const result=run(file,args);assert.equal(result.status,2);assert.equal(result.stdout,'');
  const failure=JSON.parse(result.stderr);assert.equal(failure.mode,'blocked');assert.equal(failure.code,'APPLY_DISABLED');safeState(failure);
 }
});

test('connection parameters, secrets and former live verification are rejected without reflection',()=>{
 for(const {file}of operators)for(const args of[['--project-ref='+canary],['--password='+canary],['--host='+hostname],['--target='+canary],['--live'],['--verify']]){
  const result=run(file,args);assert.equal(result.status,2);assert.equal(result.stdout,'');
  const failure=JSON.parse(result.stderr);assert.equal(failure.code,'INVALID_ARGUMENTS');safeState(failure);
 }
});

test('fixed manifests reject replacements, traversal, extra files and repeated flags',()=>{
 for(const {file,sqls}of operators)for(const args of[[sqls[0]],['../'+sqls[0]],['C:\\synthetic-private\\'+canary+'.sql'],[sqls[0],sqls[0]],['--dry-run','--dry-run'],['--help','-h']]){
  const result=run(file,args);assert.equal(result.status,2);assert.equal(result.stdout,'');
  const failure=JSON.parse(result.stderr);assert.equal(failure.code,'INVALID_ARGUMENTS');safeState(failure);
 }
});

test('data-dependent repair/configuration operators remain retired for every CLI mode',()=>{
 const variants=[[],['--help'],['-h'],['--verify'],['--dry-run'],['--apply'],['--apply=true'],['--help','--apply'],['--project-ref='+canary],['--password='+canary],['--host='+hostname],['--file='+canary],['../'+canary+'.sql'],['--live']];
 for(const {file,reason}of retired)for(const args of variants){
  const result=run(file,args);assert.equal(result.status,2);assert.equal(result.stdout,'');
  const failure=JSON.parse(result.stderr);assert.equal(failure.mode,'blocked');assert.equal(failure.code,'OPERATOR_RETIRED');safeState(failure);assert.equal(failure.executionSupported,false);assert.match(failure.message,reason);assert.ok(!Object.hasOwn(failure,'files'));
 }
});

