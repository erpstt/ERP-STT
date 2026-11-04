import assert from 'node:assert/strict';
import {test} from 'node:test';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {assertIsolatedTestArgs} from './lib/migration-preview.mjs';

assertIsolatedTestArgs();
const canary='SYNTHETIC-P117-PRIVATE-DO-NOT-READ';
const env={};for(const key of ['SystemRoot','WINDIR','COMSPEC','PATHEXT','PATH','TEMP','TMP'])if(process.env[key]!==undefined)env[key]=process.env[key];
Object.assign(env,{PGPASSWORD:canary,SUPABASE_URL:'https://synthetic-p117.supabase.co',SUPABASE_DB_PASSWORD:canary,SUPABASE_SERVICE_ROLE_KEY:canary,SMTP_PASSWORD:canary});
test('the retired fixed-project branding installer rejects every invocation without reading credentials or opening IO',()=>{
  for(const args of [[],['--help'],['--dry-run'],['--apply'],['--apply=true'],['--project-ref='+canary],['--password='+canary],['--host=synthetic-p117.supabase.co'],['--file='+canary],['../'+canary+'.sql'],['--live']]){
    const child=spawnSync(process.execPath,['--import',new URL('./fixtures/operator-no-live-io.mjs',import.meta.url).href,fileURLToPath(new URL('./apply-subsidiary-branding-migration.mjs',import.meta.url)),...args],{cwd:fileURLToPath(new URL('./fixtures/',import.meta.url)),env,encoding:'utf8',timeout:5000,maxBuffer:64*1024,stdio:['ignore','pipe','pipe'],windowsHide:true});
    if(child.error)throw child.error;assert.equal(child.signal,null);assert.equal(child.status,2);assert.equal(child.stdout,'');assert.ok(!child.stderr.includes(canary));assert.ok(!child.stderr.includes('OPERATOR_GUARD_FORBIDDEN:'));
    const result=JSON.parse(child.stderr);assert.equal(result.code,'OPERATOR_RETIRED');assert.equal(result.mode,'blocked');for(const key of ['appliesSql','loadsEnvironment','opensConnections','executionSupported'])assert.equal(result[key],false);
  }
});
