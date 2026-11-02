// Text and quoted HTML attributes only. URLs require validation before escaping.
export const escapeHtml=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

export function safeHttpUrl(value){
  if(typeof value!=='string')return'';
  const text=value.trim();
  if(!/^https?:\/\//i.test(text)||/[\u0000-\u0020\u007f\\]/.test(text))return'';
  try{const url=new URL(text);return['http:','https:'].includes(url.protocol)&&url.hostname&&!url.username&&!url.password?url.href:'';}catch{return'';}
}

export function safeNavigationUrl(value,base=globalThis.location?.origin){
  if(typeof value!=='string'||!value.trim()||/[\u0000-\u001f\u007f\\]/.test(value))return'';
  try{return safeHttpUrl(new URL(value.trim(),base).href);}catch{return'';}
}

export function safeImageUrl(value,base=globalThis.location?.origin){
  if(typeof value!=='string')return'';
  if(/^data:image\/(png|jpeg|gif|webp|bmp);base64,[a-z0-9+/]+={0,2}$/i.test(value))return value;
  return safeNavigationUrl(value,base);
}

export function configureImage(image,value){
  const url=safeImageUrl(value);
  image.removeAttribute('src');image.hidden=!url;image.referrerPolicy='no-referrer';
  if(url)image.src=url;
  return Boolean(url);
}

export const canPreviewAttachment=type=>/^(application\/pdf|image\/(png|jpeg|gif|webp|bmp))(?:$|;)/i.test(String(type||''));

export async function canPreviewAttachmentBlob(blob){
  if(!canPreviewAttachment(blob.type))return false;
  const bytes=new Uint8Array(await blob.slice(0,16).arrayBuffer()),starts=signature=>signature.every((value,index)=>bytes[index]===value),text=(start,length)=>String.fromCharCode(...bytes.slice(start,start+length));
  switch(blob.type.split(';')[0].toLowerCase()){
    case 'application/pdf':return text(0,5)==='%PDF-';
    case 'image/png':return starts([137,80,78,71,13,10,26,10]);
    case 'image/jpeg':return starts([255,216,255]);
    case 'image/gif':return ['GIF87a','GIF89a'].includes(text(0,6));
    case 'image/webp':return text(0,4)==='RIFF'&&text(8,4)==='WEBP';
    case 'image/bmp':return text(0,2)==='BM';
    default:return false;
  }
}

export function securePreviewPopup(popup){
  if(!popup)return null;
  try{popup.opener=null;const meta=popup.document.createElement('meta');meta.name='referrer';meta.content='no-referrer';popup.document.head.append(meta);return popup;}catch{try{popup.close();}catch{}return null;}
}

export function safeAttachmentUrl(value){
  const remote=safeHttpUrl(value);if(remote)return remote;
  if(typeof value!=='string')return'';
  // Files are downloaded, never embedded as executable HTML/SVG documents.
  return /^data:(application\/(pdf|octet-stream|zip|xml|msword|vnd\.[a-z0-9.+-]+)|image\/(png|jpeg|gif|webp|bmp)|text\/(plain|csv|xml));base64,[a-z0-9+/]+={0,2}$/i.test(value)?value:'';
}

export function configureAttachmentLink(link,item){
  const file=item.support_type==='Archivo',url=file?safeAttachmentUrl(item.file_data):safeHttpUrl(item.support_url);
  link.removeAttribute('href');link.removeAttribute('download');link.rel='noopener noreferrer';
  link.hidden=!url;
  if(url){link.href=url;if(file)link.download=item.file_name||'respaldo';else link.target='_blank';}
  return Boolean(url);
}

export function renderAttachmentLinks(container,items){
  container.replaceChildren();
  if(!items.length){container.textContent='No hay archivos de respaldo.';return;}
  for(const item of items){const link=document.createElement('a');link.target='_blank';link.textContent=item.display_name||item.file_name||'Respaldo';configureAttachmentLink(link,item);container.append(link);}
}

export function previewDocument(html){
  const policy="default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src data: https: http:; font-src data:; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'";
  return '<!doctype html><meta http-equiv="Content-Security-Policy" content="'+escapeHtml(policy)+'">'+String(html??'');
}
