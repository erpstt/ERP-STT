import {getSupabaseConfig} from '../../core/database/supabase.client.js';
import {fetchReportSupabase,requireReportAccess} from './report-access.service.js';

type JsonRecord=Record<string,unknown>;
export interface GeneralLedgerExportSnapshot extends JsonRecord {
 rows:JsonRecord[];
 total:number;
 summary:{debit:number|string;credit:number|string};
 snapshotFingerprint:string;
 context:{
  subsidiary:{id:number;name:string};
  localCurrency:{id:number;code:string;name:string|null};
  book:{id:number;name:string}|null;
  bookId:number|null;
  dateFrom:string;dateTo:string;filters:JsonRecord;generatedAt:string;
 };
}
const fields=new Set(['subsidiaryIds','bookId','dateFrom','dateTo','accountId','accountIds','accountFrom','accountTo','entityType','entityId','costCenterId']);
function invalid():never {throw Object.assign(new Error('Revise la subsidiaria, las fechas y los filtros del Libro Mayor.'),{status:400});}
function record(value:unknown):value is JsonRecord {return !!value&&typeof value==='object'&&!Array.isArray(value);}
function positiveId(value:unknown):number {
 if((typeof value!=='string'&&typeof value!=='number')||!(/^[1-9]\d*$/).test(String(value)))return invalid();
 const id=Number(value);if(!Number.isSafeInteger(id)||id<=0)return invalid();return id;
}
function optionalId(value:unknown):number|null {return value===undefined||value===null||value===''?null:positiveId(value);}
function optionalText(value:unknown):string|null {
 if(value===undefined||value===null||value==='')return null;
 if(typeof value!=='string')return invalid();return value;
}
function date(value:unknown):string {
 if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(value)||value.startsWith('0000-'))return invalid();
 const parsed=new Date(value+'T00:00:00.000Z');
 if(!Number.isFinite(parsed.getTime())||parsed.toISOString().slice(0,10)!==value)return invalid();return value;
}
export function cleanGeneralLedgerExportFilters(input:unknown) {
 if(!record(input)||Object.keys(input).some(key=>!fields.has(key)))return invalid();
 if(!Array.isArray(input.subsidiaryIds)||input.subsidiaryIds.length!==1)return invalid();
 const accountIds=input.accountIds===undefined||input.accountIds===null?[]:input.accountIds;
 if(!Array.isArray(accountIds))return invalid();
 const dateFrom=date(input.dateFrom),dateTo=date(input.dateTo);if(dateFrom>dateTo)return invalid();
 return {subsidiaryIds:[positiveId(input.subsidiaryIds[0])],bookId:optionalId(input.bookId),dateFrom,dateTo,
  accountId:optionalId(input.accountId),accountIds:accountIds.map(positiveId),accountFrom:optionalText(input.accountFrom),accountTo:optionalText(input.accountTo),
  entityType:optionalText(input.entityType),entityId:optionalId(input.entityId),costCenterId:optionalId(input.costCenterId)};
}
function incomplete():never {throw Object.assign(new Error('La exportación completa del Libro Mayor está incompleta o cambió de contexto. Vuelva a solicitarla.'),{status:502});}
function idEquals(value:unknown,expected:number):boolean {return(typeof value==='number'||typeof value==='string')&&Number.isSafeInteger(Number(value))&&Number(value)===expected;}
function validId(value:unknown):boolean {return(typeof value==='number'||typeof value==='string')&&/^[1-9]\d*$/.test(String(value))&&Number.isSafeInteger(Number(value));}
function calendarDate(value:unknown):value is string {return typeof value==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(value)&&!value.startsWith('0000-')&&Number.isFinite(Date.parse(value+'T00:00:00.000Z'))&&new Date(value+'T00:00:00.000Z').toISOString().slice(0,10)===value;}
function finite(value:unknown):boolean {return(typeof value==='number'||typeof value==='string'&&value.trim()!=='')&&Number.isFinite(Number(value));}
function nullableFinite(value:unknown):boolean {return value===null||finite(value);}
function canonical(value:unknown):unknown {return Array.isArray(value)?value.map(canonical):record(value)?Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])])):value;}
function validateSnapshot(input:unknown,filters:ReturnType<typeof cleanGeneralLedgerExportFilters>):GeneralLedgerExportSnapshot {
 if(!record(input)||!Array.isArray(input.rows)||!Number.isSafeInteger(input.total)||input.total!==input.rows.length||!record(input.summary)||!finite(input.summary.debit)||!finite(input.summary.credit)||typeof input.snapshotFingerprint!=='string'||!(/^[a-f0-9]{32}$/).test(input.snapshotFingerprint)||!record(input.context))return incomplete();
 const context=input.context;
 if(!record(context.subsidiary)||!idEquals(context.subsidiary.id,filters.subsidiaryIds[0]!)||typeof context.subsidiary.name!=='string'||!record(context.localCurrency)||!validId(context.localCurrency.id)||typeof context.localCurrency.code!=='string'||context.localCurrency.code===''||(context.localCurrency.name!==null&&typeof context.localCurrency.name!=='string'))return incomplete();
 if(context.dateFrom!==filters.dateFrom||context.dateTo!==filters.dateTo||typeof context.generatedAt!=='string'||!Number.isFinite(Date.parse(context.generatedAt))||JSON.stringify(canonical(context.filters))!==JSON.stringify(canonical(filters)))return incomplete();
 if(filters.bookId===null){if(context.bookId!==null||context.book!==null)return incomplete();}
 else if(!idEquals(context.bookId,filters.bookId)||!record(context.book)||!idEquals(context.book.id,filters.bookId)||typeof context.book.name!=='string')return incomplete();
 const ids=new Set<string>();
 for(const row of input.rows){
  if(!record(row)||!validId(row.id)||ids.has(String(row.id))||!validId(row.account_id))return incomplete();
  ids.add(String(row.id));
  if(typeof row.account_number!=='string'||typeof row.account_name!=='string'||typeof row.nature!=='string'||!calendarDate(row.date)||row.date<filters.dateFrom||row.date>filters.dateTo)return incomplete();
  for(const key of ['debit','credit','running_balance','opening_balance','account_debit_total','account_credit_total','account_final_balance'])if(!finite(row[key]))return incomplete();
  if(row.original_currency_code!==null&&typeof row.original_currency_code!=='string')return incomplete();
  for(const key of ['original_exchange_rate','original_debit','original_credit'])if(!nullableFinite(row[key]))return incomplete();
 }
 return input as unknown as GeneralLedgerExportSnapshot;
}
/** One authorized RPC and one database snapshot; never assembles live pages. */
export async function collectGeneralLedgerExportData(authorization:string,input:unknown):Promise<GeneralLedgerExportSnapshot> {
 await requireReportAccess(authorization);
 const filters=cleanGeneralLedgerExportFilters(input),config=getSupabaseConfig();
 if(!config)throw Object.assign(new Error('Supabase no está configurado.'),{status:500});
 const response=await fetchReportSupabase(new URL('/rest/v1/rpc/run_general_ledger_export',config.url),{
  method:'POST',headers:{apikey:config.anonKey,Authorization:authorization,'Content-Type':'application/json'},body:JSON.stringify({p_filters:filters})});
 let result:unknown;
 try{const raw=await response.text();result=raw?JSON.parse(raw):null;}catch{throw Object.assign(new Error('No fue posible leer la exportación del Libro Mayor.'),{status:502});}
 if(!response.ok){
  const code=record(result)&&typeof result.code==='string'?result.code:'';
  const status=code==='42501'?403:['22023','22P02','22003','22007','22008'].includes(code)?400:code==='57014'?504:500;
  throw Object.assign(new Error(status===403?'El rol o la subsidiaria no permiten exportar este Libro Mayor.':status===400?'Revise la subsidiaria, las fechas y los filtros del Libro Mayor.':status===504?'La exportación del Libro Mayor superó el tiempo disponible. Reduzca el rango de fechas y vuelva a solicitarla.':'No fue posible generar la exportación completa del Libro Mayor.'),{status});
 }
 return validateSnapshot(result,filters);
}
