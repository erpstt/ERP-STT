import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
import {mkdir,mkdtemp,writeFile,rm,symlink,truncate,realpath,lstat} from 'node:fs/promises';
import {join,resolve,relative,isAbsolute,basename,sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createMigrationPreview,assertIsolatedTestArgs} from './lib/migration-preview.mjs';

const repository=fileURLToPath(new URL('../',import.meta.url));
const fixtureBase=resolve(repository,'.local-tools/p82-operator-tests');
const preloader=new URL('./fixtures/operator-no-live-io.mjs',import.meta.url).href;
const name='20260101000000_synthetic_preview.sql',second='20260101000001_synthetic_second.sql';
const config={entrypoint:'scripts/operator-fixture.mjs',defaultFiles:[name],allowFileArgument:true};
const canary='SYNTHETIC-P82-DO-NOT-PRINT';
function insideDirectory(parent,target){const path=relative(parent,target);return path!==''&&path!=='..'&&!path.startsWith('..'+sep)&&!isAbsolute(path);}
async function fixtureDirectory(workspace,parent,name){
  const canonicalParent=await realpath(parent);
  assert.equal(canonicalParent,parent,'The fixture parent must remain canonical');
  assert.ok(parent===workspace||insideDirectory(workspace,parent),'Fixture parents must stay inside the workspace');
  const candidate=join(parent,name);
  try{const entry=await lstat(candidate);assert.ok(entry.isDirectory()&&!entry.isSymbolicLink(),'Fixture directories cannot be links');}
  catch(error){if(error.code!=='ENOENT')throw error;await mkdir(candidate);}
  const canonical=await realpath(candidate);
  assert.ok(insideDirectory(workspace,canonical),'The fixture directory must resolve inside the workspace');
  assert.equal(relative(parent,canonical),name,'The fixture directory must remain directly below its verified parent');
  return canonical;
}
async function fixture(t){
  const workspace=await realpath(repository);
  const tools=await fixtureDirectory(workspace,workspace,'.local-tools');
  const base=await fixtureDirectory(workspace,tools,'p82-operator-tests');
  assert.equal(await realpath(fixtureBase),base,'The named fixture base must resolve to its verified workspace directory');
  const created=await mkdtemp(join(base,'case-')),directory=await realpath(created);
  assert.ok(insideDirectory(base,directory)&&insideDirectory(workspace,directory),'The new fixture must resolve inside both its base and workspace');
  assert.equal(created,directory,'The newly created fixture must be canonical');
  assert.ok(basename(directory).startsWith('case-'),'Only uniquely created operator fixtures may be cleaned up');
  t.after(async()=>{
    assert.equal(await realpath(repository),workspace,'The workspace must not change before cleanup');
    assert.equal(await realpath(fixtureBase),base,'The fixture base must not change before cleanup');
    const entry=await lstat(directory),target=await realpath(directory);
    assert.ok(entry.isDirectory()&&!entry.isSymbolicLink(),'Refusing cleanup of a replaced fixture link');
    assert.equal(target,directory,'Refusing cleanup of a non-canonical fixture');
    assert.ok(insideDirectory(base,target)&&insideDirectory(workspace,target)&&basename(target).startsWith('case-'),'Fixture cleanup must stay inside its verified base and workspace');
    await rm(target,{recursive:true,force:true});
  });
  const supabase=await fixtureDirectory(workspace,directory,'supabase');
  const root=await fixtureDirectory(workspace,supabase,'migrations');
  const sql="select 'SYNTHETIC-CONTENT-NOT-TO-PRINT';\r\n";
  await writeFile(join(root,name),sql);await writeFile(join(root,second),'select 2;\n');
  return{directory,root,sql,options:{migrationsRoot:root,cwd:directory}};
}
const blocked=(code)=>error=>error?.code===code&&!error.message.includes(canary);
function childEnvironment(){
  const env={};for(const key of ['SystemRoot','WINDIR','COMSPEC','PATH','Path','TEMP','TMP'])if(process.env[key])env[key]=process.env[key];
  return{...env,SUPABASE_URL:'https://syntheticproduction01.supabase.co',SUPABASE_DB_HOST:'syntheticproduction01.supabase.co',SUPABASE_DB_PORT:'5432',SUPABASE_DB_USER:'postgres.syntheticproduction01',SUPABASE_DB_PASSWORD:canary,PGPASSWORD:canary,ERP_TEST_EMAIL:'synthetic@example.invalid',ERP_TEST_PASSWORD:canary};
}
async function child(args,cwd){
  return await new Promise((resolveResult,reject)=>{
    const process=spawn(globalThis.process.execPath,['--import',preloader,...args],{cwd,env:childEnvironment(),stdio:['ignore','pipe','pipe']});
    let output='',error='';process.stdout.on('data',s=>output+=s);process.stderr.on('data',s=>error+=s);process.once('error',reject);
    const timeout=setTimeout(()=>{process.kill();reject(Error('Operator fixture child exceeded its deadline'));},15000);
    process.once('close',code=>{clearTimeout(timeout);resolveResult({code,output,error});});
  });
}
function safeOutput(result){assert.ok(!result.output.includes(canary));assert.ok(!result.error.includes(canary));assert.ok(!result.output.includes('SYNTHETIC-CONTENT-NOT-TO-PRINT'));assert.ok(!result.error.includes('OPERATOR_GUARD_FORBIDDEN:'));}

