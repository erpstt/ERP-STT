import { getSupabaseConfig } from '../../../core/database/supabase.client.js';

const BCRD_PAGE='https://www.bancentral.gov.do/SectorExterno/CertificacionTasas';
const BCRD_RATE='https://www.bancentral.gov.do/Home/GetExchangeRateBySingleDate';

type BcrdResponse={success:boolean;result?:{buyingValue:number;sellingValue:number;exchangeRateDate:string};error?:{message?:string}|null};
type CurrencyRow={currency_id:number;currency_code:string};

function effectiveDate(value?:Date|string){
 const date=value instanceof Date?value:new Date(value??Date.now());
 if(Number.isNaN(date.getTime()))throw new Error('La fecha efectiva no es válida.');
 return date.toISOString().slice(0,10);
}

/** Consulta la tasa oficial de compra publicada por el Banco Central de la República Dominicana. */
export async function obtenerTipoDeCambioRD(monedaOrigen='USD',monedaDestino='DOP',fechaEfectiva?:Date|string){
 const from=monedaOrigen.trim().toUpperCase();const to=monedaDestino.trim().toUpperCase();
 if(from===to)return{monedaOrigen:from,monedaDestino:to,fechaEfectiva:effectiveDate(fechaEfectiva),tipoCambio:1,fuente:'Banco Central de la República Dominicana'};
 if(!((from==='USD'&&to==='DOP')||(from==='DOP'&&to==='USD')))throw new Error('Por ahora la consulta de República Dominicana admite únicamente USD y DOP.');
 const date=effectiveDate(fechaEfectiva);const page=await fetch(BCRD_PAGE,{headers:{'User-Agent':'Nexo ERP/1.0'}});
 if(!page.ok)throw new Error('No fue posible iniciar la consulta con el Banco Central de la República Dominicana.');
 const cookieMap=new Map<string,string>();for(const item of page.headers.getSetCookie?.()??[]){const pair=item.split(';')[0];const separator=pair.indexOf('=');if(separator>0&&pair.slice(separator+1))cookieMap.set(pair.slice(0,separator),pair.slice(separator+1));}const cookie=[...cookieMap].map(([name,value])=>`${name}=${value}`).join('; ');
 const form=new URLSearchParams({fromDate:`${date}T00:00:00.000Z`});
 const response=await fetch(BCRD_RATE,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded; charset=UTF-8','X-Requested-With':'XMLHttpRequest',Referer:BCRD_PAGE,Cookie:cookie,'User-Agent':'Nexo ERP/1.0'},body:form});
 const raw=await response.text();if(!response.ok||!raw)throw new Error('El Banco Central no devolvió una tasa para la fecha solicitada.');
 const payload=JSON.parse(raw) as BcrdResponse;const buy=Number(payload.result?.buyingValue);
 if(!payload.success||!Number.isFinite(buy)||buy<=0)throw new Error(payload.error?.message||'No existe una tasa válida para la fecha solicitada.');
 return{monedaOrigen:from,monedaDestino:to,fechaEfectiva:date,tipoCambio:from==='USD'?buy:1/buy,tasaCompra:buy,tasaVenta:Number(payload.result?.sellingValue),fuente:'Banco Central de la República Dominicana'};
}

function claims(authorization:string){const part=authorization.replace(/^Bearer\s+/,'').split('.')[1];if(!part)throw new Error('La sesión no es válida.');return JSON.parse(Buffer.from(part,'base64url').toString('utf8')) as Record<string,unknown>;}
async function rest<T>(path:string,authorization:string,init:RequestInit={}):Promise<T>{const config=getSupabaseConfig();if(!config)throw new Error('Supabase no está configurado.');const response=await fetch(new URL(`/rest/v1/${path}`,config.url),{...init,headers:{apikey:config.anonKey,Authorization:authorization,'Content-Type':'application/json',...(init.headers??{})}});const raw=await response.text();const payload:unknown=raw?JSON.parse(raw):null;if(!response.ok)throw new Error(typeof payload==='object'&&payload&&'message'in payload?String(payload.message):'No fue posible guardar el tipo de cambio.');return payload as T;}

async function currency(authorization:string,code:string){const rows=await rest<CurrencyRow[]>(`currencies?select=currency_id,currency_code&currency_code=eq.${encodeURIComponent(code)}&limit=1`,authorization);if(!rows[0])throw new Error(`La moneda ${code} no existe en el catálogo de Monedas.`);return rows[0];}
async function localCurrency(authorization:string){const sessionId=String(claims(authorization).session_id??claims(authorization).sub??'');const sessions=await rest<Array<{subsidiary_id:number}>>(`user_company_sessions?select=subsidiary_id&session_id=eq.${encodeURIComponent(sessionId)}&limit=1`,authorization);if(!sessions[0])throw new Error('Debe seleccionar una empresa activa antes de consultar el tipo de cambio.');const subsidiaries=await rest<Array<{currency_id:number}>>(`subsidiaries?select=currency_id&subsidiary_id=eq.${sessions[0].subsidiary_id}&limit=1`,authorization);if(!subsidiaries[0])throw new Error('No fue posible determinar la moneda local de la empresa activa.');const currencies=await rest<CurrencyRow[]>(`currencies?select=currency_id,currency_code&currency_id=eq.${subsidiaries[0].currency_id}&limit=1`,authorization);if(!currencies[0])throw new Error('La moneda local de la empresa activa no está configurada.');return currencies[0];}

export async function consultarYGuardarTipoDeCambioRD(authorization:string,input:{monedaOrigen?:string;monedaDestino?:string;fechaEfectiva?:Date|string}){
 const origin=await currency(authorization,(input.monedaOrigen||'USD').trim().toUpperCase());const destination=input.monedaDestino?await currency(authorization,input.monedaDestino.trim().toUpperCase()):await localCurrency(authorization);
 const rate=await obtenerTipoDeCambioRD(origin.currency_code,destination.currency_code,input.fechaEfectiva);
 if(origin.currency_id===destination.currency_id)return{...rate,guardado:false};
 const rows=await rest<Array<Record<string,unknown>>>('exchange_rates?on_conflict=from_currency_id,to_currency_id,effective_date',authorization,{method:'POST',headers:{Prefer:'resolution=merge-duplicates,return=representation'},body:JSON.stringify({from_currency_id:origin.currency_id,to_currency_id:destination.currency_id,effective_date:rate.fechaEfectiva,spot_rate:rate.tipoCambio})});
 return{...rate,guardado:true,registro:rows[0]};
}
