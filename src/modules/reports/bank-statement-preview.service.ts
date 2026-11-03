import {reconciliationRpc,requireReconciliationAccess} from '../banking-catalogs/bank-reconciliation-security.service.js';
import {parseBankStatementFile,resolveBankStatementBalances} from './bank-statement-import.js';

type BankOptions={accounts?:Array<{id:number}>;reconciliations?:Array<{bankAccountId:number;date:string;status:string;statementBalance:unknown}>};
const invalid=(message:string)=>Object.assign(new Error(message),{status:400});

/** Read-only preparation, shared with import so balances never depend on editable fields. */
export async function previewBankStatement(authorization:string,input:Record<string,unknown>){
 await requireReconciliationAccess(authorization,'banking:bank-statements','create');
 const accountId=Number(input.p_bank_account_id),cutoff=String(input.p_statement_date??'');
 if(!Number.isSafeInteger(accountId)||accountId<=0)throw invalid('Seleccione una cuenta bancaria.');
 if(!/^\d{4}-\d{2}-\d{2}$/.test(cutoff)||!Number.isFinite(Date.parse(`${cutoff}T12:00:00Z`))||new Date(`${cutoff}T12:00:00Z`).toISOString().slice(0,10)!==cutoff)throw invalid('Seleccione una fecha de conciliación válida.');
 const options=await reconciliationRpc<BankOptions>(authorization,'bank_reconciliation_options',{},'reports:accounting-reports','view');
 if(!(options.accounts??[]).some(account=>Number(account.id)===accountId))throw Object.assign(new Error('La cuenta bancaria no pertenece a la empresa activa o no está disponible.'),{status:403});
 let parsed:Awaited<ReturnType<typeof parseBankStatementFile>>;
 try{
  parsed=await parseBankStatementFile({fileName:String(input.p_file_name??''),...(typeof input.p_file_text==='string'?{text:input.p_file_text}:{}),...(typeof input.p_file_base64==='string'?{base64:input.p_file_base64}:{})});
 }catch(cause){throw invalid(cause instanceof Error?cause.message:'No fue posible leer el extracto bancario.');}
 if(parsed.lines.some(line=>line.date>cutoff))throw invalid('El extracto contiene movimientos posteriores a la fecha de conciliación.');
 if('balanceDate'in parsed&&typeof parsed.balanceDate==='string'&&parsed.balanceDate>cutoff)throw invalid('El saldo del extracto corresponde a una fecha posterior a la conciliación.');
 // Only a contiguous, closed month is a valid substitute for balances omitted by the bank file.
 const [year,month]=cutoff.split('-').map(Number),previousDate=new Date(Date.UTC(year,month-1,0)).toISOString().slice(0,10);
 const previous=(options.reconciliations??[]).find(row=>Number(row.bankAccountId)===accountId&&row.status==='CERRADA'&&row.date===previousDate);
 const candidate=previous?.statementBalance,previousClosing=candidate!==null&&candidate!==undefined&&String(candidate).trim()!==''&&Number.isFinite(Number(candidate))&&parsed.lines.every(line=>line.date>previousDate)?Number(candidate):null;
 try{return resolveBankStatementBalances(parsed,previousClosing);}
 catch(cause){throw invalid(cause instanceof Error?cause.message:'El extracto no permite determinar sus saldos.');}
}
