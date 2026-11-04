import assert from 'node:assert/strict';
import {test,after} from 'node:test';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {assertIsolatedTestArgs} from './lib/migration-preview.mjs';

assertIsolatedTestArgs();
const preloader=new URL('./fixtures/operator-no-live-io.mjs',import.meta.url).href;
const cwd=fileURLToPath(new URL('./fixtures/',import.meta.url));
const canary='SYNTHETIC-P150-DO-NOT-READ-OR-PRINT';
const hostname='synthetic-production-p150.supabase.co';
const operators=[
 {file:'configure-scheduled-report-catalog.mjs',sql:'20260921200000_scheduled_report_catalog.sql',reason:/guardado de reportes, reemplazos temporales de funciones/},
 {file:'configure-scheduled-reports.mjs',sql:'20260921190000_scheduled_reports.sql',reason:/cambios de programación, procesamiento de trabajos/},
 {file:'configure-tax-calendar.mjs',sql:'20260927090000_tax_calendar.sql',reason:/cambios de eventos, documentos, membresías y colas/},
 {file:'configure-tax-obligation-catalog.mjs',sql:'20260928090000_tax_obligation_catalog_and_templates.sql',reason:/cambios de obligaciones, plantillas, eventos y encolado/},
 {file:'import-permissions.mjs',reason:/cambios de permisos a partir de un XLSX/},
 {file:'link-existing-laptop-proposal.mjs',reason:/vinculación histórica específica/},
 {file:'sync-consolidated-exchange-rates.mjs',reason:/sincronización de tasas/}
];
function environment(){
 const env={};for(const key of['SystemRoot','WINDIR','COMSPEC','PATHEXT','PATH','Path','TEMP','TMP'])if(process.env[key])env[key]=process.env[key];
 return{...env,SUPABASE_URL:'https://'+hostname,SUPABASE_DB_HOST:hostname,SUPABASE_DB_USER:'postgres.synthetic-p150',SUPABASE_DB_PORT:'5432',SUPABASE_DB_PASSWORD:canary,SUPABASE_SERVICE_ROLE_KEY:canary,DATABASE_URL:'postgresql://synthetic:'+canary+'@'+hostname+'/synthetic',PGPASSWORD:canary,ERP_TEST_PASSWORD:canary,SMTP_PASSWORD:canary};
}
let checkedChildren=0;
function retired(operator,args=[]){
 const script=fileURLToPath(new URL('./'+operator.file,import.meta.url));
 // No temporary files or cleanup; every child confirms exit before returning.
 const result=spawnSync(process.execPath,['--import',preloader,script,...args],{cwd,env:environment(),encoding:'utf8',timeout:5000,killSignal:'SIGKILL',maxBuffer:64*1024,stdio:['ignore','pipe','pipe'],windowsHide:true});
 if(result.error)throw result.error;
 assert.equal(result.signal,null,'Operator child must confirm normal exit');
 for(const output of[result.stdout,result.stderr]){
  assert.ok(!output.includes(canary));assert.ok(!output.includes(hostname));
  assert.ok(!output.includes('OPERATOR_GUARD_FORBIDDEN:'));
 }
 assert.equal(result.status,2);assert.equal(result.stdout,'');
 const failure=JSON.parse(result.stderr);
 assert.equal(failure.mode,'blocked');assert.equal(failure.code,'OPERATOR_RETIRED');
 assert.equal(failure.appliesSql,false);assert.equal(failure.loadsEnvironment,false);assert.equal(failure.opensConnections,false);assert.equal(failure.executionSupported,false);
 assert.match(failure.message,operator.reason);
 for(const key of['files','workbook','rows','snapshot','snapshots','sync','stored','rulesValid','applied','committed','alreadyInstalled','configuredSubsidiaries'])assert.ok(!Object.hasOwn(failure,key));
 checkedChildren++;
}
after(()=>{console.log(JSON.stringify({checkedChildren}));});

test('seven mixed or ad-hoc entrypoints stay retired by default, in dry-run and in help modes',()=>{
 for(const operator of operators)for(const args of[[],['--dry-run'],['--help'],['-h']])retired(operator,args);
});

test('former apply and commit opt-ins cannot restore execution, even in mixed modes',()=>{
 const variants=[['--apply'],['--apply=true'],['--commit'],['--commit=true'],['--help','--apply'],['--dry-run','--commit'],['--apply','--project-ref='+canary]];
 for(const operator of operators)for(const args of variants)retired(operator,args);
});

test('connection destinations, credentials and live-check flags never cause IO or value reflection',()=>{
 const variants=[['--project-ref='+canary],['--password='+canary],['--host='+hostname],['--connection-string=postgresql://'+canary+'@'+hostname+'/synthetic'],['--target='+canary],['--live'],['--verify']];
 for(const operator of operators)for(const args of variants)retired(operator,args);
});

test('workbook paths, file overrides and repeated flags are rejected without opening or previewing the input',()=>{
 const variants=[[canary+'.xlsx'],['../'+canary+'.xlsx'],['C:\\synthetic-private\\'+canary+'.xlsx'],['--file='+canary+'.sql'],['--dry-run','--dry-run']];
 for(const operator of operators)for(const args of variants)retired(operator,args);
});

test('former snapshot modes cannot read records or export source data',()=>{
 for(const operator of operators)for(const args of[['--snapshot'],['--snapshots'],['--snapshot','--apply']])retired(operator,args);
});

test('the four fixed migration components cannot be mistaken for a complete executable or preview plan',()=>{
 for(const operator of operators.filter(item=>item.sql))retired(operator,[operator.sql]);
});
