import {safeHttpUrl} from './html-safety.js?v=20261101-a03-1';

// CSV is intended for viewing. XLSX preserves text types without adding a prefix.
export function csvCell(value,{numeric=false}={}) {
 let text=String(value??'');
 const number=typeof value==='number'&&Number.isFinite(value)||numeric&&/^-?\d+(?:[.,]\d+)?$/.test(text);
 if(!number&&(/^[\s\p{Cf}\u0000-\u001f\u007f]*[=+\-@\uff1d\uff0b\uff0d\uff20]/u.test(text)||/^[\t\r\n]/.test(text)))text='\t'+text;
 return '"'+text.replaceAll('"','""')+'"';
}

// Parse only the exact es-CR format emitted by the report, never arbitrary text.
export function reportNumber(value,symbol='') {
 let text=String(value??'').trim(),negative=false;
 if(text.startsWith('(')&&text.endsWith(')')){negative=true;text=text.slice(1,-1).trim();}
 if(symbol&&text.startsWith(symbol))text=text.slice(symbol.length).trim();
 if(!/^-?(?:\d+|\d{1,3}(?:[.\s\u00a0]\d{3})+),\d{2}$/.test(text))return String(value??'');
 const number=Number(text.replace(/[.\s\u00a0]/g,'').replace(',','.'));
 return negative?-number:number;
}

let runtime;
async function excelRuntime(){
 runtime??=(async()=>{
  if(typeof window==='undefined'){const mod=await import('exceljs');return mod.default??mod;}
  await import('./vendor/exceljs-4.4.0.min.js');
  if(!window.ExcelJS?.Workbook)throw Error('No fue posible cargar la exportación Excel.');
  return window.ExcelJS;
 })();
 try{return await runtime;}catch(error){runtime=undefined;throw error;}
}
const cellValue=value=>typeof value==='number'&&Number.isFinite(value)||typeof value==='boolean'?value:String(value??'');
function linkUrl(value){try{return safeHttpUrl(new URL(String(value),globalThis.location?.origin||'https://invalid.local').href);}catch{return '';}}
async function addLogo(workbook,sheet,value){
 if(!value)return;
 try{
  let bytes;
  if(/^data:image\/(?:png|jpeg);base64,[a-z0-9+/=]+$/i.test(value)){
   if(value.length>2800000)return;
   const binary=atob(value.slice(value.indexOf(',')+1));bytes=Uint8Array.from(binary,c=>c.charCodeAt(0));
  }else{
   const url=linkUrl(value);if(!url)return;
   const response=await fetch(url,{credentials:'omit',redirect:'error',signal:AbortSignal.timeout(4000)});
   if(!response.ok||Number(response.headers.get('content-length')||0)>2000000)return;
   const reader=response.body.getReader(),chunks=[];let length=0;
   try{while(true){const {done,value}=await reader.read();if(done)break;length+=value.length;if(length>2000000){await reader.cancel();return;}chunks.push(value);}}finally{reader.releaseLock();}
   bytes=new Uint8Array(length);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
  }
  const png=[137,80,78,71,13,10,26,10].every((v,i)=>bytes[i]===v),jpeg=bytes[0]===255&&bytes[1]===216&&bytes[2]===255;
  if(!png&&!jpeg)return;
  const id=workbook.addImage({buffer:bytes,extension:png?'png':'jpeg'});
  sheet.addImage(id,{tl:{col:4,row:0},ext:{width:150,height:65}});
 }catch{/* A missing or unavailable logo must not prevent the report download. */}
}

export async function reportWorkbook({headers,rows,context={},title='Reporte',totalColumns=[],links=[],extraSheets=[]}){
 const ExcelJS=await excelRuntime(),workbook=new ExcelJS.Workbook();workbook.creator='GENTIA ERP';
 workbook.calcProperties.fullCalcOnLoad=true;
 const sheet=workbook.addWorksheet('Reporte');
 for(const value of [context.subsidiaryName,title,context.periodLabel,context.currencyLabel])sheet.addRow([String(value??'')]);
 sheet.addRow([]);const heading=sheet.addRow(headers.map(value=>String(value??''))),first=heading.number+1;
 function addRows(target,values){for(const row of values){const added=target.addRow(row.map(cellValue));added.eachCell(cell=>{if(typeof cell.value==='number')cell.numFmt='#,##0.00;(#,##0.00)';});}}
 addRows(sheet,rows);
 // Formula objects can only originate here, from validated integer column indexes.
 if(rows.length&&totalColumns.length){const total=sheet.addRow([]);for(const index of totalColumns){if(!Number.isInteger(index)||index<0||index>=headers.length)throw Error('Columna de total inválida.');const column=sheet.getColumn(index+1).letter,result=rows.reduce((sum,row)=>sum+(typeof row[index]==='number'&&Number.isFinite(row[index])?row[index]:0),0);total.getCell(index+1).value={formula:`SUM(${column}${first}:${column}${first+rows.length-1})`,result};total.getCell(index+1).numFmt='#,##0.00;(#,##0.00)';}}
 for(const link of links){if(!Number.isInteger(link.row)||link.row<0||link.row>=rows.length||!Number.isInteger(link.column)||link.column<0||link.column>=headers.length)continue;const url=linkUrl(link.url);if(url){const cell=sheet.getCell(first+link.row,link.column+1);cell.value={text:String(rows[link.row][link.column]??''),hyperlink:url};}}
 const style=(target,header)=>{header.font={bold:true,color:{argb:'FFFFFFFF'}};header.fill={type:'pattern',pattern:'solid',fgColor:{argb:'FF063B79'}};target.views=[{state:'frozen',ySplit:header.number}];for(let i=1;i<=target.columnCount;i++)target.getColumn(i).width=i===1?22:30;};style(sheet,heading);
 for(const [index,extra]of extraSheets.entries()){const target=workbook.addWorksheet('Detalle '+(index+1)),header=target.addRow(extra.headers.map(value=>String(value??'')));addRows(target,extra.rows);style(target,header);for(const link of extra.links||[]){const url=linkUrl(link.url);if(url&&Number.isInteger(link.row)&&link.row>=0&&link.row<extra.rows.length&&Number.isInteger(link.column)&&link.column>=0&&link.column<extra.headers.length)target.getCell(link.row+2,link.column+1).value={text:String(extra.rows[link.row][link.column]??''),hyperlink:url};}}
 await addLogo(workbook,sheet,context.logoUrl);
 return new Blob([await workbook.xlsx.writeBuffer()],{type:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'});
}
