import { fetchSupabase, getSupabaseConfig } from '../../core/database/supabase.client.js';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync=promisify(execFile);

const reports=new Set(['balance-sheet','income-statement','cash-flow','equity-changes','trial-balance','general-ledger','journal','pending-invoice-control','receivables-aging','payables-aging','bank-reconciliation','bank-balances','sales-transactions','purchase-transactions']);
async function rpc<T>(authorization:string,name:string,input:Record<string,unknown>={}){
  const config=getSupabaseConfig();if(!config)throw new Error('Supabase no está configurado.');
  const response=await fetchSupabase(new URL(`/rest/v1/rpc/${name}`,config.url),{method:'POST',headers:{apikey:config.anonKey,Authorization:authorization,'Content-Type':'application/json'},body:JSON.stringify(input)});
  const raw=await response.text(),payload:unknown=raw?JSON.parse(raw):null;
  if(!response.ok)throw new Error(typeof payload==='object'&&payload&&'message'in payload?String(payload.message):'No fue posible generar el informe.');
  return payload as T;
}
export async function accountingReportOptions(authorization:string){const [base,dimensionLinks,journalOptions,pendingInvoiceOptions,agingOptions,bankOptions]=await Promise.all([rpc<Record<string,unknown>>(authorization,'accounting_report_options'),rpc<Record<string,unknown>>(authorization,'income_statement_dimension_links'),rpc<Record<string,unknown>>(authorization,'general_journal_options'),rpc<Record<string,unknown>>(authorization,'pending_invoice_control_options'),rpc<Record<string,unknown>>(authorization,'aging_report_options'),rpc<Record<string,unknown>>(authorization,'bank_reconciliation_options')]);return{...base,...dimensionLinks,journalOptions,pendingInvoiceOptions,agingOptions,bankOptions};}
export function runAccountingReport(authorization:string,report:string,filters:Record<string,unknown>){
  if(!reports.has(report))throw new Error('El reporte solicitado no existe.');
  if(report==='income-statement'&&filters.columnView&&filters.columnView!=='TOTAL')return rpc<Record<string,unknown>>(authorization,'run_income_statement_matrix',{p_filters:filters});
  if(report==='pending-invoice-control')return rpc<Record<string,unknown>>(authorization,'run_pending_invoice_control_report',{p_filters:filters});
  if(report==='journal')return rpc<Record<string,unknown>>(authorization,'run_general_journal_report',{p_filters:filters});
  if(report==='receivables-aging'||report==='payables-aging')return rpc<Record<string,unknown>>(authorization,'run_aging_report',{p_kind:report==='receivables-aging'?'AR':'AP',p_filters:filters});
  if(report==='bank-reconciliation')return rpc<Record<string,unknown>>(authorization,'run_bank_reconciliation_report',{p_filters:filters});
  if(report==='bank-balances')return rpc<Record<string,unknown>>(authorization,'run_bank_balance_period_report',{p_filters:filters});
  if(report==='sales-transactions')return rpc<Record<string,unknown>>(authorization,'run_sales_transaction_report',{p_filters:filters});
  if(report==='purchase-transactions')return rpc<Record<string,unknown>>(authorization,'run_purchase_transaction_report',{p_filters:filters});
  return rpc<Record<string,unknown>>(authorization,'run_accounting_report',{p_report:report,p_filters:filters});
}
export function reverseJournalEntry(authorization:string,journalId:number){return rpc<number>(authorization,'reverse_journal_entry',{target_journal_id:journalId});}
export function pendingInvoiceReversalOptions(authorization:string,journalId:number,reversalDate:string){return rpc<Record<string,unknown>>(authorization,'pending_invoice_reversal_options',{p_journal_id:journalId,p_reversal_date:reversalDate});}
export function reversePendingInvoiceJournal(authorization:string,journalId:number,payload:Record<string,unknown>){return rpc<Record<string,unknown>>(authorization,'reverse_pending_invoice_journal',{p_journal_id:journalId,p_payload:payload});}
export async function bankReconciliationAction(authorization:string,action:string,input:Record<string,unknown>){const names:Record<string,string>={import:'import_bank_statement',auto:'auto_match_bank_reconciliation',match:'match_bank_transaction',close:'close_bank_reconciliation','close-report':'bank_reconciliation_close_report'};if(!names[action])throw new Error('Acción bancaria no válida.');if(action==='import'&&typeof input.p_file_base64==='string'){const encoded=input.p_file_base64;if(encoded.length>8_000_000)throw new Error('El archivo Excel supera el límite permitido de 5 MB.');const {default:readXlsxFile}=await import('read-excel-file/node');const matrix=await readXlsxFile(Buffer.from(encoded,'base64')) as unknown as unknown[][],headers=(matrix.shift()??[]).map(value=>String(value??'').trim().toLowerCase()),cell=(row:unknown[],names:string[])=>row[headers.findIndex(header=>names.some(name=>header.includes(name)))],dateValue=(value:unknown)=>value instanceof Date?value.toISOString().slice(0,10):String(value??'').slice(0,10);input.p_lines=matrix.map(row=>({date:dateValue(cell(row,['fecha','date'])),valueDate:dateValue(cell(row,['valor','value'])),reference:String(cell(row,['referencia','reference','cheque'])??''),description:String(cell(row,['nota','descrip','concept','memo'])??''),beneficiary:String(cell(row,['benefici','nombre','name'])??''),amount:Number(cell(row,['monto','amount','importe'])??0)})).filter(row=>/^\d{4}-\d{2}-\d{2}$/.test(row.date)&&Number.isFinite(row.amount)&&row.amount!==0);delete input.p_file_base64;if(!(input.p_lines as unknown[]).length)throw new Error('El archivo Excel no contiene movimientos reconocibles.');}if(action==='import'){const lines=Array.isArray(input.p_lines)?input.p_lines as Record<string,unknown>[]:[],opening=Number(input.p_opening_balance??0);input.p_opening_balance=Number.isFinite(opening)?opening:0;if(input.p_closing_balance===null||input.p_closing_balance===undefined||input.p_closing_balance==='')input.p_closing_balance=Number(input.p_opening_balance)+lines.reduce((sum,line)=>sum+Number(line.amount||0),0);}return rpc<unknown>(authorization,names[action],input);}

