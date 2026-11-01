import{createHash}from'node:crypto';import{fetchSupabase,getSupabaseConfig}from'../../../core/database/supabase.client.js';
const hash=(s:string)=>createHash('sha256').update(s).digest('hex');
export async function registerTrustedLogin(token:string,authUserId:string,deviceToken:string|undefined,deviceName:string|undefined,ipAddress:string|null){
 const c=getSupabaseConfig(),key=process.env.SUPABASE_SERVICE_ROLE_KEY?.trim(),device=deviceToken?.trim()??'';if(!c||!key)throw Object.assign(Error('El registro seguro de sesiones no está configurado.'),{status:503});
 let claims:{sub?:string;session_id?:string;exp?:number};try{claims=JSON.parse(Buffer.from(token.split('.')[1]??'','base64url').toString('utf8'));}catch{throw Error('La identidad autenticada no es válida.');}
 if(claims.sub!==authUserId||!claims.session_id||!Number.isFinite(claims.exp)||Number(claims.exp)*1000<=Date.now()||device.length<20||device.length>200)throw Error('La identidad autenticada no es válida.');
 const r=await fetchSupabase(new URL('/rest/v1/rpc/security_register_login',c.url),{method:'POST',headers:{apikey:key,Authorization:`Bearer ${key}`,'Content-Type':'application/json'},body:JSON.stringify({p_auth_user_id:authUserId,p_auth_session_id:claims.session_id,p_session_token_hash:hash(token),p_device_token_hash:hash(device),p_device_name:deviceName?.trim().slice(0,240)||'Navegador',p_expires_at:new Date(Number(claims.exp)*1000).toISOString(),p_ip_address:ipAddress})});
 const d=await r.json();if(!r.ok||!Number.isSafeInteger(d?.userId)||d.userId<=0)throw Object.assign(Error('El usuario no está aprovisionado correctamente o está inactivo, o el dispositivo fue revocado.'),{status:403});return d as{userId:number;expiresAt:string};
}
