export interface TenantContext {
  id: string;
  name: string;
  country: string;
  currency: string;
}

export const defaultTenant: TenantContext = {
  id: 'demo-tenant',
  name: 'Gentia Demo',
  country: 'Costa Rica',
  currency: 'CRC'
};
