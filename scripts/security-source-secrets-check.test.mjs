import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,createHash} from 'node:crypto';
import {mkdirSync,readFileSync,readdirSync,writeFileSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {VERSION,SOURCE_ROOTS,LIMITS,MANIFEST_SHA256,RELEASE_BASE,COUNT_TEMPLATE,FIXED_CONFIG,SourceSecretsError,sha256,verifyPinnedBytes,assetFor,isolatedEnvironment,createOwnedTemporary,removeOwnedTemporary,command,directHttpsTransport,downloadPublicAsset,verifyReleaseBuffers,acquireExecutable,prepareScanner,parseCountsReport,scan,verifyCanary,sourceManifest,assertExactCommit,createSourceSnapshot,verifySourceSnapshot,publicFailure,checkSourceSecrets,exitCode} from './security-source-secrets-lib.mjs';

const scopeSha='a'.repeat(40),otherSha='b'.repeat(40);
function rejected(operation,code){assert.throws(operation,error=>error instanceof SourceSecretsError&&error.code===code);}
async function rejectedAsync(operation,code){await assert.rejects(operation,error=>error instanceof SourceSecretsError&&error.code===code);}
function output(value,status=0,stderr=''){return{status,signal:null,stdout:Buffer.isBuffer(value)?value:Buffer.from(value),stderr:Buffer.from(stderr)};}
function counts(ruleIds=[]){return JSON.stringify({findingCount:ruleIds.length,ruleIds});}
function temporary(t){const owned=createOwnedTemporary();t.after(()=>removeOwnedTemporary(owned));return owned.root;}
function scannerFixture(t,run){
 const root=temporary(t),binary=join(root,'synthetic-executable');const bytes=Buffer.from('synthetic executable bytes, never executed');writeFileSync(binary,bytes,{flag:'wx'});
 return prepareScanner(root,{binary,binarySha256:sha256(bytes)},isolatedEnvironment(),run);
}
function oid(bytes){return createHash('sha1').update('blob '+bytes.length+'\0').update(bytes).digest('hex');}
function syntheticGit(entries,{head=scopeSha,extraRows=[],badObject=false,declaredSize}={}){
 const files=new Map(entries.map(([name,body])=>[name,Buffer.from(body)]));const objects=new Map([...files.values()].map(body=>[oid(body),body]));const events=[];
 return{files,events,run(command,args,options){
  assert.equal(command,'git');events.push(args);
  if(args[0]==='rev-parse')return output((args[2]==='HEAD^{commit}'?head:scopeSha)+'\n');
  if(args[0]==='ls-tree')return output([...files].map(([name,body])=>'100644 blob '+oid(body)+'\t'+name+'\0').join('')+extraRows.join(''));
  assert.equal(args[0],'cat-file');const requested=String(options.input).trim().split('\n');
  if(args[1]==='--batch-check')return output(requested.map(key=>key+' blob '+(declaredSize??objects.get(key).length)).join('\n')+'\n');
  assert.equal(args[1],'--batch');return output(Buffer.concat(requested.flatMap(key=>{const body=objects.get(key);return[Buffer.from(key+' blob '+body.length+'\n'),badObject?Buffer.alloc(body.length,120):body,Buffer.from('\n')];})));
 }};
}
const baseEntries=[['package.json','{}\n'],['package-lock.json','{}\n'],['src/synthetic.mjs','export const number = 1;\n'],['public/synthetic.js','const number = 1;\n'],['supabase/migrations/synthetic.sql','select 1;\n']];

test('source scope includes the isolated PDF renderer and workflows while excluding their environment files',t=>{
 const root=temporary(t),workspace=join(root,'workspace'),directory=join(root,'source');mkdirSync(workspace);mkdirSync(directory);
 const included=[...baseEntries,['services/pdf-renderer/server.mjs','export const synthetic = true;\n'],['services/pdf-renderer/Dockerfile','FROM synthetic-placeholder\n'],['services/pdf-renderer/package.json','{}\n'],['.github/workflows/synthetic.yml','name: synthetic\n']];
 const ignored=[['services/pdf-renderer/.env','synthetic excluded value'],['.github/workflows/.env.local','synthetic excluded value']];
 const git=syntheticGit([...included,...ignored]);
 assert.deepEqual(createSourceSnapshot({workspace,scopeSha,directory,env:{},run:git.run}),{files:included.length,bytes:included.reduce((sum,entry)=>sum+Buffer.byteLength(entry[1]),0)});
 for(const[name,body]of included)assert.equal(readFileSync(join(directory,name),'utf8'),body);
 for(const[name]of ignored)assert.equal(existsSync(join(directory,name)),false);
 const requests=git.events.filter(args=>args[0]==='ls-tree');assert.equal(requests.length,1);assert.ok(requests[0].includes('services/pdf-renderer'));assert.ok(requests[0].includes('.github/workflows'));
});

test('fixed release pins cover only Linux and Windows x64 without a global-binary fallback',()=>{
 assert.equal(VERSION,'8.30.1');assert.equal(assetFor('linux','x64').sha256,'551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb');
 assert.equal(assetFor('win32','x64').sha256,'d29144deff3a68aa93ced33dddf84b7fdc26070add4aa0f4513094c8332afc4e');assert.match(MANIFEST_SHA256,/^[a-f0-9]{64}$/);
 for(const[platform,arch]of[['linux','arm64'],['darwin','x64'],['win32','ia32'],['toString','x64']])rejected(()=>assetFor(platform,arch),'UNSUPPORTED_PLATFORM');
});
test('child environment keeps OS essentials while dropping credentials, proxies, scanner overrides and NODE_OPTIONS',()=>{
 const marker=randomBytes(12).toString('hex'),input={PATH:'synthetic-path',TEMP:'synthetic-temp',SystemRoot:'synthetic-system',HOME:marker,GITHUB_TOKEN:marker,SUPABASE_SERVICE_ROLE_KEY:marker,NODE_OPTIONS:marker,HTTPS_PROXY:marker,GITLEAKS_CONFIG:marker,GITLEAKS_CONFIG_TOML:marker,GIT_CONFIG_COUNT:marker};
 const windows=isolatedEnvironment(input,'win32'),linux=isolatedEnvironment(input,'linux');assert.deepEqual(Object.keys(windows).sort(),['PATH','SystemRoot','TEMP'].sort());assert.deepEqual(Object.keys(linux).sort(),['PATH','TEMP']);assert.equal(JSON.stringify({windows,linux}).includes(marker),false);
});
test('pinned byte verifier accepts exact bytes and rejects corruption, length overflow and nonbuffers',()=>{
 const bytes=Buffer.from('synthetic checksum fixture');verifyPinnedBytes(bytes,sha256(bytes),bytes.length,'FIXTURE_HASH_MISMATCH');
 for(const value of[Buffer.from('changed'),bytes.toString(),null])rejected(()=>verifyPinnedBytes(value,sha256(bytes),bytes.length,'FIXTURE_HASH_MISMATCH'),'FIXTURE_HASH_MISMATCH');
 rejected(()=>verifyPinnedBytes(bytes,sha256(bytes),bytes.length-1,'FIXTURE_HASH_MISMATCH'),'FIXTURE_HASH_MISMATCH');
 rejected(()=>verifyReleaseBuffers(assetFor('linux','x64'),bytes,bytes),'MANIFEST_HASH_MISMATCH');
});
test('acquisition fails before any extraction or executable spawn when mock download hashes differ',async t=>{
 const root=temporary(t),calls=[];const marker=randomBytes(18).toString('hex');
 await rejectedAsync(()=>acquireExecutable({root,platform:'linux',arch:'x64',env:{},transport:async(url,options)=>{calls.push(url);assert.equal(options.redirect,'manual');assert.equal(Object.hasOwn(options.headers,'Authorization'),false);return new Response(marker);},run(){assert.fail('An unverified executable must never be spawned.');}}),'MANIFEST_HASH_MISMATCH');
 assert.deepEqual(calls,[RELEASE_BASE+'gitleaks_8.30.1_checksums.txt',RELEASE_BASE+assetFor('linux','x64').filename]);assert.equal(readdirSync(root).length,0);
});
test('download follows only bounded official HTTPS redirects and enforces size/status failures without bodies',async()=>{
 const seen=[];const downloaded=await downloadPublicAsset(RELEASE_BASE+'synthetic',32,async(url,options)=>{seen.push({url,headers:Object.keys(options.headers)});return seen.length===1?new Response(null,{status:302,headers:{location:'https://release-assets.githubusercontent.com/synthetic'}}):new Response('synthetic');});
 assert.equal(downloaded.toString(),'synthetic');assert.equal(seen.length,2);assert.deepEqual(seen[1].headers.sort(),['Accept','User-Agent']);
 await rejectedAsync(()=>downloadPublicAsset(RELEASE_BASE+'synthetic',32,async()=>new Response(null,{status:302,headers:{location:'https://example.invalid/private'}})),'INVALID_ASSET_URL');
 await rejectedAsync(()=>downloadPublicAsset(RELEASE_BASE+'synthetic',32,async()=>new Response(null,{status:302,headers:{location:RELEASE_BASE+'loop'}})),'ASSET_REDIRECT_LIMIT');
 await rejectedAsync(()=>downloadPublicAsset(RELEASE_BASE+'synthetic',2,async()=>new Response('too long')),'ASSET_TOO_LARGE');
 await rejectedAsync(()=>downloadPublicAsset(RELEASE_BASE+'synthetic',2,async()=>new Response('x',{headers:{'content-length':'100'}})),'ASSET_TOO_LARGE');
 await rejectedAsync(()=>downloadPublicAsset(RELEASE_BASE+'synthetic',32,async()=>new Response('private synthetic error body',{status:403})),'ASSET_DOWNLOAD_FAILED');
 await rejectedAsync(()=>downloadPublicAsset(RELEASE_BASE+'synthetic',32,async()=>{throw Error('private synthetic transport context');}),'ASSET_DOWNLOAD_FAILED');
});
test('default HTTPS transport uses a dedicated proxy-free agent and verified TLS without making a real request',async()=>{
 let observed;
 const response=await directHttpsTransport(RELEASE_BASE+'synthetic',{headers:{Accept:'application/octet-stream'},signal:AbortSignal.timeout(1000)},(url,options,receive)=>{
  observed=options;assert.equal(url,RELEASE_BASE+'synthetic');const child=new EventEmitter();child.end=()=>queueMicrotask(()=>{const stream=new PassThrough();stream.statusCode=200;stream.headers={'content-length':'9'};receive(stream);stream.end('synthetic');});return child;
 });
 assert.deepEqual(observed.agent.options.proxyEnv,{});assert.equal(observed.rejectUnauthorized,true);assert.equal(observed.method,'GET');assert.equal(response.status,200);assert.equal(response.headers.get('content-length'),'9');const reader=response.body.getReader();const part=await reader.read();assert.equal(Buffer.from(part.value).toString(),'synthetic');assert.equal((await reader.read()).done,true);await reader.cancel();reader.releaseLock();
});
test('counts parser aggregates exact RuleIDs without carrying raw fields or paths',()=>{
 assert.deepEqual(parseCountsReport(Buffer.from(counts()),0),{total:0,byRule:{}});
 assert.deepEqual(parseCountsReport(Buffer.from(counts(['generic-api-key','github-pat','generic-api-key'])),10),{total:3,byRule:{'generic-api-key':2,'github-pat':1}});
 const prototype=parseCountsReport(Buffer.from(counts(['__proto__'])),10);assert.equal(Object.hasOwn(prototype.byRule,'__proto__'),true);assert.equal(prototype.byRule.__proto__,1);
});
test('counts parser fails closed on raw metadata, invalid values and inconsistent exits',()=>{
 const marker=randomBytes(20).toString('hex');const cases=[{},[],null,{findingCount:0,ruleIds:[],Secret:marker},{findingCount:1,ruleIds:['bad\n'+marker]},{findingCount:-1,ruleIds:[]},{findingCount:1,ruleIds:[]},{findingCount:0.5,ruleIds:[]},{findingCount:1,ruleIds:[{}]}];
 for(const value of cases)rejected(()=>parseCountsReport(Buffer.from(JSON.stringify(value)),0),'INVALID_COUNTS_REPORT');
 rejected(()=>parseCountsReport(Buffer.from('{'),0),'INVALID_COUNTS_REPORT');rejected(()=>parseCountsReport(Buffer.alloc(LIMITS.reportBytes+1),0),'INVALID_COUNTS_REPORT');
 for(const[report,status]of[[counts(),10],[counts(['github-pat']),0],[counts(),1]])rejected(()=>parseCountsReport(Buffer.from(report),status),'INCONSISTENT_COUNTS_REPORT');
});
test('scanner uses fixed source-only flags, empty overrides and isolated piped I/O',t=>{
 const calls=[];const scanner=scannerFixture(t,(binary,args,options)=>{calls.push({binary,args,options});return output(counts());});
 const target=join(scanner.root,'source');mkdirSync(target);assert.deepEqual(scan(scanner,'dir',{target}).counts,{total:0,byRule:{}});
 const call=calls[0];assert.equal(call.binary,scanner.binary);assert.equal(call.args[0],'dir');assert.equal(call.args[1],target);assert.equal(call.options.cwd,scanner.cwd);assert.equal(call.options.maxBuffer,LIMITS.reportBytes);
 for(const flag of['--redact=100','--log-level=error','--no-banner','--report-format=template','--report-path=-','--exit-code=10','--ignore-gitleaks-allow','--max-archive-depth=0','--max-decode-depth=5','--timeout=60'])assert.ok(call.args.includes(flag));
 assert.equal(call.args.includes('--baseline-path'),false);assert.equal(readFileSync(scanner.ignore).length,0);assert.equal(readFileSync(scanner.config,'utf8'),FIXED_CONFIG);assert.equal(readFileSync(scanner.template,'utf8'),COUNT_TEMPLATE);assert.doesNotMatch(COUNT_TEMPLATE,/\.Secret|\.Match|\.Fingerprint|\.File|\.StartLine/);
});
test('scanner never forwards nonempty stderr, malformed output, timeout or signal details',t=>{
 const marker='SYNTHETIC_PRIVATE_'+randomBytes(18).toString('hex');
 for(const response of[output(counts(),0,marker),{...output(counts()),error:Error(marker)},{...output(counts()),signal:'SIGTERM',status:null},output(JSON.stringify({findingCount:1,ruleIds:['github-pat'],Match:marker}),10),output(marker,1)]){
  const root=join(temporary(t),'case');mkdirSync(root);const binary=join(root,'synthetic');writeFileSync(binary,'synthetic');const scanner=prepareScanner(root,{binary,binarySha256:sha256(Buffer.from('synthetic'))},{},()=>response);
  let failure;try{scan(scanner,'stdin',{input:marker});}catch(error){failure=publicFailure(error,scopeSha);}assert.equal(failure.status,'operational-error');assert.equal(JSON.stringify(failure).includes(marker),false);assert.equal(JSON.stringify(failure).includes('stderr'),false);
 }
});
test('bounded command kills a synthetic local child before returning to temporary cleanup',t=>{
 const cwd=temporary(t);const result=command(process.execPath,['-e','setInterval(()=>{},1000)'],{cwd,env:isolatedEnvironment(),timeout:100,maxBuffer:1024});
 assert.equal(result.error?.code,'ETIMEDOUT');assert.equal(result.status,null);assert.equal(result.signal,'SIGKILL');assert.equal(readdirSync(cwd).length,0);
});
test('scanner rejects mutation of executable, fixed config, template or empty ignore before child I/O',t=>{
 for(const key of['binary','config','template','ignore']){const scanner=scannerFixture(t,()=>assert.fail('Changed scanner inputs must never execute.'));writeFileSync(scanner[key],'changed');rejected(()=>scan(scanner,'stdin',{input:'synthetic'}),'SCANNER_INPUT_CHANGED');}
 const scanner=scannerFixture(t,()=>assert.fail('Invalid modes must never execute.'));rejected(()=>scan(scanner,'git',{}),'INVALID_SCAN_MODE');rejected(()=>scan(scanner,'dir',{target:process.cwd()}),'INVALID_SCAN_TARGET');
});
test('canary is generated at runtime, kept in memory and must detect github-pat before a clean control',t=>{
 const inputs=[];const scanner=scannerFixture(t,(binary,args,options)=>{assert.equal(args[0],'stdin');inputs.push(options.input);return inputs.length===1?output(counts(['github-pat']),10):output(counts());});
 assert.equal(verifyCanary(scanner),true);assert.equal(inputs.length,2);assert.match(inputs[0],/^GENTIA_SYNTHETIC_SCAN_TOKEN=ghp_[a-f0-9]{36}\n$/);assert.equal(inputs[1],'const syntheticNumber = 1;\n');
 assert.equal(readdirSync(scanner.cwd).length,3);assert.equal(readdirSync(scanner.root).length,2);
});
test('canary failure prevents approval when detection is missing or a clean control reports a finding',t=>{
 const missing=scannerFixture(t,()=>output(counts()));rejected(()=>verifyCanary(missing),'PRIVACY_CANARY_FAILED');
 const always=scannerFixture(t,()=>output(counts(['github-pat']),10));rejected(()=>verifyCanary(always),'PRIVACY_CANARY_FAILED');
});
test('manifest excludes fixed non-source components before blobs are requested',()=>{
 const included=baseEntries.map(([name,body])=>'100644 blob '+oid(Buffer.from(body))+'\t'+name+'\0').join('');
 const ignored=['src/.env','src/.env.production','public/.tmp/file','scripts/manuales/file','scripts/manuales_backup/file','public/deliverables/report','src/node_modules/module','src/.git/config','public/manuals/readme'];
 const manifest=sourceManifest(Buffer.from(included+ignored.map(name=>'100644 blob '+scopeSha+'\t'+name+'\0').join('')));assert.deepEqual([...manifest.keys()],baseEntries.map(([name])=>name));
});
test('manifest rejects unsafe paths, symlinks, gitlinks, duplicates, collisions and missing package files',()=>{
 const valid=baseEntries.map(([name,body])=>'100644 blob '+oid(Buffer.from(body))+'\t'+name+'\0').join('');
 const invalidRows=['120000 blob '+scopeSha+'\tsrc/link\0','160000 commit '+scopeSha+'\tsrc/submodule\0',...['src/../outside','src//file','/src/file','src/CON.txt','src/file.','src/file ','src/file:stream','src/dir\\file','docs/secret','src/line\nfile'].map(name=>'100644 blob '+scopeSha+'\t'+name+'\0')];
 for(const row of invalidRows)rejected(()=>sourceManifest(Buffer.from(valid+row)),'UNSAFE_SOURCE_MANIFEST');
 rejected(()=>sourceManifest(Buffer.from(valid+'100644 blob '+scopeSha+'\tSRC/Synthetic.mjs\0')),'UNSAFE_SOURCE_MANIFEST');
 rejected(()=>sourceManifest(Buffer.from(valid+'100644 blob '+scopeSha+'\tsrc/SYNTHETIC.mjs\0')),'UNSAFE_SOURCE_MANIFEST');
 rejected(()=>sourceManifest(Buffer.from(valid+valid)),'UNSAFE_SOURCE_MANIFEST');rejected(()=>sourceManifest(Buffer.from('')),'INCOMPLETE_SOURCE_MANIFEST');
});
test('manifest enforces a bounded file count before reading object contents',()=>{
 const header=baseEntries.slice(0,2).map(([name,body])=>'100644 blob '+oid(Buffer.from(body))+'\t'+name+'\0').join('');
 const many=Array.from({length:LIMITS.files},(_,i)=>'100644 blob '+scopeSha+'\tsrc/f'+i+'\0').join('');rejected(()=>sourceManifest(Buffer.from(header+many)),'SOURCE_TOO_LARGE');
});
test('exact checkout SHA is required before tree or blob reads; malformed IDs never reach Git',()=>{
 const mismatch=syntheticGit(baseEntries,{head:otherSha});rejected(()=>assertExactCommit('synthetic',scopeSha,{},mismatch.run),'CHECKOUT_SHA_MISMATCH');assert.equal(mismatch.events.length,1);
 for(const value of[undefined,'HEAD',scopeSha.toUpperCase(),'--all',scopeSha+'\n'])rejected(()=>assertExactCommit('synthetic',value,{},()=>assert.fail('Malformed SHA must not reach Git.')),'INVALID_SOURCE_SHA');
});
test('snapshot copies only verified current-commit blobs, without working tree or history reads',t=>{
 const root=temporary(t),workspace=join(root,'workspace'),directory=join(root,'snapshot');mkdirSync(workspace);mkdirSync(directory);writeFileSync(join(workspace,'working-tree-only'),'synthetic untracked text');
 const git=syntheticGit([...baseEntries,['scripts/.env','synthetic excluded text']]);const inventory=createSourceSnapshot({workspace,scopeSha,directory,env:{},run:git.run});
 assert.equal(inventory.files,baseEntries.length);assert.equal(inventory.bytes,baseEntries.reduce((total,[,body])=>total+Buffer.byteLength(body),0));assert.equal(existsSync(join(directory,'working-tree-only')),false);assert.equal(existsSync(join(directory,'scripts','.env')),false);
 assert.equal(readFileSync(join(directory,'src','synthetic.mjs'),'utf8'),baseEntries[2][1]);
 assert.deepEqual(git.events.map(args=>args[0]),['rev-parse','rev-parse','ls-tree','cat-file','cat-file']);assert.deepEqual(git.events[2],['ls-tree','--full-tree','-r','-z',scopeSha,'--',...SOURCE_ROOTS]);
});
test('snapshot fails before object allocation on excessive sizes and rejects altered object bytes',t=>{
 for(const options of[{declaredSize:LIMITS.sourceBytes+1},{badObject:true}]){
  const root=temporary(t),workspace=join(root,'workspace'),directory=join(root,'snapshot');mkdirSync(workspace);mkdirSync(directory);const git=syntheticGit(baseEntries,options);
  rejected(()=>createSourceSnapshot({workspace,scopeSha,directory,env:{},run:git.run}),options.badObject?'BLOB_IDENTITY_MISMATCH':'INVALID_SOURCE_OBJECT');
  if(options.declaredSize)assert.equal(git.events.some(args=>args[0]==='cat-file'&&args[1]==='--batch'),false);
 }
});
test('snapshot verifier rejects changed, missing and unexpected files and cleanup refuses unrelated directories',t=>{
 const root=temporary(t),directory=join(root,'snapshot');mkdirSync(directory);const bytes=Buffer.from('synthetic');writeFileSync(join(directory,'package.json'),bytes);const manifest=new Map([['package.json',oid(bytes)]]);assert.equal(verifySourceSnapshot(directory,manifest).files,1);
 writeFileSync(join(directory,'package.json'),'changed');rejected(()=>verifySourceSnapshot(directory,manifest),'SNAPSHOT_IDENTITY_MISMATCH');
 writeFileSync(join(directory,'package.json'),bytes);writeFileSync(join(directory,'unexpected'),'synthetic');rejected(()=>verifySourceSnapshot(directory,manifest),'SNAPSHOT_IDENTITY_MISMATCH');
 const unrelated=join(root,'unrelated');mkdirSync(unrelated);rejected(()=>removeOwnedTemporary({root:unrelated,parent:root}),'CLEANUP_REFUSED');assert.equal(existsSync(unrelated),true);
});
test('public failures and exit mapping expose only fixed metadata even for hostile exception messages',()=>{
 const marker=randomBytes(30).toString('hex');const failure=publicFailure(Error(marker),scopeSha);assert.deepEqual(failure,{status:'operational-error',scopeSha,code:'SOURCE_CHECK_FAILED'});assert.equal(JSON.stringify(failure).includes(marker),false);
 assert.equal(exitCode({status:'clean'}),0);assert.equal(exitCode({status:'findings'}),1);assert.equal(exitCode(failure),2);assert.equal(publicFailure(Error(marker),marker).scopeSha,null);
 assert.equal(publicFailure(new SourceSecretsError(marker),{toString:()=>scopeSha,toJSON:()=>marker}).scopeSha,null);assert.equal(publicFailure(new SourceSecretsError(marker),scopeSha).code,'SOURCE_CHECK_FAILED');
});
test('runner rejects an absent or malformed CI SHA and unsupported architecture before network acquisition',async()=>{
 for(const scopeSha of[undefined,'HEAD','',otherSha+'\n']){const result=await checkSourceSecrets({scopeSha,environment:{},platform:'linux',arch:'x64'});assert.equal(result.code,'INVALID_SOURCE_SHA');assert.equal(result.status,'operational-error');}
 const result=await checkSourceSecrets({scopeSha,environment:{},platform:'linux',arch:'arm64'});assert.equal(result.code,'UNSUPPORTED_PLATFORM');
});
test('CLI rejects custom arguments from an empty cwd and never emits supplied canary or environment values',t=>{
 const cwd=temporary(t),marker=randomBytes(28).toString('hex');const entry=fileURLToPath(new URL('./security-source-secrets-check.mjs',import.meta.url));
 const child=spawnSync(process.execPath,[entry,marker],{cwd,env:{...isolatedEnvironment(),GITHUB_SHA:scopeSha},encoding:'utf8',windowsHide:true,timeout:5000,maxBuffer:65536});
 assert.equal(child.status,2);assert.equal(child.stderr,'');assert.equal(child.stdout.includes(marker),false);const result=JSON.parse(child.stdout);assert.deepEqual(result,{status:'operational-error',scopeSha,code:'ARGUMENTS_NOT_ALLOWED'});assert.equal(readdirSync(cwd).length,0);
});
