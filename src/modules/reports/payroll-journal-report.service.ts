import {getSupabaseConfig} from '../../core/database/supabase.client.js';
import {fetchReportSupabase,requireReportAccess} from './report-access.service.js';
export async function runPayrollJournalReport(auth:string,input:Record<string,unknown>){
 await requireReportAccess(auth);
 const bad=()=>Object.assign(new Error('Seleccione fechas dentro del mismo mes y un tipo de asiento válido.'),{status:400});
 if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(k=>!['dateFrom','dateTo','transactionType','accountId','noteMode'].includes(k)))throw bad();
 const from=String(input.dateFrom||''),to=String(input.dateTo||'');
 for(const value of[from,to]){const d=new Date(value+'T00:00:00Z');if(!/^\d{4}-\d{2}-\d{2}$/.test(value)||!Number.isFinite(d.getTime())||d.toISOString().slice(0,10)!==value)throw bad();}
 if(from>to||from.slice(0,7)!==to.slice(0,7)||!['ALL','ASI_NOM','ASI_LIQ'].includes(String(input.transactionType??'ALL')))throw bad();
 if(!['LINE','HEADER'].includes(String(input.noteMode??'HEADER')))throw bad();
 if(input.accountId!=null&&input.accountId!==''&&!/^[1-9]\d{0,18}$/.test(String(input.accountId)))throw bad();
 const c=getSupabaseConfig();if(!c)throw Error('Supabase no está configurado.');
 const r=await fetchReportSupabase(new URL('/rest/v1/rpc/run_payroll_journal_report',c.url),{method:'POST',headers:{apikey:c.anonKey,Authorization:auth,'Content-Type':'application/json'},body:JSON.stringify({p_filters:input})});
 const data=await r.json();if(!r.ok){const status=data?.code==='42501'?403:['22023','22007','22008','22P02','22003'].includes(data?.code)?400:500;throw Object.assign(new Error(status===403?'No tiene acceso a la subsidiaria o cuenta.':status===400?'Revise las fechas, el tipo de asiento y la cuenta.':'No fue posible generar el reporte de asientos de nómina.'),{status});}return data;
}
