import {getSupabaseConfig} from '../../core/database/supabase.client.js';
import {fetchReportSupabase,requireReportAccess} from './report-access.service.js';

const fields=new Set(['subsidiaryIds','dateFrom','dateTo','bookId','accountId','currencyId','departmentId','costCenterId','onlyNonzero','page','pageSize']);
function invalid(message='Revise los filtros del informe de gastos acumulados por pagar.'):never{throw Object.assign(new Error(message),{status:400});}
function positiveId(value:unknown):number{
 if((typeof value!=='number'&&typeof value!=='string')||!(/^[1-9]\d*$/).test(String(value)))return invalid();
 const id=Number(value);if(!Number.isSafeInteger(id)||id<=0)return invalid();return id;
}
function optionalId(value:unknown){return value===undefined||value===null||value===''?null:positiveId(value);}
function calendarDate(value:unknown):string{
 if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(value)||value.startsWith('0000-'))return invalid('Indique un rango de fechas válido.');
 const parsed=new Date(value+'T00:00:00.000Z');if(!Number.isFinite(parsed.getTime())||parsed.toISOString().slice(0,10)!==value)return invalid('Indique un rango de fechas válido.');
 return value;
}
function cleanFilters(value:unknown){
 if(!value||typeof value!=='object'||Array.isArray(value))return invalid();
 const input=value as Record<string,unknown>;
 if(Object.keys(input).some(key=>!fields.has(key)))return invalid();
 const own=(key:string)=>Object.hasOwn(input,key)?input[key]:undefined;
 const subsidiaries=own('subsidiaryIds');if(!Array.isArray(subsidiaries)||subsidiaries.length!==1)return invalid('Seleccione una subsidiaria para consultar sus gastos acumulados por pagar.');
 const dateFrom=calendarDate(own('dateFrom')),dateTo=calendarDate(own('dateTo'));if(dateFrom>dateTo)return invalid('La fecha inicial no puede ser posterior a la fecha final.');
 const onlyNonzero=own('onlyNonzero');if(onlyNonzero!==undefined&&typeof onlyNonzero!=='boolean')return invalid();
 const page=own('page')===undefined?1:positiveId(own('page')),pageSize=own('pageSize')===undefined?50:positiveId(own('pageSize'));
 if(page>2_147_483_647||pageSize>250)return invalid();
 return{subsidiaryIds:[positiveId(subsidiaries[0])],dateFrom,dateTo,bookId:optionalId(own('bookId')),accountId:optionalId(own('accountId')),currencyId:optionalId(own('currencyId')),departmentId:optionalId(own('departmentId')),costCenterId:optionalId(own('costCenterId')),onlyNonzero:onlyNonzero??true,page,pageSize};
}
export async function runAccruedPayrollPayablesReport(authorization:string,filters:unknown){
 await requireReportAccess(authorization);
 const cleaned=cleanFilters(filters),config=getSupabaseConfig();if(!config)throw Object.assign(new Error('Supabase no está configurado.'),{status:500});
 const response=await fetchReportSupabase(new URL('/rest/v1/rpc/run_accrued_payroll_payables_report',config.url),{method:'POST',headers:{apikey:config.anonKey,Authorization:authorization,'Content-Type':'application/json'},body:JSON.stringify({p_filters:cleaned})});
 let result:unknown;try{const raw=await response.text();result=raw?JSON.parse(raw):null;}catch{throw Object.assign(new Error('No fue posible leer el informe de gastos acumulados por pagar.'),{status:502});}
 if(!response.ok){const code=typeof result==='object'&&result&&!Array.isArray(result)&&'code'in result?String(result.code):'';const status=code==='42501'?403:['22023','22P02','22003','22007','22008'].includes(code)?400:500;throw Object.assign(new Error(status===403?'El rol activo no puede consultar estos gastos acumulados.':status===400?'Revise la subsidiaria, las fechas y los filtros del informe.':'No fue posible generar el informe de gastos acumulados por pagar.'),{status});}
 if(!result||typeof result!=='object'||Array.isArray(result))throw Object.assign(new Error('El informe de gastos acumulados por pagar está incompleto.'),{status:502});
 return result as Record<string,unknown>;
}