export async function renderBankReconciliationPdf(input:Record<string,unknown>){
 const html=String(input.html??''),requestedName=String(input.fileName??'conciliacion-bancaria.pdf'),safeName=requestedName.replace(/[^a-zA-Z0-9._-]/g,'-');
 if(!html.startsWith('<!doctype html>')||html.length>4_000_000)throw new Error('El contenido del reporte PDF no es válido.');
 const id=randomUUID(),htmlPath=join(tmpdir(),`nexo-bank-${id}.html`),pdfPath=join(tmpdir(),`nexo-bank-${id}.pdf`),profilePath=join(tmpdir(),`nexo-chrome-${id}`),chrome=process.env.CHROME_PATH||'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
 try{await writeFile(htmlPath,html,'utf8');await execFileAsync(chrome,['--headless','--no-sandbox','--disable-gpu','--disable-gpu-compositing','--disable-dev-shm-usage','--disable-extensions','--no-first-run',`--user-data-dir=${profilePath}`,'--no-pdf-header-footer',`--print-to-pdf=${pdfPath}`,new URL(`file:///${htmlPath.replaceAll('\\','/')}`).href],{windowsHide:true,timeout:60_000});const pdf=await readFile(pdfPath);if(pdf.subarray(0,4).toString()!=='%PDF')throw new Error('No fue posible producir un archivo PDF válido.');return{fileName:safeName.toLowerCase().endsWith('.pdf')?safeName:`${safeName}.pdf`,mimeType:'application/pdf',base64:pdf.toString('base64')};}finally{await Promise.allSettled([rm(htmlPath,{force:true}),rm(pdfPath,{force:true}),rm(profilePath,{recursive:true,force:true})]);}
}
