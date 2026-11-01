import{accessAdminRpc}from'../security-catalogs/access-admin.service.js';
export const transactionTypeRpc=(auth:string,name:string,payload:Record<string,unknown>={})=>accessAdminRpc(auth,name,payload);
