import assert from 'node:assert/strict';
import {test} from 'node:test';
import {safeNavigationUrl,safeImageUrl,canPreviewAttachment,canPreviewAttachmentBlob} from '../public/html-safety.js';
const origin='https://erp.example.invalid';
test('navegación resuelve rutas internas y HTTP(S), rechazando esquemas activos y credenciales',()=>{
 assert.equal(safeNavigationUrl('/journal-view.html?id=1',origin),origin+'/journal-view.html?id=1');assert.equal(safeNavigationUrl('https://external.invalid/a?q=1',origin),'https://external.invalid/a?q=1');
 for(const value of ['javascript:alert(1)','java\nscript:alert(1)','data:text/html,test','blob:https://erp.example.invalid/id','file:///x','https://user:password@external.invalid','https:\\evil.invalid','https://e.invalid/a\nb',{},null,''])assert.equal(safeNavigationUrl(value,origin),'',String(value));
});
test('imágenes admiten rutas/HTTP(S) y datos raster; no HTML/SVG activos ni esquemas arbitrarios',()=>{
 for(const type of ['png','jpeg','gif','webp','bmp'])assert.equal(safeImageUrl('data:image/'+type+';base64,QUJD',origin),'data:image/'+type+';base64,QUJD');
 assert.equal(safeImageUrl('/gentia-logo.svg',origin),origin+'/gentia-logo.svg');
 for(const value of ['data:image/svg+xml;base64,PHN2Zy8+','data:text/html;base64,QUJD','javascript:alert(1)','blob:https://erp.example.invalid/a','https://user:password@e.invalid','data:image/png;base64,QUJD" onerror="bad'])assert.equal(safeImageUrl(value,origin),'');
});
test('vista previa de archivos solo PDF/raster; XML/texto/ofimática se descargan',()=>{
 for(const type of ['application/pdf','image/png','image/jpeg','image/gif','image/webp','image/bmp','application/pdf; charset=utf-8'])assert.equal(canPreviewAttachment(type),true,type);
 for(const type of ['text/html','image/svg+xml','application/xml','text/xml','text/plain','text/csv','application/octet-stream','application/vnd.ms-excel','application/pdf-evil','image/png-script'])assert.equal(canPreviewAttachment(type),false,type);
});
test('vista previa contrasta MIME con firma inicial; HTML disfrazado se descarga',async()=>{
 const signatures=[['application/pdf','%PDF-1.4'],['image/png',new Uint8Array([137,80,78,71,13,10,26,10])],['image/jpeg',new Uint8Array([255,216,255])],['image/gif','GIF89a'],['image/webp','RIFF1234WEBP'],['image/bmp','BM1234']];
 for(const [type,bytes]of signatures){assert.equal(await canPreviewAttachmentBlob(new Blob([bytes],{type})),true,type);assert.equal(await canPreviewAttachmentBlob(new Blob(['<html><script>bad()</script></html>'],{type})),false,type);}
 assert.equal(await canPreviewAttachmentBlob(new Blob(['%PDF-1.4'],{type:'text/html'})),false);
});
