// Isolated P164 test runtime only. Never import from application code or jobs.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import net from 'node:net';
import tls from 'node:tls';
import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import dgram from 'node:dgram';
import childProcess from 'node:child_process';
import {registerHooks,syncBuiltinESMExports} from 'node:module';

const prefix='p164-costa-rica-rate-';
const osKeys=['SystemRoot','WINDIR','COMSPEC','PATHEXT','PATH','Path','TEMP','TMP'];
export const syntheticRateConfig=Object.freeze({
 BCCR_TOKEN:'Bearer P164_SYNTHETIC_BCCR_TOKEN_NOT_A_CREDENTIAL',
 SUPABASE_URL:'https://p164-synthetic.invalid',
 SUPABASE_ANON_KEY:'P164_SYNTHETIC_PUBLIC_KEY',
 // Prefix-only placeholder exercises modern-key headers and cannot be a key.
 SUPABASE_SERVICE_ROLE_KEY:'sb_secret_',
 DISABLE_BACKGROUND_JOBS:'true',
 EMAIL_NOTIFICATIONS_ENABLED:'false'
});
export const syntheticRateAuthorization='Bearer P164_SYNTHETIC_USER_NOT_A_CREDENTIAL';
const token=syntheticRateConfig.BCCR_TOKEN.replace(/^Bearer\s+/i,'');
const inside=(parent,target)=>{const value=path.relative(parent,target);return value!==''&&value!=='..'&&!value.startsWith('..'+path.sep)&&!path.isAbsolute(value);};
function isEnv(value){
 const text=value instanceof URL&&value.protocol==='file:'?fileURLToPath(value):String(value);
 return/(?:^|\/)\.env(?:\.[^/]*)?$/i.test(text.replaceAll('\\','/'));
}
export async function isolatedCostaRicaRateRuntime(){
 const workspace=await fsp.realpath(fileURLToPath(new URL('../../',import.meta.url))),namedBase=path.join(workspace,'.local-tools');
 try{const entry=await fsp.lstat(namedBase);assert.ok(entry.isDirectory()&&!entry.isSymbolicLink());}catch(error){if(error.code!=='ENOENT')throw error;await fsp.mkdir(namedBase);}
 const base=await fsp.realpath(namedBase);assert.equal(base,namedBase);assert.ok(inside(workspace,base));
 const created=await fsp.mkdtemp(path.join(base,prefix)),directory=await fsp.realpath(created);
 assert.equal(directory,created);assert.ok(inside(workspace,directory)&&inside(base,directory));assert.deepEqual(await fsp.readdir(directory),[]);
 const originalCwd=process.cwd(),allowed={};
 for(const name of osKeys)if(process.env[name]!==undefined)allowed[name]=process.env[name];
 process.env={...allowed,...syntheticRateConfig};
 process.chdir(directory);
 const attempts=new Set(),requests=[];let handler;
 const deny=kind=>{attempts.add(kind);process.stderr.write('P164_BLOCKED:'+kind+'\n');throw Object.assign(Error('P164_FORBIDDEN_IO'),{code:'P164_FORBIDDEN_IO'});};
 const cleanupDirectory=async()=>{
  process.chdir(originalCwd);
  assert.equal(await fsp.realpath(workspace),workspace);assert.equal(await fsp.realpath(namedBase),base);
  const entry=await fsp.lstat(directory);assert.ok(entry.isDirectory()&&!entry.isSymbolicLink());
  const target=await fsp.realpath(directory);assert.equal(target,directory);assert.ok(inside(workspace,target)&&inside(base,target)&&path.basename(target).startsWith(prefix));
  assert.deepEqual(await fsp.readdir(target),[],'Only the owned empty CWD may be removed');
  await fsp.rmdir(target);
 };
 try{
 process.loadEnvFile=()=>deny('environment-file');
 for(const name of['readFile','readFileSync','open','openSync','createReadStream']){const original=fs[name];fs[name]=function(value,...args){if(isEnv(value))return deny('environment-file');return original.call(this,value,...args);};}
 for(const name of['readFile','open']){const original=fsp[name];fsp[name]=function(value,...args){if(isEnv(value))return deny('environment-file');return original.call(this,value,...args);};}
 net.Socket.prototype.connect=()=>deny('network');net.Server.prototype.listen=()=>deny('network');
 for(const name of['connect','createConnection'])net[name]=()=>deny('network');
 tls.connect=()=>deny('network');
 for(const owner of[dns,dns.promises]){
  for(const name of Object.getOwnPropertyNames(owner))if(/^(?:lookup|lookupService|reverse|resolve.*)$/.test(name)&&typeof owner[name]==='function')owner[name]=()=>deny('dns');
  const Resolver=owner.Resolver;
  for(const name of Object.getOwnPropertyNames(Resolver.prototype))if(/^(?:lookup|lookupService|reverse|resolve.*)$/.test(name)&&typeof Resolver.prototype[name]==='function')Resolver.prototype[name]=()=>deny('dns');
  owner.Resolver=class{constructor(){deny('dns');}};
 }
 for(const owner of[http,https])for(const name of['request','get'])owner[name]=()=>deny('network');
 for(const name of['connect','send'])dgram.Socket.prototype[name]=()=>deny('network');
 for(const name of['spawn','spawnSync','exec','execSync','execFile','execFileSync','fork'])childProcess[name]=()=>deny('child-process');
 if(typeof process.execve==='function')process.execve=()=>deny('child-process');
 syncBuiltinESMExports();
 registerHooks({resolve(specifier,context,next){
  if(/^(?:node:)?worker_threads$|^(?:playwright(?:-core)?|puppeteer(?:-core)?|@playwright\/test)(?:\/|$)/.test(specifier))return deny('browser-or-worker-import');
  if(/^(?:pg|postgres|dotenv)(?:\/|$)|^@supabase\//.test(specifier))return deny('database-or-env-import');
  const result=next(specifier,context);
  if(/\/node_modules\/(?:playwright(?:-core)?|puppeteer(?:-core)?|@playwright\/test)\//.test(result.url.replaceAll('\\','/')))return deny('browser-or-worker-import');
  if(/\/node_modules\/(?:pg|postgres|dotenv)\/|\/node_modules\/@supabase\//.test(result.url.replaceAll('\\','/')))return deny('database-or-env-import');
  return result;
 }});
 globalThis.fetch=async(input,init={})=>{
  if(!(input instanceof URL)&&typeof input!=='string')return deny('fetch-shape');
  let request;
  try{
  const url=new URL(String(input)),headers=new Headers(init.headers),method=init.method??'GET';
  if(url.username||url.password||url.hash)return deny('fetch-target');
  let kind,identity,indicator;
  if(url.origin==='https://apim.bccr.fi.cr'){
   const match=/^\/SDDE\/api\/Bccr\.Ge\.SDDE\.Publico\.Indicadores\.API\/indicadoresEconomicos\/(317|318)\/series$/.exec(url.pathname);
   if(!match||method!=='GET'||init.body!==undefined)return deny('bccr-request');
   assert.deepEqual([...url.searchParams.keys()].sort(),['fechaFin','fechaInicio','idioma']);
   assert.equal(url.searchParams.get('idioma'),'es');
   assert.equal(headers.get('Authorization'),'Bearer '+token);assert.equal(headers.get('Accept'),'application/json');assert.equal(headers.has('apikey'),false);
   kind='bccr';identity='bccr';indicator=match[1];
  }else if(url.origin===syntheticRateConfig.SUPABASE_URL){
   if(headers.get('Authorization')===syntheticRateAuthorization){assert.equal(headers.get('apikey'),syntheticRateConfig.SUPABASE_ANON_KEY);identity='manual';}
   else if(!headers.has('Authorization')&&headers.get('apikey')===syntheticRateConfig.SUPABASE_SERVICE_ROLE_KEY)identity='automatic';
   else return deny('supabase-identity');
   if(url.pathname==='/rest/v1/currencies'){
    if(method!=='GET'||init.body!==undefined)return deny('currency-request');
    assert.deepEqual([...url.searchParams.keys()].sort(),['currency_code','limit','select']);
    assert.equal(url.searchParams.get('select'),'currency_id,currency_code');assert.equal(url.searchParams.get('limit'),'1');
    if(!['eq.USD','eq.CRC'].includes(url.searchParams.get('currency_code')))return deny('currency-filter');
    kind='currency';
   }else{
    if(url.search||method!=='POST'||headers.get('Content-Type')!=='application/json')return deny('rpc-request');
    const names={'/rest/v1/rpc/exchange_rate_source_context':'context','/rest/v1/rpc/save_exchange_rate':'save','/rest/v1/rpc/ingest_official_exchange_rate':'ingest'};
    kind=names[url.pathname];if(!kind||identity!==(kind==='ingest'?'automatic':'manual'))return deny('rpc-target');
   }
  }else return deny('fetch-target');
  const body=init.body===undefined?undefined:JSON.parse(init.body);
  request={kind,identity,indicator,url,method,headers,body};
  }catch(error){if(error.code==='P164_FORBIDDEN_IO')throw error;return deny('request-contract');}
  requests.push(request);if(typeof handler!=='function')return deny('missing-mock');
  const result=await handler(request);if(!(result instanceof Response))return deny('mock-response');
  return result;
 };
 process.on('exit',()=>{if(attempts.size){process.stderr.write('P164_BLOCKED:forbidden-io\n');process.exitCode=86;}});
 return{
  directory,requests,
  useFetch(value){assert.equal(typeof value,'function');handler=value;},
  reset(){handler=undefined;requests.length=0;},
  assertClean(){assert.equal(attempts.size,0,'No caught forbidden IO attempt may be hidden.');},
  async close(){
   handler=undefined;
   try{assert.equal(attempts.size,0,'No caught forbidden IO attempt may be hidden.');}
   finally{await cleanupDirectory();}
  }
 };
 }catch(error){await cleanupDirectory();throw error;}
}
