import {fetchReportSupabase,requireReportAccess} from './report-access.service.js';
import {getSupabaseConfig} from '../../core/database/supabase.client.js';

export async function runCustomerFeesReport(auth:string,filters:Record<string,unknown>){
 await requireReportAccess(auth,'customer-payment-fees');
 const config=getSupabaseConfig();if(!config)throw Error('Base de datos no configurada.');
 const response=await fetchReportSupabase(new URL('/rest/v1/rpc/run_customer_payment_fee_report',config.url),{method:'POST',headers:{apikey:config.anonKey,Authorization:auth,'Content-Type':'application/json'},body:JSON.stringify({p_filters:filters})});
 const result=await response.json() as Record<string,any>;
 if(!response.ok)throw Object.assign(Error('No fue posible consultar el informe de comisiones.'),{status:response.status===403||result.code==='42501'?403:500});
 return {...result,rows:(result.rows||[]).map((row:Record<string,unknown>)=>({...row,cashNet:Math.max(Number(row.amount||0)-Number(row.advanceTotal||0)-Number(row.bankFeeTotal||0),0)}))};
}
