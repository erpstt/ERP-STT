import { getSupabaseConfig } from '../../core/database/supabase.client.js';

export interface Country { id: number; name: string; }

async function request<T>(path: string, accessToken: string, init: RequestInit = {}): Promise<T> {
  const config = getSupabaseConfig();
  if (!config) throw new Error('La conexión con Supabase no está configurada.');
  const response = await fetch(new URL(path, config.url), {
    ...init,
    headers: { apikey: config.anonKey, Authorization: accessToken, 'Content-Type': 'application/json', ...(init.headers ?? {}) }
  });
  const payload: unknown = response.status === 204 ? null : await response.json();
  if (!response.ok) {
    const message = typeof payload === 'object' && payload !== null && 'message' in payload ? String(payload.message) : 'No fue posible guardar el país.';
    throw new Error(message);
  }
  return payload as T;
}

function toCountry(value: unknown): Country {
  if (typeof value !== 'object' || value === null || !('id' in value) || !('name' in value)) throw new Error('Supabase devolvió un país inválido.');
  return { id: Number(value.id), name: String(value.name) };
}

export async function listCountries(accessToken: string): Promise<Country[]> {
  const data = await request<unknown[]>('/rest/v1/countries?select=id,name&order=name.asc', accessToken);
  return data.map(toCountry);
}

export async function createCountry(accessToken: string, name: string): Promise<Country> {
  const data = await request<unknown[]>('/rest/v1/countries', accessToken, { method: 'POST', headers: { Prefer: 'return=representation' }, body: JSON.stringify({ name }) });
  return toCountry(data[0]);
}

export async function updateCountry(accessToken: string, id: number, name: string): Promise<Country> {
  const data = await request<unknown[]>(`/rest/v1/countries?id=eq.${id}`, accessToken, { method: 'PATCH', headers: { Prefer: 'return=representation' }, body: JSON.stringify({ name }) });
  return toCountry(data[0]);
}

export async function deleteCountry(accessToken: string, id: number): Promise<void> {
  await request<null>(`/rest/v1/countries?id=eq.${id}`, accessToken, { method: 'DELETE' });
}
