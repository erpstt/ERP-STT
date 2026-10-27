import type { LoginDto } from '../dto/login.dto.js';
import { fetchSupabase, getSupabaseConfig } from '../../../core/database/supabase.client.js';

export interface AuthRepository {
  signIn(input: LoginDto, ipAddress?: string | null): Promise<{ accessToken: string; user: { name: string; email: string } }>;
}

export class SupabaseAuthRepository implements AuthRepository {
  async signIn(input: LoginDto, ipAddress: string | null = null) {
    const config = getSupabaseConfig();
    if (!config) throw new Error('La autenticación con Supabase no está configurada.');

    const response = await fetchSupabase(new URL('/auth/v1/token?grant_type=password', config.url), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: config.anonKey },
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
    const revokeAuthSession=()=>fetchSupabase(new URL('/auth/v1/logout?scope=global',config.url),{method:'POST',headers:{apikey:config.anonKey,Authorization:`Bearer ${accessToken}`}}).catch(()=>undefined);
    if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(authUserId)){
      await revokeAuthSession();
      throw new Error('No fue posible validar la identidad del usuario en el ERP. Contacte al administrador.');
    }
    let erpUserId:number;
    try{
      const profileResponse=await fetchSupabase(new URL('/rest/v1/rpc/app_user_id',config.url),{
        method:'POST',
        headers:{apikey:config.anonKey,Authorization:`Bearer ${accessToken}`,'Content-Type':'application/json'},
        body:'{}'
      });
      const profileText=await profileResponse.text();
      const profileValue:unknown=profileText?JSON.parse(profileText):null;
      if(!profileResponse.ok||!Number.isSafeInteger(Number(profileValue))||Number(profileValue)<=0)throw new Error('Invalid ERP profile response.');
      erpUserId=Number(profileValue);
    }catch{
      await revokeAuthSession();
      throw new Error('El usuario no está aprovisionado correctamente o se encuentra inactivo en el ERP. Contacte al administrador.');
    }
    const request=async<T>(path:string,init:RequestInit={}):Promise<T>=>{const result=await fetchSupabase(new URL(`/rest/v1/${path}`,config.url),{...init,headers:{apikey:config.anonKey,Authorization:`Bearer ${accessToken}`,'Content-Type':'application/json',...(init.headers??{})}});const text=await result.text();const value:unknown=text?JSON.parse(text):null;if(!result.ok)throw new Error(typeof value==='object'&&value&&'message'in value?String(value.message):'No fue posible registrar el usuario en el ERP.');return value as T;};
    const passwordHistory=await request<Array<{history_id:number}>>(`password_history?select=history_id&user_id=eq.${erpUserId}&limit=1`);
    if(!passwordHistory.length){const{hashPassword}=await import('../../../shared/services/password.service.js');await request('password_history',{method:'POST',headers:{Prefer:'return=minimal'},body:JSON.stringify({user_id:erpUserId,password_hash:await hashPassword(input.password)})});}
    const { registerDevice } = await import('../services/device.service.js');
    await registerDevice(`Bearer ${accessToken}`, erpUserId, input.deviceToken, input.deviceName);
    const { registerSession } = await import('../services/session.service.js');
    await registerSession(`Bearer ${accessToken}`, erpUserId, ipAddress);
    return {
      accessToken,
      user: { name: email.split('@')[0], email }
    };
  }
}
