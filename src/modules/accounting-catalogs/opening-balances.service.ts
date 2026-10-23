import{fetchSupabase,getSupabaseConfig}from'../../core/database/supabase.client.js';

const map:Record<string,string>={options:'opening_balance_options',validate:'opening_balance_validate',preview:'opening_balance_preview',post:'opening_balance_post',reverse:'opening_balance_reverse'};
const MAX_OPENING_FILE_BYTES=5_000_000;
const MAX_OPENING_ROWS=50_000;
const MAX_OPENING_COLUMNS=200;

type OpeningFileError={code:string;message:string;row?:number;rows?:number[];column?:number;columnLetter?:string;field?:string;value?:string;suggestion?:string};
export type OpeningBalanceFileValidation={key:string;label:string;fileName:string;errors:OpeningFileError[]};

class OpeningFileParseError extends Error{
 constructor(message:string,public readonly detail:OpeningFileError){super(message);this.name='OpeningFileParseError';}
}

export class OpeningBalanceFilesValidationError extends Error{
 readonly status=422;
 readonly code='OPENING_BALANCE_FILES_INVALID';
 constructor(public readonly files:OpeningBalanceFileValidation[]){
  super(`${files.length} ${files.length===1?'archivo requiere':'archivos requieren'} corrección antes de continuar.`);
  this.name='OpeningBalanceFilesValidationError';
 }
}

function columnLetter(position:number){
 let value=position,result='';
 while(value>0){value--;result=String.fromCharCode(65+(value%26))+result;value=Math.floor(value/26);}
 return result;
}

function columnReference(position:number){return`${columnLetter(position)} (${position})`;}

function emptyHeaderFailure(row:number,indexes:number[]){
 const references=indexes.map(index=>columnReference(index+1));
 const message=`Fila ${row}: ${indexes.length===1?'la columna':'las columnas'} ${references.join(', ')} ${indexes.length===1?'no tiene':'no tienen'} encabezado.`;
 const detailMessage=indexes.length===1?'El encabezado de esta columna está vacío o no contiene un nombre válido.':`Hay encabezados vacíos o inválidos en las columnas ${references.join(', ')}.`;
 return new OpeningFileParseError(message,{code:'EMPTY_HEADER',message:detailMessage,row,column:indexes[0]+1,columnLetter:columnLetter(indexes[0]+1),suggestion:'Escriba un encabezado o elimine la columna vacía de la plantilla.'});
}

function duplicateHeaderFailure(row:number,headers:string[]){
 const duplicates=[...new Set(headers.filter((header,index)=>headers.indexOf(header)!==index))];
 const groups=duplicates.map(header=>`"${header}" en ${headers.map((value,index)=>value===header?columnReference(index+1):'').filter(Boolean).join(' y ')}`);
 const message=`Fila ${row}: ${duplicates.length===1?'el encabezado está duplicado':'los encabezados están duplicados'}: ${groups.join('; ')}.`;
 const first=headers.indexOf(duplicates[0])+1;
 return new OpeningFileParseError(message,{code:'DUPLICATE_HEADER',message:`${duplicates.length===1?'El encabezado está repetido':'Hay encabezados repetidos'}: ${groups.join('; ')}.`,row,column:first,columnLetter:columnLetter(first),suggestion:'Conserve una sola columna para cada encabezado.'});
}

function extraColumnFailure(row:number,position:number){
 const message=`Fila ${row}: la columna ${columnReference(position)} contiene datos, pero no existe en el encabezado.`;
 return new OpeningFileParseError(message,{code:'EXTRA_COLUMN',message:'Esta columna contiene datos, pero no existe en el encabezado.',row,column:position,columnLetter:columnLetter(position),suggestion:'Agregue el encabezado correspondiente o elimine esa columna adicional.'});
}

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
 if(Buffer.byteLength(text,'utf8')>MAX_OPENING_FILE_BYTES)throw Error('El archivo de saldos iniciales supera 5 MB.');
 if(text.includes('\0'))throw Error('El archivo CSV no contiene texto válido.');
 let source=text.replace(/^\uFEFF/,'');
 const excelSeparator=source.match(/^(?:[ \t]*(?:\r\n|\n|\r))*[ \t]*sep=([;,])[ \t]*(?:\r\n|\n|\r|$)/i);
 const sourceStartLine=excelSeparator?1+(excelSeparator[0].match(/\r\n|\n|\r/g)?.length??0):1;
 if(excelSeparator)source=source.slice(excelSeparator[0].length);
 const firstContentLine=source.split(/\r\n|\n|\r/).find(line=>line.trim()!=='')??'';
 const separator=excelSeparator?.[1]??delimiter(firstContentLine),records:{values:string[];row:number}[]=[];
 let record:string[]=[],value='',quoted=false,physicalLine=sourceStartLine,recordStartLine=physicalLine;
 for(let index=0;index<source.length;index++){
  const character=source[index];
  if(character==='"'){
   if(quoted&&source[index+1]==='"'){value+='"';index++;}else quoted=!quoted;
  }else if(character===separator&&!quoted){record.push(value.trim());value='';}
  else if((character==='\n'||character==='\r')&&!quoted){
   if(character==='\r'&&source[index+1]==='\n')index++;
   record.push(value.trim());value='';
   if(record.some(cell=>cell!=='')){
    records.push({values:record,row:recordStartLine});
    if(records.length>MAX_OPENING_ROWS+1)throw Error(`El archivo CSV supera el límite de ${MAX_OPENING_ROWS.toLocaleString('es-CR')} filas.`);
   }
   record=[];physicalLine++;recordStartLine=physicalLine;
  }else{
   value+=character;
   if(character==='\n'||(character==='\r'&&source[index+1]!=='\n'))physicalLine++;
  }
 }
 if(quoted)throw Error('El archivo CSV contiene un campo entre comillas sin cerrar.');
 record.push(value.trim());if(record.some(cell=>cell!==''))records.push({values:record,row:recordStartLine});
 if(!records.length)return[];
 if(records.length>MAX_OPENING_ROWS+1)throw Error(`El archivo CSV supera el límite de ${MAX_OPENING_ROWS.toLocaleString('es-CR')} filas.`);
 const headerRecord=records[0],headerRow=headerRecord.row;
 if(headerRecord.values.length>MAX_OPENING_COLUMNS)throw Error(`El archivo CSV supera el límite de ${MAX_OPENING_COLUMNS} columnas.`);
 const headers=headerRecord.values.map(header=>header.trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[^a-z0-9]+/g,'_').replace(/^_+|_+$/g,''));
 const emptyHeaders=headers.flatMap((header,index)=>header?[]:[index]);
 if(emptyHeaders.length)throw emptyHeaderFailure(headerRow,emptyHeaders);
 if(new Set(headers).size!==headers.length)throw duplicateHeaderFailure(headerRow,headers);
 if(records.length<2)return[];
 return records.slice(1).map(({values,row})=>{
  if(values.length>MAX_OPENING_COLUMNS)throw Error(`CSV fila ${row}: supera el límite de ${MAX_OPENING_COLUMNS} columnas.`);
  const extraIndex=values.findIndex((value,column)=>column>=headers.length&&value!=='');
  if(extraIndex>=0)throw extraColumnFailure(row,extraIndex+1);
  return{row,data:Object.fromEntries(headers.map((header,column)=>[header,values[column]??'']))};
 });
}

