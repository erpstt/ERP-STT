import {createHash,randomBytes} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {chmodSync,existsSync,lstatSync,mkdirSync,mkdtempSync,readFileSync,readdirSync,realpathSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {basename,isAbsolute,join,relative,sep} from 'node:path';
import {Agent,request} from 'node:https';
import {Readable} from 'node:stream';

export const VERSION='8.30.1';
export const SOURCE_ROOTS=Object.freeze(['src','public','scripts','supabase/migrations','services/pdf-renderer','.github/workflows','package.json','package-lock.json']);
export const LIMITS=Object.freeze({files:20000,sourceBytes:100*1024*1024,reportBytes:2*1024*1024,archiveBytes:32*1024*1024,manifestBytes:64*1024,commandMilliseconds:70000});
export const MANIFEST_SHA256='061476c21adaf5441516f96f185c1a4706a83cd6329b9b38762271b3d4a52fae';
export const RELEASE_BASE='https://github.com/gitleaks/gitleaks/releases/download/v8.30.1/';
export const COUNT_TEMPLATE='{"findingCount":{{len .}},"ruleIds":[{{range $i,$finding := .}}{{if $i}},{{end}}{{printf "%q" $finding.RuleID}}{{end}}]}\n';
export const FIXED_CONFIG='[extend]\nuseDefault = true\n';
const assets=Object.freeze({
 linux:Object.freeze({filename:'gitleaks_8.30.1_linux_x64.tar.gz',sha256:'551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb',member:'gitleaks'}),
 win32:Object.freeze({filename:'gitleaks_8.30.1_windows_x64.zip',sha256:'d29144deff3a68aa93ced33dddf84b7fdc26070add4aa0f4513094c8332afc4e',member:'gitleaks.exe'})
});
const publicCodes=new Set([
 'ARGUMENTS_NOT_ALLOWED','ARCHIVE_HASH_MISMATCH','ARCHIVE_MEMBER_MISMATCH','ASSET_DOWNLOAD_FAILED','ASSET_REDIRECT_LIMIT','ASSET_TOO_LARGE',
 'BLOB_IDENTITY_MISMATCH','CHECKOUT_SHA_MISMATCH','CHILD_PROCESS_FAILED','CLEANUP_REFUSED','EXECUTABLE_CHANGED','INCOMPLETE_BLOB_METADATA',
 'INCOMPLETE_SOURCE_MANIFEST','INCOMPLETE_SOURCE_SNAPSHOT','INCONSISTENT_COUNTS_REPORT','INVALID_ASSET_URL','INVALID_BLOB_HEADER',
 'INVALID_CHILD_ENCODING','INVALID_COUNTS_REPORT','INVALID_EXECUTABLE','INVALID_SCAN_MODE','INVALID_SCAN_TARGET','INVALID_SOURCE_OBJECT',
 'INVALID_SOURCE_SHA','INVALID_TEMPORARY_ROOT','MANIFEST_ENTRY_MISMATCH','MANIFEST_HASH_MISMATCH','NON_REGULAR_PATH','PRIVACY_CANARY_FAILED',
 'SCANNER_INPUT_CHANGED','SNAPSHOT_IDENTITY_MISMATCH','SNAPSHOT_NOT_EMPTY','SNAPSHOT_SIZE_MISMATCH','SOURCE_TOO_LARGE',
 'UNEXPECTED_SOURCE_BYTES','UNSAFE_SNAPSHOT_PATH','UNSAFE_SOURCE_MANIFEST','UNSUPPORTED_PLATFORM'
]);
export class SourceSecretsError extends Error{
 constructor(code){super('Source security check stopped.');this.name='SourceSecretsError';this.code=code;}
}
function fail(code){throw new SourceSecretsError(code);}
export function sha256(bytes){return createHash('sha256').update(bytes).digest('hex');}
export function verifyPinnedBytes(bytes,expected,maximum,code){if(!Buffer.isBuffer(bytes)||bytes.length>maximum||sha256(bytes)!==expected)fail(code);}
function blobId(bytes){return createHash('sha1').update('blob '+bytes.length+'\0').update(bytes).digest('hex');}
export function assetFor(platform,arch){if(arch!=='x64'||!Object.hasOwn(assets,platform))fail('UNSUPPORTED_PLATFORM');return assets[platform];}
export function isolatedEnvironment(input=process.env,platform=process.platform){
 const result={};const keys=platform==='win32'?['SystemRoot','WINDIR','COMSPEC','PATHEXT','PATH','TEMP','TMP']:['PATH','TMPDIR','TEMP','TMP'];
 for(const key of keys)if(typeof input[key]==='string')result[key]=input[key];
 return result;
}
export function regular(path,directory=false){
 const info=lstatSync(path);if(info.isSymbolicLink()||(directory?!info.isDirectory():!info.isFile())||realpathSync(path)!==path)fail('NON_REGULAR_PATH');return info;
}
function descendant(root,path){const part=relative(root,path);return part!==''&&part!=='..'&&!part.startsWith('..'+sep)&&!isAbsolute(part);}
export function createOwnedTemporary(parent=tmpdir()){
 const canonical=realpathSync(parent);regular(canonical,true);const root=mkdtempSync(join(canonical,'gentia-source-secrets-'));
 regular(root,true);if(!descendant(canonical,root)||readdirSync(root).length)fail('INVALID_TEMPORARY_ROOT');chmodSync(root,0o700);
 return{root,parent:canonical};
}
export function removeOwnedTemporary({root,parent}){
 regular(parent,true);regular(root,true);if(!descendant(parent,root)||!basename(root).startsWith('gentia-source-secrets-'))fail('CLEANUP_REFUSED');
 function verify(directory){for(const entry of readdirSync(directory,{withFileTypes:true})){const child=join(directory,entry.name);const info=lstatSync(child);if(info.isSymbolicLink()||realpathSync(child)!==child||!descendant(root,child))fail('CLEANUP_REFUSED');if(info.isDirectory())verify(child);else if(!info.isFile())fail('CLEANUP_REFUSED');}}
 verify(root);rmSync(root,{recursive:true,force:false});
}
export function command(commandName,args,{cwd,env,input,maxBuffer=LIMITS.reportBytes,timeout=LIMITS.commandMilliseconds}={}){
 // Synchronous completion waits for child exit before the caller can clean up its files.
 return spawnSync(commandName,args,{cwd,env,input,maxBuffer,timeout,killSignal:'SIGKILL',windowsHide:true,shell:false,stdio:['pipe','pipe','pipe']});
}
function captured(result,allowedStatuses=[0]){
 if(result?.error||result?.signal||!allowedStatuses.includes(result?.status)||!Buffer.isBuffer(result.stdout)||!Buffer.isBuffer(result.stderr)||result.stderr.length)fail('CHILD_PROCESS_FAILED');return result.stdout;
}
function text(bytes){try{return new TextDecoder('utf-8',{fatal:true}).decode(bytes);}catch{fail('INVALID_CHILD_ENCODING');}}

function publicAssetUrl(value){let url;try{url=new URL(value);}catch{fail('INVALID_ASSET_URL');}
 if(url.protocol!=='https:'||url.username||url.password||url.port||!['github.com','release-assets.githubusercontent.com','objects.githubusercontent.com'].includes(url.hostname))fail('INVALID_ASSET_URL');return url.href;
}
export function directHttpsTransport(url,{headers,signal},makeRequest=request){
 // A dedicated empty proxy environment also avoids Node's global --use-env-proxy dispatcher.
 const agent=new Agent({keepAlive:false,proxyEnv:{}});
 return new Promise((resolve,reject)=>{
  try{
   const child=makeRequest(publicAssetUrl(url),{method:'GET',headers,signal,agent,rejectUnauthorized:true},response=>{
    response.once('close',()=>agent.destroy());
    resolve({status:response.statusCode,headers:{get(name){const value=response.headers[name.toLowerCase()];return Array.isArray(value)?value.join(','):value??null;}},body:Readable.toWeb(response)});
   });
   child.once('error',error=>{agent.destroy();reject(error);});child.end();
  }catch(error){agent.destroy();reject(error);}
 });
}
export async function downloadPublicAsset(url,maximumBytes,transport=directHttpsTransport){
 const signal=AbortSignal.timeout(45000);let next=publicAssetUrl(url);
 try{for(let redirects=0;redirects<=5;redirects++){
  const response=await transport(next,{redirect:'manual',signal,headers:{'User-Agent':'GENTIA-source-security-check','Accept':'application/octet-stream'}});
  if([301,302,303,307,308].includes(response.status)){
   const location=response.headers.get('location');await response.body?.cancel();if(!location||redirects===5)fail('ASSET_REDIRECT_LIMIT');next=publicAssetUrl(new URL(location,next).href);continue;
  }
  if(response.status!==200||!response.body){await response.body?.cancel();fail('ASSET_DOWNLOAD_FAILED');}
  const declared=response.headers.get('content-length');if(declared!==null&&(!/^[0-9]+$/.test(declared)||Number(declared)>maximumBytes)){await response.body.cancel();fail('ASSET_TOO_LARGE');}
  const chunks=[];let size=0;const reader=response.body.getReader();
  try{while(true){const part=await reader.read();if(part.done)break;size+=part.value.byteLength;if(size>maximumBytes)fail('ASSET_TOO_LARGE');chunks.push(Buffer.from(part.value));}}
  finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
  return Buffer.concat(chunks,size);
 }}catch(error){if(error instanceof SourceSecretsError)throw error;fail('ASSET_DOWNLOAD_FAILED');}
 fail('ASSET_DOWNLOAD_FAILED');
}
export function verifyReleaseBuffers(asset,manifest,archive){
 verifyPinnedBytes(manifest,MANIFEST_SHA256,LIMITS.manifestBytes,'MANIFEST_HASH_MISMATCH');
 verifyPinnedBytes(archive,asset.sha256,LIMITS.archiveBytes,'ARCHIVE_HASH_MISMATCH');
 const matches=text(manifest).split(/\r?\n/).filter(line=>line.endsWith('  '+asset.filename)||line.endsWith(' '+asset.filename));
 if(matches.length!==1||!new RegExp('^'+asset.sha256+'\\s+'+asset.filename.replaceAll('.','\\.')+'$').test(matches[0]))fail('MANIFEST_ENTRY_MISMATCH');
}
export async function acquireExecutable({root,platform,arch,env,run=command,transport=directHttpsTransport}){
 regular(root,true);const asset=assetFor(platform,arch);
 const manifest=await downloadPublicAsset(RELEASE_BASE+'gitleaks_8.30.1_checksums.txt',LIMITS.manifestBytes,transport);
 const archive=await downloadPublicAsset(RELEASE_BASE+asset.filename,LIMITS.archiveBytes,transport);
 verifyReleaseBuffers(asset,manifest,archive);
 const directory=join(root,'release');mkdirSync(directory,{mode:0o700});regular(directory,true);
 const archivePath=join(directory,asset.filename);writeFileSync(archivePath,archive,{flag:'wx',mode:0o600});
 if(sha256(readFileSync(archivePath))!==asset.sha256)fail('ARCHIVE_HASH_MISMATCH');
 const listing=text(captured(run('tar',['-tf',archivePath],{cwd:directory,env,maxBuffer:64*1024}))).split(/\r?\n/).filter(Boolean);
 if(listing.filter(name=>name===asset.member).length!==1)fail('ARCHIVE_MEMBER_MISMATCH');
 // Extract one exact member to captured stdout; no archive-relative path is written.
 const bytes=captured(run('tar',['-xOf',archivePath,asset.member],{cwd:directory,env,maxBuffer:LIMITS.archiveBytes}));
 if(!bytes.length||bytes.length>LIMITS.archiveBytes)fail('INVALID_EXECUTABLE');
 const binary=join(directory,asset.member);writeFileSync(binary,bytes,{flag:'wx',mode:0o700});regular(binary);chmodSync(binary,0o700);
 return{binary,binarySha256:sha256(bytes)};
}
export function prepareScanner(root,executable,env,run=command){
 regular(root,true);regular(executable.binary);if(sha256(readFileSync(executable.binary))!==executable.binarySha256)fail('EXECUTABLE_CHANGED');
 const cwd=join(root,'scanner');mkdirSync(cwd,{mode:0o700});regular(cwd,true);
 const config=join(cwd,'fixed.toml'),template=join(cwd,'counts.tmpl'),ignore=join(cwd,'empty.gitleaksignore');
 writeFileSync(config,FIXED_CONFIG,{flag:'wx',mode:0o600});writeFileSync(template,COUNT_TEMPLATE,{flag:'wx',mode:0o600});writeFileSync(ignore,'',{flag:'wx',mode:0o600});
 return{...executable,root,cwd,config,template,ignore,env,run};
}
export function parseCountsReport(stdout,status){
 if(!Buffer.isBuffer(stdout)||stdout.length>LIMITS.reportBytes)fail('INVALID_COUNTS_REPORT');
 let report;try{report=JSON.parse(text(stdout));}catch{fail('INVALID_COUNTS_REPORT');}
 if(!report||Object.keys(report).sort().join(',')!=='findingCount,ruleIds'||!Number.isSafeInteger(report.findingCount)||report.findingCount<0||!Array.isArray(report.ruleIds)||report.ruleIds.length!==report.findingCount||!report.ruleIds.every(rule=>typeof rule==='string'&&/^[a-z0-9_-]{1,100}$/.test(rule)))fail('INVALID_COUNTS_REPORT');
 if(![0,10].includes(status)||(status===0)!==(report.findingCount===0))fail('INCONSISTENT_COUNTS_REPORT');
 const byRule=new Map();for(const rule of report.ruleIds)byRule.set(rule,(byRule.get(rule)??0)+1);
 return{total:report.findingCount,byRule:Object.fromEntries([...byRule].sort())};
}
export function scan(scanner,mode,{input,target}={}){
 if(!['stdin','dir'].includes(mode))fail('INVALID_SCAN_MODE');
 regular(scanner.cwd,true);for(const path of[scanner.binary,scanner.config,scanner.template,scanner.ignore])regular(path);
 if(sha256(readFileSync(scanner.binary))!==scanner.binarySha256||readFileSync(scanner.config,'utf8')!==FIXED_CONFIG||readFileSync(scanner.template,'utf8')!==COUNT_TEMPLATE||readFileSync(scanner.ignore).length)fail('SCANNER_INPUT_CHANGED');
 if(mode==='dir'){if(!target||!descendant(scanner.root,target))fail('INVALID_SCAN_TARGET');regular(target,true);}
 const args=[mode,...(mode==='dir'?[target]:[]),'--config',scanner.config,'--redact=100','--log-level=error','--no-banner','--report-format=template','--report-template',scanner.template,'--report-path=-','--exit-code=10','--gitleaks-ignore-path',scanner.ignore,'--ignore-gitleaks-allow','--max-archive-depth=0','--max-decode-depth=5','--timeout=60'];
 const result=scanner.run(scanner.binary,args,{cwd:scanner.cwd,env:scanner.env,input:mode==='stdin'?input:undefined,maxBuffer:LIMITS.reportBytes,timeout:LIMITS.commandMilliseconds});
 const stdout=captured(result,[0,10]);return{counts:parseCountsReport(stdout,result.status),stdout};
}
export function verifyCanary(scanner){
 const canary='ghp_'+randomBytes(18).toString('hex'),input='GENTIA_SYNTHETIC_SCAN_TOKEN='+canary+'\n';
 const found=scan(scanner,'stdin',{input});if(found.stdout.includes(canary)||found.stdout.includes(input)||found.counts.total<1||!(found.counts.byRule['github-pat']>=1))fail('PRIVACY_CANARY_FAILED');
 const clean=scan(scanner,'stdin',{input:'const syntheticNumber = 1;\n'});if(clean.counts.total!==0)fail('PRIVACY_CANARY_FAILED');
 return true;
}

function eligible(name){return SOURCE_ROOTS.some(root=>name===root||name.startsWith(root+'/'));}
function excluded(name){return name.split('/').some(part=>/^(?:\.git|\.tmp|node_modules|deliverables|manuals|manuales(?:_.*)?)$/i.test(part)||/^\.env(?:\.|$)/i.test(part));}
function safeSourceName(name){
 if(!name||isAbsolute(name)||/[\x00-\x1f\x7f:\\]/.test(name))return false;
 return name.split('/').every(part=>part&&part!=='.'&&part!=='..'&&!/[. ]$/.test(part)&&!/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part));
}
export function sourceManifest(output){
 const result=new Map(),folded=new Set();
 for(const row of text(output).split('\0').filter(Boolean)){
  const match=/^([0-7]{6}) (blob|commit|tree) ([a-f0-9]{40})\t([\s\S]+)$/.exec(row);
  if(!match||!safeSourceName(match[4])||!eligible(match[4]))fail('UNSAFE_SOURCE_MANIFEST');
  const[,mode,type,oid,name]=match;if(excluded(name))continue;
  const key=name.normalize('NFC').toLowerCase();if(!['100644','100755'].includes(mode)||type!=='blob'||result.has(name)||folded.has(key))fail('UNSAFE_SOURCE_MANIFEST');
  folded.add(key);result.set(name,oid);if(result.size>LIMITS.files)fail('SOURCE_TOO_LARGE');
 }
 if(!result.size||!result.has('package.json')||!result.has('package-lock.json'))fail('INCOMPLETE_SOURCE_MANIFEST');return result;
}
export function assertExactCommit(workspace,scopeSha,env,run=command){
 if(typeof scopeSha!=='string'||!/^[a-f0-9]{40}$/.test(scopeSha))fail('INVALID_SOURCE_SHA');
 for(const ref of['HEAD^{commit}',scopeSha+'^{commit}']){
  const value=text(captured(run('git',['rev-parse','--verify',ref],{cwd:workspace,env,maxBuffer:1024}))).trim();if(value!==scopeSha)fail('CHECKOUT_SHA_MISMATCH');
 }
}
export function createSourceSnapshot({workspace,scopeSha,directory,env,run=command}){
 regular(workspace,true);regular(directory,true);if(readdirSync(directory).length)fail('SNAPSHOT_NOT_EMPTY');assertExactCommit(workspace,scopeSha,env,run);
 const manifest=sourceManifest(captured(run('git',['ls-tree','--full-tree','-r','-z',scopeSha,'--',...SOURCE_ROOTS],{cwd:workspace,env,maxBuffer:10*1024*1024})));
 const requests=[...manifest.values()].join('\n')+'\n';
 const metadata=text(captured(run('git',['cat-file','--batch-check'],{cwd:workspace,env,input:requests,maxBuffer:manifest.size*120+1024}))).trim().split(/\r?\n/);
 if(metadata.length!==manifest.size)fail('INCOMPLETE_BLOB_METADATA');let total=0,index=0;const sizes=[];
 for(const oid of manifest.values()){
  const match=/^([a-f0-9]{40}) blob ([0-9]+)$/.exec(metadata[index++]);const size=match?Number(match[2]):NaN;
  if(!match||match[1]!==oid||!Number.isSafeInteger(size)||size<0||size>LIMITS.sourceBytes)fail('INVALID_SOURCE_OBJECT');total+=size;sizes.push(size);if(total>LIMITS.sourceBytes)fail('SOURCE_TOO_LARGE');
 }
 const bytes=captured(run('git',['cat-file','--batch'],{cwd:workspace,env,input:requests,maxBuffer:total+manifest.size*120+1024}));let offset=0;index=0;
 for(const[name,oid]of manifest){
  const end=bytes.indexOf(10,offset);if(end<offset||end-offset>100)fail('INVALID_BLOB_HEADER');
  const header=/^([a-f0-9]{40}) blob ([0-9]+)$/.exec(bytes.subarray(offset,end).toString('ascii')),size=sizes[index++];
  if(!header||header[1]!==oid||Number(header[2])!==size)fail('INVALID_BLOB_HEADER');offset=end+1;
  const contents=bytes.subarray(offset,offset+size);if(contents.length!==size||bytes[offset+size]!==10||blobId(contents)!==oid)fail('BLOB_IDENTITY_MISMATCH');
  let parent=directory;const parts=name.split('/');for(const part of parts.slice(0,-1)){parent=join(parent,part);if(!existsSync(parent))mkdirSync(parent,{mode:0o700});regular(parent,true);if(!descendant(directory,parent))fail('UNSAFE_SNAPSHOT_PATH');}
  writeFileSync(join(parent,parts.at(-1)),contents,{flag:'wx',mode:0o600});offset+=size+1;
 }
 if(offset!==bytes.length)fail('UNEXPECTED_SOURCE_BYTES');
 const inventory=verifySourceSnapshot(directory,manifest);if(inventory.bytes!==total)fail('SNAPSHOT_SIZE_MISMATCH');return inventory;
}
export function verifySourceSnapshot(directory,manifest){
 regular(directory,true);const found=new Set();let bytes=0;
 function visit(parent){for(const entry of readdirSync(parent,{withFileTypes:true})){
  const path=join(parent,entry.name),info=lstatSync(path),name=relative(directory,path).split(sep).join('/');
  if(info.isSymbolicLink()||realpathSync(path)!==path||!descendant(directory,path)||!safeSourceName(name)||excluded(name))fail('UNSAFE_SNAPSHOT_PATH');
  if(info.isDirectory()){visit(path);continue;}
  if(!info.isFile()||!eligible(name)||!manifest.has(name)||blobId(readFileSync(path))!==manifest.get(name))fail('SNAPSHOT_IDENTITY_MISMATCH');
  found.add(name);bytes+=info.size;if(bytes>LIMITS.sourceBytes||found.size>LIMITS.files)fail('SOURCE_TOO_LARGE');
 }}visit(directory);if(found.size!==manifest.size)fail('INCOMPLETE_SOURCE_SNAPSHOT');return{files:found.size,bytes};
}
export function publicFailure(error,scopeSha){return{status:'operational-error',scopeSha:typeof scopeSha==='string'&&/^[a-f0-9]{40}$/.test(scopeSha)?scopeSha:null,code:error instanceof SourceSecretsError&&publicCodes.has(error.code)?error.code:'SOURCE_CHECK_FAILED'};}
export async function checkSourceSecrets(options={}){
 const{workspace=process.cwd(),platform=process.platform,arch=process.arch,tempParent,environment=process.env}=options;
 const scopeSha=Object.hasOwn(options,'scopeSha')?options.scopeSha:environment.GITHUB_SHA;
 let owned,result;
 try{
  assetFor(platform,arch);if(typeof scopeSha!=='string'||!/^[a-f0-9]{40}$/.test(scopeSha))fail('INVALID_SOURCE_SHA');
  const canonical=realpathSync(workspace);regular(canonical,true);const env=isolatedEnvironment(environment,platform);
  owned=createOwnedTemporary(tempParent);const emptyGitConfig=join(owned.root,'empty.gitconfig');writeFileSync(emptyGitConfig,'',{flag:'wx',mode:0o600});
  const gitEnv={...env,GIT_NO_REPLACE_OBJECTS:'1',GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:emptyGitConfig};assertExactCommit(canonical,scopeSha,gitEnv);
  const executable=await acquireExecutable({root:owned.root,platform,arch,env});const scanner=prepareScanner(owned.root,executable,env);
  verifyCanary(scanner);const directory=join(owned.root,'source');mkdirSync(directory,{mode:0o700});
  const snapshot=createSourceSnapshot({workspace:canonical,scopeSha,directory,env:gitEnv});const{counts}=scan(scanner,'dir',{target:directory});
  result={status:counts.total===0?'clean':'findings',scopeSha,snapshot,counts,privacy:{canaryVerified:true}};
 }catch(error){result=publicFailure(error,scopeSha);}
 finally{if(owned)try{removeOwnedTemporary(owned);}catch{result=publicFailure(new SourceSecretsError('CLEANUP_REFUSED'),scopeSha);}}
 return result;
}
export function exitCode(result){return result.status==='clean'?0:result.status==='findings'?1:2;}
