import type {IncomingMessage} from 'node:http';
import {fetchSupabase,getSupabaseConfig} from '../../../core/database/supabase.client.js';
import {invalidateRoleAccessCaches} from '../../security-catalogs/role-access-matrix.module.js';
import {invalidateOperationalReadCaches} from '../../../core/performance/operational-read-cache.js';
import {assertRequestAccess,invalidateRequestAccess} from './request-access.service.js';
import {revokeCurrentSession} from './session.service.js';
import {issueSession,providerSession,readRefreshCookie,readSessionHint,requestDevice,sessionHash,SessionRenewalError,type IssuedAuthSession,type RefreshCredential} from './session-credentials.js';

type Binding={userId:number;sessionTokenHash:string;expiresAt:string;authNotAfter?:string|null};
const locks=new Map<string,Promise<unknown>>(),refreshes=new Map<string,Promise<IssuedAuthSession>>();
const rateBuckets=new Map<string,{count:number;until:number}>();
const failure401=()=>new SessionRenewalError(401,'La sesión expiró o fue revocada. Inicie sesión nuevamente.');
export function assertSessionRenewalRate(ip:string|null,binding:string){
 const now=Date.now(),key=sessionHash((ip??'unknown')+'\0'+binding);
 for(let n=0;n<32;n++){const first=rateBuckets.entries().next();if(first.done||first.value[1].until>now)break;rateBuckets.delete(first.value[0]);}
 let bucket=rateBuckets.get(key);if(bucket&&bucket.until<=now){rateBuckets.delete(key);bucket=undefined;}
 if(!bucket){if(rateBuckets.size>=10_000)throw new SessionRenewalError(429,'Espere antes de renovar la sesión.',60);bucket={count:0,until:now+60_000};rateBuckets.set(key,bucket);}
 if(++bucket.count>20)throw new SessionRenewalError(429,'Espere antes de renovar la sesión.',Math.max(1,Math.ceil((bucket.until-now)/1000)));
}
async function exclusive<T>(key:string,operation:()=>Promise<T>):Promise<T>{
 const previous=locks.get(key);
 if(!previous&&locks.size>=500)throw new SessionRenewalError(503,'La renovación está ocupada. Intente nuevamente.');
 let current!:Promise<T>;current=(async()=>{await previous?.catch(()=>undefined);return operation();})();locks.set(key,current);
 try{return await current;}finally{if(locks.get(key)===current)locks.delete(key);}
}
async function trustedRpc<T>(name:string,payload:Record<string,unknown>):Promise<T>{
 const config=getSupabaseConfig(),key=process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
 if(!config||!key)throw new SessionRenewalError(503,'La renovación segura de sesiones no está configurada.');
 let response:Response;
 try{response=await fetchSupabase(new URL('/rest/v1/rpc/'+name,config.url),{method:'POST',redirect:'error',headers:{apikey:key,Authorization:`Bearer ${key}`,'Content-Type':'application/json'},body:JSON.stringify(payload)});}catch{throw new SessionRenewalError(503,'No fue posible verificar la sesión. Intente nuevamente.');}
 let value:Record<string,unknown>|null=null;try{value=await response.json() as Record<string,unknown>;}catch{throw new SessionRenewalError(503,'No fue posible verificar la sesión. Intente nuevamente.');}
 if(!response.ok){if(value?.code==='PT409'||response.status===409)throw new SessionRenewalError(409,'La sesión cambió durante la renovación. Intente nuevamente.');if(value?.code==='42501')throw failure401();if(response.status===429)throw new SessionRenewalError(429,'Espere antes de renovar la sesión.',60);throw new SessionRenewalError(503,'No fue posible verificar la sesión. Intente nuevamente.');}
 return value as T;
}
function bindingInput(credential:RefreshCredential){return{p_auth_user_id:credential.authUserId,p_auth_session_id:credential.authSessionId,p_device_token_hash:credential.deviceHash};}
async function prepare(credential:RefreshCredential){
 const value=await trustedRpc<Binding>('security_prepare_session_refresh',bindingInput(credential));
 if(!Number.isSafeInteger(value?.userId)||value.userId<=0||!/^[0-9a-f]{64}$/.test(value.sessionTokenHash)||typeof value.expiresAt!=='string')throw new SessionRenewalError(503,'No fue posible verificar la sesión. Intente nuevamente.');
 return value;
}
async function providerRefresh(credential:RefreshCredential){
 const config=getSupabaseConfig();if(!config)throw new SessionRenewalError(503,'La renovación segura de sesiones no está configurada.');
 let response:Response;
 try{response=await fetchSupabase(new URL('/auth/v1/token?grant_type=refresh_token',config.url),{method:'POST',redirect:'error',headers:{apikey:config.anonKey,'Content-Type':'application/json'},body:JSON.stringify({refresh_token:credential.refreshToken})});}catch{throw new SessionRenewalError(503,'No fue posible renovar la sesión. Intente nuevamente.');}
 if(!response.ok){if(response.status===429)throw new SessionRenewalError(429,'Espere antes de renovar la sesión.',60);if(response.status===409)throw new SessionRenewalError(409,'La sesión se está renovando. Intente nuevamente.');if(response.status===408||response.status>=500)throw new SessionRenewalError(503,'No fue posible renovar la sesión. Intente nuevamente.');throw failure401();}
 let value:unknown;try{value=await response.json();}catch{throw new SessionRenewalError(502,'El proveedor devolvió una respuesta de renovación inválida.');}
 return providerSession(value,credential);
}
function verifiedCookie(request:IncomingMessage){const hint=readSessionHint(request.headers.authorization),device=requestDevice(request),credential=readRefreshCookie(request,hint,device);return{hint,device,credential,key:sessionHash(credential.authUserId+'\0'+credential.authSessionId+'\0'+credential.deviceHash)};}
export async function renewSession(request:IncomingMessage,ip:string|null){
 const{credential,key}=verifiedCookie(request);assertSessionRenewalRate(ip,key);
 const pending=refreshes.get(key);if(pending)return pending;
 let operation!:Promise<IssuedAuthSession>;operation=exclusive(key,async()=>{
  const before=await prepare(credential),provider=await providerRefresh(credential);
  const complete=await trustedRpc<{userId:number;expiresAt:string}>('security_refresh_session',{...bindingInput(credential),p_expected_session_token_hash:before.sessionTokenHash,p_session_token_hash:sessionHash(provider.hint.token),p_expires_at:new Date(provider.hint.expiresAt).toISOString()});
  if(complete?.userId!==before.userId||typeof complete.expiresAt!=='string')throw new SessionRenewalError(503,'No fue posible confirmar la renovación de sesión.');
  const result=issueSession(provider.hint.token,provider.user,complete.expiresAt,provider.refreshToken,requestDevice(request),credential.rememberMe,credential,before.authNotAfter);
  invalidateRequestAccess(`Bearer ${provider.hint.token}`);invalidateRoleAccessCaches(`Bearer ${provider.hint.token}`);invalidateOperationalReadCaches(`Bearer ${provider.hint.token}`);
  return result;
 });refreshes.set(key,operation);
 try{return await operation;}finally{if(refreshes.get(key)===operation)refreshes.delete(key);}
}
export async function logoutSession(request:IncomingMessage,ip:string|null){
 const hint=readSessionHint(request.headers.authorization),device=requestDevice(request);
 let verified:ReturnType<typeof verifiedCookie>;
 try{verified=verifiedCookie(request);}catch(error){
  // Compatibility for already active logins without a renewal cookie. A decoded
  // token alone never authorizes expired-session logout or the service RPC.
  if(error instanceof SessionRenewalError&&error.status===401){await assertRequestAccess(request.headers.authorization!,device);await revokeCurrentSession(request.headers.authorization!);invalidateRequestAccess(request.headers.authorization!);invalidateRoleAccessCaches(request.headers.authorization!);return hint.authSessionId;}
  throw error;
 }
 assertSessionRenewalRate(ip,verified.key);
 await exclusive(verified.key,async()=>{
  const before=await prepare(verified.credential),provider=await providerRefresh(verified.credential);
  const done=await trustedRpc<boolean>('security_logout_session_binding',{...bindingInput(verified.credential),p_expected_session_token_hash:before.sessionTokenHash});
  if(done!==true)throw new SessionRenewalError(503,'No fue posible confirmar el cierre de sesión.');
  const config=getSupabaseConfig()!;
  await fetchSupabase(new URL('/auth/v1/logout?scope=local',config.url),{method:'POST',redirect:'error',headers:{apikey:config.anonKey,Authorization:`Bearer ${provider.hint.token}`}}).catch(()=>undefined);
  invalidateRequestAccess(request.headers.authorization!);invalidateRequestAccess(`Bearer ${provider.hint.token}`);invalidateRoleAccessCaches(`Bearer ${provider.hint.token}`);invalidateOperationalReadCaches(`Bearer ${provider.hint.token}`);
 });return hint.authSessionId;
}
