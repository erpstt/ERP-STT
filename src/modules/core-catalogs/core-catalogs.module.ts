import { getSupabaseConfig } from '../../core/database/supabase.client.js';

type FieldType = 'text' | 'number' | 'boolean';
export interface CatalogField { key: string; label: string; type: FieldType; required?: boolean; }
export interface CatalogDefinition { slug: string; table: string; title: string; description: string; primaryKey: string; fields: CatalogField[]; }

export const coreCatalogs: CatalogDefinition[] = [
  { slug: 'countries', table: 'countries', title: 'Países', description: 'Catálogo de países del sistema', primaryKey: 'country_id', fields: [{key:'country_code_iso2',label:'Código ISO 2',type:'text'},{key:'country_code_iso3',label:'Código ISO 3',type:'text'},{key:'name',label:'Nombre',type:'text',required:true},{key:'phone_code',label:'Código telefónico',type:'text'}] },
  { slug: 'languages', table: 'languages', title: 'Idiomas', description: 'Idiomas soportados por la plataforma', primaryKey: 'language_id', fields: [{key:'code',label:'Código',type:'text',required:true},{key:'iso_code',label:'Código ISO',type:'text',required:true},{key:'name',label:'Nombre',type:'text',required:true},{key:'is_active',label:'Activo',type:'boolean'}] },
  { slug: 'timezones', table: 'timezones', title: 'Zonas horarias', description: 'Zonas horarias configurables', primaryKey: 'timezone_id', fields: [{key:'name',label:'Nombre',type:'text',required:true},{key:'utc_offset',label:'Diferencia UTC',type:'text',required:true},{key:'is_active',label:'Activo',type:'boolean'}] },
  { slug: 'currencies', table: 'currencies', title: 'Monedas', description: 'Catálogo maestro de monedas', primaryKey: 'currency_id', fields: [{key:'currency_code',label:'Código',type:'text',required:true},{key:'name',label:'Nombre',type:'text',required:true},{key:'symbol',label:'Símbolo',type:'text',required:true},{key:'fx_rate_precision',label:'Precisión cambiaria',type:'number',required:true}] },
  { slug: 'status', table: 'status', title: 'Estados', description: 'Estados maestros del sistema', primaryKey: 'status_id', fields: [{key:'code',label:'Código',type:'text',required:true},{key:'name',label:'Nombre',type:'text',required:true},{key:'module',label:'Módulo',type:'text',required:true},{key:'description',label:'Descripción',type:'text'}] },
  { slug: 'number-sequences', table: 'number_sequences', title: 'Secuencias numéricas', description: 'Secuencias numéricas autonumerables', primaryKey: 'sequence_id', fields: [{key:'prefix',label:'Prefijo',type:'text'},{key:'suffix',label:'Sufijo',type:'text'},{key:'current_number',label:'Número actual',type:'number',required:true},{key:'padding_length',label:'Longitud',type:'number',required:true}] },
  { slug: 'transaction-types', table: 'transaction_types', title: 'Tipos de transacción', description: 'Tipos de transacciones del motor ERP', primaryKey: 'transaction_type_id', fields: [{key:'code',label:'Código',type:'text',required:true},{key:'name',label:'Nombre',type:'text',required:true},{key:'module_category',label:'Categoría de módulo',type:'text',required:true}] },
  { slug: 'parameters', table: 'parameters', title: 'Parámetros', description: 'Parámetros globales del sistema', primaryKey: 'parameter_id', fields: [{key:'parameter_key',label:'Clave',type:'text',required:true},{key:'parameter_value',label:'Valor',type:'text'},{key:'description',label:'Descripción',type:'text'}] },
  { slug: 'settings', table: 'settings', title: 'Configuraciones', description: 'Configuraciones del sistema', primaryKey: 'setting_id', fields: [{key:'setting_key',label:'Clave',type:'text',required:true},{key:'setting_value',label:'Valor',type:'text'},{key:'scope',label:'Alcance',type:'text',required:true}] }
];

export function getCoreCatalog(slug: string): CatalogDefinition {
  const catalog = coreCatalogs.find(item => item.slug === slug);
  if (!catalog) throw new Error('El catálogo solicitado no existe.');
  return catalog;
}

function sanitize(catalog: CatalogDefinition, input: Record<string, unknown>) {
  return Object.fromEntries(catalog.fields.map(field => {
    const raw = input[field.key];
    if (field.required && (raw === undefined || raw === null || String(raw).trim() === '')) throw new Error(`${field.label} es obligatorio.`);
    if (field.type === 'boolean') return [field.key, raw === true || raw === 'true'];
    if (field.type === 'number') return [field.key, Number(raw ?? 0)];
    return [field.key, raw === undefined || raw === null || String(raw).trim() === '' ? null : String(raw).trim()];
  }));
}

async function request<T>(catalog: CatalogDefinition, accessToken: string, query = '', init: RequestInit = {}): Promise<T> {
  const config = getSupabaseConfig();
  if (!config) throw new Error('La conexión con Supabase no está configurada.');
  const response = await fetch(new URL(`/rest/v1/${catalog.table}${query}`, config.url), { ...init, headers: { apikey: config.anonKey, Authorization: accessToken, 'Content-Type': 'application/json', ...(init.headers ?? {}) } });
  const payload: unknown = response.status === 204 ? null : await response.json();
  if (!response.ok) { const message = typeof payload === 'object' && payload !== null && 'message' in payload ? String(payload.message) : 'No fue posible completar la operación.'; throw new Error(message); }
  return payload as T;
}

export const listCatalogRows = (catalog: CatalogDefinition, token: string) => request<Record<string, unknown>[]>(catalog, token, `?select=*&order=${catalog.primaryKey}.asc`);
export async function createCatalogRow(catalog: CatalogDefinition, token: string, input: Record<string, unknown>) { const rows = await request<Record<string, unknown>[]>(catalog, token, '', { method:'POST', headers:{Prefer:'return=representation'}, body:JSON.stringify(sanitize(catalog,input)) }); return rows[0]; }
export async function updateCatalogRow(catalog: CatalogDefinition, token: string, id: number, input: Record<string, unknown>) { const rows = await request<Record<string, unknown>[]>(catalog, token, `?${catalog.primaryKey}=eq.${id}`, { method:'PATCH', headers:{Prefer:'return=representation'}, body:JSON.stringify(sanitize(catalog,input)) }); return rows[0]; }
export const deleteCatalogRow = (catalog: CatalogDefinition, token: string, id: number) => request<null>(catalog, token, `?${catalog.primaryKey}=eq.${id}`, { method:'DELETE' });
