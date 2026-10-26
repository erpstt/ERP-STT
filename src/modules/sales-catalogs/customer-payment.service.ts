import { fetchSupabase, getSupabaseConfig } from '../../core/database/supabase.client.js';

async function rpc(authorization:string,name:string,parameters:Record<string,unknown>={}) {
  const config=getSupabaseConfig();
  if(!config)throw Error('Supabase no está configurado.');
  const response=await fetchSupabase(new URL(`/rest/v1/rpc/${name}`,config.url),{method:'POST',headers:{apikey:config.anonKey,Authorization:authorization,'Content-Type':'application/json'},body:JSON.stringify(parameters)});
  const text=await response.text(),data=text?JSON.parse(text):null;
  if(!response.ok)throw Error(data?.message||'No fue posible procesar el cobro.');
  return data;
}
export async function customerPaymentOptions(authorization:string,paymentId?:number){
  if(paymentId!==undefined&&(!Number.isSafeInteger(paymentId)||paymentId<=0))throw Error('El cobro indicado no es válido.');
  const optionsRequest=paymentId===undefined
    ?rpc(authorization,'customer_payment_options')
    :rpc(authorization,'customer_payment_edit_options',{p_payment_id:paymentId});
  const [options,advances,bankFeeOptions]=await Promise.all([optionsRequest,rpc(authorization,'customer_available_advances'),rpc(authorization,'bank_fee_options')]);
  return {...options,advances,bankFeeAccount:bankFeeOptions?.expenseAccount??null};
}
export async function customerPaymentReport(authorization:string,filters:Record<string,unknown>){
  const [report,summaries,bankFees]=await Promise.all([rpc(authorization,'customer_payment_report',{p_filters:filters}),rpc(authorization,'customer_payment_advance_summary'),rpc(authorization,'customer_payment_bank_fee_summary')]);
  const advanceByPayment=new Map<string,unknown>();for(const item of summaries as Array<Record<string,unknown>>){const paymentId=String(item.paymentId);if(!advanceByPayment.has(paymentId))advanceByPayment.set(paymentId,item.advanceTotal);}
  const bankFeeByPayment=new Map<string,Record<string,unknown>>();for(const item of bankFees as Array<Record<string,unknown>>)bankFeeByPayment.set(String(item.paymentId),item);
  return {...report,rows:(report.rows||[]).map((row:Record<string,unknown>)=>{const advanceTotal=Number(advanceByPayment.get(String(row.id))||0),bankFee=bankFeeByPayment.get(String(row.id)),bankFeeTotal=Number(bankFee?.amount||0);return{...row,advanceTotal,bankFeeTotal,bankFeeAccountNumber:bankFee?.expenseAccountNumber??null,bankFeeAccountName:bankFee?.expenseAccountName??null,cashNet:Math.max(Number(row.amount||0)-advanceTotal-bankFeeTotal,0)};})};
}
export async function customerPaymentDetail(authorization:string,id:number){
  const [detail,advances,bankFee]=await Promise.all([rpc(authorization,'customer_payment_detail',{p_payment_id:id}),rpc(authorization,'customer_payment_advance_detail',{p_payment_id:id}),rpc(authorization,'customer_payment_bank_fee_detail',{p_payment_id:id})]);
  return {...detail,advances,bankFee:Object.keys(bankFee||{}).length?bankFee:null};
}
export const saveCustomerPayment=(authorization:string,payload:Record<string,unknown>,id?:number)=>rpc(authorization,'save_customer_payment_with_advances',{p_payload:payload,p_payment_id:id||null});
export const deleteCustomerPayment=(authorization:string,id:number)=>rpc(authorization,'delete_customer_payment',{p_payment_id:id});

