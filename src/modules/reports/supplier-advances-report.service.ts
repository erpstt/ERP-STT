import {getSupabaseConfig} from '../../core/database/supabase.client.js';
import {fetchReportSupabase,requireReportAccess} from './report-access.service.js';

const fields=new Set(['subsidiaryIds','dateTo','bookId','supplierId','currencyId','onlyNonzero','page','pageSize']);
function invalid(message='Revise los filtros del informe de adelantos a proveedores.'):never{throw Object.assign(new Error(message),{status:400});}
function positiveId(value:unknown):number{
 if((typeof value!=='number'&&typeof value!=='string')||!(/^[1-9]\d*$/).test(String(value)))return invalid();
 const id=Number(value);if(!Number.isSafeInteger(id)||id<=0)return invalid();return id;
}
function optionalId(value:unknown){return value===undefined||value===null||value===''?null:positiveId(value);}
function cleanFilters(value:unknown){
 if(!value||typeof value!=='object'||Array.isArray(value))return invalid();
 const input=value as Record<string,unknown>;
 if(Object.keys(input).some(key=>!fields.has(key)))return invalid();
 const own=(key:string)=>Object.hasOwn(input,key)?input[key]:undefined;
 const subsidiaries=own('subsidiaryIds');if(!Array.isArray(subsidiaries)||subsidiaries.length!==1)return invalid('Seleccione una subsidiaria para consultar sus adelantos.');
 const date=own('dateTo');if(typeof date!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(date)||date.startsWith('0000-'))return invalid('Indique una fecha de corte válida.');
 const parsed=new Date(date+'T00:00:00.000Z');if(!Number.isFinite(parsed.getTime())||parsed.toISOString().slice(0,10)!==date)return invalid('Indique una fecha de corte válida.');
 const onlyNonzero=own('onlyNonzero');if(onlyNonzero!==undefined&&typeof onlyNonzero!=='boolean')return invalid();
 const page=own('page')===undefined?1:positiveId(own('page')),pageSize=own('pageSize')===undefined?50:positiveId(own('pageSize'));
 if(page>2_147_483_647||pageSize>250)return invalid();
 // Legacy clients may still send this boolean. The report always excludes
 // fully applied sources; a caller cannot opt into settled advance history.
 return{subsidiaryIds:[positiveId(subsidiaries[0])],dateTo:date,bookId:optionalId(own('bookId')),supplierId:optionalId(own('supplierId')),currencyId:optionalId(own('currencyId')),onlyNonzero:true,page,pageSize};
}
export async function runSupplierAdvancesReport(authorization:string,filters:unknown){
 await requireReportAccess(authorization);
 const cleaned=cleanFilters(filters),config=getSupabaseConfig();if(!config)throw Object.assign(new Error('Supabase no está configurado.'),{status:500});
 const response=await fetchReportSupabase(new URL('/rest/v1/rpc/run_supplier_advances_report',config.url),{method:'POST',headers:{apikey:config.anonKey,Authorization:authorization,'Content-Type':'application/json'},body:JSON.stringify({p_filters:cleaned})});
 let result:unknown;try{const raw=await response.text();result=raw?JSON.parse(raw):null;}catch{throw Object.assign(new Error('No fue posible leer el informe de adelantos a proveedores.'),{status:502});}
 if(!response.ok){const code=typeof result==='object'&&result&&!Array.isArray(result)&&'code'in result?String(result.code):'';const status=code==='42501'?403:['22023','22P02','22003','22007','22008'].includes(code)?400:500;throw Object.assign(new Error(status===403?'El rol activo no puede consultar estos adelantos.':status===400?'Revise la subsidiaria, la fecha de corte y los filtros del informe.':'No fue posible generar el informe de adelantos a proveedores.'),{status});}
 if(!result||typeof result!=='object'||Array.isArray(result)||!('reportMode'in result)||result.reportMode!=='UNAPPLIED_ADVANCES')throw Object.assign(new Error('El informe de adelantos pendientes está incompleto. Vuelva a generarlo.'),{status:502});
 return result as Record<string,unknown>;
}
