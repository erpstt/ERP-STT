import{fetchSupabase,getSupabaseConfig}from'../../core/database/supabase.client.js';

const map:Record<string,string>={options:'opening_balance_options',validate:'opening_balance_validate',preview:'opening_balance_preview',post:'opening_balance_post',reverse:'opening_balance_reverse'};
const MAX_OPENING_FILE_BYTES=5_000_000;
const MAX_OPENING_ROWS=50_000;
const MAX_OPENING_COLUMNS=200;

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
   if(record.some(cell=>cell!=='')){
    records.push(record);
    if(records.length>MAX_OPENING_ROWS+1)throw Error(`El archivo CSV supera el límite de ${MAX_OPENING_ROWS.toLocaleString('es-CR')} filas.`);
   }
   record=[];
  }else value+=character;
 }
 if(quoted)throw Error('El archivo CSV contiene un campo entre comillas sin cerrar.');
 record.push(value.trim());if(record.some(cell=>cell!==''))records.push(record);
 if(records.length<2)return[];
 if(records.length>MAX_OPENING_ROWS+1)throw Error(`El archivo CSV supera el límite de ${MAX_OPENING_ROWS.toLocaleString('es-CR')} filas.`);
 if(records[0].length>MAX_OPENING_COLUMNS)throw Error(`El archivo CSV supera el límite de ${MAX_OPENING_COLUMNS} columnas.`);
 const headers=records[0].map(header=>header.trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[^a-z0-9]+/g,'_').replace(/^_+|_+$/g,''));
 if(headers.some(header=>!header))throw Error('El archivo CSV contiene una columna sin encabezado.');
 if(new Set(headers).size!==headers.length)throw Error('El archivo CSV contiene encabezados duplicados.');
 return records.slice(1).map((values,index)=>{
  if(values.length>MAX_OPENING_COLUMNS)throw Error(`CSV fila ${index+2}: supera el límite de ${MAX_OPENING_COLUMNS} columnas.`);
  if(values.slice(headers.length).some(value=>value!==''))throw Error(`CSV fila ${index+2}: contiene más columnas que el encabezado.`);
  return{row:index+2,data:Object.fromEntries(headers.map((header,column)=>[header,values[column]??'']))};
 });
}

