import {getSupabaseConfig} from '../../core/database/supabase.client.js';
import {requireReconciliationAccess} from '../banking-catalogs/bank-reconciliation-security.service.js';
import {fetchReportSupabase,requireReportAccess} from './report-access.service.js';

type DraftAction='preview'|'delete';
const fingerprint=/^[a-f0-9]{64}$/;
const positiveId=(value:unknown):value is number=>typeof value==='number'&&Number.isSafeInteger(value)&&value>0;
function fail(message:string,status:number):never{throw Object.assign(new Error(message),{status});}
function cleanInput(action:DraftAction,input:unknown){
 if(action!=='preview'&&action!=='delete')return fail('La acción del borrador no es válida.',400);
 if(!input||typeof input!=='object'||Array.isArray(input))return fail('Revise la cuenta, la fecha y el borrador seleccionado.',400);
 const value=input as Record<string,unknown>,fields=['p_bank_account_id','p_cutoff','p_reconciliation_id',...(action==='delete'?['p_expected_fingerprint']:[])];
 if(Object.keys(value).some(key=>!fields.includes(key))||fields.some(key=>!Object.hasOwn(value,key))||!positiveId(value.p_bank_account_id)||!positiveId(value.p_reconciliation_id))return fail('Revise la cuenta, la fecha y el borrador seleccionado.',400);
 const date=value.p_cutoff;
 if(typeof date!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(date)||date.startsWith('0000-')||!Number.isFinite(Date.parse(date+'T00:00:00.000Z'))||new Date(date+'T00:00:00.000Z').toISOString().slice(0,10)!==date)return fail('Seleccione una fecha de conciliación válida.',400);
 if(action==='delete'&&(typeof value.p_expected_fingerprint!=='string'||!fingerprint.test(value.p_expected_fingerprint)))return fail('Vuelva a revisar el borrador antes de eliminarlo.',400);
 return{p_bank_account_id:value.p_bank_account_id,p_cutoff:date,p_reconciliation_id:value.p_reconciliation_id,...(action==='delete'?{p_expected_fingerprint:value.p_expected_fingerprint}:{})};
}
function safeResult(action:DraftAction,value:unknown,input:ReturnType<typeof cleanInput>){
 const invalid=()=>fail('No fue posible verificar la respuesta del borrador. Actualice el historial antes de continuar.',502);
 if(!value||typeof value!=='object'||Array.isArray(value))return invalid();const r=value as Record<string,unknown>;
 if(r.reconciliationId!==input.p_reconciliation_id||r.bankAccountId!==input.p_bank_account_id||r.cutoff!==input.p_cutoff||!positiveId(r.fiscalPeriodId))return invalid();
 const identity={reconciliationId:r.reconciliationId,bankAccountId:r.bankAccountId,cutoff:r.cutoff,fiscalPeriodId:r.fiscalPeriodId};
 if(action==='delete'){if(r.success!==true||r.deleted!==true)return invalid();return{success:true,deleted:true,...identity};}
 if(!positiveId(r.subsidiaryId)||typeof r.status!=='string'||typeof r.canDelete!=='boolean'||typeof r.matchCount!=='number'||!Number.isSafeInteger(r.matchCount)||r.matchCount<0)return invalid();
 if(r.fingerprint!==null&&(typeof r.fingerprint!=='string'||!fingerprint.test(r.fingerprint)))return invalid();
 if(r.blockedReason!==null&&(typeof r.blockedReason!=='string'||!/^[A-Z0-9_]{1,80}$/.test(r.blockedReason)))return invalid();
 const labels=Object.fromEntries(['bankName','accountNumber','currencyCode','periodName'].map(key=>[key,typeof r[key]==='string'?r[key]:null]));
 if(r.canDelete&&(r.status!=='ABIERTA'||r.matchCount!==0||typeof r.fingerprint!=='string'||r.blockedReason!==null||Object.values(labels).some(text=>!text)))return invalid();
 if(!r.canDelete&&!r.blockedReason)return invalid();
 return{...identity,...labels,subsidiaryId:r.subsidiaryId,status:r.status,canDelete:r.canDelete,matchCount:r.matchCount,blockedReason:r.blockedReason,fingerprint:r.fingerprint};
}

export async function bankReconciliationDraftDeleteAction(authorization:string,action:DraftAction,input:unknown,onMutationSettled?:()=>void){
 await requireReportAccess(authorization);
 await requireReconciliationAccess(authorization,'banking:bank-reconciliations','delete');
 const cleaned=cleanInput(action,input),config=getSupabaseConfig();if(!config)return fail('Supabase no está configurado.',500);
 const rpc=action==='preview'?'preview_bank_reconciliation_draft_delete':'delete_bank_reconciliation_draft';
 try{
  const response=await fetchReportSupabase(new URL('/rest/v1/rpc/'+rpc,config.url),{method:'POST',headers:{apikey:config.anonKey,Authorization:authorization,'Content-Type':'application/json'},body:JSON.stringify(cleaned)});
  let value:unknown;try{const raw=await response.text();value=raw?JSON.parse(raw):null;}catch{return fail('No fue posible leer la respuesta del borrador. Actualice el historial antes de continuar.',502);}
  if(!response.ok){const code=value&&typeof value==='object'&&!Array.isArray(value)&&'code'in value?String(value.code):'';
   if(code==='42501')return fail('No tiene permiso para eliminar este borrador.',403);
   if(['PBD01','55000','40001','40P01','55P03','57014'].includes(code))return fail('El borrador cambió, está protegido o ya no está disponible. Actualice el historial y vuelva a revisarlo.',409);
   if(['22023','22P02','22003','22007','22008'].includes(code))return fail('Revise la cuenta, la fecha y el borrador seleccionado.',400);
   return fail('No fue posible procesar el borrador. Actualice el historial antes de continuar.',response.status>=500?502:422);
  }
  return safeResult(action,value,cleaned);
 }finally{
  // An authenticated, validated mutation attempt can commit before a transport
  // error. Clear cached history after any such attempt, never retry the delete.
  if(action==='delete')onMutationSettled?.();
 }
}
