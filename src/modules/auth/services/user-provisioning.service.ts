import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { fetchSupabase, getSupabaseConfig } from '../../../core/database/supabase.client.js';
import { hashPassword, validateNewPassword, verifyPassword } from '../../../shared/services/password.service.js';
import { sendUserInvitationEmail, sendUserPasswordRecoveryEmail } from '../../notifications/user-invitation-email.js';

type CreateUserInput = {
  email?: unknown; first_name?: unknown; last_name?: unknown; timezone_id?: unknown;
  is_active?: unknown; notify_user?: unknown; notifyUser?: unknown;
  password_hash?: unknown; // Legacy: accepted but deliberately ignored.
};
type CompleteInvitationInput = {state?:string;invitationType?:string;accessToken?:string;newPassword?:string;confirmation?:string};
type AuthUser = {id?:unknown;email?:unknown};
type InvitationGrant = {invitation_id:number;email_hash:string;auth_user_id:string;created_at:string};
type PasswordNotificationTarget = {actor_user_id:number;subsidiary_id:number;user_id:number;email:string;first_name:string|null;last_name:string|null};
type PasswordNotificationIdentity = {user_id:number;email:string;auth_user_id:string|null;is_active:boolean};

export class UserProvisioningError extends Error {
  constructor(message:string,readonly status=400,readonly retryAfterSeconds?:number){super(message);this.name='UserProvisioningError';}
}

const sha256=(value:string)=>createHash('sha256').update(value).digest('hex');
const invitationAttempts=new Map<string,number[]>();
const passwordNotificationAttempts=new Map<string,number[]>();
function limitInvitationAttempts(ip:string|null|undefined,now=Date.now()){const key=ip||'unknown',windowMs=15*60*1_000,recent=(invitationAttempts.get(key)||[]).filter(value=>now-value<windowMs);if(recent.length>=10){const retry=Math.max(1,Math.ceil((recent[0]+windowMs-now)/1_000));throw new UserProvisioningError(`Demasiados intentos de activación. Intente nuevamente en ${Math.ceil(retry/60)} minuto(s).`,429,retry);}recent.push(now);invitationAttempts.set(key,recent);if(invitationAttempts.size>5_000)for(const[entry,values]of invitationAttempts)if(!values.some(value=>now-value<windowMs))invitationAttempts.delete(entry);}
function safeHexEqual(left:string,right:string){return /^[a-f0-9]{64}$/i.test(left)&&/^[a-f0-9]{64}$/i.test(right)&&timingSafeEqual(Buffer.from(left,'hex'),Buffer.from(right,'hex'));}
function limitPasswordNotificationAttempts(actorUserId:number,userId:number,now=Date.now()){const key=`${actorUserId}|${userId}`,windowMs=15*60*1_000,recent=(passwordNotificationAttempts.get(key)||[]).filter(value=>now-value<windowMs);if(recent.length>=3){const retry=Math.max(1,Math.ceil((recent[0]+windowMs-now)/1_000));throw new UserProvisioningError(`Se enviaron demasiados enlaces. Intente nuevamente en ${Math.ceil(retry/60)} minuto(s).`,429,retry);}recent.push(now);passwordNotificationAttempts.set(key,recent);if(passwordNotificationAttempts.size>5_000)for(const[entry,values]of passwordNotificationAttempts)if(!values.some(value=>now-value<windowMs))passwordNotificationAttempts.delete(entry);}
function emailValue(value:unknown){const email=typeof value==='string'?value.trim().toLowerCase():'';if(!email||email.length>254||!/^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/.test(email))throw new UserProvisioningError('Ingrese un correo electrónico válido.');return email;}
function nameValue(value:unknown,label:string){const name=typeof value==='string'?value.trim().replace(/\s+/g,' '):'';if(!name)throw new UserProvisioningError(`${label} es obligatorio.`);if(name.length>120)throw new UserProvisioningError(`${label} no puede exceder 120 caracteres.`);return name;}
function timezoneValue(value:unknown){if(value===undefined||value===null||value==='')return null;const id=Number(value);if(!Number.isSafeInteger(id)||id<=0)throw new UserProvisioningError('La zona horaria no es válida.');return id;}
function bool(value:unknown,fallback:boolean){if(value===undefined||value===null||value==='')return fallback;if(value===true||value==='true'||value===1||value==='1')return true;if(value===false||value==='false'||value===0||value==='0')return false;throw new UserProvisioningError('El valor de la opción indicada no es válido.');}

