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
    return {
      accessToken: String(payload.access_token),
      user: { name: String(user.email).split('@')[0], email: String(user.email) }
    };
  }
}
