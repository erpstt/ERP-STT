import { fetchSupabase, getSupabaseConfig } from '../../../core/database/supabase.client.js';

export type SupportedLocale = 'es' | 'en' | 'pt';

export interface LanguageOption {
  languageId: number;
  code: string;
  isoCode: string;
  locale: SupportedLocale;
  name: string;
}

export interface LanguagePreference extends Partial<LanguageOption> {
  locale: SupportedLocale;
  languages: LanguageOption[];
}

function errorMessage(payload: unknown, fallback: string) {
  return typeof payload === 'object' && payload !== null && 'message' in payload
    ? String((payload as { message?: unknown }).message ?? fallback)
    : fallback;
}

async function rpc<T>(authorization: string, name: string, input: Record<string, unknown> = {}): Promise<T> {
  const config = getSupabaseConfig();
  if (!config) throw new Error('Supabase no está configurado.');
  const response = await fetchSupabase(new URL(`/rest/v1/rpc/${name}`, config.url), {
    method: 'POST',
    headers: {
      apikey: config.anonKey,
      Authorization: authorization,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(input),
  });
  const text = await response.text();
  let payload: unknown = null;
  try { payload = text ? JSON.parse(text) : null; }
  catch { throw new Error('Supabase devolvió una respuesta inválida al consultar la preferencia de idioma.'); }
  if (!response.ok) throw new Error(errorMessage(payload, 'No fue posible actualizar la preferencia de idioma.'));
  return payload as T;
}

function normalizedLocale(value: unknown): SupportedLocale {
  const locale = String(value ?? '').trim().toLowerCase().split(/[-_]/)[0];
  if (locale === 'es' || locale === 'en' || locale === 'pt') return locale;
  throw new Error('Seleccione un idioma compatible: Español, Inglés o Portugués.');
}

export function getLanguagePreference(authorization: string) {
  return rpc<LanguagePreference>(authorization, 'user_language_preference');
}

export function setLanguagePreference(authorization: string, locale: unknown) {
  return rpc<LanguagePreference>(authorization, 'set_user_language_preference', {
    p_locale: normalizedLocale(locale),
  });
}

