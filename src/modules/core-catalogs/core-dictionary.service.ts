import{accessAdminRpc}from'../security-catalogs/access-admin.service.js';
export const coreDictionaries=new Set(['countries','currencies']);
export const coreDictionaryRpc=(auth:string,name:string,payload:Record<string,unknown>={})=>accessAdminRpc(auth,name,payload);
