import type {DocumentSnapshot} from './document-snapshot-pdf.service.js';

const escape=(value:string)=>value.replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]!));

export function paymentRequestPdfHtml(document:DocumentSnapshot){
 const metrics=document.blocks.filter(block=>block.kind==='metric');
 const metricParts=(value:string)=>{const [label,...rest]=value.split('\n');return{label:label||'',value:rest.join('\n')};};
 const total=metrics.map(block=>metricParts(block.text||'')).find(item=>item.label==='Total solicitado');
 const summary=metrics.map(block=>metricParts(block.text||'')).filter(item=>item.label!=='Total solicitado');
 const status=summary.find(item=>item.label==='Estado')?.value||'';
 const card=(item:{label:string;value:string})=>`<div class="card"><span>${escape(item.label)}</span><strong>${escape(item.value)}</strong></div>`;
 const content=document.blocks.filter(block=>block.kind!=='metric').map(block=>{
  if(block.kind==='heading')return `<h2>${escape(block.text||'')}</h2>`;
  if(block.kind!=='table')return `<p class="copy">${escape(block.text||'')}</p>`;
  const rows=block.rows||[];
  const row=(item:typeof rows[number])=>`<tr>${item.cells.map((cell,index)=>{const tag=item.header?'th':'td';return `<${tag} colspan="${cell.span}" class="${cell.numeric?'amount':''} ${index===item.cells.length-1?'requested':''}">${escape(cell.text)}</${tag}>`;}).join('')}</tr>`;
  return `<table><thead>${rows.filter(item=>item.header).map(row).join('')}</thead><tbody>${rows.filter(item=>!item.header).map(row).join('')}</tbody></table>`;
 }).join('');
 return `<!doctype html><html lang="es"><head><meta charset="utf-8"><style>
 @page{size:A4 portrait;margin:15mm 16mm 17mm}*{box-sizing:border-box}body{margin:0;color:#20364d;font:11px Arial,sans-serif;line-height:1.5}
 .brand{color:#087e76;font-size:9px;font-weight:700;letter-spacing:2px}.header{border-bottom:3px solid #0c9a82;padding-bottom:19px;margin-bottom:20px}.company{font-size:14px;font-weight:700;margin:8px 0 18px}.title-row{display:flex;align-items:center;justify-content:space-between;gap:15px}h1{font-size:27px;line-height:1.15;margin:0;color:#102f55}.status{display:inline-block;background:#e9f5f0;color:#087254;padding:6px 12px;border-radius:20px;font-size:10px;font-weight:700;white-space:nowrap}.reference{font-size:12px;color:#52677b;margin-top:9px;overflow-wrap:anywhere}
 .summary{display:grid;grid-template-columns:1fr 1fr;gap:9px;margin-bottom:23px}.card{background:#f4f7fa;border:1px solid #e1e8ef;border-radius:6px;padding:11px 13px;break-inside:avoid}.card span{display:block;font-size:9px;color:#627588;margin-bottom:4px}.card strong{font-size:11px;font-weight:600;overflow-wrap:anywhere}
 h2{color:#12385e;font-size:13px;margin:23px 0 9px;padding-bottom:7px;border-bottom:1px solid #dce5ed;break-after:avoid}.copy{font-size:11px;white-space:pre-line;overflow-wrap:anywhere;margin:8px 0 14px}table{width:100%;border-collapse:collapse;table-layout:fixed;font-size:10px;margin:12px 0 0}thead{display:table-header-group}th{background:#173d66;color:white;font-size:9px;text-align:left;padding:11px 8px}td{padding:12px 8px;border-bottom:1px solid #e0e7ef;vertical-align:top;white-space:pre-line}th,td{overflow-wrap:anywhere}tr{break-inside:avoid}tbody tr:nth-child(even){background:#f6f9fb}.amount{text-align:right;font-variant-numeric:tabular-nums}.requested{font-weight:700}
 .total-wrap{display:flex;justify-content:flex-end;margin-top:18px;break-inside:avoid}.total{min-width:265px;max-width:100%;border-left:4px solid #0b947d;background:#edf8f4;border-radius:6px;padding:15px 19px;text-align:right}.total span{font-size:10px;color:#427060;display:block;margin-bottom:5px}.total strong{font-size:22px;color:#08765c;line-height:1.3;overflow-wrap:anywhere}
 .note{color:#687c8e;font-size:9px;margin-top:22px;border-top:1px solid #e2e9ef;padding-top:10px}footer{margin-top:20px;break-inside:avoid;display:flex;justify-content:space-between;color:#7a8996;font-size:8px;border-top:1px solid #e0e7ed;padding-top:6px}
 </style></head><body><header class="header"><div class="brand">GENTIA · TESORERÍA</div><div class="company">${escape(document.company)}</div><div class="title-row"><h1>Solicitud de pago</h1><span class="status">${escape(status)}</span></div><div class="reference">${escape(document.title.replace(/^Solicitud de pago\s*/,''))}</div></header><section class="summary">${summary.filter(item=>item.label!=='Estado').map(card).join('')}</section>${content}${total?`<div class="total-wrap"><div class="total"><span>Total solicitado · ${escape(document.currency)}</span><strong>${escape(total.value)}</strong></div></div>`:''}<p class="note">Documento administrativo de solicitud de pago. La aprobación no constituye un comprobante de pago.</p><footer><span>GENTIA · Solicitudes de pago</span><span>${escape(document.title.replace(/^Solicitud de pago\s*/,''))}</span></footer></body></html>`;
}
