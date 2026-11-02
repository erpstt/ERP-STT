import{accessAdminRpc}from'../security-catalogs/access-admin.service.js';
export const globalConfigurations=new Set(['parameters','settings']);
export const globalConfigurationRpc=(auth:string,name:string,payload:Record<string,unknown>={})=>accessAdminRpc(auth,name,payload);
