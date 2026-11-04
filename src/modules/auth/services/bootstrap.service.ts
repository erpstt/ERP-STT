import { fetchSupabase, getSupabaseConfig } from '../../../core/database/supabase.client.js';
import { primeRoleAccessCache } from '../../security-catalogs/role-access-matrix.module.js';
import { invalidateOrganizationSubsidiarySummaryCache } from '../../organization-catalogs/organization-catalogs.module.js';
import { invalidateAccountingReportOptionsCache } from '../../reports/accounting-reports.service.js';
import { invalidateOperationalReadCaches } from '../../../core/performance/operational-read-cache.js';

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

function bootstrapFailureMessage(status: number) {
  if (status === 401) return 'La sesión no es válida. Inicie sesión nuevamente.';
  if (status === 403) return 'No tiene acceso al rol o a la empresa seleccionados.';
  if (status === 429) return 'Espere un momento antes de volver a preparar la sesión.';
  if ([400, 409, 422].includes(status)) return 'No fue posible seleccionar el rol o la empresa. Revise su acceso e inténtelo nuevamente.';
  return 'No fue posible preparar la sesión. Inténtelo nuevamente.';
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
  if (!response.ok) {
    const failure = new Error(bootstrapFailureMessage(response.status)) as Error & { status?: number };
    failure.status = response.status;
    throw failure;
  }
  let payload: unknown;
  try { payload = text ? JSON.parse(text) : null; }
  catch { throw new Error('Supabase devolvió una respuesta inválida al preparar la sesión.'); }
  if (!payload || typeof payload !== 'object') throw new Error('Supabase no devolvió el contexto de sesión esperado.');
  const value = payload as BootstrapPayload;
  if (value.bootstrapVersion !== 1) throw new Error('Supabase devolvió una versión de contexto de sesión no compatible.');
  // La RPC puede seleccionar un rol o una empresa distintos para esta sesión.
  // Se invalida solo el resumen de esta sesión; las autorizaciones positivas
  // se limpian para impedir que sobrevivan a un cambio de rol.
  const roleAccess = await primeRoleAccessCache(authorization, {
    isAdmin: value.roleAccess?.isAdmin === true,
    grants: Array.isArray(value.roleAccess?.grants) ? value.roleAccess.grants : [],
  });
  invalidateOrganizationSubsidiarySummaryCache(authorization);
  invalidateAccountingReportOptionsCache(authorization);
  invalidateOperationalReadCaches(authorization);
  return {
    ...value,
    roleAccess,
  };
}
