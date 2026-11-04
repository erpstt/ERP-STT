// Child-process tripwire for operator previews only. Never preload this in the ERP.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import net from 'node:net';
import tls from 'node:tls';
import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import dgram from 'node:dgram';
import {registerHooks,syncBuiltinESMExports} from 'node:module';

const attempts=new Set();
function denied(kind){
  attempts.add(kind);
  throw Object.assign(Error('Operator preview attempted forbidden IO.'),{code:'OPERATOR_PREVIEW_FORBIDDEN_IO'});
}
const credentials=/^(SUPABASE(?:_|$)|PG(?:PASSWORD|HOST|PORT|USER|DATABASE|SERVICE|OPTIONS|PASSFILE)|DATABASE_URL$|ERP_TEST_|SMTP_)/i;
process.env=new Proxy(process.env,{get(target,key){if(typeof key==='string'&&credentials.test(key))denied('credential-read');return Reflect.get(target,key);}});
process.loadEnvFile=()=>denied('environment-file');
const isEnvironmentFile=value=>/(?:^|\/)\.env(?:\.[^/]*)?$/i.test(String(value instanceof URL?value.pathname:value).replaceAll('\\','/'));
for(const name of ['readFile','readFileSync','open','openSync','createReadStream']){
  const original=fs[name];fs[name]=function(path,...rest){if(isEnvironmentFile(path))denied('environment-file');return original.call(this,path,...rest);};
}
for(const name of ['readFile','open']){
  const original=fsp[name];fsp[name]=function(path,...rest){if(isEnvironmentFile(path))denied('environment-file');return original.call(this,path,...rest);};
}
net.Socket.prototype.connect=()=>denied('network');
net.Server.prototype.listen=()=>denied('network');
for(const name of ['connect','createConnection'])net[name]=()=>denied('network');
tls.connect=()=>denied('network');
for(const name of ['lookup','resolve','resolve4','resolve6','reverse'])dns[name]=()=>denied('network');
for(const owner of [http,https])for(const name of ['request','get'])owner[name]=()=>denied('network');
for(const name of ['connect','send'])dgram.Socket.prototype[name]=()=>denied('network');
globalThis.fetch=async()=>denied('network');
syncBuiltinESMExports();
registerHooks({resolve(specifier,context,nextResolve){
  if(/^(?:pg|postgres|dotenv)(?:\/|$)|^@supabase\//.test(specifier))denied('database-or-environment-import');
  const result=nextResolve(specifier,context);
  if(/\/node_modules\/(?:pg|postgres|dotenv)\/|\/node_modules\/@supabase\//.test(result.url.replaceAll('\\','/')))denied('database-or-environment-import');
  return result;
}});
// Catching an exception must not hide an attempt from the parent assertion.
process.on('exit',()=>{
  if(attempts.size){process.stderr.write('OPERATOR_GUARD_FORBIDDEN:'+Array.from(attempts).sort().join(',')+'\n');process.exitCode=86;}
});
