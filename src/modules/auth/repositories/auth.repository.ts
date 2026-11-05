import{registerTrustedLogin}from'../services/trusted-session.service.js';
import type { LoginDto } from '../dto/login.dto.js';
import { fetchSupabase, getSupabaseConfig } from '../../../core/database/supabase.client.js';
import { withDeviceContext } from '../../../core/security/device-context.js';
import {issueSession,providerSession,type IssuedAuthSession} from '../services/session-credentials.js';

export interface AuthRepository {
  signIn(input: LoginDto, ipAddress?: string | null): Promise<IssuedAuthSession>;
}

export class SupabaseAuthRepository implements AuthRepository {
  async signIn(input: LoginDto, ipAddress: string | null = null) {
    return withDeviceContext(input.deviceToken, () => this.signInWithDevice(input, ipAddress));
  }

  private async signInWithDevice(input: LoginDto, ipAddress: string | null) {
    const config = getSupabaseConfig();
    if (!config) throw new Error('La autenticación con Supabase no está configurada.');

    const serviceKey=process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();if(!serviceKey)throw Object.assign(Error('El registro seguro de sesiones no esta configurado.'),{status:503});
    const response = await fetchSupabase(new URL('/auth/v1/token?grant_type=password', config.url), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: serviceKey, Authorization:`Bearer ${serviceKey}` },
      body: JSON.stringify({ email: input.email, password: input.password })
    });
    const payload: unknown = await response.json();
    if (!response.ok) {
      const message = typeof payload === 'object' && payload !== null
        ? String(('message' in payload && payload.message) || ('error_description' in payload && payload.error_description) || ('msg' in payload && payload.msg) || 'No fue posible iniciar sesión.')
        : 'No fue posible iniciar sesión.';
      throw new Error(message === 'Email not confirmed'
        ? 'Confirma tu correo electrónico antes de iniciar sesión.'
        : message);
    }
    if (typeof payload !== 'object' || payload === null || !('access_token' in payload) || !('user' in payload)) {
      throw new Error('Supabase devolvió una respuesta de autenticación inválida.');
    }
    const user = payload.user;
    if (typeof user !== 'object' || user === null || !('email' in user)) throw new Error('No fue posible obtener el usuario autenticado.');
    const accessToken=String(payload.access_token);
    const email=String(user.email);
    const authUserId='id'in user&&typeof user.id==='string'?user.id:'';
    const revokeAuthSession=()=>fetchSupabase(new URL('/auth/v1/logout?scope=local',config.url),{method:'POST',headers:{apikey:config.anonKey,Authorization:`Bearer ${accessToken}`}}).catch(()=>undefined);
    if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(authUserId)){
      await revokeAuthSession();
      throw new Error('No fue posible validar la identidad del usuario en el ERP. Contacte al administrador.');
    }
    let freshSession:ReturnType<typeof providerSession>;
    try{freshSession=providerSession(payload);}catch(cause){await revokeAuthSession();throw cause;}
    let erpUserId:number;let erpExpiresAt:string;
    try{
      const registered=await registerTrustedLogin(accessToken,authUserId,input.deviceToken,input.deviceName,ipAddress);erpUserId=registered.userId;erpExpiresAt=registered.expiresAt;
    }catch{
      await revokeAuthSession();
      throw new Error('El usuario no está aprovisionado correctamente o se encuentra inactivo en el ERP. Contacte al administrador.');
    }
    const request=async<T>(path:string,init:RequestInit={}):Promise<T>=>{const result=await fetchSupabase(new URL(`/rest/v1/${path}`,config.url),{...init,headers:{apikey:config.anonKey,Authorization:`Bearer ${accessToken}`,'Content-Type':'application/json',...(init.headers??{})}});const text=await result.text();const value:unknown=text?JSON.parse(text):null;if(!result.ok)throw new Error(typeof value==='object'&&value&&'message'in value?String(value.message):'No fue posible registrar el usuario en el ERP.');return value as T;};
    try {
      const passwordHistory=await request<Array<{history_id:number}>>(`password_history?select=history_id&user_id=eq.${erpUserId}&limit=1`);
      if(!passwordHistory.length){const{hashPassword}=await import('../../../shared/services/password.service.js');await request('password_history',{method:'POST',headers:{Prefer:'return=minimal'},body:JSON.stringify({user_id:erpUserId,password_hash:await hashPassword(input.password)})});}
    } catch (cause) {
      await revokeAuthSession();
      throw cause;
    }
    try{return issueSession(accessToken,{name:email.split('@')[0]!,email},erpExpiresAt,freshSession.refreshToken,input.deviceToken!.trim(),input.rememberMe===true);}
    catch(cause){await revokeAuthSession();throw cause;}
  }
}
