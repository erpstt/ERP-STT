import { getSupabaseConfig } from '../../../core/database/supabase.client.js';

import { consultarTasasBCCR, fechaCostaRica } from './bccr-sdde.client.js';

type CurrencyRow={currency_id:number;currency_code:string};

/** Consulta la venta oficial del BCCR en CRC por USD para la fecha solicitada. */
export async function obtenerTipoDeCambioCR(monedaOrigen='USD',monedaDestino='CRC',fechaEfectiva?:Date|string){
  const from=monedaOrigen.trim().toUpperCase(),to=monedaDestino.trim().toUpperCase();
  const date=fechaCostaRica(fechaEfectiva);
  if(!['USD','CRC'].includes(from)||!['USD','CRC'].includes(to))throw new Error('La consulta de Costa Rica admite USD y CRC.');
  if(from===to)return{monedaOrigen:from,monedaDestino:to,fechaEfectiva:date,tipoCambio:1,fuente:'Banco Central de Costa Rica'};
  const {compra,venta}=await consultarTasasBCCR(date);
  return{monedaOrigen:from,monedaDestino:to,fechaEfectiva:date,tipoCambio:from==='USD'?venta:1/venta,tasaCompra:compra,tasaVenta:venta,fuente:'Banco Central de Costa Rica'};
}

async function rest<T>(path:string,authorization:string,init:RequestInit={}):Promise<T>{const config=getSupabaseConfig();if(!config)throw new Error('Supabase no está configurado.');const response=await fetch(new URL(`/rest/v1/${path}`,config.url),{...init,headers:{apikey:config.anonKey,Authorization:authorization,'Content-Type':'application/json',...(init.headers??{})}});const raw=await response.text();const payload:unknown=raw?JSON.parse(raw):null;if(!response.ok)throw new Error(typeof payload==='object'&&payload&&'message'in payload?String(payload.message):'No fue posible guardar el tipo de cambio.');return payload as T;}
async function currency(authorization:string,code:string){const rows=await rest<CurrencyRow[]>(`currencies?select=currency_id,currency_code&currency_code=eq.${encodeURIComponent(code)}&limit=1`,authorization);if(!rows[0])throw new Error(`La moneda ${code} no existe en el catálogo de Monedas.`);return rows[0];}
export async function consultarYGuardarTipoDeCambioCR(authorization:string,input:{monedaOrigen?:string;monedaDestino?:string;fechaEfectiva?:Date|string}){const origin=await currency(authorization,(input.monedaOrigen||'USD').trim().toUpperCase());const destination=await currency(authorization,(input.monedaDestino||'CRC').trim().toUpperCase());const rate=await obtenerTipoDeCambioCR(origin.currency_code,destination.currency_code,input.fechaEfectiva);if(origin.currency_id===destination.currency_id)return{...rate,guardado:false};const rows=await rest<Array<Record<string,unknown>>>('exchange_rates?on_conflict=from_currency_id,to_currency_id,effective_date',authorization,{method:'POST',headers:{Prefer:'resolution=merge-duplicates,return=representation'},body:JSON.stringify({from_currency_id:origin.currency_id,to_currency_id:destination.currency_id,effective_date:rate.fechaEfectiva,spot_rate:rate.tipoCambio})});return{...rate,guardado:true,registro:rows[0]};}

export async function consultarYGuardarTipoDeCambioCRAutomatico(fechaEfectiva?:Date|string){const serviceKey=process.env.SUPABASE_SERVICE_ROLE_KEY;if(!serviceKey)throw new Error('SUPABASE_SERVICE_ROLE_KEY no está configurada para la automatización.');const authorization=`Bearer ${serviceKey}`;const[origin,destination]=await Promise.all([currency(authorization,'USD'),currency(authorization,'CRC')]);const rate=await obtenerTipoDeCambioCR('USD','CRC',fechaEfectiva);const rows=await rest<Array<Record<string,unknown>>>('exchange_rates?on_conflict=from_currency_id,to_currency_id,effective_date',authorization,{method:'POST',headers:{apikey:serviceKey,Prefer:'resolution=merge-duplicates,return=representation'},body:JSON.stringify({from_currency_id:origin.currency_id,to_currency_id:destination.currency_id,effective_date:rate.fechaEfectiva,spot_rate:rate.tipoCambio})});return{...rate,guardado:true,registro:rows[0]};}
