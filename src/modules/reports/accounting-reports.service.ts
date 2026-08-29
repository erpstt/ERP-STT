import { getSupabaseConfig } from '../../core/database/supabase.client.js';

const reports=new Set(['balance-sheet','income-statement','cash-flow','equity-changes','trial-balance','general-ledger','journal','receivables-aging','payables-aging','bank-reconciliation','sales-transactions','purchase-transactions']);
async function rpc<T>(authorization:string,name:string,input:Record<string,unknown>={}){
  const config=getSupabaseConfig();if(!config)throw new Error('Supabase no está configurado.');
  const response=await fetch(new URL(`/rest/v1/rpc/${name}`,config.url),{method:'POST',headers:{apikey:config.anonKey,Authorization:authorization,'Content-Type':'application/json'},body:JSON.stringify(input)});
  const raw=await response.text(),payload:unknown=raw?JSON.parse(raw):null;
  if(!response.ok)throw new Error(typeof payload==='object'&&payload&&'message'in payload?String(payload.message):'No fue posible generar el informe.');
  return payload as T;
}
export async function accountingReportOptions(authorization:string){const [base,journalOptions,agingOptions,bankOptions]=await Promise.all([rpc<Record<string,unknown>>(authorization,'accounting_report_options'),rpc<Record<string,unknown>>(authorization,'general_journal_options'),rpc<Record<string,unknown>>(authorization,'aging_report_options'),rpc<Record<string,unknown>>(authorization,'bank_reconciliation_options')]);return{...base,journalOptions,agingOptions,bankOptions};}
export function runAccountingReport(authorization:string,report:string,filters:Record<string,unknown>){
  if(!reports.has(report))throw new Error('El reporte solicitado no existe.');
  if(report==='journal')return rpc<Record<string,unknown>>(authorization,'run_general_journal_report',{p_filters:filters});
  if(report==='receivables-aging'||report==='payables-aging')return rpc<Record<string,unknown>>(authorization,'run_aging_report',{p_kind:report==='receivables-aging'?'AR':'AP',p_filters:filters});
  if(report==='bank-reconciliation')return rpc<Record<string,unknown>>(authorization,'run_bank_reconciliation_report',{p_filters:filters});
  if(report==='sales-transactions')return rpc<Record<string,unknown>>(authorization,'run_sales_transaction_report',{p_filters:filters});
  if(report==='purchase-transactions')return rpc<Record<string,unknown>>(authorization,'run_purchase_transaction_report',{p_filters:filters});
  return rpc<Record<string,unknown>>(authorization,'run_accounting_report',{p_report:report,p_filters:filters});
}
export function reverseJournalEntry(authorization:string,journalId:number){return rpc<number>(authorization,'reverse_journal_entry',{target_journal_id:journalId});}
export async function bankReconciliationAction(authorization:string,action:string,input:Record<string,unknown>){const names:Record<string,string>={import:'import_bank_statement',auto:'auto_match_bank_reconciliation',match:'match_bank_transaction',close:'close_bank_reconciliation'};if(!names[action])throw new Error('Acción bancaria no válida.');if(action==='import'&&typeof input.p_file_base64==='string'){const encoded=input.p_file_base64;if(encoded.length>8_000_000)throw new Error('El archivo Excel supera el límite permitido de 5 MB.');const {default:readXlsxFile}=await import('read-excel-file/node');const matrix=await readXlsxFile(Buffer.from(encoded,'base64')) as unknown as unknown[][],headers=(matrix.shift()??[]).map(value=>String(value??'').trim().toLowerCase()),cell=(row:unknown[],names:string[])=>row[headers.findIndex(header=>names.some(name=>header.includes(name)))],dateValue=(value:unknown)=>value instanceof Date?value.toISOString().slice(0,10):String(value??'').slice(0,10);input.p_lines=matrix.map(row=>({date:dateValue(cell(row,['fecha','date'])),valueDate:dateValue(cell(row,['valor','value'])),reference:String(cell(row,['referencia','reference','cheque'])??''),description:String(cell(row,['descrip','concept','memo'])??''),beneficiary:String(cell(row,['benefici','nombre','name'])??''),amount:Number(cell(row,['monto','amount','importe'])??0)})).filter(row=>/^\d{4}-\d{2}-\d{2}$/.test(row.date)&&Number.isFinite(row.amount)&&row.amount!==0);delete input.p_file_base64;if(!(input.p_lines as unknown[]).length)throw new Error('El archivo Excel no contiene movimientos reconocibles.');}return rpc<unknown>(authorization,names[action],input);}
