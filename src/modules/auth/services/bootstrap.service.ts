import { fetchSupabase, getSupabaseConfig } from '../../../core/database/supabase.client.js';
import { invalidateRoleAccessCaches, roleAccessModules } from '../../security-catalogs/role-access-matrix.module.js';
import { invalidateOrganizationSubsidiarySummaryCache } from '../../organization-catalogs/organization-catalogs.module.js';

interface BootstrapInput {
  preferredRoleId?: unknown;
  preferredSubsidiaryId?: unknown;
}

interface BootstrapGrant {
  resourceKey: string;
  canView: boolean;
  canCreate: boolean;
  canEdit: boolean;
  canDelete: boolean;
}

interface BootstrapPayload {
  bootstrapVersion: 1;
  user: { name: string; email: string };
  locale: 'es' | 'en' | 'pt';
  languages: Array<{ languageId: number; code: string; isoCode: string; locale: string; name: string }>;
  roles: Array<{ roleId: number; name: string; description: string }>;
  activeRole: { roleId: number; name: string; description: string } | null;
  roleAccess: { isAdmin: boolean; grants: BootstrapGrant[] };
  companies: Array<{ subsidiaryId: number; name: string; legalName: string; logoUrl: null; currencyCode: string }>;
  activeCompany: { subsidiaryId: number; name: string; legalName: string; logoUrl: string | null; currencyCode: string; allowedCurrencyIds: number[] } | null;
  requiresCompanySelection: boolean;
}

function optionalId(value: unknown, label: string) {
  if (value === undefined || value === null || value === '') return null;
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id <= 0) throw new Error(`${label} no es válido.`);
  return id;
}

function errorMessage(payload: unknown) {
  return typeof payload === 'object' && payload !== null && 'message' in payload
    ? String((payload as { message?: unknown }).message ?? 'No fue posible preparar la sesión.')
    : 'No fue posible preparar la sesión.';
}

export async function bootstrapSession(authorization: string, input: BootstrapInput = {}) {
  const config = getSupabaseConfig();
  if (!config) throw new Error('Supabase no está configurado.');
  const preferredRoleId = optionalId(input.preferredRoleId, 'El rol preferido');
  const preferredSubsidiaryId = optionalId(input.preferredSubsidiaryId, 'La empresa preferida');
  const response = await fetchSupabase(new URL('/rest/v1/rpc/auth_bootstrap_context', config.url), {
    method: 'POST',
    headers: {
      apikey: config.anonKey,
      Authorization: authorization,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      p_preferred_role_id: preferredRoleId,
      p_preferred_subsidiary_id: preferredSubsidiaryId,
    }),
  });
  const text = await response.text();
  let payload: unknown;
  try { payload = text ? JSON.parse(text) : null; }
  catch { throw new Error('Supabase devolvió una respuesta inválida al preparar la sesión.'); }
  if (!response.ok) {
    const failure = new Error(errorMessage(payload)) as Error & { status?: number };
    failure.status = response.status;
    throw failure;
  }
  if (!payload || typeof payload !== 'object') throw new Error('Supabase no devolvió el contexto de sesión esperado.');
  const value = payload as BootstrapPayload;
  if (value.bootstrapVersion !== 1) throw new Error('Supabase devolvió una versión de contexto de sesión no compatible.');
  // La RPC puede seleccionar un rol o una empresa distintos para esta sesión.
  // Se invalida solo el resumen de esta sesión; las autorizaciones positivas
  // se limpian para impedir que sobrevivan a un cambio de rol.
  invalidateRoleAccessCaches(authorization);
  invalidateOrganizationSubsidiarySummaryCache(authorization);
  return {
    ...value,
    roleAccess: {
      isAdmin: Boolean(value.roleAccess?.isAdmin),
      grants: Array.isArray(value.roleAccess?.grants) ? value.roleAccess.grants : [],
      modules: roleAccessModules,
    },
  };
}
