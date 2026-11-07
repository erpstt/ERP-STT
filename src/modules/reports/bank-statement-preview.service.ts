import {reconciliationRpc,requireReconciliationAccess} from '../banking-catalogs/bank-reconciliation-security.service.js';
import {parseBankStatementFile,resolveBankStatementBalances} from './bank-statement-import.js';

type PreviousStatement={id:number;date:string;closingBalance:number};
type BalanceContext={bankAccountId:number;statementDate:string;previousDate:string;previousStatement:PreviousStatement|null};
const invalid=(message:string)=>Object.assign(new Error(message),{status:400});
const invalidContext=()=>Object.assign(new Error('No fue posible verificar el contexto del extracto anterior. Vuelva a cargar el extracto.'),{status:502});
function balanceContext(value:unknown,accountId:number,cutoff:string,previousDate:string):BalanceContext{
 if(!value||typeof value!=='object'||Array.isArray(value))throw invalidContext();
 const context=value as BalanceContext;
 if(context.bankAccountId!==accountId||context.statementDate!==cutoff||context.previousDate!==previousDate)throw invalidContext();
 const previous=context.previousStatement;
 if(previous!==null&&(!previous||typeof previous!=='object'||Array.isArray(previous)||!Number.isSafeInteger(previous.id)||previous.id<=0||previous.date!==previousDate||typeof previous.closingBalance!=='number'||!Number.isFinite(previous.closingBalance)))throw invalidContext();
 return {bankAccountId:accountId,statementDate:cutoff,previousDate,previousStatement:previous===null?null:{id:previous.id,date:previous.date,closingBalance:previous.closingBalance}};
}

/** Read-only preparation, shared with import so balances never depend on editable fields. */
export async function previewBankStatement(authorization:string,input:Record<string,unknown>){
 await requireReconciliationAccess(authorization,'banking:bank-statements','create');
 const accountId=Number(input.p_bank_account_id),cutoff=String(input.p_statement_date??'');
 if(!Number.isSafeInteger(accountId)||accountId<=0)throw invalid('Seleccione una cuenta bancaria.');
 if(!/^\d{4}-\d{2}-\d{2}$/.test(cutoff)||!Number.isFinite(Date.parse(`${cutoff}T12:00:00Z`))||new Date(`${cutoff}T12:00:00Z`).toISOString().slice(0,10)!==cutoff)throw invalid('Seleccione una fecha de conciliación válida.');
 const previousDay=new Date(`${cutoff}T12:00:00Z`);previousDay.setUTCDate(0);
 const previousDate=previousDay.toISOString().slice(0,10),monthStart=`${cutoff.slice(0,7)}-01`;
 const context=balanceContext(await reconciliationRpc(authorization,'bank_statement_balance_context',{p_bank_account_id:accountId,p_statement_date:cutoff},'reports:accounting-reports','view'),accountId,cutoff,previousDate);
 let parsed:Awaited<ReturnType<typeof parseBankStatementFile>>;
 try{
  parsed=await parseBankStatementFile({fileName:String(input.p_file_name??''),...(typeof input.p_file_text==='string'?{text:input.p_file_text}:{}),...(typeof input.p_file_base64==='string'?{base64:input.p_file_base64}:{})});
 }catch(cause){throw invalid(cause instanceof Error?cause.message:'No fue posible leer el extracto bancario.');}
 if(parsed.lines.some(line=>line.date>cutoff))throw invalid('El extracto contiene movimientos posteriores a la fecha de conciliación.');
 if(parsed.lines.some(line=>line.date<monthStart))throw invalid('El extracto contiene movimientos de otro mes. Cargue únicamente los movimientos del mes de la fecha de conciliación.');
 if('balanceDate'in parsed&&typeof parsed.balanceDate==='string'&&parsed.balanceDate>cutoff)throw invalid('El saldo del extracto corresponde a una fecha posterior a la conciliación.');
 try{return {...resolveBankStatementBalances(parsed,context.previousStatement?.closingBalance,previousDate),previousStatement:context.previousStatement,previousDate};}
 catch(cause){throw invalid(cause instanceof Error?cause.message:'El extracto no permite determinar sus saldos.');}
}
