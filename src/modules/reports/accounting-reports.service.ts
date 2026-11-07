import {requireReportAccess,fetchReportSupabase} from './report-access.service.js';
import {previewBankStatement} from './bank-statement-preview.service.js';
import {calculateBankStatementClosing} from './bank-statement-import.js';
import{pendingInvoiceRpc,assertPendingSource,assertPendingInvoiceAccess}from'./pending-invoice-security.service.js';
import {reconciliationRpc,requireReconciliationAccess} from '../banking-catalogs/bank-reconciliation-security.service.js';
import { getSupabaseConfig } from '../../core/database/supabase.client.js';
import { ScopedReadCache } from '../../core/performance/scoped-read-cache.js';
import {
  operationalReadCacheTtlMs,
  operationalSessionScope,
  registerOperationalReadCacheNamespace,
} from '../../core/performance/operational-read-cache.js';
import { renderPdf } from '../../core/security/pdf-renderer.js';
import { reverseManualJournal } from '../accounting-catalogs/journal-entry.service.js';
import {supplierInvoiceRpc} from '../purchasing-catalogs/supplier-invoice-security.service.js';

const accountingOptionsCache=new ScopedReadCache<Record<string,unknown>>({defaultTtlMs:90_000,maxEntries:2_000});
const accountingOptionsCacheNamespace=registerOperationalReadCacheNamespace('reports-accounting-options');

function accountingOptionsScope(authorization:string){
  return operationalSessionScope(authorization);
}

export function invalidateAccountingReportOptionsCache(authorization?:string){
  accountingOptionsCache.invalidate(accountingOptionsCacheNamespace,authorization?accountingOptionsScope(authorization):undefined);
}