type ParsedRow={row:number;data:Record<string,string>};
type PendingLine={
 sourceRow:number;account:string;debit:string;credit:string;debitFx:string;creditFx:string;isControlLine:boolean;
 department:string;costCenter:string;className:string;financialCreditor:string;relatedCompany:string;location:string;note:string;
};
export type OpeningPendingItem={
 reference:string;periodType:'ACTUAL'|'ANTERIOR';originDate:string;entityTaxId:string;currency:string;exchangeRate:string;serviceMonth:string;serviceCountry:string;note:string;supportUrl:string;supportLink:string;lines:PendingLine[];
};
export type OpeningBankItem={
 sourceRow:number;bankCode:string;accountNumber:string;currency:string;recordType:'SALDO_CONCILIADO'|'DEPOSITO_EN_TRANSITO'|'CHEQUE_EN_TRANSITO';
 transactionDate:string;valueDate:string;reference:string;beneficiary:string;description:string;originalAmount:string;localEquivalent:string;
};

function normalizedHeader(value:unknown){
 return String(value??'').trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[^a-z0-9]+/g,'_').replace(/^_+|_+$/g,'');
}

function spreadsheetCell(value:unknown){
 if(value instanceof Date&&!Number.isNaN(value.getTime()))return value.toISOString().slice(0,10);
 if(typeof value==='number')return Number.isFinite(value)?String(value):'';
 if(typeof value==='boolean')return value?'SI':'NO';
 return String(value??'').trim();
}

