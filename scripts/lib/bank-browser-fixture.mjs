import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {resolve,sep,extname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {chromium} from '@playwright/test';

// Public assets and synthetic route mocks only; no application backend is started.
export async function bankBrowserFixture(t,{viewport={width:1500,height:950},timeout=10000}={}){
 const root=resolve(fileURLToPath(new URL('../../public/',import.meta.url)));
 let browser,server;
 const cleanup=async()=>{try{await browser?.close();}finally{if(server?.listening)await new Promise(done=>{server.closeAllConnections();server.close(done);});}};
 t.after(cleanup);
 server=createServer(async(request,response)=>{
  try{
   const pathname=decodeURIComponent(new URL(request.url,'http://127.0.0.1').pathname);
   if(pathname==='/'){response.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});response.end('<!doctype html><html><head><meta charset="utf-8"></head><body></body></html>');return;}
   const file=resolve(root,'.'+pathname);if(!file.startsWith(root+sep)){response.writeHead(403);response.end();return;}
   const content=await readFile(file),type={'.html':'text/html','.js':'text/javascript','.css':'text/css','.json':'application/json','.csv':'text/csv','.svg':'image/svg+xml'}[extname(file)]||'application/octet-stream';
   response.writeHead(200,{'Content-Type':type+'; charset=utf-8','Cache-Control':'no-store'});response.end(content);
  }catch{response.writeHead(404);response.end();}
 });
 await new Promise((done,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',done);});
 const baseURL=`http://127.0.0.1:${server.address().port}`;
 browser=await chromium.launch({headless:true});const page=await browser.newPage({viewport});page.setDefaultTimeout(timeout);
 await page.route('**/*',async route=>{const url=new URL(route.request().url());if(url.origin!==baseURL){await route.abort();return;}await route.continue();});
 return{browser,page,baseURL,cleanup};
}
