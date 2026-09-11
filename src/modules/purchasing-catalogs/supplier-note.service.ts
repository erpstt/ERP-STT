import { getSupabaseConfig } from '../../core/database/supabase.client.js';

async function rpc(authorization:string,name:string,parameters:Record<string,unknown>){
  const config=getSupabaseConfig();if(!config)throw Error('Supabase no está configurado.');
  const response=await fetch(new URL(`/rest/v1/rpc/${name}`,config.url),{method:'POST',headers:{apikey:config.anonKey,Authorization:authorization,'Content-Type':'application/json'},body:JSON.stringify(parameters)});
  const raw=await response.text(),result=raw?JSON.parse(raw):null;
  if(!response.ok)throw Error(result?.message||'No fue posible guardar la nota de proveedor.');
  return result;
}
const numeric=(value:unknown)=>Number(value||0);
const rounded=(value:number)=>Math.round((value+Number.EPSILON)*1_000_000)/1_000_000;
const money=(value:number)=>value.toLocaleString('es-CR',{minimumFractionDigits:2,maximumFractionDigits:6});

export async function saveSupplierNote(authorization:string,kind:string,payload:Record<string,unknown>,id:number|null=null){
  if(kind==='CREDIT'){
    const lines=Array.isArray(payload.lines)?payload.lines as Array<Record<string,unknown>>:[];
    const total=lines.reduce((sum,line)=>sum+rounded(numeric(line.amount)*(1+numeric(line.tax_rate)/100)),0);
    const available=numeric(await rpc(authorization,'supplier_credit_note_available_balance',{p_invoice_id:numeric(payload.invoice_id),p_exclude_cn_id:id}));
    if(total>available+0.000001)throw Error(`El monto de la nota de crédito supera el saldo pendiente de la factura. Saldo máximo permitido: ${money(available)}.`);
  }
  return rpc(authorization,'save_supplier_note',{p_kind:kind,p_payload:payload,p_target_id:id});
}