function spreadsheetRows(matrix:unknown[][],label='Pendientes de Facturar'):ParsedRow[]{
 if(matrix.length>MAX_OPENING_ROWS+1)throw Error(`La hoja de ${label} supera el límite de ${MAX_OPENING_ROWS.toLocaleString('es-CR')} filas.`);
 const nonEmpty=matrix.map((record,index)=>({record,row:index+1})).filter(({record})=>record.some(cell=>spreadsheetCell(cell)!==''));
 if(!nonEmpty.length)return[];
 const headerRecord=nonEmpty[0].record;
 const headerRow=nonEmpty[0].row;
 if(headerRecord.length>MAX_OPENING_COLUMNS)throw Error(`La hoja de ${label} supera el límite de ${MAX_OPENING_COLUMNS} columnas.`);
 const headers=headerRecord.map(normalizedHeader);
 const emptyHeaders=headers.flatMap((header,index)=>header?[]:[index]);
 if(emptyHeaders.length)throw emptyHeaderFailure(headerRow,emptyHeaders);
 if(new Set(headers).size!==headers.length)throw duplicateHeaderFailure(headerRow,headers);
 if(nonEmpty.length<2)return[];
 return nonEmpty.slice(1).map(({record,row})=>{
  if(record.length>MAX_OPENING_COLUMNS)throw Error(`${label} fila ${row}: supera el límite de ${MAX_OPENING_COLUMNS} columnas.`);
  const extraIndex=record.findIndex((cell,column)=>column>=headers.length&&spreadsheetCell(cell)!=='');
  if(extraIndex>=0)throw extraColumnFailure(row,extraIndex+1);
  return{row,data:Object.fromEntries(headers.map((header,column)=>[header,spreadsheetCell(record[column])]))};
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

function requireColumns(parsed:{row:number;data:Record<string,string>}[],label:string,columns:string[]){
 if(!parsed.length)return;
 const missing=columns.filter(column=>!(column in parsed[0].data));
 if(missing.length)throw Error(`La plantilla de ${label} no contiene ${missing.length===1?'la columna':'las columnas'} ${missing.join(', ')}.`);
}

function applyAccountingAliases(parsed:{row:number;data:Record<string,string>}[]){
 const aliases:Record<string,string[]>= {
  moneda:['moneda_original'],
  saldo:['saldo_moneda_original','importe_moneda_original','saldo_original','monto_original'],
  equivalente_moneda_local:['equivalente_local','importe_moneda_local','saldo_moneda_local','saldo_local','local_equivalent'],
  tipo_cambio_historico:['tipo_cambio','tasa_cambio','tasa_historica','historical_exchange_rate','exchange_rate'],
  debito_moneda_local:['debito_local','debito'],credito_moneda_local:['credito_local','credito'],
  debito_moneda_original:['debito_moneda_origen','debito_original','debito_moneda_extranjera'],credito_moneda_original:['credito_moneda_origen','credito_original','credito_moneda_extranjera'],
  centro_costos:['centro_de_costos','centro_costo'],acreedor_financiero:['acreedores_financieros'],compania_relacionada:['companias_relacionadas'],sucursal:['ubicacion']
 };
 for(const{data}of parsed)for(const[target,candidates]of Object.entries(aliases))if(!(target in data)){
  const candidate=candidates.find(name=>name in data);if(candidate)data[target]=data[candidate];
 }
}

function openingAccountingAmount(
 data:Record<string,string>,row:number,property:string,aliases:string[],field:string,source:string,required=true
){
 const value=String(data[property]??'').trim(),column=openingColumn(data,[property,...aliases]);
 if(!value&&!required)return'';
 if(!value)throw new OpeningFileParseError(`${source} fila ${row}: complete ${field}.`,{
  code:'REQUIRED_AMOUNT',message:`Complete ${field}.`,row,...(column?{column,columnLetter:columnLetter(column)}:{}),field,value,
  suggestion:'Use un importe positivo sin separadores de miles; puede utilizar punto o coma para los decimales.'
 });
 let parsed='';
 try{parsed=amount(value);}catch(cause){
  const detail=cause instanceof Error?cause.message:`El valor "${value}" no es numérico.`;
  throw new OpeningFileParseError(`${source} fila ${row}: ${detail}`,{
   code:'INVALID_AMOUNT',message:detail,row,...(column?{column,columnLetter:columnLetter(column)}:{}),field,value,
   suggestion:'Use un importe positivo sin separadores de miles; por ejemplo, 75500.00.'
  });
 }
 if(Number(parsed)<=0)throw new OpeningFileParseError(`${source} fila ${row}: ${field} debe ser mayor que cero.`,{
  code:'INVALID_AMOUNT',message:`${field} debe ser mayor que cero.`,row,...(column?{column,columnLetter:columnLetter(column)}:{}),field,value,
  suggestion:'Registre solamente documentos con saldo pendiente positivo.'
 });
 return parsed;
}

function openingAccountingRate(data:Record<string,string>,row:number,original:string,local:string,source:string){
 const property='tipo_cambio_historico',aliases=['tipo_cambio','tasa_cambio','tasa_historica','historical_exchange_rate','exchange_rate'];
 const value=String(data[property]??'').trim(),column=openingColumn(data,[property,...aliases]);
 let parsed='';
 if(value){
  try{parsed=amount(value);}catch(cause){
   const detail=cause instanceof Error?cause.message:`El valor "${value}" no es numérico.`;
   throw new OpeningFileParseError(`${source} fila ${row}: ${detail}`,{
    code:'INVALID_EXCHANGE_RATE',message:detail,row,...(column?{column,columnLetter:columnLetter(column)}:{}),field:'Tipo de cambio histórico',value,
    suggestion:'Use una tasa positiva sin separadores de miles; por ejemplo, 151.000000.'
   });
  }
  if(Number(parsed)<=0)throw new OpeningFileParseError(`${source} fila ${row}: el tipo de cambio histórico debe ser mayor que cero.`,{
   code:'INVALID_EXCHANGE_RATE',message:'El tipo de cambio histórico debe ser mayor que cero.',row,...(column?{column,columnLetter:columnLetter(column)}:{}),field:'Tipo de cambio histórico',value,
   suggestion:'Indique la tasa histórica positiva o deje la celda vacía para calcularla con ambos importes.'
  });
 }
 if(!value)return local?(Number(local)/Number(original)).toFixed(10).replace(/0+$/,'').replace(/\.$/,''):'';
 const rounded=(numericValue:number)=>Math.round((numericValue+Number.EPSILON)*100)/100,rate=Number(parsed);
 if(local&&Math.abs(rounded(Number(local))-rounded(Number(original)*rate))>.000001)throw new OpeningFileParseError(`${source} fila ${row}: el equivalente en moneda local no corresponde al saldo original por el tipo de cambio histórico.`,{
  code:'EXCHANGE_RATE_MISMATCH',message:`El saldo original ${original}, la equivalencia local ${local} y la tasa ${parsed} no coinciden al centavo.`,row,...(column?{column,columnLetter:columnLetter(column)}:{}),field:'Tipo de cambio histórico',value,
  suggestion:'Corrija el importe local o la tasa. La fórmula es: saldo_moneda_original × tipo_cambio_historico = equivalente_moneda_local.'
 });
 return parsed;
}

function applyPendingAliases(parsed:ParsedRow[]){
 const aliases:Record<string,string[]>={
  id_pendiente:['referencia','referencia_pendiente','numero_pendiente','numero_documento'],
  tipo_periodo:['tipo_de_periodo','period_type','clasificacion_periodo'],
  fecha_origen:['fecha','fecha_documento','fecha_reconocimiento'],
  identificacion_cliente:['identificacion_tercero','cliente_identificacion','nit_cliente','ruc_cliente'],
  tipo_cambio:['tipo_cambio_historico','tasa_cambio','tasa','exchange_rate'],
  debito_moneda_local:['debito_local','debito'],credito_moneda_local:['credito_local','credito'],
  debito_moneda_original:['debito_moneda_origen','debito_original','debito_moneda_extranjera'],credito_moneda_original:['credito_moneda_origen','credito_original','credito_moneda_extranjera'],
  mes_servicio:['periodo_servicio'],pais_servicio:['codigo_pais_servicio'],
  es_linea_control:['linea_control','es_control'],enlace_respaldo:['url_respaldo','support_url','support_link'],
  centro_costos:['centro_de_costos','centro_costo'],acreedor_financiero:['acreedores_financieros'],compania_relacionada:['companias_relacionadas'],sucursal:['ubicacion']
 };
 for(const{data}of parsed)for(const[target,candidates]of Object.entries(aliases))if(!(target in data)){
  const candidate=candidates.find(name=>name in data);if(candidate)data[target]=data[candidate];
 }
}

function parseOpeningAccountingRows(parsed:ParsedRow[],type:'GL'|'AR'|'AP'){
 applyAccountingAliases(parsed);
 const common=['cuenta','moneda','centro_costos','sucursal','nota'];
 if(type==='GL')requireColumns(parsed,'Libro Mayor',['cuenta','debito_moneda_local','credito_moneda_local','moneda','debito_moneda_original','credito_moneda_original','departamento','centro_costos','clase','acreedor_financiero','compania_relacionada','sucursal','nota']);
 else requireColumns(parsed,type==='AR'?'Cuentas por Cobrar':'Cuentas por Pagar',['identificacion_tercero','numero_documento','fecha_emision','fecha_vencimiento',...common.slice(0,2),'saldo',...common.slice(2)]);
 return parsed.map(({row,data:x})=>{
  if(!x.cuenta)throw Error(`${type} fila ${row}: complete la cuenta contable.`);
  if(!x.moneda)throw Error(`${type} fila ${row}: complete la moneda.`);
  if(type!=='GL'&&(!x.identificacion_tercero||!x.numero_documento))throw Error(`${type} fila ${row}: complete tercero y documento.`);
  const source=type==='AR'?'Cuentas por Cobrar':type==='AP'?'Cuentas por Pagar':'Libro Mayor';
  const issueDate=type==='GL'?'':openingIsoDate(x,row,'fecha_emision',[],'Fecha de emisi\u00f3n',source);
  const dueDate=type==='GL'?'':openingIsoDate(x,row,'fecha_vencimiento',[],'Fecha de vencimiento',source);
  const originalBalance=type==='GL'?'':openingAccountingAmount(x,row,'saldo',['saldo_moneda_original','importe_moneda_original','saldo_original','monto_original'],'Saldo en moneda original',source);
  const explicitLocalEquivalent=type==='GL'?'':openingAccountingAmount(x,row,'equivalente_moneda_local',['equivalente_local','importe_moneda_local','saldo_moneda_local','saldo_local','local_equivalent'],'Equivalente en moneda local',source,false);
  const historicalRate=type==='GL'?'':openingAccountingRate(x,row,originalBalance,explicitLocalEquivalent,source);
  const localEquivalent=explicitLocalEquivalent||(historicalRate?String(Math.round((Number(originalBalance)*Number(historicalRate)+Number.EPSILON)*100)/100):'');
  return{
   sourceType:type,sourceRow:row,account:x.cuenta,documentNumber:x.numero_documento||'',issueDate,dueDate,currency:(x.moneda||'').toUpperCase(),
   debit:amount(type==='GL'?x.debito_moneda_local:(type==='AR'?originalBalance:'')),credit:amount(type==='GL'?x.credito_moneda_local:(type==='AP'?originalBalance:'')),
   debitFx:amount(type==='GL'?x.debito_moneda_original:(type==='AR'?originalBalance:'')),creditFx:amount(type==='GL'?x.credito_moneda_original:(type==='AP'?originalBalance:'')),
   ...(type==='GL'?{}:{localDebit:type==='AR'?localEquivalent:'',localCredit:type==='AP'?localEquivalent:'',localEquivalent,originalAmount:originalBalance,exchangeRate:historicalRate,historicalRate,auxiliaryOnly:true}),
   entityTaxId:x.identificacion_tercero||'',
   department:x.departamento||'',costCenter:x.centro_costos||'',className:x.clase||'',financialCreditor:x.acreedor_financiero||'',relatedCompany:x.compania_relacionada||'',
   location:x.sucursal||'',note:x.nota||''
  };
 });
}

export function parseOpeningAccountingCsv(text:string,type:'GL'|'AR'|'AP'){
 return parseOpeningAccountingRows(rows(text),type);
}

function controlMarker(value:string,row:number){
 const normalized=value.trim().toUpperCase();
 if(['1','SI','SÍ','TRUE','VERDADERO','YES','X'].includes(normalized))return true;
 if(['0','NO','FALSE','FALSO'].includes(normalized))return false;
 throw Error(`Pendientes de Facturar fila ${row}: es_linea_control debe indicar SI o NO.`);
}
function decimal(value:unknown,label:string,row:number,required=false){
 const parsed=amount(value);
 if(required&&!parsed)throw Error(`Pendientes de Facturar fila ${row}: complete ${label}.`);
 if(parsed&&Number(parsed)<0)throw Error(`Pendientes de Facturar fila ${row}: ${label} no puede ser negativo.`);
 return parsed||'0';
}
function exchangeRateDecimal(value:unknown,row:number){
 const raw=String(value??'').trim().replace(/\s/g,'');
 if(!raw)throw Error(`Pendientes de Facturar fila ${row}: complete tipo de cambio.`);
 const normalized=raw.includes(',')&&raw.includes('.')
  ?(raw.lastIndexOf(',')>raw.lastIndexOf('.')?raw.replace(/\./g,'').replace(',','.'):raw.replace(/,/g,''))
  :raw.replace(',','.');
 if(!/^\d+(?:\.\d+)?$/.test(normalized)||!Number.isFinite(Number(normalized)))throw Error(`Pendientes de Facturar fila ${row}: tipo de cambio no es numérico.`);
 if(Number(normalized)<=0)throw Error(`Pendientes de Facturar fila ${row}: el tipo de cambio debe ser mayor que cero.`);
 return normalized;
}
function close(a:number,b:number,tolerance=.005){return Math.abs(a-b)<=tolerance;}
function normalizedOpeningDateValue(value:unknown){
 const raw=String(value??'').trim();
 let match=/^(\d{4})-(\d{2})-(\d{2})$/.exec(raw),year:number,month:number,day:number;
 if(match){year=Number(match[1]);month=Number(match[2]);day=Number(match[3]);}
 else{
  match=/^(\d{1,2})[\/-](\d{1,2})[\/-](\d{4})$/.exec(raw);
  if(!match)return'';
  day=Number(match[1]);month=Number(match[2]);year=Number(match[3]);
 }
 const date=new Date(Date.UTC(year,month-1,day));
 if(date.getUTCFullYear()!==year||date.getUTCMonth()!==month-1||date.getUTCDate()!==day)return'';
 return`${String(year).padStart(4,'0')}-${String(month).padStart(2,'0')}-${String(day).padStart(2,'0')}`;
}

function openingColumn(data:Record<string,string>,fields:string[]){
 const headers=Object.keys(data);
 const positions=fields.map(field=>headers.indexOf(field)+1).filter(position=>position>0);
 return positions.length?Math.min(...positions):undefined;
}

function openingIsoDate(
 data:Record<string,string>,row:number,property:string,aliases:string[],field:string,source:string,required=true
){
 const value=String(data[property]??'').trim(),column=openingColumn(data,[property,...aliases]);
 const normalized=normalizedOpeningDateValue(value);
 if(value&&normalized)return normalized;
 if(!value&&!required)return '';
 const message=value?`El valor "${value}" no es una fecha valida para ${field}.`:`Complete ${field}.`;
 throw new OpeningFileParseError(`${source} fila ${row}: ${message}`,{
  code:value?'INVALID_DATE':'REQUIRED_DATE',message,row,...(column?{column,columnLetter:columnLetter(column)}:{}),field,value,
  suggestion:'Use AAAA-MM-DD, DD/MM/AAAA o DD-MM-AAAA; por ejemplo, 2021-12-29 o 29/12/2021.'
 });
}

function parseOpeningPendingRows(parsed:ParsedRow[],openingDate=''):OpeningPendingItem[]{
 applyPendingAliases(parsed);
 const required=['id_pendiente','tipo_periodo','fecha_origen','identificacion_cliente','moneda','tipo_cambio','cuenta','debito_moneda_local','credito_moneda_local','debito_moneda_original','credito_moneda_original','mes_servicio','pais_servicio','departamento','centro_costos','clase','acreedor_financiero','compania_relacionada','sucursal','nota'];
 requireColumns(parsed,'Auxiliar de Pendientes de Facturar',required);
 const grouped=new Map<string,{header:Record<string,string>;rows:ParsedRow[]}>();
 for(const current of parsed){
  const x=current.data,reference=x.id_pendiente.trim();
  if(!reference)throw Error(`Pendientes de Facturar fila ${current.row}: complete la referencia del pendiente.`);
  if(reference.length>100)throw Error(`Pendientes de Facturar fila ${current.row}: la referencia admite hasta 100 caracteres.`);
  const entry=grouped.get(reference)??{header:x,rows:[]};entry.rows.push(current);grouped.set(reference,entry);
 }
 const items:OpeningPendingItem[]=[];
 for(const[reference,group]of grouped){
  const first=group.header,firstRow=group.rows[0].row;
  const commonFields:[string,string][]=[['tipo_periodo','tipo de período'],['fecha_origen','fecha de origen'],['identificacion_cliente','cliente'],['moneda','moneda'],['tipo_cambio','tipo de cambio'],['mes_servicio','mes de servicio'],['pais_servicio','país de servicio'],['enlace_respaldo','enlace de respaldo']];
  for(const[field,label]of commonFields){
   const values=new Set(group.rows.map(({data})=>String(data[field]??'').trim().toUpperCase()));
   if(values.size>1)throw Error(`Pendiente ${reference}: ${label} debe ser igual en todas sus líneas.`);
  }
  const periodType=first.tipo_periodo.trim().toUpperCase()as OpeningPendingItem['periodType'];
  const originDate=openingIsoDate(first,firstRow,'fecha_origen',['fecha','fecha_documento','fecha_reconocimiento'],'Fecha de origen','Auxiliar de Pendientes de Facturar'),serviceMonth=first.mes_servicio.trim(),currency=first.moneda.trim().toUpperCase(),entityTaxId=first.identificacion_cliente.trim(),serviceCountry=first.pais_servicio.trim().toUpperCase();
  if(!['ACTUAL','ANTERIOR'].includes(periodType))throw Error(`Pendiente ${reference}: tipo_periodo debe ser ACTUAL o ANTERIOR.`);
  if(openingDate&&originDate>openingDate)throw Error(`Pendiente ${reference}: la fecha de origen no puede ser posterior a la fecha de apertura.`);
  if(!/^\d{4}-(0[1-9]|1[0-2])$/.test(serviceMonth))throw Error(`Pendiente ${reference}: use mes_servicio con formato YYYY-MM.`);
  if(openingDate&&serviceMonth>openingDate.slice(0,7))throw Error(`Pendiente ${reference}: el mes de servicio no puede ser posterior a la fecha de apertura.`);
  if(!entityTaxId)throw Error(`Pendiente ${reference}: complete la identificación del cliente.`);
  if(!/^[A-Z]{3}$/.test(currency))throw Error(`Pendiente ${reference}: moneda debe ser un código ISO de tres letras.`);
  if(!serviceCountry)throw Error(`Pendiente ${reference}: complete el país de servicio.`);
  const exchangeRate=exchangeRateDecimal(first.tipo_cambio,firstRow);
  const controlAccount=periodType==='ACTUAL'?'113003':'113004',counterpartAccount=periodType==='ACTUAL'?'413001':'413002';
  if(group.rows.length!==2)throw Error(`Pendiente ${reference}: incluya exactamente dos líneas, ${controlAccount} al debe y ${counterpartAccount} al haber.`);
  const lines:PendingLine[]=group.rows.map(({row,data:x})=>{
   const account=x.cuenta.replace(/\s/g,'');
   if(![controlAccount,counterpartAccount].includes(account))throw Error(`Pendientes de Facturar fila ${row}: para tipo ${periodType} solo se permiten las cuentas ${controlAccount} y ${counterpartAccount}.`);
   const debit=decimal(x.debito_moneda_local,'débito en moneda local',row),credit=decimal(x.credito_moneda_local,'crédito en moneda local',row),debitFx=decimal(x.debito_moneda_original,'débito en moneda original',row),creditFx=decimal(x.credito_moneda_original,'crédito en moneda original',row);
   if(account===controlAccount&&(Number(debit)<=0||Number(credit)!==0||Number(debitFx)<=0||Number(creditFx)!==0))throw Error(`Pendientes de Facturar fila ${row}: la cuenta ${controlAccount} debe llevar el débito local y original.`);
   if(account===counterpartAccount&&(Number(credit)<=0||Number(debit)!==0||Number(creditFx)<=0||Number(debitFx)!==0))throw Error(`Pendientes de Facturar fila ${row}: la cuenta ${counterpartAccount} debe llevar el crédito local y original.`);
   const marker=x.es_linea_control;
   if(marker!==undefined&&marker.trim()&&controlMarker(marker,row)!==(account===controlAccount))throw Error(`Pendientes de Facturar fila ${row}: es_linea_control solo puede marcarse para la cuenta ${controlAccount}.`);
   return{sourceRow:row,account,debit,credit,debitFx,creditFx,isControlLine:account===controlAccount,department:x.departamento||'',costCenter:x.centro_costos||'',className:x.clase||'',financialCreditor:x.acreedor_financiero||'',relatedCompany:x.compania_relacionada||'',location:x.sucursal||'',note:x.nota||''};
  });
  if(lines.filter(line=>line.account===controlAccount).length!==1||lines.filter(line=>line.account===counterpartAccount).length!==1)throw Error(`Pendiente ${reference}: incluya una línea ${controlAccount} y una línea ${counterpartAccount}.`);
  const debit=lines.reduce((sum,line)=>sum+Number(line.debit),0),credit=lines.reduce((sum,line)=>sum+Number(line.credit),0),debitFx=lines.reduce((sum,line)=>sum+Number(line.debitFx),0),creditFx=lines.reduce((sum,line)=>sum+Number(line.creditFx),0);
  if(!close(debit,credit))throw Error(`Pendiente ${reference}: los débitos y créditos en moneda local no cuadran.`);
  if(!close(debitFx,creditFx,.00005))throw Error(`Pendiente ${reference}: los débitos y créditos en moneda original no cuadran.`);
  if(!close(debit,debitFx*Number(exchangeRate)))throw Error(`Pendiente ${reference}: el importe local no corresponde al importe original por el tipo de cambio indicado.`);
  const supportLink=(first.enlace_respaldo||'').trim();
  if(supportLink&&!/^https?:\/\/[^\s]+$/i.test(supportLink))throw Error(`Pendiente ${reference}: el enlace de respaldo debe iniciar con http:// o https://.`);
  items.push({reference,periodType,originDate,entityTaxId,currency,exchangeRate,serviceMonth,serviceCountry,note:group.rows.map(row=>row.data.nota).find(Boolean)||'',supportUrl:supportLink,supportLink,lines});
 }
 return items;
}

/** Convierte la plantilla CSV del auxiliar en pendientes listos para la RPC de apertura. */
export function parseOpeningPendingCsv(text:string,openingDate=''){
 return parseOpeningPendingRows(rows(text),openingDate);
}

function applyBankAliases(parsed:ParsedRow[]){
 const aliases:Record<string,string[]>={
  codigo_banco:['banco','bank_code'],numero_cuenta_bancaria:['cuenta_bancaria','numero_cuenta','bank_account'],
  moneda:['currency'],tipo_registro:['tipo','record_type'],fecha_movimiento:['fecha','transaction_date'],fecha_valor:['value_date'],
  referencia:['reference'],beneficiario:['beneficiary'],descripcion:['description'],
  importe_moneda_original:['importe_original','monto_moneda_original','original_amount'],
  equivalente_moneda_local:['equivalente_local','importe_moneda_local','local_equivalent']
 };
 for(const{data}of parsed)for(const[target,candidates]of Object.entries(aliases))if(!(target in data)){
  const candidate=candidates.find(name=>name in data);if(candidate)data[target]=data[candidate];
 }
}

function parseOpeningBankRows(parsed:ParsedRow[],openingDate=''):OpeningBankItem[]{
 applyBankAliases(parsed);
 const label='Auxiliar de Bancos',required=['codigo_banco','numero_cuenta_bancaria','moneda','tipo_registro','fecha_movimiento','fecha_valor','referencia','beneficiario','descripcion','importe_moneda_original','equivalente_moneda_local'];
 requireColumns(parsed,label,required);
 const allowed=new Set(['SALDO_CONCILIADO','DEPOSITO_EN_TRANSITO','CHEQUE_EN_TRANSITO']),openingBalances=new Set<string>();
 return parsed.map(({row,data:x})=>{
  const bankCode=(x.codigo_banco||'').trim().toUpperCase(),accountNumber=(x.numero_cuenta_bancaria||'').trim(),currency=(x.moneda||'').trim().toUpperCase();
  const recordType=(x.tipo_registro||'').trim().toUpperCase()as OpeningBankItem['recordType'];
  const transactionDate=openingIsoDate(x,row,'fecha_movimiento',['fecha','transaction_date'],'Fecha de movimiento',label);
  const valueDate=openingIsoDate(x,row,'fecha_valor',['value_date'],'Fecha valor',label,false),reference=(x.referencia||'').trim();
  if(!bankCode)throw Error(`${label} fila ${row}: complete codigo_banco.`);
  if(!accountNumber)throw Error(`${label} fila ${row}: complete numero_cuenta_bancaria.`);
  if(!/^[A-Z]{3}$/.test(currency))throw Error(`${label} fila ${row}: moneda debe ser un codigo ISO de tres letras.`);
  if(!allowed.has(recordType))throw Error(`${label} fila ${row}: tipo_registro debe ser SALDO_CONCILIADO, DEPOSITO_EN_TRANSITO o CHEQUE_EN_TRANSITO.`);
  if(openingDate&&transactionDate>openingDate)throw Error(`${label} fila ${row}: fecha_movimiento no puede ser posterior a la fecha de apertura.`);
  if(openingDate&&valueDate&&valueDate>openingDate)throw Error(`${label} fila ${row}: fecha_valor no puede ser posterior a la fecha de apertura.`);
  if(recordType!=='SALDO_CONCILIADO'&&!reference)throw Error(`${label} fila ${row}: complete referencia para la partida en transito.`);
  const originalRaw=amount(x.importe_moneda_original),localRaw=amount(x.equivalente_moneda_local);
  if(!originalRaw)throw Error(`${label} fila ${row}: complete importe_moneda_original.`);
  if(!localRaw)throw Error(`${label} fila ${row}: complete equivalente_moneda_local.`);
  const originalInput=Number(originalRaw),localInput=Number(localRaw);
  if(recordType==='SALDO_CONCILIADO'){
   if((originalInput===0)!==(localInput===0))throw Error(`${label} fila ${row}: el saldo original y su equivalente local deben ser ambos cero o ambos distintos de cero.`);
   if(originalInput!==0&&Math.sign(originalInput)!==Math.sign(localInput))throw Error(`${label} fila ${row}: el saldo original y su equivalente local deben tener el mismo signo.`);
   const key=`${bankCode}\u0000${accountNumber.toUpperCase()}\u0000${currency}`;
   if(openingBalances.has(key))throw Error(`${label} fila ${row}: la cuenta bancaria ya tiene una fila SALDO_CONCILIADO.`);
   openingBalances.add(key);
  }else if(originalInput<=0||localInput<=0)throw Error(`${label} fila ${row}: las partidas en transito deben ingresarse con importes positivos; el sistema deriva el signo.`);
  const sign=recordType==='CHEQUE_EN_TRANSITO'?-1:1;
  return{
   sourceRow:row,bankCode,accountNumber,currency,recordType,transactionDate,valueDate,reference,
   beneficiary:(x.beneficiario||'').trim(),description:(x.descripcion||'').trim(),
   originalAmount:String(recordType==='SALDO_CONCILIADO'?originalInput:originalInput*sign),
   localEquivalent:String(recordType==='SALDO_CONCILIADO'?localInput:localInput*sign)
  };
 });
}

export function parseOpeningBankCsv(text:string,openingDate=''){
 return parseOpeningBankRows(rows(text),openingDate);
}

async function parseOpeningUpload<T>(
 input:unknown,
 label:string,
 fileNameHint:string,
 parseCsv:(text:string)=>T[],
 parseSpreadsheet:(parsed:ParsedRow[])=>T[]
){
 if(input===null||input===undefined||input==='')return[];
 if(typeof input==='string')return parseCsv(input);
 if(typeof input!=='object'||Array.isArray(input))throw Error(`El archivo de ${label} no tiene un formato válido.`);
 const file=input as Record<string,unknown>,fileName=String(file.fileName||file.name||fileNameHint||'').trim();
 const encoded=String(file.base64||file.contentBase64||'').replace(/^data:[^;,]+;base64,/i,'').replace(/\s/g,'');
 if(!fileName||!encoded)throw Error(`Indique el nombre y contenido del archivo de ${label}.`);
 if(encoded.length>Math.ceil(MAX_OPENING_FILE_BYTES/3)*4+4)throw Error(`El archivo de ${label} supera 5 MB.`);
 if(!/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)||encoded.length%4===1)throw Error(`El contenido del archivo de ${label} no es Base64 válido.`);
 const buffer=Buffer.from(encoded,'base64');
 if(!buffer.length)throw Error(`El archivo de ${label} está vacío.`);
 if(buffer.length>MAX_OPENING_FILE_BYTES)throw Error(`El archivo de ${label} supera 5 MB.`);
 const normalizedName=fileName.toLowerCase();
 if(normalizedName.endsWith('.csv'))return parseCsv(buffer.toString('utf8').replace(/^\uFEFF/,''));
 if(!normalizedName.endsWith('.xlsx'))throw Error(`Seleccione una plantilla de ${label} en formato CSV o XLSX.`);
 if(buffer[0]!==0x50||buffer[1]!==0x4b)throw Error(`El archivo Excel de ${label} no es válido o está dañado.`);
 let matrix:unknown[][];
 try{
  const{readSheet}=await import('read-excel-file/node');
  matrix=await readSheet(buffer,1)as unknown as unknown[][];
 }catch{throw Error(`El archivo Excel de ${label} no es válido o está dañado.`);}
 return parseSpreadsheet(spreadsheetRows(matrix,label));
}

export async function parseOpeningPendingFile(input:unknown,openingDate:string,fileNameHint=''){
 return parseOpeningUpload(input,'Pendientes de Facturar',fileNameHint,text=>parseOpeningPendingCsv(text,openingDate),parsed=>parseOpeningPendingRows(parsed,openingDate));
}

export async function parseOpeningBankFile(input:unknown,openingDate:string,fileNameHint=''){
 return parseOpeningUpload(input,'Auxiliar de Bancos',fileNameHint,text=>parseOpeningBankCsv(text,openingDate),parsed=>parseOpeningBankRows(parsed,openingDate));
}

function parseOpeningFixedAssetRows(parsed:ParsedRow[]){
 if(!parsed.length)return[];
 const required=['nombre_activo','codigo_categoria','fecha_compra','fecha_en_servicio','costo_historico','depreciacion_acumulada','meses_depreciados','ubicacion','estado','moneda'];
 for(const field of required)if(!(field in parsed[0].data))throw Error(`La plantilla de Activos Fijos no contiene la columna ${field}.`);
 return parsed.map(({row,data:x})=>{
  const purchaseDate=openingIsoDate(x,row,'fecha_compra',[],'Fecha de compra','Auxiliar de Activos Fijos');
  const serviceDate=openingIsoDate(x,row,'fecha_en_servicio',[],'Fecha en servicio','Auxiliar de Activos Fijos');
  return{
   sourceRow:row,assetNumber:x.codigo_activo||'AUTO',name:x.nombre_activo,categoryCode:(x.codigo_categoria||'').toUpperCase(),serial:x.numero_serie||'',description:x.descripcion||'',purchaseDate,serviceDate,cost:amount(x.costo_historico),accumulatedDepreciation:amount(x.depreciacion_acumulada),bookValue:amount(x.valor_en_libros),depreciatedMonths:x.meses_depreciados||'0',location:x.ubicacion||'',departmentType:x.tipo_departamento||'',department:x.departamento||'',costCenter:x.centro_costos||'',className:x.clase||'',status:(x.estado||'ACTIVO').toUpperCase(),currency:(x.moneda||'').toUpperCase(),note:x.nota||''
  };
 });
}

export function parseOpeningFixedAssetCsv(text:string){
 return parseOpeningFixedAssetRows(rows(text));
}

// Se conserva como alias interno para las integraciones CSV existentes.
function fixedAssetCsv(text:string){return parseOpeningFixedAssetCsv(text);}

export function parseOpeningAccountingFile(input:unknown,type:'GL'|'AR'|'AP',fileNameHint=''){
 const label=type==='GL'?'Libro Mayor':type==='AR'?'Cuentas por Cobrar':'Cuentas por Pagar';
 return parseOpeningUpload(input,label,fileNameHint,text=>parseOpeningAccountingCsv(text,type),parsed=>parseOpeningAccountingRows(parsed,type));
}

export function parseOpeningFixedAssetFile(input:unknown,fileNameHint=''){
 return parseOpeningUpload(input,'Activos Fijos',fileNameHint,parseOpeningFixedAssetCsv,parseOpeningFixedAssetRows);
}

async function rpc(auth:string,name:string,p:Record<string,unknown>={}){
 const config=getSupabaseConfig();if(!config)throw Error('Supabase no configurado.');
 const response=await fetchSupabase(new URL(`/rest/v1/rpc/${name}`,config.url),{method:'POST',headers:{apikey:config.anonKey,Authorization:auth,'Content-Type':'application/json'},body:JSON.stringify(p)}),raw=await response.text(),result=raw?JSON.parse(raw):null;
 if(!response.ok)throw Error(result?.message||'No fue posible procesar la apertura.');return result;
}

function normalizeOpeningPreview(value:unknown){
 if(!value||typeof value!=='object'||Array.isArray(value))return value;
 const result=value as Record<string,unknown>,nested=result.pending&&typeof result.pending==='object'&&!Array.isArray(result.pending)?result.pending as Record<string,unknown>:{};
 const arAp=result.arAp&&typeof result.arAp==='object'&&!Array.isArray(result.arAp)?result.arAp as Record<string,unknown>:{};
 return{
  ...result,
  arApSummary:result.arApSummary??result.ar_ap_summary??arAp.summary??{},
  arApReconciliation:result.arApReconciliation??result.ar_ap_reconciliation??arAp.reconciliation??[],
  arReconciliation:result.arReconciliation??result.ar_reconciliation??arAp.arReconciliation??arAp.ar_reconciliation??[],
  apReconciliation:result.apReconciliation??result.ap_reconciliation??arAp.apReconciliation??arAp.ap_reconciliation??[],
  pendingSummary:result.pendingSummary??result.pending_summary??nested.summary??{},
  pendingReconciliation:result.pendingReconciliation??result.pending_reconciliation??nested.reconciliation??[],
  pendingItems:result.pendingItems??result.pending_items??nested.items??(Array.isArray(result.pending)?result.pending:[]),
  bankSummary:result.bankSummary??result.bank_summary??result.banksSummary??result.banks_summary??(result.banks&&typeof result.banks==='object'&&!Array.isArray(result.banks)?(result.banks as Record<string,unknown>).summary:{}),
  bankReconciliation:result.bankReconciliation??result.bank_reconciliation??result.banksReconciliation??result.banks_reconciliation??(result.banks&&typeof result.banks==='object'&&!Array.isArray(result.banks)?(result.banks as Record<string,unknown>).reconciliation:[]),
  bankItems:result.bankItems??result.bank_items??result.banksItems??result.banks_items??(result.banks&&typeof result.banks==='object'&&!Array.isArray(result.banks)?(result.banks as Record<string,unknown>).items:[])??[]
 };
}

function openingUploadFileName(input:unknown,hint:unknown){
 if(input&&typeof input==='object'&&!Array.isArray(input)){
  const file=input as Record<string,unknown>,name=String(file.fileName||file.name||'').trim();
  if(name)return name;
 }
 const name=String(hint||'').trim();
 if(name)return name;
 return typeof input==='string'&&input.trim()?'Archivo CSV sin nombre':'Archivo sin nombre';
}

function openingFileError(cause:unknown):OpeningFileError{
 if(cause instanceof OpeningFileParseError)return cause.detail;
 const message=cause instanceof Error?cause.message:'No fue posible leer el archivo.';
 const rowMatch=/\bfila\s+(\d+)/i.exec(message),row=rowMatch?Number(rowMatch[1]):undefined;
 return{code:'INVALID_FILE',message,...(row?{row}:{}),suggestion:'Revise la plantilla y corrija el dato indicado.'};
}

type OpeningValidationSource={key:string;label:string;fileName:string;rows:Record<string,unknown>[]};
type OpeningDimensionFailure={property:string;field:string;value:string;message:string;suggestion:string};

function openingLookupText(value:unknown){return String(value??'').trim().normalize('NFC').toLowerCase();}

function openingDimensionFailure(message:string):OpeningDimensionFailure|null{
 const match=/^(.+?)\s+"([^"]+)"\s+(.+)$/.exec(message.trim());
 if(!match)return null;
 const dimension=openingLookupText(match[1]).normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/\s+/g,' ');
 const definitions:Record<string,{property:string;field:string;lookup:string}>={
  departamento:{property:'department',field:'Departamento',lookup:'nombre exacto o ID:identificador'},
  'centro de costos':{property:'costCenter',field:'Centro de costos',lookup:'código, nombre exacto o ID:identificador'},
  clase:{property:'className',field:'Clase',lookup:'nombre exacto o ID:identificador'},
  'acreedor financiero':{property:'financialCreditor',field:'Acreedor financiero',lookup:'código, identificación, nombre exacto o ID:identificador'},
  'compania relacionada':{property:'relatedCompany',field:'Compañía relacionada',lookup:'código, identificación, nombre exacto o ID:identificador'},
  'ubicacion / sucursal':{property:'location',field:'Ubicación / sucursal',lookup:'nombre exacto o ID:identificador'}
 };
 const definition=definitions[dimension];if(!definition)return null;
 const value=match[2].trim(),reason=match[3].trim().replace(/\s+Use\s+.+$/i,'').trim();
 return{
  property:definition.property,field:definition.field,value,
  message:`${definition.field} "${value}" ${reason}`,
  suggestion:`Corrija el campo ${definition.field} y use un valor activo asignado a la subsidiaria: ${definition.lookup}.`
 };
}