const reports=new Set(['balance-sheet','income-statement','cash-flow','equity-changes','trial-balance','general-ledger','journal','pending-invoice-control','receivables-aging','payables-aging','bank-reconciliation','bank-balances','sales-transactions','purchase-transactions','intercompany-loans','intercompany-commercial']);
async function rpc<T>(authorization:string,name:string,input:Record<string,unknown>={}){await requireReportAccess(authorization);
  const config=getSupabaseConfig();if(!config)throw new Error('Supabase no está configurado.');
  const response=await fetchReportSupabase(new URL(`/rest/v1/rpc/${name}`,config.url),{method:'POST',headers:{apikey:config.anonKey,Authorization:authorization,'Content-Type':'application/json'},body:JSON.stringify(input)});
  const raw=await response.text(),payload:unknown=raw?JSON.parse(raw):null;
  if(!response.ok)throw new Error(typeof payload==='object'&&payload&&'message'in payload?String(payload.message):'No fue posible generar el informe.');
  return payload as T;
}
export async function accountingReportOptions(authorization:string){
  await requireReportAccess(authorization);
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
  const presentation=filters.presentationCurrency;
  if(presentation!==undefined&&presentation!=='LOCAL'&&presentation!=='USD')throw Object.assign(new Error('Seleccione una moneda de presentación válida: LOCAL o USD.'),{status:400});
  if(presentation==='USD'&&report!=='balance-sheet'&&report!=='income-statement')throw Object.assign(new Error('La presentación en USD está disponible para el estado de situación financiera y el estado de resultados.'),{status:400});
  const scopedFilters=report==='income-statement'?{...filters,accountId:null}:filters;
  if(presentation==='USD')return rpc<Record<string,unknown>>(authorization,'run_financial_statement_presentation',{p_report:report,p_filters:scopedFilters});
  if(report==='income-statement'&&scopedFilters.columnView&&scopedFilters.columnView!=='TOTAL')return rpc<Record<string,unknown>>(authorization,'run_income_statement_matrix',{p_filters:scopedFilters});
  if(report==='pending-invoice-control')return pendingInvoiceRpc(authorization,'run_pending_invoice_control_report',{p_filters:scopedFilters},'report');
  if(report==='journal')return rpc<Record<string,unknown>>(authorization,'run_general_journal_report',{p_filters:scopedFilters});
  if(report==='receivables-aging'||report==='payables-aging')return rpc<Record<string,unknown>>(authorization,'run_aging_report',{p_kind:report==='receivables-aging'?'AR':'AP',p_filters:scopedFilters});
  if(report==='bank-reconciliation')return reconciliationRpc<Record<string,unknown>>(authorization,'run_bank_reconciliation_report',{p_filters:scopedFilters},'reports:accounting-reports','view');
  if(report==='bank-balances')return rpc<Record<string,unknown>>(authorization,'run_bank_balance_period_report',{p_filters:scopedFilters});
  if(report==='sales-transactions')return rpc<Record<string,unknown>>(authorization,'run_sales_transaction_report',{p_filters:scopedFilters});
  if(report==='purchase-transactions')return supplierInvoiceRpc<Record<string,unknown>>(authorization,'run_purchase_transaction_report',{p_filters:scopedFilters},'view','reports:accounting-reports');
  return rpc<Record<string,unknown>>(authorization,'run_accounting_report',{p_report:report,p_filters:scopedFilters});
}
export function purchaseTransactionSupport(authorization:string,supportId:number){
  if(!Number.isSafeInteger(supportId)||supportId<=0)throw new Error('El respaldo solicitado no es válido.');
  return supplierInvoiceRpc<Record<string,unknown>>(authorization,'purchase_transaction_support',{p_support_id:supportId},'view','reports:accounting-reports');
}
export const reverseJournalEntry=reverseManualJournal;
export async function pendingInvoiceReversalOptions(authorization:string,journalId:number,reversalDate:string){await assertPendingInvoiceAccess(authorization,'reverse');assertPendingSource(journalId);return pendingInvoiceRpc(authorization,'pending_invoice_reversal_options',{p_journal_id:journalId,p_reversal_date:reversalDate},'reverse');}
export async function reversePendingInvoiceJournal(authorization:string,journalId:number,payload:Record<string,unknown>){await assertPendingInvoiceAccess(authorization,'reverse');assertPendingSource(journalId);return pendingInvoiceRpc(authorization,'reverse_pending_invoice_journal',{p_journal_id:journalId,p_payload:payload},'reverse');}
function assertAnnualPendingInvoiceReclassificationDate(value:unknown){
  const date=String(value??'').trim();
  if(!/^\d{4}-01-01$/.test(date))throw Object.assign(new Error('La reclasificación anual debe registrarse con fecha 01 de enero.'),{status:400});
  return date;
}
export async function previewPendingInvoiceReclassification(authorization:string,reclassificationDate:unknown){
  await assertPendingInvoiceAccess(authorization,'preview');return pendingInvoiceRpc(authorization,'pending_invoice_reclassification_preview',{p_reclassification_date:assertAnnualPendingInvoiceReclassificationDate(reclassificationDate)},'preview');
}
export async function executePendingInvoiceReclassification(authorization:string,reclassificationDate:unknown){
  await assertPendingInvoiceAccess(authorization,'execute');return pendingInvoiceRpc(authorization,'pending_invoice_reclassification_execute',{p_reclassification_date:assertAnnualPendingInvoiceReclassificationDate(reclassificationDate)},'execute');
}
export async function bankReconciliationAction(authorization:string,action:string,input:Record<string,unknown>){
 const resource=action==='import'?'banking:bank-statements':action==='close-report'?'reports:accounting-reports':'banking:bank-reconciliations',permission=action==='import'?'create':action==='close-report'?'view':'edit';
 await requireReconciliationAccess(authorization,resource,permission);
 const names:Record<string,string>={import:'import_bank_statement',auto:'auto_match_bank_reconciliation',match:'match_bank_transaction',unmatch:'unmatch_bank_reconciliation','unmatch-all-preview':'preview_bank_reconciliation_unmatch_all','unmatch-all':'unmatch_all_bank_reconciliation',close:'close_bank_reconciliation','close-report':'bank_reconciliation_close_report'};
 if(!names[action])throw new Error('Acción bancaria no válida.');
 let payload={...input};
 if(['unmatch','unmatch-all-preview','unmatch-all'].includes(action)){
  const fields=['p_bank_account_id','p_cutoff',...(action==='unmatch'?['p_match_id']:action==='unmatch-all'?['p_statement_id','p_expected_fingerprint','p_expected_count']:[])];
  const positiveId=(value:unknown)=>Number.isSafeInteger(value)&&Number(value)>0;
  if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(key=>!fields.includes(key))||!positiveId(input.p_bank_account_id)||(action==='unmatch'&&!positiveId(input.p_match_id))||(action==='unmatch-all'&&(!positiveId(input.p_statement_id)||!positiveId(input.p_expected_count)||Number(input.p_expected_count)>2_147_483_647||typeof input.p_expected_fingerprint!=='string'||!/^[a-f0-9]{64}$/.test(input.p_expected_fingerprint))))throw Object.assign(new Error('Seleccione un punteo bancario válido.'),{status:400});
  const cutoff=input.p_cutoff;
  if(typeof cutoff!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(cutoff)||Number(cutoff.slice(0,4))===0||!Number.isFinite(Date.parse(cutoff+'T00:00:00.000Z'))||new Date(cutoff+'T00:00:00.000Z').toISOString().slice(0,10)!==cutoff)throw Object.assign(new Error('Seleccione una fecha de conciliación válida.'),{status:400});
  payload={p_bank_account_id:input.p_bank_account_id,p_cutoff:cutoff,...(action==='unmatch'?{p_match_id:input.p_match_id}:action==='unmatch-all'?{p_statement_id:input.p_statement_id,p_expected_fingerprint:input.p_expected_fingerprint,p_expected_count:input.p_expected_count}:{})};
 }
 if(action==='import'&&(typeof input.p_file_text==='string'||typeof input.p_file_base64==='string')){
  const prepared=await previewBankStatement(authorization,input);
  payload={p_bank_account_id:input.p_bank_account_id,p_statement_date:input.p_statement_date,p_file_name:input.p_file_name,p_opening_balance:prepared.openingBalance,p_closing_balance:prepared.closingBalance,p_lines:prepared.lines};
 }else if(action==='import'){
  const lines=Array.isArray(input.p_lines)?input.p_lines as Record<string,unknown>[]:[],openingValue=input.p_opening_balance,opening=Number(openingValue);
  if(openingValue===null||openingValue===undefined||String(openingValue).trim()===''||!Number.isFinite(opening))throw Object.assign(new Error('El extracto debe incluir un saldo inicial válido.'),{status:400});
  const closingValue=input.p_closing_balance,closing=closingValue===null||closingValue===undefined||closingValue===''?calculateBankStatementClosing(opening,lines.map(line=>({amount:Number(line.amount)}))):Number(closingValue);
  if(!Number.isFinite(closing))throw Object.assign(new Error('El saldo final debe ser finito.'),{status:400});
  payload={...input,p_opening_balance:opening,p_closing_balance:closing};
 }
 const result=await reconciliationRpc(authorization,names[action],payload,resource,permission);
 if(['import','auto','match','unmatch','unmatch-all','close'].includes(action))invalidateAccountingReportOptionsCache();
 return result;
}

export async function renderBankReconciliationPdf(input:Record<string,unknown>){
 const safeName=String(input.fileName??'reporte.pdf').replace(/[^a-zA-Z0-9._-]/g,'-').slice(0,120)||'reporte.pdf';
 const pdf=await renderPdf(String(input.html??''));
 return{fileName:safeName.toLowerCase().endsWith('.pdf')?safeName:`${safeName}.pdf`,mimeType:'application/pdf',base64:pdf.toString('base64')};
}