function config(){const base=getSupabaseConfig(),serviceKey=process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();if(!base||!serviceKey)throw new UserProvisioningError('La administración de usuarios no está configurada.',503);return{...base,serviceKey};}
function appUrl(){const raw=String(process.env.GENTIA_APP_URL??process.env.APP_BASE_URL??process.env.NEXO_APP_URL??'').trim();if(!raw)throw new UserProvisioningError('La URL pública de la aplicación no está configurada.',503);let url:URL;try{url=new URL(raw);}catch{throw new UserProvisioningError('La URL pública de la aplicación no es válida.',503);}const local=['localhost','127.0.0.1','::1'].includes(url.hostname);if(url.protocol!=='https:'&&!(local&&url.protocol==='http:'))throw new UserProvisioningError('La URL de invitación debe utilizar HTTPS.',503);url.username='';url.password='';url.pathname='/';url.search='';url.hash='';return url;}
async function payload(response:Response){const text=response.status===204?'':await response.text();if(!text)return null;try{return JSON.parse(text)as unknown;}catch{return null;}}
function apiMessage(value:unknown,fallback:string){if(typeof value!=='object'||value===null)return fallback;for(const key of['message','msg','error_description']){const item=(value as Record<string,unknown>)[key];if(typeof item==='string'&&item.trim())return item;}return fallback;}

async function serviceRest<T>(path:string,init:RequestInit={}):Promise<T>{const c=config(),response=await fetchSupabase(new URL(`/rest/v1/${path}`,c.url),{...init,headers:{apikey:c.serviceKey,Authorization:`Bearer ${c.serviceKey}`,'Content-Type':'application/json',...(init.headers??{})}}),value=await payload(response);if(!response.ok){const raw=apiMessage(value,'No fue posible administrar la invitación.'),code=typeof value==='object'&&value!==null?(value as Record<string,unknown>).code:null,conflict=response.status===409||code==='23505';throw new UserProvisioningError(conflict?'Ya existe un usuario con ese correo electrónico.':raw,conflict?409:503);}return value as T;}
async function actorRpc<T>(authorization:string,name:string,body:Record<string,unknown>):Promise<T>{const c=config(),response=await fetchSupabase(new URL(`/rest/v1/rpc/${name}`,c.url),{method:'POST',headers:{apikey:c.anonKey,Authorization:authorization,'Content-Type':'application/json'},body:JSON.stringify(body)}),value=await payload(response);if(!response.ok){const raw=apiMessage(value,'No fue posible crear el usuario en el ERP.'),code=typeof value==='object'&&value!==null?String((value as Record<string,unknown>).code??''):'',conflict=response.status===409||code==='23505',forbidden=response.status===401||response.status===403||code==='42501';throw new UserProvisioningError(conflict?'Ya existe un usuario con ese correo electrónico.':raw,conflict?409:forbidden?403:response.status>=500?503:400);}return value as T;}
async function authAdmin(path:string,init:RequestInit){const c=config(),response=await fetchSupabase(new URL(`/auth/v1/${path}`,c.url),{...init,headers:{apikey:c.serviceKey,Authorization:`Bearer ${c.serviceKey}`,'Content-Type':'application/json',...(init.headers??{})}}),value=await payload(response);if(!response.ok){const raw=apiMessage(value,'No fue posible crear la cuenta de acceso.'),duplicate=response.status===409||/already|registered|exists|duplicate/i.test(raw);throw new UserProvisioningError(duplicate?'Ya existe una cuenta de acceso para ese correo electrónico.':raw,duplicate?409:400);}return value;}
async function deleteAuthUser(id:string){const c=config();try{const response=await fetchSupabase(new URL(`/auth/v1/admin/users/${encodeURIComponent(id)}`,c.url),{method:'DELETE',headers:{apikey:c.serviceKey,Authorization:`Bearer ${c.serviceKey}`}});return response.ok;}catch{return false;}}
async function deleteGrant(stateHash:string){try{await serviceRest(`user_invitation_grants?state_hash=eq.${stateHash}`,{method:'DELETE'});return true;}catch{return false;}}
function authIdentity(value:unknown){const source=typeof value==='object'&&value!==null&&'user'in value?(value as{user?:unknown}).user:value;if(typeof source!=='object'||source===null)throw new UserProvisioningError('Supabase devolvió una cuenta de acceso no válida.',502);const row=source as AuthUser,id=typeof row.id==='string'?row.id:'',email=typeof row.email==='string'?row.email.trim().toLowerCase():'';if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)||!email)throw new UserProvisioningError('Supabase devolvió una cuenta de acceso no válida.',502);return{id,email};}
function actionLink(value:unknown){if(typeof value!=='object'||value===null)return'';const row=value as Record<string,unknown>,direct=row.action_link;if(typeof direct==='string')return direct;const properties=typeof row.properties==='object'&&row.properties!==null?row.properties as Record<string,unknown>:null;return typeof properties?.action_link==='string'?properties.action_link:'';}
function generatedRedirect(value:unknown,link:string){if(typeof value==='object'&&value!==null){const row=value as Record<string,unknown>;if(typeof row.redirect_to==='string')return row.redirect_to;const properties=typeof row.properties==='object'&&row.properties!==null?row.properties as Record<string,unknown>:null;if(typeof properties?.redirect_to==='string')return properties.redirect_to;}try{return new URL(link).searchParams.get('redirect_to')||'';}catch{return'';}}

