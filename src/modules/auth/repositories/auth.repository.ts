import type { LoginDto } from '../dto/login.dto.js';
import { getSupabaseConfig } from '../../../core/database/supabase.client.js';

export interface AuthRepository {
  signIn(input: LoginDto): Promise<{ accessToken: string; user: { name: string; email: string } }>;
}

export class SupabaseAuthRepository implements AuthRepository {
  async signIn(input: LoginDto) {
    const config = getSupabaseConfig();
    if (!config) throw new Error('La autenticación con Supabase no está configurada.');

    const response = await fetch(new URL('/auth/v1/token?grant_type=password', config.url), {
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
    const authId='id' in user?String(user.id):email;
    const metadata='user_metadata' in user&&typeof user.user_metadata==='object'&&user.user_metadata!==null?user.user_metadata as Record<string,unknown>:{};
    const request=async<T>(path:string,init:RequestInit={}):Promise<T>=>{const result=await fetch(new URL(`/rest/v1/${path}`,config.url),{...init,headers:{apikey:config.anonKey,Authorization:`Bearer ${accessToken}`,'Content-Type':'application/json',...(init.headers??{})}});const text=await result.text();const value:unknown=text?JSON.parse(text):null;if(!result.ok)throw new Error(typeof value==='object'&&value&&'message'in value?String(value.message):'No fue posible registrar el usuario en el ERP.');return value as T;};
    let erpUsers=await request<Array<{user_id:number}>>(`users?select=user_id&email=eq.${encodeURIComponent(email)}&limit=1`);
    if(!erpUsers.length){const firstName=String(metadata.first_name??metadata.full_name??email.split('@')[0]);const inserted=await request<Array<{user_id:number}>>('users',{method:'POST',headers:{Prefer:'return=representation'},body:JSON.stringify({email,password_hash:`auth:${authId}`,first_name:firstName,last_name:String(metadata.last_name??''),is_active:true})});erpUsers=inserted;}
    const erpUserId=erpUsers[0].user_id;
    const links=await request<Array<{id:number}>>(`user_subsidiaries?select=id&user_id=eq.${erpUserId}&limit=1`);
    if(!links.length&&email.toLowerCase()==='demo@nexo.com'){const companies=await request<Array<{subsidiary_id:number}>>('subsidiaries?select=subsidiary_id&is_active=eq.true');if(companies.length)await request('user_subsidiaries',{method:'POST',body:JSON.stringify(companies.map(company=>({user_id:erpUserId,subsidiary_id:company.subsidiary_id})))});}
    return {
      accessToken,
      user: { name: email.split('@')[0], email }
    };
  }
}
