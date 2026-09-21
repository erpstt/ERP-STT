import {fetchSupabase,getSupabaseConfig} from '../../core/database/supabase.client.js';
const functions:Record<string,string>={options:'budget_options',headers:'budget_save_header',lines:'budget_save_lines',action:'budget_header_action',transfers:'budget_transfer_request',override:'budget_override_action','check-availability':'budget_check_availability','execution-report':'budget_report'};
export function parseBudgetCsv(text:string):string[][]{
 const rows:string[][]=[];let row:string[]=[],field='',quoted=false;
 for(let i=0;i<text.length;i++){const c=text[i];if(c==='"'){if(quoted&&text[i+1]==='"'){field+='"';i++;}else quoted=!quoted;}else if(c===','&&!quoted){row.push(field);field='';}else if((c==='\r'||c==='\n')&&!quoted){if(c==='\r'&&text[i+1]==='\n')i++;row.push(field);if(row.some(v=>v.trim()))rows.push(row);row=[];field='';}else field+=c;}
 if(quoted)throw Error('El CSV contiene comillas sin cerrar.');row.push(field);if(row.some(v=>v.trim()))rows.push(row);return rows;
}
export async function budgetAction(auth:string,action:string,input:Record<string,unknown>){
 if(action==='import-excel'){
  const encoded=String(input.base64||'');if(encoded.length>7_000_000)throw Error('El archivo supera 5 MB.');
  const buffer=Buffer.from(encoded,'base64');let matrix:unknown[][];
  if(String(input.fileName).toLowerCase().endsWith('.csv'))matrix=parseBudgetCsv(buffer.toString('utf8').replace(/^\uFEFF/,''));
  else if(String(input.fileName).toLowerCase().endsWith('.xlsx')){const {readSheet}=await import('read-excel-file/node');matrix=await readSheet(buffer,1);}else throw Error('Seleccione un archivo CSV o XLSX.');
  const headers=(matrix.shift()||[]).map(v=>String(v??'').trim().toLowerCase());
  for(const required of ['cuenta','mes','monto'])if(!headers.includes(required))throw Error(`Falta la columna ${required}.`);
  if(matrix.length>12000)throw Error('Importe hasta 12.000 líneas.');
  const lines=matrix.filter(r=>r.some(v=>v!==null&&v!=='')).map((r,index)=>{const get=(key:string)=>r[headers.indexOf(key)]??'';const amount=String(get('monto')).trim(),month=String(get('mes')).trim();if(!/^\d+(\.\d{1,6})?$/.test(amount)||!/^\d{4}-(0[1-9]|1[0-2])$/.test(month))throw Error(`Fila ${index+2}: use mes YYYY-MM y monto positivo sin separadores de miles.`);return{account:String(get('cuenta')).trim(),centerId:String(get('centro_id')).trim(),month,amount};});
  if(lines.some(line=>line.centerId))throw Error('El presupuesto es general por sociedad. Use la nueva plantilla sin centros de costo.');
  input={id:input.id,revision:input.revision,lines};action='lines';
 }
 const fn=functions[action];if(!fn)throw Error('Acción presupuestaria inválida.');
 const config=getSupabaseConfig();if(!config)throw Error('Supabase no está configurado.');
 const response=await fetchSupabase(new URL(`/rest/v1/rpc/${fn}`,config.url),{method:'POST',headers:{apikey:config.anonKey,Authorization:auth,'Content-Type':'application/json'},body:JSON.stringify(action==='options'?{}:{p:input})});
 const data=await response.json();if(!response.ok){const error=new Error(data?.message||'No fue posible completar la operación presupuestaria.')as Error&{status?:number};error.status=data?.code==='PT422'?422:data?.code==='42501'?403:400;throw error;}return data;
}
