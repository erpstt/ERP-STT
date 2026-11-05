import {createHash,createHmac,timingSafeEqual} from 'node:crypto';
import type {IncomingMessage} from 'node:http';
import {publicAppUrl} from '../../../shared/services/public-app-url.js';

const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const COOKIE_LIFETIME_MS=30*24*60*60*1000;
export class SessionRenewalError extends Error {
 constructor(readonly status:number,message:string,readonly retryAfterSeconds?:number){super(message);this.name='SessionRenewalError';}
}
export interface SessionHint {authUserId:string;authSessionId:string;expiresAt:number;token:string;}
export interface RefreshCredential {version:1;authUserId:string;authSessionId:string;deviceHash:string;refreshToken:string;rememberMe:boolean;issuedAt:number;cookieExpiresAt:number;}
export interface PublicAuthSession {accessToken:string;user:{name:string;email:string};expiresAt:string;erpSessionExpiresAt:string;refreshAt:string;}
export interface IssuedAuthSession extends PublicAuthSession {refreshCredential:RefreshCredential;}
export const sessionHash=(value:string)=>createHash('sha256').update(value).digest('hex');
const invalid=()=>new SessionRenewalError(401,'La sesión expiró o fue revocada. Inicie sesión nuevamente.');
export function readSessionHint(authorization:unknown):SessionHint{
 if(typeof authorization!=='string'||authorization.length>16_384||!/^Bearer\s+\S+$/i.test(authorization))throw invalid();
 const token=authorization.replace(/^Bearer\s+/i,''),parts=token.split('.');
 try{
  if(parts.length!==3||!parts.every(part=>/^[a-zA-Z0-9_-]+$/.test(part)))throw Error();
  const claims=JSON.parse(Buffer.from(parts[1]!, 'base64url').toString('utf8'));
  if(!uuid.test(claims.sub)||!uuid.test(claims.session_id)||!Number.isSafeInteger(claims.exp)||claims.exp<=0||claims.exp*1000>8.64e15)throw Error();
  return{authUserId:claims.sub.toLowerCase(),authSessionId:claims.session_id.toLowerCase(),expiresAt:claims.exp*1000,token};
 }catch{throw invalid();}
}
export function requestDevice(request:IncomingMessage){
 const raw=request.headers['x-device-token'];
 if(typeof raw!=='string'||raw.length<20||raw.length>200||raw!==raw.trim()||/[\u0000-\u001f\u007f]/.test(raw))throw invalid();
 return raw;
}
function localHttpAllowed(){return process.env.NODE_ENV==='test'&&process.env.SESSION_REFRESH_ALLOW_LOCAL_HTTP==='true';}
export function authCookiePolicy(){
 let url:URL;
 try{url=publicAppUrl({rootOnly:true,allowLocalHttp:localHttpAllowed(),disallowLocalhost:!localHttpAllowed()});}
 catch{throw new SessionRenewalError(503,'La URL pública segura de acceso no está configurada.');}
 const insecure=url.protocol==='http:'&&localHttpAllowed()&&['localhost','127.0.0.1'].includes(url.hostname);
 if(url.protocol!=='https:'&&!insecure)throw new SessionRenewalError(503,'La URL pública segura de acceso no está configurada.');
 return{origin:url.origin,secure:!insecure,prefix:insecure?'erp-refresh-':'__Host-erp-refresh-'};
}
export function assertAuthOrigin(request:IncomingMessage){
 const origin=request.headers.origin,site=request.headers['sec-fetch-site'],policy=authCookiePolicy();
 if(typeof origin!=='string'||origin!==policy.origin||(site!==undefined&&site!=='same-origin'&&site!=='none'))throw new SessionRenewalError(403,'El origen de la solicitud de acceso no está autorizado.');
 return policy;
}
function cookieKey(){
 const secret=process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
 if(!secret)throw new SessionRenewalError(503,'La renovación segura de sesiones no está configurada.');
 return createHmac('sha256',secret).update('gentia/session-refresh-cookie/v1').digest();
}
function cookieSignature(value:string){return createHmac('sha256',cookieKey()).update(value).digest();}
export function refreshCookieName(authSessionId:string){if(!uuid.test(authSessionId))throw invalid();return authCookiePolicy().prefix+authSessionId.toLowerCase();}
export function signRefreshCookie(credential:RefreshCredential){
 const encoded=Buffer.from(JSON.stringify(credential)).toString('base64url');
 if(encoded.length>3600)throw new SessionRenewalError(502,'La respuesta de renovación no es válida.');
 return encoded+'.'+cookieSignature(encoded).toString('base64url');
}
export function readRefreshCookie(request:IncomingMessage,hint:SessionHint,device:string):RefreshCredential{
 const name=refreshCookieName(hint.authSessionId),header=request.headers.cookie??'';
 if(header.length>32_768)throw invalid();
 const matches=header.split(';').map(part=>part.trim()).filter(part=>part.startsWith(name+'='));
 if(matches.length!==1)throw invalid();
 const value=matches[0]!.slice(name.length+1),parts=value.split('.');
 if(parts.length!==2||!parts.every(part=>/^[a-zA-Z0-9_-]+$/.test(part))||parts[0]!.length>3600)throw invalid();
 const expected=cookieSignature(parts[0]!),supplied=Buffer.from(parts[1]!,'base64url');
 if(expected.length!==supplied.length||supplied.toString('base64url')!==parts[1]||!timingSafeEqual(expected,supplied))throw invalid();
 let credential:RefreshCredential;
 try{credential=JSON.parse(Buffer.from(parts[0]!,'base64url').toString('utf8'));}catch{throw invalid();}
 const now=Date.now();
 if(credential.version!==1||credential.authUserId!==hint.authUserId||credential.authSessionId!==hint.authSessionId||credential.deviceHash!==sessionHash(device)||typeof credential.rememberMe!=='boolean'||typeof credential.refreshToken!=='string'||!/^[\x21-\x7e]{1,2048}$/.test(credential.refreshToken)||!Number.isSafeInteger(credential.issuedAt)||!Number.isSafeInteger(credential.cookieExpiresAt)||credential.issuedAt<=0||credential.issuedAt>now+60_000||credential.cookieExpiresAt<=now||credential.cookieExpiresAt<=credential.issuedAt||credential.cookieExpiresAt>credential.issuedAt+COOKIE_LIFETIME_MS)throw invalid();
 return credential;
}
export function refreshSetCookie(credential:RefreshCredential){
 const policy=authCookiePolicy();
 const persistent=credential.rememberMe?`; Max-Age=${Math.max(0,Math.floor((credential.cookieExpiresAt-Date.now())/1000))}; Expires=${new Date(credential.cookieExpiresAt).toUTCString()}`:'';
 return`${refreshCookieName(credential.authSessionId)}=${signRefreshCookie(credential)}; Path=/; HttpOnly; SameSite=Strict${policy.secure?'; Secure':''}${persistent}`;
}
export function clearRefreshCookie(authSessionId:string){return`${refreshCookieName(authSessionId)}=; Path=/; HttpOnly; SameSite=Strict${authCookiePolicy().secure?'; Secure':''}; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT`;}
export function providerSession(value:unknown,expected?:Pick<RefreshCredential,'authUserId'|'authSessionId'>){
 if(!value||typeof value!=='object')throw new SessionRenewalError(502,'El proveedor devolvió una respuesta de acceso inválida.');
 const p=value as Record<string,unknown>;let hint:SessionHint;
 try{hint=readSessionHint(`Bearer ${typeof p.access_token==='string'?p.access_token:''}`);}catch{throw new SessionRenewalError(502,'El proveedor devolvió una respuesta de acceso inválida.');}
 const user=p.user as Record<string,unknown>|null;
 if(!user||typeof user.id!=='string'||user.id.toLowerCase()!==hint.authUserId||typeof user.email!=='string'||typeof p.refresh_token!=='string'||!/^[\x21-\x7e]{1,2048}$/.test(p.refresh_token)||hint.expiresAt<=Date.now())throw new SessionRenewalError(502,'El proveedor devolvió una respuesta de acceso inválida.');
 if(expected&&(hint.authUserId!==expected.authUserId||hint.authSessionId!==expected.authSessionId))throw invalid();
 return{hint,refreshToken:p.refresh_token,user:{name:user.email.split('@')[0]!,email:user.email}};
}
export function issueSession(accessToken:string,user:{name:string;email:string},erpExpiry:string,refreshToken:string,device:string,rememberMe:boolean,previous?:RefreshCredential,authNotAfter?:string|null):IssuedAuthSession{
 const hint=readSessionHint(`Bearer ${accessToken}`),now=Date.now(),erp=Date.parse(erpExpiry);
 if(!Number.isFinite(erp)||erp<=now||hint.expiresAt<=now)throw new SessionRenewalError(502,'No fue posible confirmar la vigencia de la sesión.');
 const providerEnd=authNotAfter?Date.parse(authNotAfter):Number.POSITIVE_INFINITY;
 if(Number.isNaN(providerEnd)||providerEnd<=now)throw invalid();
 const credential:RefreshCredential={version:1,authUserId:hint.authUserId,authSessionId:hint.authSessionId,deviceHash:sessionHash(device),refreshToken,rememberMe,issuedAt:previous?.issuedAt??now,cookieExpiresAt:Math.min(previous?.cookieExpiresAt??now+COOKIE_LIFETIME_MS,providerEnd)};
 if(credential.cookieExpiresAt<=now)throw invalid();
 return{accessToken,user,expiresAt:new Date(hint.expiresAt).toISOString(),erpSessionExpiresAt:new Date(erp).toISOString(),refreshAt:new Date(Math.max(now,Math.min(hint.expiresAt,erp)-60_000)).toISOString(),refreshCredential:credential};
}
export function publicAuthSession(session:IssuedAuthSession):PublicAuthSession{
 return{accessToken:session.accessToken,user:session.user,expiresAt:session.expiresAt,erpSessionExpiresAt:session.erpSessionExpiresAt,refreshAt:session.refreshAt};
}
