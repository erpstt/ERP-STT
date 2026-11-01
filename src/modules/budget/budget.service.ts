import{assertBudgetAccess,budgetRpc}from'./budget-security.service.js';
const functions:Record<string,string>={options:'budget_options',headers:'budget_save_header',lines:'budget_save_lines',action:'budget_header_action',transfers:'budget_transfer_request',override:'budget_override_action','check-availability':'budget_check_availability','execution-report':'budget_report'};
export function parseBudgetCsv(text:string):string[][]{
 const rows:string[][]=[];let row:string[]=[],field='',quoted=false;
 for(let i=0;i<text.length;i++){const c=text[i];if(c==='"'){if(quoted&&text[i+1]==='"'){field+='"';i++;}else quoted=!quoted;}else if(c===','&&!quoted){row.push(field);field='';}else if((c==='\r'||c==='\n')&&!quoted){if(c==='\r'&&text[i+1]==='\n')i++;row.push(field);if(row.some(v=>v.trim()))rows.push(row);row=[];field='';}else field+=c;}
 if(quoted)throw Error('El CSV contiene comillas sin cerrar.');row.push(field);if(row.some(v=>v.trim()))rows.push(row);return rows;
}
export async function budgetAction(auth:string,action:string,input:Record<string,unknown>){
 await assertBudgetAccess(auth,action,input);
 if(input.id!==undefined&&input.id!==null&&input.id!==''&&(!Number.isSafeInteger(Number(input.id))||Number(input.id)<=0))throw Object.assign(Error('Identificador inválido.'),{status:400});
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
 return budgetRpc(auth,fn,action==='options'?{}:{p:input});
}
