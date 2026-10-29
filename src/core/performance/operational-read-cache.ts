import { createHash } from 'node:crypto';
import { invalidateReadCacheNamespace } from './scoped-read-cache.js';

export const OPERATIONAL_READ_CACHE_TTL_MS = 90_000;

const operationalNamespaces = new Set<string>([
  'reports-accounting-options',
  'organization-subsidiaries-summary',
  'catalog-sales-invoices',
  'catalog-purchasing-supplier-invoices',
  'catalog-banking-bank-accounts',
  'catalog-banking-bank-statements',
  'catalog-fixed-assets-assets',
  'catalog-fixed-assets-asset-categories',
  'entities-customers-list',
  'organization-departments-list',
  'organization-cost-centers-list',
]);

function identityClaims(authorization: string) {
  const raw = authorization.replace(/^Bearer\s+/, '');
  const part = raw.split('.')[1];
  if (!part) return null;
  try { return JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) as Record<string, unknown>; }
  catch { return null; }
}

/** Scope shared by reads that depend on the active company and role. */
export function operationalSessionScope(authorization: string) {
  const identity = identityClaims(authorization);
  if (!identity) return [authorization] as const;
  const user = String(identity.sub ?? identity.email ?? 'unknown');
  return [user, String(identity.session_id ?? user)] as const;
}

/** Registers a namespace for invalidation whenever company or role changes. */
export function registerOperationalReadCacheNamespace(namespace: string) {
  operationalNamespaces.add(namespace);
  return namespace;
}

/** Stable 100%-115% TTL spread per session to avoid synchronized refreshes. */
export function operationalReadCacheTtlMs(
  scope: readonly (string | number | boolean | null | undefined)[],
  baseTtlMs = OPERATIONAL_READ_CACHE_TTL_MS,
) {
  const base = Math.max(1_000, Math.min(300_000, Math.trunc(baseTtlMs)));
  const digest = createHash('sha256').update(JSON.stringify(scope)).digest();
  const fraction = digest.readUInt16BE(0) / 65_535;
  return Math.min(300_000, Math.round(base * (1 + (fraction * 0.15))));
}

/** Invalidates only the affected session, or every session when omitted. */
export function invalidateOperationalReadCaches(authorization?: string) {
  const scope = authorization ? operationalSessionScope(authorization) : undefined;
  for (const namespace of operationalNamespaces) invalidateReadCacheNamespace(namespace, scope);
}
