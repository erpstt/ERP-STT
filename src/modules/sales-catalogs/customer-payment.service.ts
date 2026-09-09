import { getSupabaseConfig } from '../../core/database/supabase.client.js';

async function rpc(authorization:string,name:string,parameters:Record<string,unknown>={}) {
  const config=getSupabaseConfig();
  if(!config)throw Error('Supabase no está configurado.');
  const response=await fetch(new URL(`/rest/v1/rpc/${name}`,config.url),{method:'POST',headers:{apikey:config.anonKey,Authorization:authorization,'Content-Type':'application/json'},body:JSON.stringify(parameters)});
  const text=await response.text(),data=text?JSON.parse(text):null;
  if(!response.ok)throw Error(data?.message||'No fue posible procesar el cobro.');
  return data;
}
export async function customerPaymentOptions(authorization:string){
  const [options,advances]=await Promise.all([rpc(authorization,'customer_payment_options'),rpc(authorization,'customer_available_advances')]);
  return {...options,advances};
}
export async function customerPaymentReport(authorization:string,filters:Record<string,unknown>){
  const [report,summaries]=await Promise.all([rpc(authorization,'customer_payment_report',{p_filters:filters}),rpc(authorization,'customer_payment_advance_summary')]);
  return {...report,rows:(report.rows||[]).map((row:Record<string,unknown>)=>({...row,advanceTotal:summaries.find((item:Record<string,unknown>)=>String(item.paymentId)===String(row.id))?.advanceTotal||0}))};
}
export async function customerPaymentDetail(authorization:string,id:number){
  const [detail,advances]=await Promise.all([rpc(authorization,'customer_payment_detail',{p_payment_id:id}),rpc(authorization,'customer_payment_advance_detail',{p_payment_id:id})]);
  return {...detail,advances};
}
export const saveCustomerPayment=(authorization:string,payload:Record<string,unknown>,id?:number)=>rpc(authorization,'save_customer_payment_with_advances',{p_payload:payload,p_payment_id:id||null});
export const deleteCustomerPayment=(authorization:string,id:number)=>rpc(authorization,'delete_customer_payment',{p_payment_id:id});

