import{getSupabaseConfig}from'../../core/database/supabase.client.js';
async function rpc(a:string,n:string,i:Record<string,unknown>={}){const c=getSupabaseConfig();if(!c)throw Error('Supabase no está configurado.');const r=await fetch(new URL(`/rest/v1/rpc/${n}`,c.url),{method:'POST',headers:{apikey:c.anonKey,Authorization:a,'Content-Type':'application/json'},body:JSON.stringify(i)}),t=await r.text(),x=t?JSON.parse(t):null;if(!r.ok)throw Error(x?.message||'No fue posible procesar la comisión bancaria.');return x}
export const bankFeeOptions=(a:string)=>rpc(a,'bank_fee_options');
export const saveBankFee=(a:string,p:Record<string,unknown>)=>rpc(a,'save_bank_fee',{p_payload:p});
export const importBankFees=(a:string,p:Record<string,unknown>)=>rpc(a,'import_bank_fees',{p_payload:p});
export const bankFeeReport=(a:string,p:Record<string,unknown>)=>rpc(a,'bank_fee_report',{p_filters:p});
export const bankFeeDetail=(a:string,id:number)=>rpc(a,'bank_fee_detail',{p_fee_id:id});
export const updateBankFee=(a:string,id:number,p:Record<string,unknown>)=>rpc(a,'update_bank_fee',{p_fee_id:id,p_payload:p});
export const deleteBankFee=(a:string,id:number)=>rpc(a,'delete_bank_fee',{p_fee_id:id});