export async function createSecurityUser(authorization:string,input:CreateUserInput){
  const email=emailValue(input.email),firstName=nameValue(input.first_name,'Nombre'),lastName=nameValue(input.last_name,'Apellidos'),timezoneId=timezoneValue(input.timezone_id),isActive=bool(input.is_active,true),requestedNotification=bool(input.notify_user??input.notifyUser,true),shouldNotify=requestedNotification&&isActive;
  // The route authorizes security:users:create and the SECURITY DEFINER RPC
  // validates the same permission again while preserving the human audit actor.
  const existing=await serviceRest<Array<{user_id:number}>>(`users?select=user_id&email=eq.${encodeURIComponent(email)}&limit=1`);if(existing.length)throw new UserProvisioningError('Ya existe un usuario con ese correo electrónico.',409);
  const metadata={first_name:firstName,last_name:lastName,invited_by_erp:true};let identity:{id:string;email:string}|null=null,stateHash='',activationLink='',expiresAt='';
  try{
    if(shouldNotify){
      const state=randomBytes(32).toString('base64url'),redirect=appUrl();stateHash=sha256(state);redirect.searchParams.set('password_invitation','1');redirect.searchParams.set('state',state);expiresAt=new Date(Date.now()+60*60*1_000).toISOString();
      const generated=await authAdmin('admin/generate_link',{method:'POST',body:JSON.stringify({type:'invite',email,data:metadata,redirect_to:redirect.toString()})});identity=authIdentity(generated);activationLink=actionLink(generated);if(!activationLink)throw new UserProvisioningError('Supabase no devolvió el enlace de activación.',502);let returnedRedirect:URL;try{returnedRedirect=new URL(generatedRedirect(generated,activationLink));}catch{throw new UserProvisioningError('Supabase no conservó la URL de activación configurada.',503);}if(returnedRedirect.toString()!==redirect.toString())throw new UserProvisioningError('La URL de invitación no está autorizada en Supabase Auth. Agréguela a Redirect URLs.',503);
      await serviceRest(`user_invitation_grants?expires_at=lt.${encodeURIComponent(new Date().toISOString())}`,{method:'DELETE'}).catch(()=>undefined);
      await serviceRest('user_invitation_grants',{method:'POST',headers:{Prefer:'return=minimal'},body:JSON.stringify({email_hash:sha256(email),state_hash:stateHash,auth_user_id:identity.id,expires_at:expiresAt})});
    }else{
      const inaccessiblePassword=randomBytes(48).toString('base64url');identity=authIdentity(await authAdmin('admin/users',{method:'POST',body:JSON.stringify({email,password:inaccessiblePassword,email_confirm:true,user_metadata:metadata})}));
    }
    if(identity.email!==email)throw new UserProvisioningError('La cuenta creada no corresponde al correo solicitado.',502);
    const user=await actorRpc<Record<string,unknown>>(authorization,'security_create_user',{p_email:email,p_auth_user_id:identity.id,p_first_name:firstName,p_last_name:lastName,p_timezone_id:timezoneId,p_is_active:isActive});
    if(!user||!Number.isSafeInteger(Number(user.user_id)))throw new UserProvisioningError('No fue posible obtener el usuario creado.',500);
    let notification:{requested:boolean;sent:boolean;status:string;error?:string}={requested:requestedNotification,sent:false,status:shouldNotify?'PENDIENTE':'NO_SOLICITADA'};
    if(shouldNotify){
      try{
        await sendUserInvitationEmail(authorization,{empresa_nombre:'',empresa_logo_url:null,usuario_nombre:`${firstName} ${lastName}`.trim(),usuario_correo:email,enlace_activacion:activationLink,fecha_expiracion:expiresAt});notification={requested:true,sent:true,status:'INVITACION_ENVIADA'};const userId=Number(user.user_id);if(Number.isSafeInteger(userId)&&userId>0)await actorRpc(authorization,'security_mark_user_invitation_sent',{p_user_id:userId}).catch(()=>undefined);
      }catch(cause){const mailError=cause instanceof Error?cause.message:'No fue posible enviar la invitación.',fallbackPassword=randomBytes(48).toString('base64url');let recoveryReady=false;try{await authAdmin(`admin/users/${encodeURIComponent(identity.id)}`,{method:'PUT',body:JSON.stringify({password:fallbackPassword,email_confirm:true})});recoveryReady=true;}catch{}const grantRemoved=await deleteGrant(stateHash);notification={requested:true,sent:false,status:recoveryReady&&grantRemoved?'ENVIO_FALLIDO_RECUPERACION_DISPONIBLE':'REQUIERE_INTERVENCION',error:mailError};}
    }else if(requestedNotification&&!isActive)notification={requested:true,sent:false,status:'OMITIDA_USUARIO_INACTIVO'};
    return{...user,notification,message:notification.sent?'Usuario creado e invitación enviada.':notification.status==='ENVIO_FALLIDO_RECUPERACION_DISPONIBLE'?'Usuario creado, pero el correo no pudo enviarse. La cuenta quedó habilitada para utilizar Recuperar contraseña.':notification.status==='REQUIERE_INTERVENCION'?'Usuario creado, pero la invitación requiere intervención administrativa antes de que pueda acceder.':isActive?'Usuario creado sin notificación. Puede utilizar Recuperar contraseña para definir su acceso.':'Usuario inactivo creado sin enviar invitación.'};
  }catch(cause){const authRemoved=identity?await deleteAuthUser(identity.id):true,grantRemoved=stateHash?await deleteGrant(stateHash):true;if(!authRemoved||!grantRemoved){console.error('[UserProvisioning] Falló la compensación de un alta incompleta.');throw new UserProvisioningError('No fue posible completar el alta y la compensación requiere intervención administrativa.',500);}throw cause;}
}

