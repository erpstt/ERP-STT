import {createExcelWorkbook} from '../../core/export/excel-workbook.js';
import {csvCell} from '../../core/export/csv-cell.js';
import {renderPdf} from '../../core/security/pdf-renderer.js';
import type {GeneralLedgerExportSnapshot} from './general-ledger-export-data.service.js';
export type {GeneralLedgerExportSnapshot} from './general-ledger-export-data.service.js';

export type GeneralLedgerExportFormat='csv'|'xlsx'|'pdf';
export type GeneralLedgerExportView='ACCOUNT'|'ENTITY'|'COST';
export type GeneralLedgerExportRow=Record<string,unknown>;
export type GeneralLedgerExportFile={fileName:string;mimeType:string;buffer:Buffer};
type Cell=string|number|null;
type Movement={source:GeneralLedgerExportRow;values:Cell[]};
type Group={label:string;items:Movement[];debit:number;credit:number};
type Account={id:string;number:string;name:string;nature:string;opening:number;debit:number;credit:number;closing:number;groups:Group[];groupMap:Map<string,Group>};
type Model={snapshot:GeneralLedgerExportSnapshot;view:GeneralLedgerExportView;viewName:string;accounts:Account[]};
const moneyFormat='#,##0.00####;(#,##0.00####)',rateFormat='0.############';
const headings=['Fecha','Tipo de transacción','Documento de origen','No. asiento','Tercero / Entidad','Centro de costo','Concepto / Glosa','Débito local','Crédito local','Saldo de la cuenta','Moneda original','Tipo de cambio utilizado','Débito original','Crédito original'];
const keys=['date','transaction_type','transaction_number','journal_number','entity_name','cost_center','concept','debit','credit','running_balance','original_currency_code','original_exchange_rate','original_debit','original_credit'];
const viewNames={ACCOUNT:'Por cuenta',ENTITY:'Auxiliar por tercero',COST:'Auxiliar por centro de costo'};
const escaped=(value:unknown)=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]!));
function invalid(message='No fue posible confirmar el contenido completo del Libro Mayor. Genere nuevamente el reporte.'):never{throw Object.assign(new Error(message),{status:502});}
function text(value:unknown){if(value===null||value===undefined)return'';if(!['string','number','boolean'].includes(typeof value))return invalid();return String(value);}
function numeric(value:unknown,nullable=false):number|null{
 if(value===null||value===undefined||value===''){if(nullable)return null;return invalid();}
 if(typeof value!=='number'&&!(typeof value==='string'&&/^-?\d+(?:\.\d+)?(?:e[+-]?\d+)?$/i.test(value)))return invalid();
 const number=Number(value);if(!Number.isFinite(number))return invalid();return number;
}
function date(value:unknown){if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(value)||!Number.isFinite(Date.parse(value+'T00:00:00Z'))||new Date(value+'T00:00:00Z').toISOString().slice(0,10)!==value)return invalid();return value;}
function sum(values:number[]){
 // Amounts are stored at six decimals. Decimal summation prevents binary
 // accumulation from introducing spurious pennies in presentation subtotals.
 let total=0n;for(const value of values){const [coefficient,exponent='0']=String(value).toLowerCase().split('e');const negative=coefficient!.startsWith('-'),unsigned=coefficient!.replace(/^-/,''),[whole,fraction='']=unsigned.split('.');let units=BigInt((whole??'0')+fraction),power=6+Number(exponent)-fraction.length;
  if(power>=0)units*=10n**BigInt(power);else{const divisor=10n**BigInt(-power);units=(units+divisor/2n)/divisor;}total+=negative?-units:units;
 }return Number(total)/1e6;
}
function model(snapshot:GeneralLedgerExportSnapshot,view:GeneralLedgerExportView):Model{
 if(!Object.hasOwn(viewNames,view))throw Object.assign(Error('Seleccione una vista válida del Libro Mayor.'),{status:400});
 if(!snapshot||!snapshot.context||!Array.isArray(snapshot.rows)||!Number.isSafeInteger(snapshot.total)||snapshot.total<0||snapshot.rows.length!==snapshot.total||!/^[a-f0-9]{32}$/i.test(snapshot.snapshotFingerprint??''))return invalid();
 const context=snapshot.context;date(context.dateFrom);date(context.dateTo);if(context.dateFrom>context.dateTo||!text(context.subsidiary?.name)||!text(context.localCurrency?.code)||!Number.isFinite(Date.parse(context.generatedAt)))return invalid();
 numeric(snapshot.summary?.debit);numeric(snapshot.summary?.credit);
 const byAccount=new Map<string,Account>(),seen=new Set<string>();
 for(const row of snapshot.rows){
  if(!row||typeof row!=='object'||Array.isArray(row))return invalid();const rowId=text(row.id);if(!rowId||seen.has(rowId))return invalid();seen.add(rowId);
  const id=text(row.account_id),number=text(row.account_number),name=text(row.account_name),nature=text(row.nature);if(!id||!number||!name)return invalid();
  const opening=numeric(row.opening_balance)!,debit=numeric(row.account_debit_total)!,credit=numeric(row.account_credit_total)!,closing=numeric(row.account_final_balance)!;
  let account=byAccount.get(id);if(!account){account={id,number,name,nature,opening,debit,credit,closing,groups:[],groupMap:new Map()};byAccount.set(id,account);}else if(account.number!==number||account.name!==name||account.nature!==nature||account.opening!==opening||account.debit!==debit||account.credit!==credit||account.closing!==closing)return invalid();
  const values:Cell[]=keys.map((key,index)=>index===0?date(row[key]):[7,8,9].includes(index)?numeric(row[key]):[11,12,13].includes(index)?numeric(row[key],true):text(row[key])||null);
  const label=view==='ENTITY'?[text(row.entity_type),text(row.entity_name)].filter(Boolean).join(': ')||'Sin tercero':view==='COST'?text(row.cost_center)||'Sin centro de costo':'Movimientos';
  let group=account.groupMap.get(label);if(!group){group={label,items:[],debit:0,credit:0};account.groups.push(group);account.groupMap.set(label,group);}group.items.push({source:row,values});
 }
 for(const account of byAccount.values())for(const group of account.groups){group.debit=sum(group.items.map(item=>item.values[7]as number));group.credit=sum(group.items.map(item=>item.values[8]as number));}
 return{snapshot,view,viewName:viewNames[view],accounts:[...byAccount.values()]};
}
const money=(value:Cell)=>value===null?'—':Number(value).toLocaleString('es-CR',{minimumFractionDigits:2,maximumFractionDigits:6});
const rate=(value:Cell)=>value===null?'—':Number(value).toLocaleString('es-CR',{maximumFractionDigits:12});
const period=(m:Model)=>`${m.snapshot.context.dateFrom} al ${m.snapshot.context.dateTo}`;
const book=(m:Model)=>m.snapshot.context.book?.name||'Todos los libros';
function display(value:Cell,index:number){return[7,8,9,12,13].includes(index)?money(value):index===11?rate(value):text(value)||'—';}
function csv(m:Model){
 const c=m.snapshot.context,rows:Cell[][]=[['tipo_fila','empresa','libro','fecha_desde','fecha_hasta','moneda_local','vista','cuenta_codigo','cuenta_nombre','grupo',...headings]];
 const add=(kind:string,account:Account,group:string,values:Cell[])=>rows.push([kind,c.subsidiary.name,book(m),c.dateFrom,c.dateTo,c.localCurrency.code,m.viewName,account.number,account.name,group,...values]);
 for(const account of m.accounts){
  const opening:Array<Cell>=Array(14).fill(null);opening[6]='Saldo inicial';opening[9]=account.opening;add('SALDO_INICIAL',account,'',opening);
  for(const group of account.groups){for(const item of group.items)add('MOVIMIENTO',account,m.view==='ACCOUNT'?'':group.label,item.values);if(m.view!=='ACCOUNT'){const cells:Array<Cell>=Array(14).fill(null);cells[6]='Subtotal '+group.label;cells[7]=group.debit;cells[8]=group.credit;add('SUBTOTAL_GRUPO',account,group.label,cells);}}
  const closing:Array<Cell>=Array(14).fill(null);closing[6]='Totales y saldo final de la cuenta';closing[7]=account.debit;closing[8]=account.credit;closing[9]=account.closing;add('TOTAL_CUENTA',account,'',closing);
 }
 return Buffer.from('\uFEFF'+rows.map(row=>row.map(value=>csvCell(value)).join(',')).join('\r\n')+'\r\n','utf8');
}
async function xlsx(m:Model){
 const workbook=await createExcelWorkbook();workbook.creator='GENTIA';workbook.created=new Date(m.snapshot.context.generatedAt);
 const sheet=workbook.addWorksheet('Libro Mayor',{views:[{showGridLines:false,state:'frozen',ySplit:8}],pageSetup:{paperSize:9,orientation:'landscape',fitToPage:true,fitToWidth:1,fitToHeight:0,printTitlesRow:'1:8'}});
 const widths=[13,25,23,23,31,27,52,19,19,22,17,25,22,22];sheet.columns=widths.map(width=>({width}));
 sheet.addRow([]);sheet.addRow(['Libro Mayor']);sheet.getRow(2).font={name:'Arial',size:16,bold:true,color:{argb:'FF143E4D'}};
 sheet.addRow([m.snapshot.context.subsidiary.name]);sheet.getRow(3).font={name:'Arial',size:12,bold:true};
 sheet.addRow(['Período: '+period(m)]);sheet.addRow([`Moneda local: ${m.snapshot.context.localCurrency.code}. La moneda original se indica en cada movimiento.`]);
 sheet.addRow([`${book(m)}. ${m.viewName}. ${m.snapshot.total} movimientos.`]);sheet.addRow([m.view==='ACCOUNT'?'': 'El saldo acumulado corresponde a la cuenta; no representa el saldo del tercero o del centro de costo.']);
 for(let row=2;row<=7;row++)sheet.mergeCells(row,1,row,14);
 sheet.addRow(headings);const header=sheet.getRow(8);header.height=33;header.font={name:'Arial',size:10,bold:true,color:{argb:'FFFFFFFF'}};header.fill={type:'pattern',pattern:'solid',fgColor:{argb:'FF143E4D'}};header.alignment={vertical:'middle',horizontal:'center',wrapText:true};
 const rowStyle=(rowNumber:number,background:string,bold=false)=>{const row=sheet.getRow(rowNumber);row.font={name:'Arial',size:10,bold,color:{argb:'FF203C47'}};row.fill={type:'pattern',pattern:'solid',fgColor:{argb:background}};row.height=24;row.alignment={vertical:'middle'};};
 const summary=(label:string,debit:number|null,credit:number|null,balance:number|null)=>{const values:Cell[]=Array(14).fill(null);values[0]=label;values[7]=debit;values[8]=credit;values[9]=balance;const row=sheet.addRow(values);sheet.mergeCells(row.number,1,row.number,7);for(const n of[8,9,10])row.getCell(n).numFmt=moneyFormat;rowStyle(row.number,'FFEAF0F2',true);return row;};
 for(const account of m.accounts){
  const title=sheet.addRow([`${account.number} - ${account.name} · Naturaleza: ${account.nature}`]);sheet.mergeCells(title.number,1,title.number,14);rowStyle(title.number,'FFD7E6EA',true);title.getCell(1).numFmt='@';
  summary('Saldo inicial',null,null,account.opening);
  for(const group of account.groups){
   if(m.view!=='ACCOUNT'){const row=sheet.addRow([group.label]);sheet.mergeCells(row.number,1,row.number,14);rowStyle(row.number,'FFF1F5F5',true);}
   for(const item of group.items){const values=item.values.map((value,index)=>index===0?new Date(String(value)+'T00:00:00Z'):value),row=sheet.addRow(values);row.font={name:'Arial',size:10,color:{argb:'FF243B45'}};row.alignment={vertical:'top',wrapText:true};row.height=Math.max(24,Math.min(409.5,15*Math.ceil(Math.max(text(item.values[6]).length/50,text(item.values[4]).length/30,1))));for(let col=1;col<=14;col++){const cell=row.getCell(col);if(col===1)cell.numFmt='yyyy-mm-dd';else if([8,9,10,13,14].includes(col)){cell.numFmt=moneyFormat;cell.alignment={horizontal:'right',vertical:'top'};}else if(col===12){cell.numFmt=rateFormat;cell.alignment={horizontal:'right',vertical:'top'};}else cell.numFmt='@';}}
   if(m.view!=='ACCOUNT')summary('Subtotal '+group.label,group.debit,group.credit,null);
  }
  summary('Totales y saldo final de la cuenta',account.debit,account.credit,account.closing);
 }
 if(!m.accounts.length)sheet.addRow(['Sin movimientos para los filtros seleccionados.']);
 summary('Totales de movimientos del reporte',Number(m.snapshot.summary.debit),Number(m.snapshot.summary.credit),null);
 sheet.headerFooter.oddFooter='&LGENTIA - Libro Mayor&RPágina &P de &N';sheet.pageSetup.printArea=`A1:N${sheet.rowCount}`;
 return Buffer.from(await workbook.xlsx.writeBuffer());
}
export function generalLedgerPdfHtml(snapshot:GeneralLedgerExportSnapshot,view:GeneralLedgerExportView){
 const m=model(snapshot,view),c=snapshot.context;
 const context=`${period(m)} · ${book(m)} · ${m.viewName}`;
 const sections=m.accounts.map(account=>`<section><table><colgroup>${[5.5,7.5,8,8,10,8,10,6.5,6.5,7,4,6.5,6,6.5].map(width=>`<col style="width:${width}%">`).join('')}</colgroup><thead><tr><th class="account" colspan="14"><strong>${escaped(account.number)} - ${escaped(account.name)}</strong><span>Naturaleza: ${escaped(account.nature)} · Saldo inicial: ${escaped(money(account.opening))} ${escaped(c.localCurrency.code)}</span></th></tr><tr>${headings.map((label,index)=>`<th${[7,8,9,11,12,13].includes(index)?' class="num"':''}>${escaped(label)}</th>`).join('')}</tr></thead><tbody>${account.groups.map(group=>`${m.view==='ACCOUNT'?'':`<tr class="subgroup"><td colspan="14">${escaped(group.label)}</td></tr>`}${group.items.map(item=>`<tr>${item.values.map((value,index)=>`<td${[7,8,9,11,12,13].includes(index)?' class="num"':''}>${escaped(display(value,index))}</td>`).join('')}</tr>`).join('')}${m.view==='ACCOUNT'?'':`<tr class="subtotal"><td colspan="7">Subtotal ${escaped(group.label)}</td><td class="num">${escaped(money(group.debit))}</td><td class="num">${escaped(money(group.credit))}</td><td></td><td colspan="4"></td></tr>`}`).join('')}<tr class="closing"><td colspan="7">Totales y saldo final de la cuenta</td><td class="num">${escaped(money(account.debit))}</td><td class="num">${escaped(money(account.credit))}</td><td class="num">${escaped(money(account.closing))}</td><td colspan="4"></td></tr></tbody></table></section>`).join('');
 return`<!doctype html><html lang="es"><head><meta charset="utf-8"><style>@page{size:A3 landscape;margin:12mm 10mm 17mm;@bottom-left{content:"GENTIA - Libro Mayor";font:8pt Arial;color:#607680}@bottom-right{content:"Página " counter(page) " de " counter(pages);font:8pt Arial;color:#607680}}*{box-sizing:border-box}body{margin:0;font:8.4pt Arial,sans-serif;color:#253d47}header{border-bottom:2pt solid #1c786d;padding-bottom:11pt;margin-bottom:14pt}.brand{font-size:10pt;letter-spacing:2pt;color:#1b766d;font-weight:bold}h1{font-size:24pt;margin:5pt 0}h2{font-size:12pt;margin:0 0 6pt}.context{color:#536b76;line-height:1.6}.metrics{margin:10pt 0 14pt;padding:9pt 12pt;background:#eef4f5;color:#284b58}.metrics b{margin-right:24pt}.note{font-size:8pt;color:#586f79;margin:8pt 0 14pt}section{margin:0 0 15pt}table{width:100%;border-collapse:collapse;table-layout:fixed}thead{display:table-header-group}th{background:#143e4d;color:white;text-align:left;font-size:8pt;font-weight:600;padding:7pt 4pt;vertical-align:bottom;border-right:.4pt solid #ffffff38}td{padding:6pt 4pt;border-bottom:.4pt solid #dde6e9;vertical-align:top;overflow-wrap:anywhere;line-height:1.35}tr{break-inside:avoid}tbody tr:nth-child(even){background:#f8fafb}.num{text-align:right;font-variant-numeric:tabular-nums}.account{background:#dfebee;color:#143e4d;padding:10pt 7pt;font-size:11pt}.account span{float:right;font-size:8.5pt;font-weight:400}.subgroup td{background:#eaf1f3;color:#264b59;font-weight:bold}.subtotal td{background:#f0f5f5;font-weight:bold;border-top:.7pt solid #bfd0d6}.closing td{background:#dcebed;color:#153e4b;font-weight:bold;border-top:1pt solid #7ea0ab}.empty{padding:35pt;text-align:center;color:#617680}.report-totals{font-size:10pt;padding:10pt 0;border-top:1pt solid #bfd0d6}</style></head><body><header><div class="brand">GENTIA</div><h1>Libro Mayor</h1><h2>${escaped(c.subsidiary.name)}</h2><div class="context">${escaped(context)}<br>Moneda local: ${escaped(c.localCurrency.code)}. La moneda original se indica en cada movimiento.</div></header><div class="metrics"><b>${snapshot.total} movimientos</b><b>Débitos locales: ${escaped(money(Number(snapshot.summary.debit)))}</b><b>Créditos locales: ${escaped(money(Number(snapshot.summary.credit)))}</b></div>${view==='ACCOUNT'?'':'<p class="note">El saldo acumulado corresponde a la cuenta; no representa el saldo del tercero o del centro de costo.</p>'}${sections||'<p class="empty">Sin movimientos para los filtros seleccionados.</p>'}<div class="report-totals">Totales de movimientos del reporte · Débitos: <b>${escaped(money(Number(snapshot.summary.debit)))}</b> · Créditos: <b>${escaped(money(Number(snapshot.summary.credit)))}</b> ${escaped(c.localCurrency.code)}</div></body></html>`;
}
export async function renderGeneralLedgerExport(snapshot:GeneralLedgerExportSnapshot,format:GeneralLedgerExportFormat,view:GeneralLedgerExportView):Promise<GeneralLedgerExportFile>{
 if(!['csv','xlsx','pdf'].includes(format))throw Object.assign(Error('Seleccione un formato de exportación válido.'),{status:400});
 const prepared=model(snapshot,view),fileName=`libro-mayor-${snapshot.context.dateFrom}-${snapshot.context.dateTo}.${format}`;
 if(format==='csv')return{fileName,mimeType:'text/csv; charset=utf-8',buffer:csv(prepared)};
 if(format==='xlsx')return{fileName,mimeType:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',buffer:await xlsx(prepared)};
 return{fileName,mimeType:'application/pdf',buffer:await renderPdf(generalLedgerPdfHtml(snapshot,view))};
}