function openingRowNumber(value:unknown){
 const row=Number(value);return Number.isInteger(row)&&row>0?row:undefined;
}

function openingRowSummary(rows:number[]){
 const ordered=[...new Set(rows)].sort((left,right)=>left-right),groups:string[]=[];
 for(let index=0;index<ordered.length;index++){
  const start=ordered[index];let end=start;
  while(index+1<ordered.length&&ordered[index+1]===end+1){end=ordered[++index];}
  groups.push(start===end?String(start):`${start}–${end}`);
 }
 return groups.join(', ');
}

function openingSourceField(failure:OpeningDimensionFailure,key:string){
 return failure.property==='location'&&key!=='fa'?'Sucursal':failure.field;
}

function openingSourceSuggestion(failure:OpeningDimensionFailure,field:string){
 return failure.suggestion.replace(`campo ${failure.field}`,`campo ${field}`);
}

function openingDimensionFileErrors(failure:OpeningDimensionFailure,sources:OpeningValidationSource[]):OpeningBalanceFileValidation[]{
 const expected=openingLookupText(failure.value);
 return sources.flatMap(source=>{
  const rows=source.rows.flatMap(row=>openingLookupText(row[failure.property])===expected&&openingRowNumber(row.sourceRow)?[openingRowNumber(row.sourceRow)!]:[]);
  if(!rows.length)return[];
  const uniqueRows=[...new Set(rows)].sort((left,right)=>left-right),rowText=openingRowSummary(uniqueRows);
  const message=uniqueRows.length===1?failure.message:`${failure.message} Filas afectadas: ${rowText}.`;
  const field=openingSourceField(failure,source.key);
  return[{key:source.key,label:source.label,fileName:source.fileName,errors:[{
   code:'INVALID_CATALOG_REFERENCE',message,row:uniqueRows[0],rows:uniqueRows,field,value:failure.value,suggestion:openingSourceSuggestion(failure,field)
  }]}];
 });
}