async function auditPasswordNotification(target:PasswordNotificationTarget,result:'ENVIADO'|'ENVIADO_CON_ADVERTENCIA'|'ERROR'){
  try{
    await serviceRest('rpc/security_audit_user_password_notification',{method:'POST',body:JSON.stringify({
      p_actor_user_id:Number(target.actor_user_id),
      p_target_user_id:Number(target.user_id),
      p_subsidiary_id:Number(target.subsidiary_id),
      p_result:result
    })});
    return true;
  }catch{
    console.error('[UserProvisioning] No fue posible registrar la auditoría del correo de recuperación.');
    return false;
  }
}

export async function sendExistingUserPasswordLink(authorization:string,userId:number){
  if(!Number.isSafeInteger(userId)||userId<=0)throw new UserProvisioningError('El usuario indicado no es válido.');

  // This actor-scoped RPC runs before every service-role operation. It checks
  // security:users:edit, the active subsidiary and the target membership.
  const target=await actorRpc<PasswordNotificationTarget>(authorization,'security_prepare_user_password_recovery',{p_user_id:userId});
  if(!target||Number(target.user_id)!==userId||!Number.isSafeInteger(Number(target.actor_user_id))||Number(target.actor_user_id)<=0||!Number.isSafeInteger(Number(target.subsidiary_id))||Number(target.subsidiary_id)<=0)throw new UserProvisioningError('El usuario no está disponible para recuperar su acceso.',404);
  try{limitPasswordNotificationAttempts(Number(target.actor_user_id),userId);}
  catch(cause){await auditPasswordNotification(target,'ERROR');throw cause;}

  let email:string,account:PasswordNotificationIdentity|undefined;
  try{email=emailValue(target.email);account=(await serviceRest<PasswordNotificationIdentity[]>(`users?select=user_id,email,auth_user_id,is_active&user_id=eq.${userId}&limit=1`))[0];}
  catch(cause){await auditPasswordNotification(target,'ERROR');throw cause;}
  const authUserId=typeof account?.auth_user_id==='string'?account.auth_user_id:'';
  if(!account?.is_active||account.user_id!==userId||account.email.trim().toLowerCase()!==email||!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(authUserId)){await auditPasswordNotification(target,'ERROR');throw new UserProvisioningError('El usuario no está disponible para recuperar su acceso.',409);}

  const state=randomBytes(32).toString('base64url'),stateHash=sha256(state),emailHash=sha256(email),expiresAt=new Date(Date.now()+30*60*1_000).toISOString(),redirect=appUrl();
  redirect.searchParams.set('password_recovery','1');
  redirect.searchParams.set('state',state);
  await serviceRest(`password_recovery_grants?expires_at=lt.${encodeURIComponent(new Date().toISOString())}`,{method:'DELETE'}).catch(()=>undefined);
  try{await serviceRest('password_recovery_grants',{method:'POST',headers:{Prefer:'return=minimal'},body:JSON.stringify({state_hash:stateHash,email_hash:emailHash,expires_at:expiresAt})});}
  catch(cause){await auditPasswordNotification(target,'ERROR');throw cause;}

  try{
    const generated=await authAdmin('admin/generate_link',{method:'POST',body:JSON.stringify({type:'recovery',email,redirect_to:redirect.toString()})}),identity=authIdentity(generated),recoveryLink=actionLink(generated);
    if(identity.id!==authUserId||identity.email!==email||!recoveryLink)throw new UserProvisioningError('No fue posible vincular el enlace con la cuenta solicitada.',502);
    let returnedRedirect:URL;try{returnedRedirect=new URL(generatedRedirect(generated,recoveryLink));}catch{throw new UserProvisioningError('Supabase no conservó la URL de recuperación configurada.',503);}
    if(returnedRedirect.toString()!==redirect.toString())throw new UserProvisioningError('La URL de recuperación no está autorizada en Supabase Auth. Agréguela a Redirect URLs.',503);
    await sendUserPasswordRecoveryEmail(authorization,{empresa_nombre:'',empresa_logo_url:null,usuario_nombre:`${target.first_name??''} ${target.last_name??''}`.trim()||email,usuario_correo:email,enlace_activacion:recoveryLink,fecha_expiracion:expiresAt,access_mode:'RECOVERY'});
    // Keep concurrent links until the first one is used. The database consume
    // RPC serializes by email and consumes every open link atomically, so two
    // simultaneous email deliveries cannot invalidate one another.
    const audited=await auditPasswordNotification(target,'ENVIADO');
    return{success:true,sent:true,status:audited?'RECUPERACION_ENVIADA':'RECUPERACION_ENVIADA_MANTENIMIENTO_PENDIENTE',message:audited?'Se envió un enlace seguro y de un solo uso para definir una nueva contraseña.':'Se envió el enlace seguro, pero la auditoría requiere revisión administrativa.'};
  }catch(cause){
    await serviceRest(`password_recovery_grants?state_hash=eq.${stateHash}`,{method:'DELETE'}).catch(()=>undefined);
    await auditPasswordNotification(target,'ERROR');
    if(cause instanceof UserProvisioningError)throw cause;
    throw new UserProvisioningError('No fue posible enviar el enlace de recuperación. El usuario puede utilizar «¿Olvidaste tu contraseña?» e intentarlo nuevamente.',503);
  }
}

