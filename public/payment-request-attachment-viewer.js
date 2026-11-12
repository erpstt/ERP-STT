import {safeAttachmentUrl,canPreviewAttachmentBlob} from './html-safety.js?v=20261102-a03-media';
let dialog,body,title,download,urls=[],generation=0,pdfTask=null,renderTask=null;
function clear(){generation++;renderTask?.cancel();renderTask=null;void pdfTask?.destroy().catch(()=>{});pdfTask=null;body?.replaceChildren();for(const url of urls)URL.revokeObjectURL(url);urls=[];download?.removeAttribute('href');}
function setup(){
 if(dialog)return;
 dialog=document.createElement('dialog');dialog.id='supportViewer';dialog.className='support-viewer';dialog.setAttribute('aria-labelledby','supportViewerTitle');
 const header=document.createElement('header'),heading=document.createElement('div'),eyebrow=document.createElement('small'),actions=document.createElement('div'),close=document.createElement('button');
 eyebrow.textContent='DOCUMENTO DE SOPORTE';title=document.createElement('h2');title.id='supportViewerTitle';title.setAttribute('data-i18n-ignore','');heading.append(eyebrow,title);
 download=document.createElement('a');download.id='supportViewerDownload';download.className='button primary';download.textContent='Descargar';download.rel='noopener noreferrer';
 close.type='button';close.className='button secondary';close.textContent='Cerrar';close.id='supportViewerClose';close.onclick=()=>dialog.close();actions.className='support-viewer-actions';actions.append(download,close);header.append(heading,actions);
 body=document.createElement('div');body.id='supportViewerBody';body.className='support-viewer-body';body.setAttribute('aria-live','polite');dialog.append(header,body);dialog.addEventListener('close',clear);document.body.append(dialog);
}
function notice(text){const p=document.createElement('p');p.className='support-viewer-notice';p.textContent=text;body.replaceChildren(p);}
async function renderPdf(bytes,token){
 const pdfjs=await import('./assets/pdfjs-6.5.438/build/pdf.mjs');if(token!==generation)return;
 pdfjs.GlobalWorkerOptions.workerSrc='/assets/pdfjs-6.5.438/build/pdf.worker.mjs';
 pdfTask=pdfjs.getDocument({data:bytes.slice(),isEvalSupported:false,useWasm:false,standardFontDataUrl:'/assets/pdfjs-6.5.438/standard_fonts/',cMapUrl:'/assets/pdfjs-6.5.438/cmaps/',cMapPacked:true});
 const pdf=await pdfTask.promise;if(token!==generation)return;
 const wrap=document.createElement('section'),toolbar=document.createElement('div'),previous=document.createElement('button'),next=document.createElement('button'),pages=document.createElement('span'),zoom=document.createElement('select'),stage=document.createElement('div'),canvas=document.createElement('canvas');
 wrap.className='support-pdf';toolbar.className='support-pdf-toolbar';stage.className='support-pdf-stage';previous.type=next.type='button';previous.textContent='Anterior';next.textContent='Siguiente';zoom.setAttribute('aria-label','Zoom del documento');for(const [value,label]of [[1,'Ajustar al ancho'],[1.25,'125%'],[1.5,'150%'],[2,'200%']])zoom.append(new Option(label,value));
 pages.setAttribute('data-i18n-ignore','');toolbar.append(previous,pages,next,zoom);stage.append(canvas);wrap.append(toolbar,stage);body.replaceChildren(wrap);let number=1;
 async function draw(){
  previous.disabled=next.disabled=zoom.disabled=true;const page=await pdf.getPage(number);if(token!==generation)return;
  const base=page.getViewport({scale:1}),fit=Math.min((stage.clientWidth-32)/base.width,1.5),viewport=page.getViewport({scale:Math.max(.2,fit)*Number(zoom.value)}),ratio=Math.min(devicePixelRatio||1,2,4096/Math.max(viewport.width,viewport.height));
  canvas.width=Math.ceil(viewport.width*ratio);canvas.height=Math.ceil(viewport.height*ratio);canvas.style.width=`${viewport.width}px`;canvas.style.height=`${viewport.height}px`;canvas.setAttribute('aria-label',`Pagina ${number} de ${pdf.numPages}`);pages.textContent=`${number} / ${pdf.numPages}`;
  renderTask=page.render({canvasContext:canvas.getContext('2d'),viewport,transform:[ratio,0,0,ratio,0,0]});await renderTask.promise;if(token!==generation)return;renderTask=null;previous.disabled=number===1;next.disabled=number===pdf.numPages;zoom.disabled=false;stage.scrollTo(0,0);
 }
 const update=()=>void draw().catch(()=>{if(token===generation)notice('No fue posible mostrar esta pagina. Puede descargar el documento.');});previous.onclick=()=>{number--;update();};next.onclick=()=>{number++;update();};zoom.onchange=update;await draw();
}
export async function viewPaymentRequestAttachment(item){
 setup();clear();const token=generation;title.textContent=item.displayName||item.fileName||'Adjunto';download.hidden=true;notice('Cargando documento...');if(!dialog.open)dialog.showModal();
 try{
  const source=safeAttachmentUrl(item.fileData);
  if(!source||!source.startsWith('data:'))throw Error('No fue posible cargar la vista previa de este archivo.');
  const match=source.match(/^data:([^;]+);base64,(.+)$/i);if(!match)throw Error('El archivo no tiene un formato válido.');
  const bytes=Uint8Array.from(atob(match[2]),c=>c.charCodeAt(0));let type=match[1].toLowerCase();
  if(type==='application/octet-stream'){
   if(String.fromCharCode(...bytes.slice(0,5))==='%PDF-')type='application/pdf';
   else {const ext=String(item.fileName||'').split('.').pop().toLowerCase();type=({png:'image/png',jpg:'image/jpeg',jpeg:'image/jpeg',gif:'image/gif',webp:'image/webp',bmp:'image/bmp',txt:'text/plain',csv:'text/csv'})[ext]||type;}
  }
  const blob=new Blob([bytes],{type}),url=URL.createObjectURL(blob);urls.push(url);download.href=url;download.download=item.fileName||'respaldo';download.hidden=false;
  if(await canPreviewAttachmentBlob(blob)){
   if(token!==generation)return;let preview;
   if(type==='application/pdf'){await renderPdf(bytes,token);return;}
   else {preview=document.createElement('img');preview.alt=item.displayName||item.fileName||'Imagen adjunta';preview.src=url;}
   body.replaceChildren(preview);
  }else if(['text/plain','text/csv','text/xml','application/xml'].includes(type)){
   const text=await blob.text();if(token!==generation)return;const preview=document.createElement('pre');preview.textContent=text;body.replaceChildren(preview);
  }else if(token===generation)notice('Este formato no tiene vista previa disponible. Puede descargar el archivo con el botón Descargar.');
 }catch(error){if(token===generation)notice(error.message||'No fue posible cargar este documento.');}
}
