import{fetchSupabase,getSupabaseConfig}from'../../core/database/supabase.client.js';

const map:Record<string,string>={options:'opening_balance_options',validate:'opening_balance_validate',preview:'opening_balance_preview',post:'opening_balance_post',reverse:'opening_balance_reverse'};

function delimiter(line:string){
 let comma=0,semicolon=0,quoted=false;
 for(let i=0;i<line.length;i++){
  if(line[i]==='"')quoted=!quoted;
  else if(!quoted&&line[i]===',')comma++;
  else if(!quoted&&line[i]===';')semicolon++;
 }
 return semicolon>comma?';':',';
}

function rows(text:string){
 let source=text.replace(/^\uFEFF/,'');
 const excelSeparator=source.match(/^sep=([;,])(?:\r?\n|$)/i),separator=excelSeparator?.[1]??delimiter(source.split(/\r?\n/,1)[0]??''),records:string[][]=[];
 if(excelSeparator)source=source.slice(excelSeparator[0].length);
 let record:string[]=[],value='',quoted=false;
 for(let index=0;index<source.length;index++){
  const character=source[index];
  if(character==='"'){
   if(quoted&&source[index+1]==='"'){value+='"';index++;}else quoted=!quoted;
  }else if(character===separator&&!quoted){record.push(value.trim());value='';}
  else if((character==='\n'||character==='\r')&&!quoted){
   if(character==='\r'&&source[index+1]==='\n')index++;
   record.push(value.trim());value='';
   if(record.some(cell=>cell!==''))records.push(record);record=[];
  }else value+=character;
 }
 if(quoted)throw Error('El archivo CSV contiene un campo entre comillas sin cerrar.');
 record.push(value.trim());if(record.some(cell=>cell!==''))records.push(record);
 if(records.length<2)return[];
 const headers=records[0].map(header=>header.trim().toLowerCase());
 if(headers.some(header=>!header))throw Error('El archivo CSV contiene una columna sin encabezado.');
 if(new Set(headers).size!==headers.length)throw Error('El archivo CSV contiene encabezados duplicados.');
 return records.slice(1).map((values,index)=>{
  if(values.slice(headers.length).some(value=>value!==''))throw Error(`CSV fila ${index+2}: contiene más columnas que el encabezado.`);
  return{row:index+2,data:Object.fromEntries(headers.map((header,column)=>[header,values[column]??'']))};
 });
}

function amount(value:unknown){
 const raw=String(value??'').trim().replace(/\s/g,'');
 if(!raw)return'';
 if(/^-?[1-9]\d{0,2}(?:[.,]\d{3})+$/.test(raw))throw Error(`El importe "${raw}" es ambiguo. Escríbalo sin separadores de miles, por ejemplo 1234.00.`);
 const normalized=raw.includes(',')&&raw.includes('.')
  ?(raw.lastIndexOf(',')>raw.lastIndexOf('.')?raw.replace(/\./g,'').replace(',','.'):raw.replace(/,/g,''))
  :raw.includes(',')&&/^-?\d{1,3}(,\d{3})+$/.test(raw)?raw.replace(/,/g,''):raw.replace(',','.');
 if(!Number.isFinite(Number(normalized)))throw Error(`El importe "${raw}" no es numérico.`);
 return normalized;
}

function accountingCsv(text:string,type:string){
 return rows(text).map(({row,data:x})=>{
  if(type!=='GL'&&(!x.identificacion_tercero||!x.numero_documento))throw Error(`${type} fila ${row}: complete tercero y documento.`);
  const balance=x.saldo||x.monto||'';
  return{sourceType:type,sourceRow:row,account:x.cuenta,documentNumber:x.numero_documento||'',issueDate:x.fecha_emision||'',dueDate:x.fecha_vencimiento||'',currency:(x.moneda||'').toUpperCase(),debit:amount(x.debito||(type==='AR'?balance:'')),credit:amount(x.credito||(type==='AP'?balance:'')),entityTaxId:x.identificacion_tercero||'',costCenter:x.centro_costos||'',location:x.sucursal||'',project:x.proyecto||'',note:x.nota||''};
 });
}

function fixedAssetCsv(text:string){
 const parsed=rows(text);
 if(!parsed.length)return[];
 const required=['nombre_activo','codigo_categoria','fecha_compra','fecha_en_servicio','costo_historico','depreciacion_acumulada','meses_depreciados','ubicacion','estado','moneda'];
 for(const field of required)if(!(field in parsed[0].data))throw Error(`La plantilla de Activos Fijos no contiene la columna ${field}.`);
 return parsed.map(({row,data:x})=>({
  sourceRow:row,assetNumber:x.codigo_activo||'AUTO',name:x.nombre_activo,categoryCode:(x.codigo_categoria||'').toUpperCase(),serial:x.numero_serie||'',description:x.descripcion||'',purchaseDate:x.fecha_compra||'',serviceDate:x.fecha_en_servicio||'',cost:amount(x.costo_historico),accumulatedDepreciation:amount(x.depreciacion_acumulada),bookValue:amount(x.valor_en_libros),depreciatedMonths:x.meses_depreciados||'0',location:x.ubicacion||'',departmentType:x.tipo_departamento||'',department:x.departamento||'',costCenter:x.centro_costos||'',className:x.clase||'',status:(x.estado||'ACTIVO').toUpperCase(),currency:(x.moneda||'').toUpperCase(),note:x.nota||''
 }));
}

async function rpc(auth:string,name:string,p:Record<string,unknown>={}){
 const config=getSupabaseConfig();if(!config)throw Error('Supabase no configurado.');
 const response=await fetchSupabase(new URL(`/rest/v1/rpc/${name}`,config.url),{method:'POST',headers:{apikey:config.anonKey,Authorization:auth,'Content-Type':'application/json'},body:JSON.stringify(p)}),raw=await response.text(),result=raw?JSON.parse(raw):null;
 if(!response.ok)throw Error(result?.message||'No fue posible procesar la apertura.');return result;
}

export function openingBalances(auth:string,action:string,p:Record<string,unknown>={}){
 if(action==='validate'){
  const financialRows=[...accountingCsv(String(p.gl||''),'GL'),...accountingCsv(String(p.ar||''),'AR'),...accountingCsv(String(p.ap||''),'AP')];
  const assets=fixedAssetCsv(String(p.fa||''));
  if(!financialRows.length&&!assets.length)throw Error('Cargue al menos una plantilla con datos.');
  return rpc(auth,map.validate,{p:{expectedSubsidiaryId:p.expectedSubsidiaryId,openingDate:p.openingDate,loadType:p.loadType,transitionAccountId:p.transitionAccountId,rows:financialRows,assets}});
 }
 const fn=map[action];if(!fn)throw Error('Acción inválida.');
 return rpc(auth,fn,action==='preview'||action==='post'||action==='reverse'?{p_run_id:Number(p.runId)}:{});
}