test('preview returns only the approved file manifest and byte-exact digest',async t=>{
  const f=await fixture(t),plan=await createMigrationPreview(config,[],f.options);
  assert.equal(plan.mode,'preview');assert.equal(plan.appliesSql,false);assert.equal(plan.loadsEnvironment,false);assert.equal(plan.opensConnections,false);assert.equal(plan.executionSupported,false);
  assert.deepEqual(plan.files,[{name,bytes:Buffer.byteLength(f.sql),sha256:createHash('sha256').update(f.sql).digest('hex')}]);
  assert.ok(!JSON.stringify(plan).includes('SYNTHETIC-CONTENT-NOT-TO-PRINT'));
});
test('basename, repository-relative and absolute paths resolve to the same permitted file',async t=>{
  const f=await fixture(t),plans=[];
  for(const input of [name,join('supabase','migrations',name),join(f.root,name)])plans.push(await createMigrationPreview(config,[input],f.options));
  for(const plan of plans)assert.deepEqual(plan.files,plans[0].files);
});
test('fixed bundles preserve order and reject an alternate file argument',async t=>{
  const f=await fixture(t),fixed={...config,allowFileArgument:false,defaultFiles:[second,name]};
  assert.deepEqual((await createMigrationPreview(fixed,['--dry-run'],f.options)).files.map(x=>x.name),[second,name]);
  await assert.rejects(createMigrationPreview(fixed,[name],f.options),blocked('INVALID_ARGUMENTS'));
});
test('help and required-file validation happen before accessing a migration directory',async()=>{
  const options={migrationsRoot:join(fixtureBase,'does-not-exist')};
  for(const flag of ['--help','-h'])assert.equal((await createMigrationPreview(config,[flag],options)).mode,'help');
  await assert.rejects(createMigrationPreview({...config,requireFile:true,defaultFiles:[]},[],options),blocked('MIGRATION_REQUIRED'));
});
test('historical execution is disabled even when apply is mixed with help, dry-run or credentials',async()=>{
  const options={migrationsRoot:join(fixtureBase,'does-not-exist')};
  for(const args of [['--apply'],['--apply=true'],['--help','--apply'],['--dry-run',name,'--apply','--project-ref='+canary]])await assert.rejects(createMigrationPreview(config,args,options),blocked('APPLY_DISABLED'));
});
test('unknown and repeated options, multiple files and non-string input fail without reflecting values',async t=>{
  const f=await fixture(t);
  for(const args of [['--password='+canary],['--project-ref',canary],['--dry-run','--dry-run'],['--help','-h'],[name,second],['--'],[null]])await assert.rejects(createMigrationPreview(config,args,f.options),blocked('INVALID_ARGUMENTS'));
});
test('traversal, control characters and arbitrary files are rejected before content can be returned',async t=>{
  const f=await fixture(t),outside=join(f.directory,name);await writeFile(outside,canary);
  for(const input of ['../'+name,'..\\'+name,join(f.root,'..','migrations',name)+'\n',name+'\u0000','.env','schema.sql',outside,'supabase/migrations/'+name+'/extra'])await assert.rejects(createMigrationPreview(config,[input],f.options),blocked('INVALID_MIGRATION_PATH'));
});
test('missing, directory and oversized migration candidates fail closed',async t=>{
  const f=await fixture(t),directoryName='20260101000002_directory.sql',largeName='20260101000003_large.sql';
  await assert.rejects(createMigrationPreview(config,['20260101000004_missing.sql'],f.options),blocked('MIGRATION_UNAVAILABLE'));
  await mkdir(join(f.root,directoryName));await assert.rejects(createMigrationPreview(config,[directoryName],f.options),blocked('INVALID_MIGRATION_PATH'));
  await writeFile(join(f.root,largeName),'');await truncate(join(f.root,largeName),10*1024*1024+1);
  await assert.rejects(createMigrationPreview(config,[largeName],f.options),blocked('INVALID_MIGRATION_PATH'));
});
test('canonical links cannot redirect a permitted name outside its migration directory',async t=>{
  const f=await fixture(t),linkName='20260101000005_link.sql',outsideDir=join(f.directory,'outside');await mkdir(outsideDir);const outsideFile=join(outsideDir,linkName);await writeFile(outsideFile,canary);
  await symlink(process.platform==='win32'?outsideDir:outsideFile,join(f.root,linkName),process.platform==='win32'?'junction':'file');
  await assert.rejects(createMigrationPreview(config,[linkName],f.options),blocked('INVALID_MIGRATION_PATH'));
});
test('isolated tests do not accept destinations, credentials or application options',()=>{
  assert.doesNotThrow(()=>assertIsolatedTestArgs([]));
  for(const args of [['--apply'],['--target=http://localhost:3000'],['--password='+canary],['--help'],null])assert.throws(()=>assertIsolatedTestArgs(args),blocked('INVALID_ARGUMENTS'));
});
test('tripwire detects caught environment, credential, client-import and network attempts',async t=>{
  const f=await fixture(t);await writeFile(join(f.directory,'.env'),'SUPABASE_DB_PASSWORD='+canary+'\n');
  for(const code of ["try{process.loadEnvFile('.env')}catch{}","try{process.env.SUPABASE_DB_PASSWORD}catch{}","try{await import('pg')}catch{}","try{await fetch('https://synthetic.invalid')}catch{}","try{(await import('node:fs')).readFileSync('.env')}catch{}","try{await(await import('node:fs/promises')).readFile('.env')}catch{}"]){const result=await child(['--input-type=module','-e',code],f.directory);assert.equal(result.code,86);assert.match(result.error,/OPERATOR_GUARD_FORBIDDEN:/);assert.ok(!result.error.includes(canary));}
});
test('all three real CLI entrypoints preview without environment, DB clients or network',async t=>{
  const f=await fixture(t);await writeFile(join(f.directory,'.env'),'SUPABASE_DB_PASSWORD='+canary+'\n');
  for(const [file,args,count]of [['apply-audit-migration.mjs',[],1],['apply-audit-change-report.mjs',['--dry-run'],3],['apply-migration.mjs',['20261104031255_contain_raw_audit_catalog_reads.sql'],1]]){
    const result=await child([join(repository,'scripts',file),...args],f.directory);assert.equal(result.code,0,result.error);safeOutput(result);const plan=JSON.parse(result.output);assert.equal(plan.mode,'preview');assert.equal(plan.files.length,count);assert.equal(plan.opensConnections,false);assert.equal(plan.loadsEnvironment,false);assert.equal(plan.appliesSql,false);
  }
});
test('real CLI rejects execution, target/secret flags and outside paths without leaking arguments',async t=>{
  const f=await fixture(t),files=['apply-audit-migration.mjs','apply-audit-change-report.mjs','apply-migration.mjs'];
  for(const file of files)for(const args of [['--apply','--project-ref='+canary],['--password='+canary]]){const result=await child([join(repository,'scripts',file),...args],f.directory);assert.equal(result.code,2);safeOutput(result);const failure=JSON.parse(result.error);assert.equal(failure.mode,'blocked');assert.equal(failure.code,args[0]==='--apply'?'APPLY_DISABLED':'INVALID_ARGUMENTS');assert.equal(failure.opensConnections,false);}
  const result=await child([join(repository,'scripts/apply-migration.mjs'),join(f.directory,name)],f.directory);assert.equal(result.code,2);safeOutput(result);assert.equal(JSON.parse(result.error).code,'INVALID_MIGRATION_PATH');
});
