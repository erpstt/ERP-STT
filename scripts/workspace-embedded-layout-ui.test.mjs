import assert from 'node:assert/strict';
import test from 'node:test';
import {createServer} from 'node:http';
import {readFile,readdir} from 'node:fs/promises';
import {resolve,sep,extname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {chromium} from '@playwright/test';

const root=fileURLToPath(new URL('../public/',import.meta.url));
const serverSource=await readFile(new URL('../src/server.ts',import.meta.url),'utf8');
const stripScripts=html=>html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi,'');
const guard=stripScripts(serverSource.match(/const guard=`([^`]+)`/)?.[1]||'');
const assets=stripScripts(serverSource.match(/const gentiaAssets='([^']+)'/)?.[1]||'');
const documents=(await readdir(root)).filter(name=>name.endsWith('.html')&&name!=='index.html').sort();
const viewports=[{width:1096,height:656},{width:1640,height:968},{width:390,height:680}];

// All business scripts are removed. Only repository HTML/CSS and synthetic
// table rows are served over loopback; no ERP backend or credentials are used.
async function fixture(t){
 let browser,server;
 t.after(async()=>{try{await browser?.close();}finally{if(server?.listening)await new Promise(done=>{server.closeAllConnections();server.close(done);});}});
 server=createServer(async(request,response)=>{
  try{
   const pathname=decodeURIComponent(new URL(request.url,'http://127.0.0.1').pathname);
   const file=resolve(root,'.'+pathname);
   if(!file.startsWith(resolve(root)+sep)){response.writeHead(403);response.end();return;}
   let content=await readFile(file);
   if(extname(file)==='.html'){
    content=stripScripts(content.toString('utf8'))
     .replace(/<html\b[^>]*>/i,'<html class="inside-erp-workspace">')
     .replace(/<head>/i,'<head>'+guard).replace('</head>',assets+'</head>');
   }
   response.writeHead(200,{'Content-Type':({'.html':'text/html','.css':'text/css','.svg':'image/svg+xml'}[extname(file)]||'application/octet-stream')+'; charset=utf-8','Cache-Control':'no-store'});
   response.end(content);
  }catch{response.writeHead(404);response.end();}
 });
 await new Promise(done=>server.listen(0,'127.0.0.1',done));
 const baseURL='http://127.0.0.1:'+server.address().port;
 browser=await chromium.launch({headless:true});
 const page=await browser.newPage();
 await page.route('**/*',async route=>{
  const request=route.request();
  if(new URL(request.url()).origin!==baseURL||request.resourceType()==='script'){await route.abort();return;}
  await route.continue();
 });
 return{page,baseURL};
}

async function geometry(page){
 return page.evaluate(()=>({
  width:innerWidth,scrollWidth:document.documentElement.scrollWidth,
  mainWidth:document.querySelector('body>main')?.getBoundingClientRect().width,
  mainMinimum:document.querySelector('body>main')?getComputedStyle(document.querySelector('body>main')).minHeight:null,
  overflow:[...document.querySelectorAll('body *')].filter(el=>getComputedStyle(el).display!=='none'&&el.getBoundingClientRect().right>innerWidth+2&&el.getBoundingClientRect().width>0).slice(0,12).map(el=>({tag:el.tagName,id:el.id,className:el.className,x:el.getBoundingClientRect().left,width:el.getBoundingClientRect().width,overflow:getComputedStyle(el).overflowX}))
 }));
}

async function revealDocument(page){
 await page.evaluate(()=>{
  const main=document.querySelector('body>main');
  if(!main)return;
  // Document views wait for fetched data and Vue catalog pages use v-cloak.
  // Reveal their existing markup here without running any business code.
  main.removeAttribute('v-cloak');main.hidden=false;
  if(getComputedStyle(main).display==='none')main.style.display='block';
 });
}

test('all 67 embedded document templates use the available width at three workspace sizes',{timeout:120000},async t=>{
 assert.equal(documents.length,67,'Review the screen inventory when adding or removing a document template.');
 assert.ok(guard,'The fixture must use the real server workspace framing.');
 assert.match(assets,/workspace-layout\.css/,'The server must deliver the shared embedded layout stylesheet.');
 const{page,baseURL}=await fixture(t);
 const failures=[];
 for(const viewport of viewports){
  await page.setViewportSize(viewport);
  for(const document of documents){
   await page.goto(baseURL+'/'+document,{waitUntil:'load'});
   await revealDocument(page);
   const result=await geometry(page);
   if(result.scrollWidth>viewport.width+2||result.mainWidth!==undefined&&Math.abs(result.mainWidth-viewport.width)>2||result.mainMinimum!==null&&result.mainMinimum!=='0px')failures.push({document,viewport,...result});
  }
 }
 assert.deepEqual(failures,[],'Each page should fit the iframe; large tables and paper may scroll within their own containers.');
 t.diagnostic('201 static HTML/CSS layouts checked; business JavaScript and external requests disabled.');
});

test('wide document detail tables remain keyboard scrollable and printable',{timeout:30000},async t=>{
 const{page,baseURL}=await fixture(t);
 await page.setViewportSize({width:390,height:680});
 for(const document of ['bank-fee-view.html','purchase-document-view.html','sales-document-view.html']){
  await page.goto(baseURL+'/'+document);
  await page.evaluate(()=>{
   const table=document.querySelector('.document-table-scroll table'),body=table.tBodies[0];
   for(let row=0;row<3;row++){
    const tr=body.insertRow();
    for(let column=0;column<table.rows[0].cells.length;column++)tr.insertCell().textContent=column===2?'Descripción de ejemplo para revisión del documento':'12345678,90';
   }
  });
  const result=await page.locator('.document-table-scroll').evaluate(el=>{
   el.scrollLeft=el.scrollWidth;
   return{focusable:el.tabIndex,role:el.getAttribute('role'),label:el.getAttribute('aria-label'),overflow:getComputedStyle(el).overflowX,scrollable:el.scrollWidth>el.clientWidth,lastColumnVisible:el.querySelector('tr').lastElementChild.getBoundingClientRect().right<=el.getBoundingClientRect().right+2,documentWidth:document.documentElement.scrollWidth};
  });
  assert.equal(result.focusable,0,document);assert.equal(result.role,'region',document);assert.ok(result.label,document);
  assert.equal(result.overflow,'auto',document);assert.ok(result.scrollable,document);assert.ok(result.lastColumnVisible,document);assert.equal(result.documentWidth,390,document);
  await page.emulateMedia({media:'print'});
  assert.equal(await page.locator('.document-table-scroll').evaluate(el=>getComputedStyle(el).overflowX),'visible',document+' must keep the entire table available to printing');
  await page.emulateMedia({media:'screen'});
 }
});

test('report tables and the PDF designer retain internal scrolling without hiding controls',{timeout:30000},async t=>{
 const{page,baseURL}=await fixture(t);
 await page.setViewportSize({width:390,height:680});
 for(const document of ['intercompany-commercial-report.html','intercompany-loans-report.html']){
  await page.goto(baseURL+'/'+document);
  await page.locator('#results').evaluate(el=>{el.hidden=false;});
  const result=await page.evaluate(()=>({documentWidth:document.documentElement.scrollWidth,tableWidth:document.querySelector('.local-section table').getBoundingClientRect().width,containerWidth:document.querySelector('.local-section .table-wrap').getBoundingClientRect().width,overflow:getComputedStyle(document.querySelector('.local-section .table-wrap')).overflowX}));
  assert.equal(result.documentWidth,390,document);assert.ok(result.tableWidth>result.containerWidth,document);assert.equal(result.overflow,'auto',document);
 }
 for(const viewport of viewports){
  await page.setViewportSize(viewport);
  await page.goto(baseURL+'/pdf-template-builder.html');
  const result=await page.evaluate(()=>{
   const save=document.getElementById('save').getBoundingClientRect(),canvas=document.querySelector('.canvas-wrap');
   return{documentWidth:document.documentElement.scrollWidth,paperWidth:document.querySelector('.paper').getBoundingClientRect().width,paperHeight:document.querySelector('.paper').getBoundingClientRect().height,canvasOverflow:getComputedStyle(canvas).overflowX,canvasScrollable:canvas.scrollWidth>canvas.clientWidth,saveVisible:save.left>=0&&save.right<=innerWidth&&save.top>=0&&save.bottom<=innerHeight};
  });
  assert.equal(result.documentWidth,viewport.width);assert.equal(result.paperWidth,794);assert.ok(result.paperHeight>=1123);assert.equal(result.canvasOverflow,'auto');if(viewport.width<1400)assert.ok(result.canvasScrollable);assert.ok(result.saveVisible,'The save control must remain visible after toolbar wrapping.');
 }
 await page.setViewportSize(viewports[0]);await page.goto(baseURL+'/payment-batches.html');
 assert.equal(await page.locator('.payment-batches-page').evaluate(el=>getComputedStyle(el).paddingBottom),'180px','The fixed selection toolbar must keep its reserved bottom space.');
});
