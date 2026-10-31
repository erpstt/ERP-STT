import { fetchSupabase, getSupabaseConfig } from '../../core/database/supabase.client.js';
import { ScopedReadCache } from '../../core/performance/scoped-read-cache.js';
import {
  operationalReadCacheTtlMs,
  operationalSessionScope,
  registerOperationalReadCacheNamespace,
} from '../../core/performance/operational-read-cache.js';
import { renderPdf } from '../../core/security/pdf-renderer.js';
import { reverseManualJournal } from '../accounting-catalogs/journal-entry.service.js';

const accountingOptionsCache=new ScopedReadCache<Record<string,unknown>>({defaultTtlMs:90_000,maxEntries:2_000});
const accountingOptionsCacheNamespace=registerOperationalReadCacheNamespace('reports-accounting-options');

function accountingOptionsScope(authorization:string){
  return operationalSessionScope(authorization);
}

export function invalidateAccountingReportOptionsCache(authorization?:string){
  accountingOptionsCache.invalidate(accountingOptionsCacheNamespace,authorization?accountingOptionsScope(authorization):undefined);
}

const reports=new Set(['balance-sheet','income-statement','cash-flow','equity-changes','trial-balance','general-ledger','journal','pending-invoice-control','receivables-aging','payables-aging','bank-reconciliation','bank-balances','sales-transactions','purchase-transactions','intercompany-loans','intercompany-commercial']);
async function rpc<T>(authorization:string,name:string,input:Record<string,unknown>={}){
  const config=getSupabaseConfig();if(!config)throw new Error('Supabase no está configurado.');
  const response=await fetchSupabase(new URL(`/rest/v1/rpc/${name}`,config.url),{method:'POST',headers:{apikey:config.anonKey,Authorization:authorization,'Content-Type':'application/json'},body:JSON.stringify(input)});
  const raw=await response.text(),payload:unknown=raw?JSON.parse(raw):null;
  if(!response.ok)throw new Error(typeof payload==='object'&&payload&&'message'in payload?String(payload.message):'No fue posible generar el informe.');
  return payload as T;
}
export function accountingReportOptions(authorization:string){
  const scope=accountingOptionsScope(authorization);
  return accountingOptionsCache.getOrLoad({
    namespace:accountingOptionsCacheNamespace,
    scope,
    ttlMs:operationalReadCacheTtlMs(scope),
    loader:()=>rpc<Record<string,unknown>>(authorization,'accounting_report_options_bundle'),
  });
}
export function runAccountingReport(authorization:string,report:string,filters:Record<string,unknown>){
  if(!reports.has(report))throw new Error('El reporte solicitado no existe.');
  const scopedFilters=report==='income-statement'?{...filters,accountId:null}:filters;
  if(report==='income-statement'&&scopedFilters.columnView&&scopedFilters.columnView!=='TOTAL')return rpc<Record<string,unknown>>(authorization,'run_income_statement_matrix',{p_filters:scopedFilters});
  if(report==='pending-invoice-control')return rpc<Record<string,unknown>>(authorization,'run_pending_invoice_control_report',{p_filters:scopedFilters});
  if(report==='journal')return rpc<Record<string,unknown>>(authorization,'run_general_journal_report',{p_filters:scopedFilters});
  if(report==='receivables-aging'||report==='payables-aging')return rpc<Record<string,unknown>>(authorization,'run_aging_report',{p_kind:report==='receivables-aging'?'AR':'AP',p_filters:scopedFilters});
  if(report==='bank-reconciliation')return rpc<Record<string,unknown>>(authorization,'run_bank_reconciliation_report',{p_filters:scopedFilters});
  if(report==='bank-balances')return rpc<Record<string,unknown>>(authorization,'run_bank_balance_period_report',{p_filters:scopedFilters});
  if(report==='sales-transactions')return rpc<Record<string,unknown>>(authorization,'run_sales_transaction_report',{p_filters:scopedFilters});
  if(report==='purchase-transactions')return rpc<Record<string,unknown>>(authorization,'run_purchase_transaction_report',{p_filters:scopedFilters});
  return rpc<Record<string,unknown>>(authorization,'run_accounting_report',{p_report:report,p_filters:scopedFilters});
}
export function purchaseTransactionSupport(authorization:string,supportId:number){
  if(!Number.isSafeInteger(supportId)||supportId<=0)throw new Error('El respaldo solicitado no es válido.');
  return rpc<Record<string,unknown>>(authorization,'purchase_transaction_support',{p_support_id:supportId});
}
export const reverseJournalEntry=reverseManualJournal;
export function pendingInvoiceReversalOptions(authorization:string,journalId:number,reversalDate:string){return rpc<Record<string,unknown>>(authorization,'pending_invoice_reversal_options',{p_journal_id:journalId,p_reversal_date:reversalDate});}
export function reversePendingInvoiceJournal(authorization:string,journalId:number,payload:Record<string,unknown>){return rpc<Record<string,unknown>>(authorization,'reverse_pending_invoice_journal',{p_journal_id:journalId,p_payload:payload});}
function assertAnnualPendingInvoiceReclassificationDate(value:unknown){
  const date=String(value??'').trim();
  if(!/^\d{4}-01-01$/.test(date))throw new Error('La reclasificación anual debe registrarse con fecha 01 de enero.');
  return date;
}
export function previewPendingInvoiceReclassification(authorization:string,reclassificationDate:unknown){
  return rpc<Record<string,unknown>>(authorization,'pending_invoice_reclassification_preview',{p_reclassification_date:assertAnnualPendingInvoiceReclassificationDate(reclassificationDate)});
}
export function executePendingInvoiceReclassification(authorization:string,reclassificationDate:unknown){
  return rpc<Record<string,unknown>>(authorization,'pending_invoice_reclassification_execute',{p_reclassification_date:assertAnnualPendingInvoiceReclassificationDate(reclassificationDate)});
}
export async function bankReconciliationAction(authorization:string,action:string,input:Record<string,unknown>){const names:Record<string,string>={import:'import_bank_statement',auto:'auto_match_bank_reconciliation',match:'match_bank_transaction',close:'close_bank_reconciliation','close-report':'bank_reconciliation_close_report'};if(!names[action])throw new Error('Acción bancaria no válida.');if(action==='import'&&typeof input.p_file_base64==='string'){const encoded=input.p_file_base64;if(encoded.length>8_000_000)throw new Error('El archivo Excel supera el límite permitido de 5 MB.');const {default:readXlsxFile}=await import('read-excel-file/node');const matrix=await readXlsxFile(Buffer.from(encoded,'base64')) as unknown as unknown[][],headers=(matrix.shift()??[]).map(value=>String(value??'').trim().toLowerCase()),cell=(row:unknown[],names:string[])=>row[headers.findIndex(header=>names.some(name=>header.includes(name)))],dateValue=(value:unknown)=>value instanceof Date?value.toISOString().slice(0,10):String(value??'').slice(0,10);input.p_lines=matrix.map(row=>({date:dateValue(cell(row,['fecha','date'])),valueDate:dateValue(cell(row,['valor','value'])),reference:String(cell(row,['referencia','reference','cheque'])??''),description:String(cell(row,['nota','descrip','concept','memo'])??''),beneficiary:String(cell(row,['benefici','nombre','name'])??''),amount:Number(cell(row,['monto','amount','importe'])??0)})).filter(row=>/^\d{4}-\d{2}-\d{2}$/.test(row.date)&&Number.isFinite(row.amount)&&row.amount!==0);delete input.p_file_base64;if(!(input.p_lines as unknown[]).length)throw new Error('El archivo Excel no contiene movimientos reconocibles.');}if(action==='import'){const lines=Array.isArray(input.p_lines)?input.p_lines as Record<string,unknown>[]:[],opening=Number(input.p_opening_balance??0);input.p_opening_balance=Number.isFinite(opening)?opening:0;if(input.p_closing_balance===null||input.p_closing_balance===undefined||input.p_closing_balance==='')input.p_closing_balance=Number(input.p_opening_balance)+lines.reduce((sum,line)=>sum+Number(line.amount||0),0);}return rpc<unknown>(authorization,names[action],input);}

export async function renderBankReconciliationPdf(input:Record<string,unknown>){
 const safeName=String(input.fileName??'reporte.pdf').replace(/[^a-zA-Z0-9._-]/g,'-').slice(0,120)||'reporte.pdf';
 const pdf=await renderPdf(String(input.html??''));
 return{fileName:safeName.toLowerCase().endsWith('.pdf')?safeName:`${safeName}.pdf`,mimeType:'application/pdf',base64:pdf.toString('base64')};
}
