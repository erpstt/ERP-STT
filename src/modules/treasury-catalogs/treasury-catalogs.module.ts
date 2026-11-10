import {collectCatalogPages,type CatalogResponseObserver} from '../../core/database/collect-catalog-pages.js';
import{requireExpenseCashAccess,expenseCashDbError}from'../security-catalogs/expense-cash-access.service.js';
import { fetchSupabase, getSupabaseConfig } from '../../core/database/supabase.client.js';

export interface TreasuryField { key:string; label:string; type:'text'|'number'|'date'; required?:boolean; reference?:string; }
export interface TreasuryCatalog { slug:string; table:string; title:string; description:string; primaryKey:string; fields:TreasuryField[]; }

export const treasuryCatalogs: TreasuryCatalog[] = [
  {slug:'cashboxes',table:'cashbox',title:'Cajas',description:'Cajas chicas y cajas físicas',primaryKey:'cashbox_id',fields:[{key:'cashbox_name',label:'Caja',type:'text',required:true},{key:'subsidiary_id',label:'Subsidiaria',type:'number',required:true,reference:'organization/subsidiaries'},{key:'location_id',label:'Ubicación',type:'number',required:true,reference:'organization/locations'},{key:'currency_id',label:'Moneda',type:'number',required:true,reference:'core/currencies'},{key:'account_id',label:'Cuenta contable',type:'number',required:true,reference:'accounting/chart-accounts'}]},
  {slug:'cash-transactions',table:'cash_transaction',title:'Movimientos de caja',description:'Movimientos de caja chica',primaryKey:'cash_tran_id',fields:[{key:'tran_date',label:'Fecha',type:'date',required:true},{key:'cashbox_id',label:'Caja',type:'number',required:true,reference:'treasury/cashboxes'},{key:'transaction_id',label:'Transacción',type:'number',reference:'transaction-engine/transactions'},{key:'amount',label:'Monto',type:'number',required:true},{key:'type',label:'Tipo',type:'text',required:true},{key:'concept',label:'Concepto',type:'text',required:true}]},
  {slug:'cash-openings',table:'cash_opening',title:'Aperturas de caja',description:'Aperturas de caja',primaryKey:'opening_id',fields:[{key:'opening_date',label:'Fecha de apertura',type:'date',required:true},{key:'cashbox_id',label:'Caja',type:'number',required:true,reference:'treasury/cashboxes'},{key:'user_id',label:'Usuario',type:'number',required:true,reference:'security/users'},{key:'initial_amount',label:'Monto inicial',type:'number',required:true}]},
  {slug:'cash-closings',table:'cash_closing',title:'Cierres y arqueos',description:'Cierres y arqueos de caja',primaryKey:'closing_id',fields:[{key:'closing_date',label:'Fecha de cierre',type:'date',required:true},{key:'cashbox_id',label:'Caja',type:'number',required:true,reference:'treasury/cashboxes'},{key:'user_id',label:'Usuario',type:'number',required:true,reference:'security/users'},{key:'final_amount',label:'Monto final',type:'number',required:true},{key:'difference',label:'Diferencia',type:'number',required:true}]},
  {slug:'cash-transfers',table:'cash_transfer',title:'Transferencias entre cajas',description:'Transferencias entre cajas',primaryKey:'transfer_id',fields:[{key:'transfer_date',label:'Fecha',type:'date',required:true},{key:'amount',label:'Monto',type:'number',required:true},{key:'from_cashbox_id',label:'Caja origen',type:'number',required:true,reference:'treasury/cashboxes'},{key:'to_cashbox_id',label:'Caja destino',type:'number',required:true,reference:'treasury/cashboxes'}]},
];

export function getTreasuryCatalog(slug:string) { const catalog=treasuryCatalogs.find(item=>item.slug===slug); if(!catalog) throw new Error('El catálogo de Tesorería no existe.'); return catalog; }

function sanitize(catalog:TreasuryCatalog,input:Record<string,unknown>) {
  const data=Object.fromEntries(catalog.fields.map(field=>{
    const raw=input[field.key];
    if(field.required&&(raw===undefined||raw===null||String(raw).trim()==='')) throw new Error(`${field.label} es obligatorio.`);
    if(field.type==='number') return [field.key,raw===undefined||raw===null||raw===''?null:Number(raw)];
    return [field.key,raw===undefined||raw===null||String(raw).trim()===''?null:String(raw).trim()];
  }));
  if(catalog.slug==='cash-transfers'&&data.from_cashbox_id===data.to_cashbox_id) throw new Error('Las cajas de origen y destino deben ser diferentes.');
  return data;
}

async function request<T>(catalog:TreasuryCatalog,token:string,query='',init:RequestInit={},onResponse?:CatalogResponseObserver):Promise<T>{
  const config=getSupabaseConfig(); if(!config) throw new Error('Supabase no está configurado.');
  const response=await fetchSupabase(new URL(`/rest/v1/${catalog.table}${query}`,config.url),{...init,headers:{apikey:config.anonKey,Authorization:token,'Content-Type':'application/json',...(init.headers??{})}});onResponse?.(response);
  const text=response.status===204?'':await response.text(); const payload:unknown=text?JSON.parse(text):null;
  if(!response.ok)expenseCashDbError(response.status,payload);
  return payload as T;
}

export async function listTreasuryRows(catalog:TreasuryCatalog,token:string){await requireExpenseCashAccess(token,'treasury:'+catalog.slug,'view');return collectCatalogPages(catalog.primaryKey,`?select=*&order=${catalog.primaryKey}.asc`,(page,init,onResponse)=>request<Record<string,unknown>[]>(catalog,token,page,init,onResponse));}
export async function createTreasuryRow(catalog:TreasuryCatalog,token:string,input:Record<string,unknown>){await requireExpenseCashAccess(token,'treasury:'+catalog.slug,'create');const rows=await request<Record<string,unknown>[]>(catalog,token,'',{method:'POST',headers:{Prefer:'return=representation'},body:JSON.stringify(sanitize(catalog,input))});return rows[0];}
export async function updateTreasuryRow(catalog:TreasuryCatalog,token:string,id:number,input:Record<string,unknown>){await requireExpenseCashAccess(token,'treasury:'+catalog.slug,'edit');const rows=await request<Record<string,unknown>[]>(catalog,token,`?${catalog.primaryKey}=eq.${id}`,{method:'PATCH',headers:{Prefer:'return=representation'},body:JSON.stringify(sanitize(catalog,input))});return rows[0];}
export async function deleteTreasuryRow(catalog:TreasuryCatalog,token:string,id:number){await requireExpenseCashAccess(token,'treasury:'+catalog.slug,'delete');return request<null>(catalog,token,`?${catalog.primaryKey}=eq.${id}`,{method:'DELETE'});}
