import {renderPdf} from '../../core/security/pdf-renderer.js';
import {assertRoleAccess} from '../security-catalogs/role-access-matrix.module.js';
import {assertSalesDocumentAccess} from '../sales-catalogs/sales-workflow.service.js';
import {assertPurchaseDocumentAccess} from '../purchasing-catalogs/purchase-workflow.service.js';
const resources:Record<string,string>={accounting:'reports:accounting-reports',assets:'fixed-assets:reports',asset:'fixed-assets:assets',journal:'accounting:journals',check:'banking:bank-checks',deposit:'banking:bank-deposits',fee:'banking:bank-fees',payment:'purchasing:supplier-payments','credit-note':'sales:credit-notes','debit-note':'sales:debit-notes'};
export type PdfCell={text:string;span:number;rowSpan?:number;numeric:boolean};
type Block={kind:'heading'|'text'|'metric'|'table';text?:string;rows?:{header:boolean;cells:PdfCell[]}[]};
export type DocumentSnapshot={scope:string;title:string;company:string;period:string;currency:string;blocks:Block[]};
const invalid=():never=>{throw Object.assign(new Error('El contenido del PDF no es válido o supera el tamaño permitido.'),{status:400});};
const text=(v:unknown,max=12000)=>typeof v==='string'&&v.length<=max?v:invalid();
export function validateDocumentSnapshot(value:unknown):DocumentSnapshot{
 if(!value||typeof value!=='object'||Array.isArray(value))return invalid();const p=value as Record<string,unknown>;
 if(Object.keys(p).some(k=>!['scope','title','company','period','currency','blocks'].includes(k)))return invalid();
 const scope=text(p.scope,40);if(!resources[scope]&&!['sales-document','purchase-document'].includes(scope))return invalid();
 if(!Array.isArray(p.blocks)||p.blocks.length>5000)return invalid();let cells=0;
 const blocks:Block[]=p.blocks.map((v:unknown)=>{if(!v||typeof v!=='object')return invalid();const b=v as Record<string,unknown>;if(!['heading','text','metric','table'].includes(String(b.kind)))return invalid();if(b.kind!=='table')return{kind:b.kind as Block['kind'],text:text(b.text)};if(!Array.isArray(b.rows)||b.rows.length>20000)return invalid();return{kind:'table',rows:b.rows.map((v:unknown)=>{if(!v||typeof v!=='object')return invalid();const r=v as Record<string,unknown>;if(!Array.isArray(r.cells)||r.cells.length>50)return invalid();return{header:r.header===true,cells:r.cells.map((v:unknown)=>{if(++cells>200000||!v||typeof v!=='object')return invalid();const c=v as Record<string,unknown>;if(!Number.isInteger(c.span)||Number(c.span)<1||Number(c.span)>50)return invalid();if(c.rowSpan!==undefined&&(!Number.isInteger(c.rowSpan)||Number(c.rowSpan)<1||Number(c.rowSpan)>50))return invalid();return{text:text(c.text),span:Number(c.span),...(c.rowSpan===undefined?{}:{rowSpan:Number(c.rowSpan)}),numeric:c.numeric===true};})};})};});
 return{scope,title:text(p.title,300),company:text(p.company,500),period:text(p.period,1500),currency:text(p.currency,1000),blocks};
}
const esc=(s:string)=>s.replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
export function documentSnapshotHtml(p:DocumentSnapshot){
 // Wide ledgers are divided into readable column panels, repeating the identifying columns.
 const panels:Block[]=[];for(const block of p.blocks){
  const width=Math.max(0,...(block.rows||[]).map(r=>r.cells.reduce((n,c)=>n+c.span,0)));
  if(block.kind!=='table'||width<=14){panels.push(block);continue;}
  for(let start=2;start<width;start+=8){const indices=[0,1,...Array.from({length:Math.min(8,width-start)},(_,i)=>start+i)];
   panels.push({kind:'text',text:`Detalle de columnas ${start+1} a ${Math.min(start+8,width)} / Se repiten las dos primeras columnas para identificar cada fila.`});
   panels.push({kind:'table',rows:block.rows!.map(r=>{const expanded:PdfCell[]=[];for(const c of r.cells)for(let i=0;i<c.span;i++)expanded.push({...c,span:1,text:i===0?c.text:''});return{header:r.header,cells:indices.map(i=>expanded[i]||{text:'',span:1,numeric:false})};})});
  }
 }p={...p,blocks:panels};

 const maxColumns=Math.max(0,...p.blocks.filter(b=>b.kind==='table').flatMap(b=>(b.rows||[]).map(r=>r.cells.reduce((n,c)=>n+c.span,0))));const wide=maxColumns>7;
 const body=p.blocks.map(b=>b.kind==='table'?`<table><thead>${(b.rows||[]).filter(r=>r.header).map(row).join('')}</thead><tbody>${(b.rows||[]).filter(r=>!r.header).map(row).join('')}</tbody></table>`:b.kind==='heading'?`<h2>${esc(b.text||'')}</h2>`:b.kind==='metric'?`<div class="metric">${esc(b.text||'')}</div>`:`<p>${esc(b.text||'')}</p>`).join('');
 function row(r:{header:boolean;cells:PdfCell[]}){return`<tr>${r.cells.map(c=>`<${r.header?'th':'td'} colspan="${c.span}" rowspan="${c.rowSpan||1}" class="${c.numeric?'num':''}">${esc(c.text)}</${r.header?'th':'td'}>`).join('')}</tr>`;}
 return `<!doctype html><html lang="es"><head><meta charset="utf-8"><style>@page{size:${maxColumns>13?'A3': 'A4'} ${wide?'landscape':'portrait'};margin:14mm}*{box-sizing:border-box}body{font:${maxColumns>13?8:10}px Arial,sans-serif;color:#20334d;margin:0}header{border-bottom:3px solid #16967b;padding-bottom:16px;margin-bottom:20px}.brand{font-size:9px;font-weight:bold;letter-spacing:2px;color:#16846f}h1{font-size:25px;margin:10px 0;overflow-wrap:anywhere}header p{margin:5px 0;color:#5e7188}.company{font-weight:bold;font-size:13px}h2{font-size:14px;margin:18px 0 9px;color:#143d72;break-after:avoid}p{white-space:pre-line;overflow-wrap:anywhere;line-height:1.5}.metric{display:inline-block;border:1px solid #d9e5ef;background:#f0f5fb;border-radius:7px;padding:12px;margin:0 8px 10px 0;white-space:pre-line;vertical-align:top;min-width:120px;max-width:100%;line-height:1.5}table{width:100%;border-collapse:collapse;margin:14px 0;table-layout:fixed}thead{display:table-header-group}th{background:#163e70;color:white;text-align:left;font-size:9px;padding:9px 7px;overflow-wrap:anywhere}td{padding:7px;border-bottom:1px solid #dfe7f0;vertical-align:top;overflow-wrap:anywhere;white-space:pre-line}tbody tr:nth-child(even){background:#f5f8fc}tr{break-inside:avoid}.num{text-align:right;font-variant-numeric:tabular-nums}footer{position:fixed;bottom:-8mm;left:0;right:0;border-top:1px solid #dfe7f0;padding-top:6px;font-size:8px;color:#617188}</style></head><body><header><div class="brand">GENTIA · INFORMES Y DOCUMENTOS</div><h1>${esc(p.title)}</h1><p class="company">${esc(p.company)}</p><p>${esc(p.period)}</p><p>${esc(p.currency)}</p><p>Generado el ${esc(new Date().toLocaleString('es-CR',{timeZone:'America/Costa_Rica'}))}</p></header>${body}</body></html>`;
}
export async function downloadDocumentSnapshot(auth:string,input:unknown){
 if(!/^Bearer\s+\S+$/i.test(auth||''))throw Object.assign(new Error('Debe iniciar sesión.'),{status:401});const p=validateDocumentSnapshot(input);
 if(p.scope==='sales-document')await assertSalesDocumentAccess(auth,'view');else if(p.scope==='purchase-document')await assertPurchaseDocumentAccess(auth,'view');else await assertRoleAccess(auth,resources[p.scope]!,'view');
 const buffer=await renderPdf(documentSnapshotHtml(p));return{base64:buffer.toString('base64'),fileName:p.title.replace(/[\\/:*?"<>|\r\n\0]/g,'-').slice(0,130)+'.pdf'};
}