type ParsedRow={row:number;data:Record<string,string>};
type PendingLine={
 sourceRow:number;account:string;debit:string;credit:string;debitFx:string;creditFx:string;isControlLine:boolean;
 department:string;costCenter:string;className:string;financialCreditor:string;relatedCompany:string;location:string;note:string;
};
export type OpeningPendingItem={
 reference:string;originDate:string;entityTaxId:string;currency:string;exchangeRate:string;serviceMonth:string;serviceCountry:string;note:string;supportUrl:string;supportLink:string;lines:PendingLine[];
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
 if(nonEmpty.length<2)return[];
 const headerRecord=nonEmpty[0].record;
 if(headerRecord.length>MAX_OPENING_COLUMNS)throw Error(`La hoja de ${label} supera el límite de ${MAX_OPENING_COLUMNS} columnas.`);
 const headers=headerRecord.map(normalizedHeader);
 if(headers.some(header=>!header))throw Error(`La hoja de ${label} contiene una columna sin encabezado.`);
 if(new Set(headers).size!==headers.length)throw Error(`La hoja de ${label} contiene encabezados duplicados.`);
 return nonEmpty.slice(1).map(({record,row})=>{
  if(record.length>MAX_OPENING_COLUMNS)throw Error(`${label} fila ${row}: supera el límite de ${MAX_OPENING_COLUMNS} columnas.`);
  if(record.slice(headers.length).some(cell=>spreadsheetCell(cell)!==''))throw Error(`${label} fila ${row}: contiene más columnas que el encabezado.`);
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
  debito_moneda_local:['debito_local','debito'],credito_moneda_local:['credito_local','credito'],
  debito_moneda_original:['debito_moneda_origen','debito_original','debito_moneda_extranjera'],credito_moneda_original:['credito_moneda_origen','credito_original','credito_moneda_extranjera'],
  centro_costos:['centro_de_costos','centro_costo'],acreedor_financiero:['acreedores_financieros'],compania_relacionada:['companias_relacionadas'],sucursal:['ubicacion']
 };
 for(const{data}of parsed)for(const[target,candidates]of Object.entries(aliases))if(!(target in data)){
  const candidate=candidates.find(name=>name in data);if(candidate)data[target]=data[candidate];
 }
}

function applyPendingAliases(parsed:ParsedRow[]){
 const aliases:Record<string,string[]>={
  id_pendiente:['referencia','referencia_pendiente','numero_pendiente','numero_documento'],
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
  const balance=x.saldo||x.monto||'';
  return{
   sourceType:type,sourceRow:row,account:x.cuenta,documentNumber:x.numero_documento||'',issueDate:x.fecha_emision||'',dueDate:x.fecha_vencimiento||'',currency:(x.moneda||'').toUpperCase(),
   debit:amount(type==='GL'?x.debito_moneda_local:(type==='AR'?balance:'')),credit:amount(type==='GL'?x.credito_moneda_local:(type==='AP'?balance:'')),
   debitFx:amount(type==='GL'?x.debito_moneda_original:''),creditFx:amount(type==='GL'?x.credito_moneda_original:''),entityTaxId:x.identificacion_tercero||'',
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
function validIsoDate(value:string){
 const match=/^(\d{4})-(\d{2})-(\d{2})$/.exec(value);if(!match)return false;
 const year=Number(match[1]),month=Number(match[2]),day=Number(match[3]),date=new Date(Date.UTC(year,month-1,day));
 return date.getUTCFullYear()===year&&date.getUTCMonth()===month-1&&date.getUTCDate()===day;
}

function parseOpeningPendingRows(parsed:ParsedRow[],openingDate=''):OpeningPendingItem[]{
 applyPendingAliases(parsed);
 const required=['id_pendiente','fecha_origen','identificacion_cliente','moneda','tipo_cambio','cuenta','debito_moneda_local','credito_moneda_local','debito_moneda_original','credito_moneda_original','mes_servicio','pais_servicio','departamento','centro_costos','clase','acreedor_financiero','compania_relacionada','sucursal','nota'];
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
  const commonFields:[string,string][]=[['fecha_origen','fecha de origen'],['identificacion_cliente','cliente'],['moneda','moneda'],['tipo_cambio','tipo de cambio'],['mes_servicio','mes de servicio'],['pais_servicio','país de servicio'],['enlace_respaldo','enlace de respaldo']];
  for(const[field,label]of commonFields){
   const values=new Set(group.rows.map(({data})=>String(data[field]??'').trim().toUpperCase()));
   if(values.size>1)throw Error(`Pendiente ${reference}: ${label} debe ser igual en todas sus líneas.`);
  }
  const originDate=first.fecha_origen.trim(),serviceMonth=first.mes_servicio.trim(),currency=first.moneda.trim().toUpperCase(),entityTaxId=first.identificacion_cliente.trim(),serviceCountry=first.pais_servicio.trim().toUpperCase();
  if(!validIsoDate(originDate))throw Error(`Pendiente ${reference}: use fecha_origen con formato YYYY-MM-DD y una fecha válida.`);
  if(openingDate&&originDate>openingDate)throw Error(`Pendiente ${reference}: la fecha de origen no puede ser posterior a la fecha de apertura.`);
  if(!/^\d{4}-(0[1-9]|1[0-2])$/.test(serviceMonth))throw Error(`Pendiente ${reference}: use mes_servicio con formato YYYY-MM.`);
  if(openingDate&&serviceMonth>openingDate.slice(0,7))throw Error(`Pendiente ${reference}: el mes de servicio no puede ser posterior a la fecha de apertura.`);
  if(!entityTaxId)throw Error(`Pendiente ${reference}: complete la identificación del cliente.`);
  if(!/^[A-Z]{3}$/.test(currency))throw Error(`Pendiente ${reference}: moneda debe ser un código ISO de tres letras.`);
  if(!serviceCountry)throw Error(`Pendiente ${reference}: complete el país de servicio.`);
  const exchangeRate=exchangeRateDecimal(first.tipo_cambio,firstRow);
  if(group.rows.length!==2)throw Error(`Pendiente ${reference}: incluya exactamente dos líneas, 113003 al debe y 413001 al haber.`);
  const lines:PendingLine[]=group.rows.map(({row,data:x})=>{
   const account=x.cuenta.replace(/\s/g,'');
   if(!['113003','413001'].includes(account))throw Error(`Pendientes de Facturar fila ${row}: solo se permiten las cuentas 113003 y 413001.`);
   const debit=decimal(x.debito_moneda_local,'débito en moneda local',row),credit=decimal(x.credito_moneda_local,'crédito en moneda local',row),debitFx=decimal(x.debito_moneda_original,'débito en moneda original',row),creditFx=decimal(x.credito_moneda_original,'crédito en moneda original',row);
   if(account==='113003'&&(Number(debit)<=0||Number(credit)!==0||Number(debitFx)<=0||Number(creditFx)!==0))throw Error(`Pendientes de Facturar fila ${row}: la cuenta 113003 debe llevar el débito local y original.`);
   if(account==='413001'&&(Number(credit)<=0||Number(debit)!==0||Number(creditFx)<=0||Number(debitFx)!==0))throw Error(`Pendientes de Facturar fila ${row}: la cuenta 413001 debe llevar el crédito local y original.`);
   const marker=x.es_linea_control;
   if(marker!==undefined&&marker.trim()&&controlMarker(marker,row)!==(account==='113003'))throw Error(`Pendientes de Facturar fila ${row}: es_linea_control solo puede marcarse para la cuenta 113003.`);
   return{sourceRow:row,account,debit,credit,debitFx,creditFx,isControlLine:account==='113003',department:x.departamento||'',costCenter:x.centro_costos||'',className:x.clase||'',financialCreditor:x.acreedor_financiero||'',relatedCompany:x.compania_relacionada||'',location:x.sucursal||'',note:x.nota||''};
  });
  if(lines.filter(line=>line.account==='113003').length!==1||lines.filter(line=>line.account==='413001').length!==1)throw Error(`Pendiente ${reference}: incluya una línea 113003 y una línea 413001.`);
  const debit=lines.reduce((sum,line)=>sum+Number(line.debit),0),credit=lines.reduce((sum,line)=>sum+Number(line.credit),0),debitFx=lines.reduce((sum,line)=>sum+Number(line.debitFx),0),creditFx=lines.reduce((sum,line)=>sum+Number(line.creditFx),0);
  if(!close(debit,credit))throw Error(`Pendiente ${reference}: los débitos y créditos en moneda local no cuadran.`);
  if(!close(debitFx,creditFx,.00005))throw Error(`Pendiente ${reference}: los débitos y créditos en moneda original no cuadran.`);
  if(!close(debit,debitFx*Number(exchangeRate)))throw Error(`Pendiente ${reference}: el importe local no corresponde al importe original por el tipo de cambio indicado.`);
  const supportLink=(first.enlace_respaldo||'').trim();
  if(supportLink&&!/^https?:\/\/[^\s]+$/i.test(supportLink))throw Error(`Pendiente ${reference}: el enlace de respaldo debe iniciar con http:// o https://.`);
  items.push({reference,originDate,entityTaxId,currency,exchangeRate,serviceMonth,serviceCountry,note:group.rows.map(row=>row.data.nota).find(Boolean)||'',supportUrl:supportLink,supportLink,lines});
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
  const transactionDate=(x.fecha_movimiento||'').trim(),valueDate=(x.fecha_valor||'').trim(),reference=(x.referencia||'').trim();
  if(!bankCode)throw Error(`${label} fila ${row}: complete codigo_banco.`);
  if(!accountNumber)throw Error(`${label} fila ${row}: complete numero_cuenta_bancaria.`);
  if(!/^[A-Z]{3}$/.test(currency))throw Error(`${label} fila ${row}: moneda debe ser un codigo ISO de tres letras.`);
  if(!allowed.has(recordType))throw Error(`${label} fila ${row}: tipo_registro debe ser SALDO_CONCILIADO, DEPOSITO_EN_TRANSITO o CHEQUE_EN_TRANSITO.`);
  if(!validIsoDate(transactionDate))throw Error(`${label} fila ${row}: use fecha_movimiento con formato YYYY-MM-DD y una fecha valida.`);
  if(openingDate&&transactionDate>openingDate)throw Error(`${label} fila ${row}: fecha_movimiento no puede ser posterior a la fecha de apertura.`);
  if(valueDate&&!validIsoDate(valueDate))throw Error(`${label} fila ${row}: use fecha_valor con formato YYYY-MM-DD y una fecha valida, o dejela vacia.`);
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
 return parsed.map(({row,data:x})=>({
  sourceRow:row,assetNumber:x.codigo_activo||'AUTO',name:x.nombre_activo,categoryCode:(x.codigo_categoria||'').toUpperCase(),serial:x.numero_serie||'',description:x.descripcion||'',purchaseDate:x.fecha_compra||'',serviceDate:x.fecha_en_servicio||'',cost:amount(x.costo_historico),accumulatedDepreciation:amount(x.depreciacion_acumulada),bookValue:amount(x.valor_en_libros),depreciatedMonths:x.meses_depreciados||'0',location:x.ubicacion||'',departmentType:x.tipo_departamento||'',department:x.departamento||'',costCenter:x.centro_costos||'',className:x.clase||'',status:(x.estado||'ACTIVO').toUpperCase(),currency:(x.moneda||'').toUpperCase(),note:x.nota||''
 }));
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
 return{
  ...result,
  pendingSummary:result.pendingSummary??result.pending_summary??nested.summary??{},
  pendingReconciliation:result.pendingReconciliation??result.pending_reconciliation??nested.reconciliation??[],
  pendingItems:result.pendingItems??result.pending_items??nested.items??(Array.isArray(result.pending)?result.pending:[]),
  bankSummary:result.bankSummary??result.bank_summary??result.banksSummary??result.banks_summary??(result.banks&&typeof result.banks==='object'&&!Array.isArray(result.banks)?(result.banks as Record<string,unknown>).summary:{}),
  bankReconciliation:result.bankReconciliation??result.bank_reconciliation??result.banksReconciliation??result.banks_reconciliation??(result.banks&&typeof result.banks==='object'&&!Array.isArray(result.banks)?(result.banks as Record<string,unknown>).reconciliation:[]),
  bankItems:result.bankItems??result.bank_items??result.banksItems??result.banks_items??(result.banks&&typeof result.banks==='object'&&!Array.isArray(result.banks)?(result.banks as Record<string,unknown>).items:[])??[]
 };
}

export async function openingBalances(auth:string,action:string,p:Record<string,unknown>={}){
 if(action==='validate'){
  const openingDate=String(p.openingDate||'');
  const[glRows,arRows,apRows,assets,pending,banks]=await Promise.all([
   parseOpeningAccountingFile(p.gl,'GL',String(p.glFileName||'')),
   parseOpeningAccountingFile(p.ar,'AR',String(p.arFileName||'')),
   parseOpeningAccountingFile(p.ap,'AP',String(p.apFileName||'')),
   parseOpeningFixedAssetFile(p.fa,String(p.faFileName||'')),
   parseOpeningPendingFile(p.pending,openingDate,String(p.pendingFileName||'')),
   parseOpeningBankFile(p.banks,openingDate,String(p.banksFileName||''))
  ]);
  const financialRows=[...glRows,...arRows,...apRows];
  if(!financialRows.length&&!assets.length&&!pending.length&&!banks.length)throw Error('Cargue al menos una plantilla con datos.');
  return normalizeOpeningPreview(await rpc(auth,map.validate,{p:{expectedSubsidiaryId:p.expectedSubsidiaryId,openingDate:p.openingDate,loadType:p.loadType,transitionAccountId:p.transitionAccountId,rows:financialRows,assets,pending,banks}}));
 }
 const fn=map[action];if(!fn)throw Error('Acción inválida.');
 const result=await rpc(auth,fn,action==='preview'||action==='post'||action==='reverse'?{p_run_id:Number(p.runId)}:{});
 return action==='preview'?normalizeOpeningPreview(result):result;
}