function bearer(authorization:string|undefined,fallback:unknown){const header=authorization?.replace(/^Bearer\s+/i,'').trim()??'',body=typeof fallback==='string'?fallback.trim():'',token=header||body;if(!token||token.length>8192)throw new UserProvisioningError('La invitación no es válida o ya expiró.',401);return token;}
function inviteIssuedAt(token:string){try{const encoded=token.split('.')[1];if(!encoded)return null;const claims=JSON.parse(Buffer.from(encoded,'base64url').toString('utf8'))as{iat?:number;exp?:number;role?:string;aud?:string|string[];amr?:Array<{method?:string}>};if(!Number.isFinite(claims.iat)||!Number.isFinite(claims.exp)||Number(claims.exp)*1000<=Date.now())return null;const audience=Array.isArray(claims.aud)?claims.aud:[claims.aud],methods=new Set(['invite','otp','magiclink','email']);if(claims.role!=='authenticated'||!audience.includes('authenticated')||!Array.isArray(claims.amr)||!claims.amr.some(item=>methods.has(String(item?.method))))return null;return Number(claims.iat)*1000;}catch{return null;}}

export async function completePasswordInvitation(authorization:string|undefined,input:CompleteInvitationInput,ipAddress?:string|null){
  limitInvitationAttempts(ipAddress);
  const state=typeof input.state==='string'?input.state.trim():'';if(!/^[A-Za-z0-9_-]{43}$/.test(state)||input.invitationType!=='invite')throw new UserProvisioningError('La invitación no es válida o ya expiró.',401);const password=input.newPassword??'';if(password!==input.confirmation)throw new UserProvisioningError('La confirmación de la nueva contraseña no coincide.');validateNewPassword(password);const token=bearer(authorization,input.accessToken),issuedAt=inviteIssuedAt(token);if(!issuedAt)throw new UserProvisioningError('La invitación no es válida o ya expiró.',401);
  const c=config(),userResponse=await fetchSupabase(new URL('/auth/v1/user',c.url),{headers:{apikey:c.anonKey,Authorization:`Bearer ${token}`}}),authValue=await payload(userResponse);if(!userResponse.ok)throw new UserProvisioningError('La invitación no es válida o ya expiró.',401);const identity=authIdentity(authValue),emailHash=sha256(identity.email),stateHash=sha256(state);
  const grants=await serviceRest<InvitationGrant[]>(`user_invitation_grants?select=invitation_id,email_hash,auth_user_id,created_at&state_hash=eq.${stateHash}&consumed_at=is.null&expires_at=gt.${encodeURIComponent(new Date().toISOString())}&limit=1`),grant=grants[0],createdAt=grant?Date.parse(grant.created_at):NaN;if(!grant||!safeHexEqual(grant.email_hash,emailHash)||grant.auth_user_id!==identity.id||!Number.isFinite(createdAt)||issuedAt<createdAt-120_000)throw new UserProvisioningError('La invitación no es válida o ya expiró.',401);
  const users=await serviceRest<Array<{user_id:number;is_active:boolean}>>(`users?select=user_id,is_active&auth_user_id=eq.${encodeURIComponent(identity.id)}&email=eq.${encodeURIComponent(identity.email)}&limit=1`),user=users[0];if(!user?.is_active)throw new UserProvisioningError('La cuenta está inactiva. Contacte al administrador.',403);const history=await serviceRest<Array<{password_hash:string}>>(`password_history?select=password_hash&user_id=eq.${user.user_id}&order=created_at.desc&limit=6`);for(const item of history)if(await verifyPassword(password,item.password_hash))throw new UserProvisioningError('No puede reutilizar ninguna de sus últimas 6 contraseñas.');
  const claimed=await serviceRest<boolean>('rpc/consume_user_invitation_grant',{method:'POST',body:JSON.stringify({p_state_hash:stateHash,p_email_hash:emailHash,p_auth_user_id:identity.id})});if(!claimed)throw new UserProvisioningError('La invitación ya fue utilizada o expiró.',401);const update=await fetchSupabase(new URL('/auth/v1/user',c.url),{method:'PUT',headers:{apikey:c.anonKey,Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify({password})});if(!update.ok)throw new UserProvisioningError('No fue posible definir la contraseña. Solicite una nueva invitación.',400);
  let maintenanceFailure=false;try{await serviceRest('password_history',{method:'POST',headers:{Prefer:'return=minimal'},body:JSON.stringify({user_id:user.user_id,password_hash:await hashPassword(password)})});}catch{maintenanceFailure=true;}try{await serviceRest(`users?user_id=eq.${user.user_id}`,{method:'PATCH',headers:{Prefer:'return=minimal'},body:JSON.stringify({invitation_accepted_at:new Date().toISOString()})});}catch{maintenanceFailure=true;}try{await serviceRest(`sessions?user_id=eq.${user.user_id}`,{method:'DELETE'});}catch{maintenanceFailure=true;}if(maintenanceFailure)console.error('[UserInvitation] La contraseña se definió, pero falló el mantenimiento posterior de la cuenta.');await fetchSupabase(new URL('/auth/v1/logout?scope=global',c.url),{method:'POST',headers:{apikey:c.anonKey,Authorization:`Bearer ${token}`}}).catch(()=>undefined);return{success:true,message:'Cuenta activada. Ya puede iniciar sesión con su nueva contraseña.'};
}
