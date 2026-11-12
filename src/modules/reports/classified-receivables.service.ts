import {requireReportAccess,fetchReportSupabase} from './report-access.service.js';
import {getSupabaseConfig} from '../../core/database/supabase.client.js';
import {createExcelWorkbook} from '../../core/export/excel-workbook.js';
import {renderPdf} from '../../core/security/pdf-renderer.js';
type Row=Record<string,any>;
type Report={rows:Row[];total:number;summary:Row;consolidated?:boolean};
export const receivableBlocks=[['CUSTOMER','Facturación de clientes'],['INTERCOMPANY','Facturación Intercompany'],['DISCOUNTED','Facturación descontada']] as const;
export const receivableBuckets=['CURRENT','1_30','31_60','61_90','91_120','OVER_120'];
export const receivableHeaders=['Cliente','Factura','Emisión','Vencimiento','Moneda','Monto original','Aplicado','Saldo pendiente','Por vencer','1–30 días','31–60 días','61–90 días','91–120 días','Más de 120 días','Facturas descontadas'];
const esc=(value:unknown)=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
export const receivableBlock=(row:Row)=>row.discounted?'DISCOUNTED':row.intercompany?'INTERCOMPANY':'CUSTOMER';
const number=(value:unknown)=>Number(value||0);
export function receivableCells(row:Row){return [row.entity_name,row.document_number,row.issue_date,row.due_date,row.report_currency,number(row.original_amount),number(row.applied_amount),number(row.pending),...receivableBuckets.map(b=>row.bucket===b?number(row.pending):0),row.discounted?'Sí':'No'];}
async function rpc<T>(auth:string,name:string,input:Row):Promise<T>{
 await requireReportAccess(auth);const config=getSupabaseConfig();if(!config)throw Error('Base de datos no configurada.');
 const response=await fetchReportSupabase(new URL(`/rest/v1/rpc/${name}`,config.url),{method:'POST',headers:{apikey:config.anonKey,Authorization:auth,'Content-Type':'application/json'},body:JSON.stringify(input)});
 const data=await response.json();if(!response.ok)throw Object.assign(Error(data.message||'No fue posible procesar el informe.'),{status:response.status===403?403:response.status===409?409:400});return data as T;
}
export async function runClassifiedReceivables(auth:string,input:Row):Promise<Report>{
 await requireReportAccess(auth);
 if(typeof input.dateTo!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(input.dateTo))throw Object.assign(Error('Seleccione la fecha de corte.'),{status:400});
 const rows:Row[]=[];let first:Report|undefined;
 for(let page=1;page<=200;page++){
  const report=await rpc<Report>(auth,'run_classified_receivables_report',{p_filters:{...input,page,pageSize:250}});first??=report;
  rows.push(...report.rows);if(rows.length>=report.total||!report.rows.length){if(rows.length!==report.total)throw Error('Los datos cambiaron durante la consulta. Consulte nuevamente.');return {...first,rows,total:rows.length};}
 }
 throw Object.assign(Error('El informe supera 50.000 facturas. Reduzca los filtros.'),{status:400});
}
export async function setReceivableDiscount(auth:string,input:Row){
 if(!Number.isSafeInteger(input.invoiceId)||input.invoiceId<=0||typeof input.discounted!=='boolean'||typeof input.expected!=='boolean')throw Object.assign(Error('Seleccione una factura y una marca válidas.'),{status:400});
 return rpc(auth,'set_receivable_discount_mark',{p_invoice_id:input.invoiceId,p_discounted:input.discounted,p_expected:input.expected});
}
export function currencyGroups(report:Report,input:Row,options:Row){
 const subsidiary=(options.subsidiaries||[]).find((s:Row)=>String(s.id)===String(input.subsidiaryIds?.[0]));
 const local=(options.currencies||[]).find((c:Row)=>String(c.id)===String(subsidiary?.currencyId))?.code||'LOCAL';
 return receivableBlocks.map(([key,label])=>({key,label,groups:[...new Set(report.rows.filter(row=>receivableBlock(row)===key).map(row=>input.consolidated?'USD':input.agingCurrencyMode==='ORIGINAL'?String(row.currency_code||row.currencyCode||'MONEDA'):local))].sort().map(currency=>({currency,rows:report.rows.filter(row=>receivableBlock(row)===key&&(input.consolidated?'USD':input.agingCurrencyMode==='ORIGINAL'?String(row.currency_code||row.currencyCode||'MONEDA'):local)===currency).map(row=>({...row,report_currency:currency}))}))}));
}
export async function exportClassifiedReceivables(auth:string,input:Row,format:'pdf'|'excel',options:Row){
 const report=await runClassifiedReceivables(auth,input),blocks=currencyGroups(report,input,options);
 const company=input.consolidated?'Consolidado USD':(options.subsidiaries||[]).find((s:Row)=>String(s.id)===String(input.subsidiaryIds?.[0]))?.name||'Subsidiaria';
 const title='Cuentas por Cobrar · Clasificación de facturas',filename=`cuentas-por-cobrar-clasificadas-${input.dateTo}`;
 if(format==='excel'){
  const workbook=await createExcelWorkbook();workbook.creator='GENTIA ERP';
  for(const block of blocks){const sheet=workbook.addWorksheet(block.label.slice(0,31));sheet.addRow([company]);sheet.addRow([title]);sheet.addRow([`Corte: ${input.dateTo} · Marcas actuales, sin efecto contable`]);const heading=sheet.addRow(receivableHeaders);heading.font={bold:true,color:{argb:'FFFFFFFF'}};heading.fill={type:'pattern',pattern:'solid',fgColor:{argb:'FF073574'}};sheet.views=[{state:'frozen',ySplit:4}];
   for(const group of block.groups){sheet.addRow([group.currency]).font={bold:true};for(const row of group.rows)sheet.addRow(receivableCells(row));const totals=Array.from({length:15},()=>'' as string|number);totals[0]=`Subtotal ${group.currency}`;totals[4]=group.currency;for(let n=5;n<14;n++)totals[n]=group.rows.reduce((sum,row)=>sum+Number(receivableCells(row)[n]),0);sheet.addRow(totals).font={bold:true};}
   if(!block.groups.length)sheet.addRow(['Sin facturas']);
   sheet.columns.forEach((column,i)=>{column.width=i===0?36:i===1?28:18;if(i>=5&&i<14)column.numFmt='#,##0.00;(#,##0.00)';});sheet.getColumn(1).alignment={wrapText:true};sheet.getColumn(2).alignment={wrapText:true};sheet.pageSetup={orientation:'landscape',paperSize:9,fitToPage:true,fitToWidth:1,fitToHeight:0};
  }return {fileName:filename+'.xlsx',mimeType:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',base64:Buffer.from(await workbook.xlsx.writeBuffer()).toString('base64')};
 }
 const money=(n:unknown)=>number(n).toLocaleString('es-CR',{minimumFractionDigits:2,maximumFractionDigits:2});
 const html=`<!doctype html><html lang="es"><meta charset="utf-8"><style>@page{size:A3 landscape;margin:14mm}body{font:10px Arial;color:#172d49}header{border-bottom:3px solid #08977d;padding-bottom:15px}h1{font-size:24px;margin:8px 0}h2{font-size:16px;color:#063574;margin:22px 0 10px}p{color:#60738a}table{width:100%;border-collapse:collapse;margin:12px 0 22px}thead{display:table-header-group}th{background:#073574;color:white;text-align:left;padding:9px 5px;font-size:9px}td{padding:8px 5px;border-bottom:1px solid #d9e3ed}tr{break-inside:avoid}tbody tr:nth-child(even){background:#f4f7fa}.num{text-align:right;white-space:nowrap}.subtotal{font-weight:bold;background:#e5f4ef}footer{margin-top:25px;border-top:1px solid #d9e3ed;padding-top:10px;color:#60738a}</style><header><b>GENTIA · INFORMES CONTABLES</b><h1>${esc(title)}</h1><b>${esc(company)}</b><p>Corte: ${esc(input.dateTo)} · Marcas actuales de clasificación, sin efecto en saldos ni contabilidad.</p></header>${blocks.map(block=>`<h2>${esc(block.label)}</h2>${block.groups.length?block.groups.map(group=>`<b>${esc(group.currency)} · ${group.rows.length} facturas</b><table><thead><tr>${receivableHeaders.map((h,i)=>`<th${i>=5&&i<14?' class="num"':''}>${esc(h)}</th>`).join('')}</tr></thead><tbody>${group.rows.map(row=>`<tr>${receivableCells(row).map((v,i)=>`<td${i>=5&&i<14?' class="num"':''}>${esc(i>=5&&i<14?money(v):v)}</td>`).join('')}</tr>`).join('')}<tr class="subtotal"><td colspan="5">Subtotal ${esc(group.currency)}</td>${Array.from({length:9},(_,i)=>`<td class="num">${esc(money(group.rows.reduce((sum,row)=>sum+Number(receivableCells(row)[i+5]),0)))}</td>`).join('')}<td></td></tr></tbody></table>`).join(''):'<p>Sin facturas.</p>'}`).join('')}<footer>Generado desde GENTIA ERP · ${esc(new Date().toISOString().slice(0,10))} · Importes separados por moneda. Los anticipos sin aplicar no se asignan a estos bloques de facturas.</footer></html>`;
 return {fileName:filename+'.pdf',mimeType:'application/pdf',base64:(await renderPdf(html)).toString('base64')};
}
