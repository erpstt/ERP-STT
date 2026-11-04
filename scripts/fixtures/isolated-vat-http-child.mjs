// Test-only preload. Never import this from the ERP or a production command.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import net from 'node:net';
import dns from 'node:dns';
import dgram from 'node:dgram';
import childProcess from 'node:child_process';
import {registerHooks,syncBuiltinESMExports} from 'node:module';

const upstream=new URL(process.env.P157_UPSTREAM_ORIGIN||'http://invalid.invalid');
if(upstream.protocol!=='http:'||upstream.hostname!=='127.0.0.1'||!upstream.port||upstream.pathname!=='/'||upstream.search||upstream.hash||upstream.username||upstream.password)throw Error('Invalid synthetic VAT upstream configuration.');
const worker='http://p157-renderer.railway.internal';
if(process.env.PDF_RENDERER_URL!==worker+'/'||process.env.DISABLE_BACKGROUND_JOBS!=='true')throw Error('Invalid isolated VAT runtime configuration.');
const attempts=new Set();
function deny(kind){attempts.add(kind);process.stderr.write('P157_BLOCKED:'+kind+'\n');throw Error('P157_FORBIDDEN_IO');}
process.loadEnvFile=()=>{throw Object.assign(Error('Environment files unavailable in this fixture.'),{code:'ENOENT'});};
const isEnv=path=>/(?:^|\/)\.env(?:\.[^/]*)?$/i.test(String(path instanceof URL?path.pathname:path).replaceAll('\\','/'));
for(const name of['readFile','readFileSync','open','openSync','createReadStream']){const original=fs[name];fs[name]=function(path,...args){if(isEnv(path))deny('environment-file');return original.call(this,path,...args);};}
for(const name of['readFile','open']){const original=fsp[name];fsp[name]=function(path,...args){if(isEnv(path))deny('environment-file');return original.call(this,path,...args);};}

const fetchLocal=globalThis.fetch;
const rpcPaths=new Set(['/rest/v1/rpc/assert_request_access','/rest/v1/rpc/security_my_role_access','/rest/v1/rpc/vat_declaration_report_options','/rest/v1/rpc/run_vat_declaration_report']);
globalThis.fetch=(input,init)=>{
 const target=new URL(input instanceof Request?input.url:String(input));
 if(target.username||target.password)return deny('fetch-credentials');
 if(target.origin===upstream.origin&&rpcPaths.has(target.pathname)&&!target.search&&!target.hash)return fetchLocal(input,init);
 // Keep the real PDF service, HTML sanitizer and private renderer client. Only
 // the worker transport is simulated; no browser or renderer process is started.
 if(target.origin===worker&&target.pathname==='/render'&&!target.search&&!target.hash)return fetchLocal(new URL('/synthetic-pdf-worker',upstream),init);
 return deny('fetch-target');
};

const connect=net.Socket.prototype.connect;
net.Socket.prototype.connect=function(...args){
 const values=Array.isArray(args[0])?args[0]:args,options=values[0];
 const host=typeof options==='object'?options.host??options.hostname:values[1];
 const port=typeof options==='object'?options.port:options;
 if(host!=='127.0.0.1'||Number(port)!==Number(upstream.port))return deny('socket-target');
 return connect.apply(this,args);
};
const listen=net.Server.prototype.listen;
net.Server.prototype.listen=function(...args){
 const options=args[0],port=typeof options==='object'?options.port:options,callback=args.find(value=>typeof value==='function');
 if(Number(port)!==Number(process.env.PORT))return deny('listener-target');
 return listen.call(this,{port:Number(port),host:'127.0.0.1'},...(callback?[callback]:[]));
};
// A literal loopback lookup is answered directly; no OS/configured resolver is
// called. All query APIs, including Promise and Resolver variants, are closed.
dns.lookup=(host,options,callback)=>{
 if(host!=='127.0.0.1')return deny('dns-lookup');
 const done=typeof options==='function'?options:callback;if(typeof done!=='function')return deny('dns-call-shape');
 queueMicrotask(()=>options?.all?done(null,[{address:host,family:4}]):done(null,host,4));
};
dns.promises.lookup=async(host,options)=>{if(host!=='127.0.0.1')return deny('dns-lookup');return options?.all?[{address:host,family:4}]:{address:host,family:4};};
for(const owner of[dns,dns.promises]){
 for(const name of Object.getOwnPropertyNames(owner))if(/^resolve|^reverse$|^lookupService$/.test(name)&&typeof owner[name]==='function')owner[name]=()=>deny('dns-query');
 const Resolver=owner.Resolver;
 for(const name of Object.getOwnPropertyNames(Resolver.prototype))if(/^resolve|^reverse$|^lookupService$/.test(name)&&typeof Resolver.prototype[name]==='function')Resolver.prototype[name]=()=>deny('dns-query');
 owner.Resolver=class{constructor(){deny('dns-resolver');}};
}
for(const name of['connect','send'])dgram.Socket.prototype[name]=()=>deny('datagram');
for(const name of['spawn','spawnSync','exec','execSync','execFile','execFileSync','fork'])childProcess[name]=()=>deny('child-process');
syncBuiltinESMExports();
registerHooks({resolve(specifier,context,next){
 if(/^(?:pg|postgres|dotenv)(?:\/|$)|^@supabase\//.test(specifier))return deny('database-or-env-import');
 const result=next(specifier,context),url=result.url.replaceAll('\\','/');
 if(/\/node_modules\/(?:pg|postgres|dotenv)\/|\/node_modules\/@supabase\//.test(url))return deny('database-or-env-import');
 return result;
}});
process.on('exit',()=>{if(attempts.size){process.stderr.write('P157_BLOCKED:'+Array.from(attempts).sort().join(',')+'\n');process.exitCode=86;}});