function openingPrefixedRpcError(message:string){
 const rules:{key:string;expression:RegExp}[]=[
  {key:'gl',expression:/^(?:GL|Libro Mayor)\s+fila\s+(\d+)\s*:\s*(.+)$/i},
  {key:'ar',expression:/^(?:AR|CxC|Cuentas por Cobrar)\s+fila\s+(\d+)\s*:\s*(.+)$/i},
  {key:'ap',expression:/^(?:AP|CxP|Cuentas por Pagar)\s+fila\s+(\d+)\s*:\s*(.+)$/i},
  {key:'pending',expression:/^Pendientes de Facturar\s+fila\s+(\d+)\s*:\s*(.+)$/i},
  {key:'fa',expression:/^(?:Activos Fijos|Auxiliar de Activos Fijos)\s+fila\s+(\d+)\s*:\s*(.+)$/i},
  {key:'banks',expression:/^Auxiliar de Bancos\s+fila\s+(\d+)\s*:\s*(.+)$/i}
 ];
 for(const rule of rules){const match=rule.expression.exec(message);if(match)return{key:rule.key,row:Number(match[1]),detail:match[2].trim()};}
 if(/^Pendiente\b/i.test(message))return{key:'pending',detail:message};
 return null;
}

function openingRpcFileErrors(cause:unknown,sources:OpeningValidationSource[]):OpeningBalanceFileValidation[]{
 const message=cause instanceof Error?cause.message:String(cause??'').trim();if(!message)return[];
 const prefixed=openingPrefixedRpcError(message);
 if(prefixed){
  const source=sources.find(candidate=>candidate.key===prefixed.key);if(!source||!source.rows.length)return[];
  const dimension=openingDimensionFailure(prefixed.detail);
  const field=dimension?openingSourceField(dimension,source.key):'';
  const issue:OpeningFileError=dimension?{
   code:'INVALID_CATALOG_REFERENCE',message:dimension.message,row:prefixed.row,rows:prefixed.row?[prefixed.row]:undefined,field,value:dimension.value,suggestion:openingSourceSuggestion(dimension,field)
  }:{
   code:'INVALID_OPENING_BALANCE_ROW',message:prefixed.detail,row:prefixed.row,suggestion:'Revise la fila indicada en este archivo y corrija el dato antes de volver a validar.'
  };
  return[{key:source.key,label:source.label,fileName:source.fileName,errors:[issue]}];
 }
 const dimension=openingDimensionFailure(message);if(!dimension)return[];
 return openingDimensionFileErrors(dimension,sources.filter(source=>['gl','ar','ap','pending'].includes(source.key)));
}

