// Text and table cells only. No page HTML, scripts, style sheets or URLs are sent to the renderer.
import {bankContext} from './bank-ui.js?v=20261105-banking-functional';
const clean=v=>String(v??'').replace(/\u00a0/g,' ').trim();
const skip='nav,footer,script,style,button,input,select,textarea,dialog,.toolbar,.exports,.pager,.view-actions,.journal-actions,#printHeader,#paymentNotifications,#workflowStatusBanner,[data-export-ignore]';
function visible(e){return !e.hidden&&getComputedStyle(e).display!=='none'&&getComputedStyle(e).visibility!=='hidden';}
function content(e){const clone=e.cloneNode(true);clone.querySelectorAll('script,style,button:not(.ledger-link):not(.account-drill),input,select,textarea,nav,.journal-actions,[hidden]').forEach(n=>n.remove());return clean(clone.textContent);}
export function documentSnapshot({root,roots,title,scope,company='',period='',currency=''}){
 const blocks=[];
 function visit(e){if(!e||e.matches(skip)||!visible(e))return;
  if(e.matches('table')){const rows=[...e.rows].filter(visible).map(r=>({header:r.parentElement.tagName==='THEAD',cells:[...r.cells].map(c=>({text:content(c),span:c.colSpan||1,rowSpan:c.rowSpan||1,numeric:c.matches('.number,.num')||/^-?[\d\s.,]+$/.test(content(c))}))}));if(rows.length)blocks.push({kind:'table',rows});return;}
  if(e.matches('.metric,.details>div,dl>div,.aging>div,.summary>div,.document-data>div')){const label=e.querySelector('small,dt,span'),value=e.querySelector('strong,b,dd');blocks.push({kind:'metric',text:label&&value?`${clean(label.textContent)}\n${clean(value.textContent)}`:content(e)});return;}
  if(e.matches('h1,h2,h3,h4')){const text=content(e);if(text&&text!==title)blocks.push({kind:'heading',text});return;}
  if(e.matches('p,dl,dt,dd,footer')||![...e.children].some(n=>!n.matches(skip))){const text=content(e);if(text)blocks.push({kind:'text',text});return;}
  for(const child of e.children)visit(child);
 }
 for(const element of roots||[root])visit(element);
 return{scope,title:clean(title)||'Documento',company:clean(company),period:clean(period),currency:clean(currency),blocks};
}
export async function downloadDocumentPdf(options){
 const payload=documentSnapshot(options),context=bankContext();if(!payload.blocks.length)throw Error('Genere o abra el documento antes de descargar.');
 const r=await fetch('/api/documents/export-pdf',{method:'POST',headers:{Authorization:`Bearer ${localStorage.getItem('nexo_token')||sessionStorage.getItem('nexo_token')}`,'X-Device-Token':localStorage.getItem('nexo_device_token')||sessionStorage.getItem('nexo_device_token')||'','Content-Type':'application/json'},body:JSON.stringify(payload)});const result=await r.json();if(!r.ok)throw Error(result.error?.message||result.message||'No fue posible descargar el PDF.');if(context!==bankContext()||options.isCurrent&&!options.isCurrent())return;
 const bytes=Uint8Array.from(atob(result.base64),c=>c.charCodeAt(0));if(new TextDecoder().decode(bytes.slice(0,4))!=='%PDF')throw Error('El servidor no devolvió un PDF válido.');const url=URL.createObjectURL(new Blob([bytes],{type:'application/pdf'})),a=document.createElement('a');a.href=url;a.download=result.fileName;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
}
export async function downloadPagePdf(){
 const paths={'account-statement':'accounting','journal-view':'journal','bank-check-view':'check','bank-deposit-view':'deposit','bank-fee-view':'fee','fixed-asset-view':'asset','sales-document-view':'sales-document','purchase-document-view':'purchase-document','supplier-payment-view':'payment','sales-note-view':new URLSearchParams(location.search).get('kind')==='DEBIT'?'debit-note':'credit-note'};
 const key=location.pathname.split('/').pop().replace('.html',''),scope=paths[key];if(!scope)throw Error('Este documento no admite esta descarga.');
 const root=document.querySelector('#document,#statement,#invoice')||document.querySelector('main'),title=document.querySelector('#journalTitle,#kind,#title')?.textContent||document.title,company=document.querySelector('#company,#companyName')?.textContent||'';
 const button=document.querySelector('#print,#pdf,#printButton,[data-document-action="print"]');if(button?.disabled)return;const before=button?.textContent;if(button){button.disabled=true;button.textContent='Preparando PDF...';}
 try{await downloadDocumentPdf({root,title,scope,company});}catch(error){const box=document.querySelector('#error,#message');if(box)box.textContent=error.message;else window.alert(error.message);}finally{if(button){button.disabled=false;button.textContent=before;}}
}
export function downloadTablePdf({headers,rows,context={},title,scope='accounting',isCurrent}){
 const table=document.createElement('table'),heading=table.createTHead().insertRow();for(const label of headers){const cell=document.createElement('th');cell.textContent=label;heading.append(cell);}const body=table.createTBody();for(const values of rows){const row=body.insertRow();for(const value of values){const cell=row.insertCell();cell.textContent=typeof value==='number'?value.toLocaleString('es-CR',{minimumFractionDigits:2,maximumFractionDigits:2}):String(value??'');if(typeof value==='number')cell.className='num';}}
 return downloadDocumentPdf({root:table,title,scope,company:context.subsidiaryName||'',period:context.periodLabel||'',currency:context.currencyLabel||'',isCurrent});
}
