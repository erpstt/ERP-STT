// Text and quoted HTML attributes only. URLs require validation before escaping.
export const escapeHtml=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

export function safeHttpUrl(value){
  if(typeof value!=='string')return'';
  const text=value.trim();
  if(!/^https?:\/\//i.test(text)||/[\u0000-\u0020\u007f\\]/.test(text))return'';
  try{const url=new URL(text);return['http:','https:'].includes(url.protocol)&&url.hostname&&!url.username&&!url.password?url.href:'';}catch{return'';}
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

export function previewDocument(html){
  const policy="default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src data: https: http:; font-src data:; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'";
  return '<!doctype html><meta http-equiv="Content-Security-Policy" content="'+escapeHtml(policy)+'">'+String(html??'');
}