export async function openingBalances(auth:string,action:string,p:Record<string,unknown>={}){
 if(action==='validate'){
  const openingDate=String(p.openingDate||'');
  const uploads=[
   {key:'gl',label:'Libro Mayor',fileName:openingUploadFileName(p.gl,p.glFileName),load:()=>parseOpeningAccountingFile(p.gl,'GL',String(p.glFileName||''))},
   {key:'ar',label:'Cuentas por Cobrar',fileName:openingUploadFileName(p.ar,p.arFileName),load:()=>parseOpeningAccountingFile(p.ar,'AR',String(p.arFileName||''))},
   {key:'ap',label:'Cuentas por Pagar',fileName:openingUploadFileName(p.ap,p.apFileName),load:()=>parseOpeningAccountingFile(p.ap,'AP',String(p.apFileName||''))},
   {key:'fa',label:'Auxiliar de Activos Fijos',fileName:openingUploadFileName(p.fa,p.faFileName),load:()=>parseOpeningFixedAssetFile(p.fa,String(p.faFileName||''))},
   {key:'pending',label:'Auxiliar de Pendientes de Facturar',fileName:openingUploadFileName(p.pending,p.pendingFileName),load:()=>parseOpeningPendingFile(p.pending,openingDate,String(p.pendingFileName||''))},
   {key:'banks',label:'Auxiliar de Bancos',fileName:openingUploadFileName(p.banks,p.banksFileName),load:()=>parseOpeningBankFile(p.banks,openingDate,String(p.banksFileName||''))}
  ];
  const parsed=await Promise.allSettled(uploads.map(upload=>upload.load()));
  const invalidFiles=parsed.flatMap((result,index)=>result.status==='rejected'?[{key:uploads[index].key,label:uploads[index].label,fileName:uploads[index].fileName,errors:[openingFileError(result.reason)]}]:[]);
  if(invalidFiles.length)throw new OpeningBalanceFilesValidationError(invalidFiles);
  const values=parsed.map(result=>result.status==='fulfilled'?result.value:[]);
  const glRows=values[0]as Awaited<ReturnType<typeof parseOpeningAccountingFile>>;
  const arRows=values[1]as Awaited<ReturnType<typeof parseOpeningAccountingFile>>;
  const apRows=values[2]as Awaited<ReturnType<typeof parseOpeningAccountingFile>>;
  const assets=values[3]as Awaited<ReturnType<typeof parseOpeningFixedAssetFile>>;
  const pending=values[4]as Awaited<ReturnType<typeof parseOpeningPendingFile>>;
  const banks=values[5]as Awaited<ReturnType<typeof parseOpeningBankFile>>;
  const financialRows=[...glRows,...arRows,...apRows];
  if(!financialRows.length&&!assets.length&&!pending.length&&!banks.length)throw Error('Cargue al menos una plantilla con datos.');
  const validationSources:OpeningValidationSource[]=[
   {key:uploads[0].key,label:uploads[0].label,fileName:uploads[0].fileName,rows:glRows as unknown as Record<string,unknown>[]},
   {key:uploads[1].key,label:uploads[1].label,fileName:uploads[1].fileName,rows:arRows as unknown as Record<string,unknown>[]},
   {key:uploads[2].key,label:uploads[2].label,fileName:uploads[2].fileName,rows:apRows as unknown as Record<string,unknown>[]},
   {key:uploads[3].key,label:uploads[3].label,fileName:uploads[3].fileName,rows:assets as unknown as Record<string,unknown>[]},
   {key:uploads[4].key,label:uploads[4].label,fileName:uploads[4].fileName,rows:pending.flatMap(item=>item.lines)as unknown as Record<string,unknown>[]},
   {key:uploads[5].key,label:uploads[5].label,fileName:uploads[5].fileName,rows:banks as unknown as Record<string,unknown>[]}
  ];
  try{return normalizeOpeningPreview(await rpc(auth,map.validate,{p:{expectedSubsidiaryId:p.expectedSubsidiaryId,openingDate:p.openingDate,loadType:p.loadType,transitionAccountId:p.transitionAccountId,rows:financialRows,assets,pending,banks}}));}
  catch(cause){
   const rpcFiles=openingRpcFileErrors(cause,validationSources);
   if(rpcFiles.length)throw new OpeningBalanceFilesValidationError(rpcFiles);
   throw cause;
  }
 }
 const fn=map[action];if(!fn)throw Error('Acción inválida.');
 const result=await rpc(auth,fn,action==='preview'||action==='post'||action==='reverse'?{p_run_id:Number(p.runId)}:{});
 return action==='preview'?normalizeOpeningPreview(result):result;
}
