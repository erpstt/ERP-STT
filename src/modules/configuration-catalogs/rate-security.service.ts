import{accessAdminRpc}from'../security-catalogs/access-admin.service.js';
export const rateCatalogs=new Set(['exchange-rates','consolidated-exchange-rates']);
export const rateRpc=(auth:string,name:string,payload:Record<string,unknown>={})=>accessAdminRpc(auth,name,payload);
export async function saveFetchedRate(auth:string,key:string|undefined,from:number,to:number,date:string,rate:number){
 if(key)return rateRpc(auth,'ingest_official_exchange_rate',{p_from:from,p_to:to,p_date:date,p_rate:rate});
 const c=await rateRpc(auth,'exchange_rate_source_context',{p_from:from,p_to:to,p_date:date});return rateRpc(auth,'save_exchange_rate',{p_catalog:'exchange-rates',p_id:c.id??null,p_payload:{from_currency_id:from,to_currency_id:to,effective_date:date,spot_rate:rate,_revision:c.revision??null}});
}
export async function assertRateSource(auth:string,code:string){const a=await rateRpc(auth,'exchange_rate_access',{p_catalog:'exchange-rates'});if(!Array.isArray(a.sourceCurrencies)||!a.sourceCurrencies.includes(code))throw Object.assign(Error('Requiere permiso explícito y acceso a las empresas afectadas por la tasa.'),{status:403});}
