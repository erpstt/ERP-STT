import { getSupabaseConfig } from '../../core/database/supabase.client.js';

const reports=new Set(['balance-sheet','income-statement','cash-flow','equity-changes','trial-balance','general-ledger','journal','receivables-payables','bank-reconciliation']);
async function rpc<T>(authorization:string,name:string,input:Record<string,unknown>={}){
  const config=getSupabaseConfig();if(!config)throw new Error('Supabase no está configurado.');
  const response=await fetch(new URL(`/rest/v1/rpc/${name}`,config.url),{method:'POST',headers:{apikey:config.anonKey,Authorization:authorization,'Content-Type':'application/json'},body:JSON.stringify(input)});
  const raw=await response.text(),payload:unknown=raw?JSON.parse(raw):null;
  if(!response.ok)throw new Error(typeof payload==='object'&&payload&&'message'in payload?String(payload.message):'No fue posible generar el informe.');
  return payload as T;
}
export async function accountingReportOptions(authorization:string){const [base,journalOptions]=await Promise.all([rpc<Record<string,unknown>>(authorization,'accounting_report_options'),rpc<Record<string,unknown>>(authorization,'general_journal_options')]);return{...base,journalOptions};}
export function runAccountingReport(authorization:string,report:string,filters:Record<string,unknown>){
  if(!reports.has(report))throw new Error('El reporte solicitado no existe.');
  return report==='journal'?rpc<Record<string,unknown>>(authorization,'run_general_journal_report',{p_filters:filters}):rpc<Record<string,unknown>>(authorization,'run_accounting_report',{p_report:report,p_filters:filters});
}
export function reverseJournalEntry(authorization:string,journalId:number){return rpc<number>(authorization,'reverse_journal_entry',{target_journal_id:journalId});}
