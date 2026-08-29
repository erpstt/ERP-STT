import { getSupabaseConfig } from '../../core/database/supabase.client.js';

const reports=new Set(['balance-sheet','income-statement','cash-flow','equity-changes','trial-balance','general-ledger','journal','receivables-payables','bank-reconciliation']);
async function rpc<T>(authorization:string,name:string,input:Record<string,unknown>={}){
  const config=getSupabaseConfig();if(!config)throw new Error('Supabase no está configurado.');
  const response=await fetch(new URL(`/rest/v1/rpc/${name}`,config.url),{method:'POST',headers:{apikey:config.anonKey,Authorization:authorization,'Content-Type':'application/json'},body:JSON.stringify(input)});
  const raw=await response.text(),payload:unknown=raw?JSON.parse(raw):null;
  if(!response.ok)throw new Error(typeof payload==='object'&&payload&&'message'in payload?String(payload.message):'No fue posible generar el informe.');
  return payload as T;
}
export function accountingReportOptions(authorization:string){return rpc<Record<string,unknown>>(authorization,'accounting_report_options');}
export function runAccountingReport(authorization:string,report:string,filters:Record<string,unknown>){
  if(!reports.has(report))throw new Error('El reporte solicitado no existe.');
  return rpc<Record<string,unknown>>(authorization,'run_accounting_report',{p_report:report,p_filters:filters});
}
