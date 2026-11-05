import assert from 'node:assert/strict';
import {test,after} from 'node:test';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {bankBrowserFixture} from './lib/bank-browser-fixture.mjs';

// Exercise the real stylesheet cascade and branding in the workspace iframe.
// The previous bank fixtures served raw HTML, omitting serveFile's late theme.
// Only banking options/read-only reports are mocked; no backend is started.
const root=resolve('public'),server=await readFile('src/server.ts','utf8');
const injection=server.match(/const guard=`([\s\S]*?)`;\s+const gentiaAssets='([^']*)';/);
const renewal=server.match(/const html=content\.toString\('utf8'\),renewal='([^']+)';/);
assert.ok(injection&&renewal,'ServeFile HTML injection must be represented');
function served(raw){
 const[,guard,assets]=injection,branded=raw.includes('</head>')?raw.replace('</head>',assets+'</head>'):assets+raw;
 const guarded=branded.includes('<head>')?branded.replace('<head>','<head>'+guard):guard+branded;
 return /<head\b[^>]*>/i.test(guarded)?guarded.replace(/<head\b[^>]*>/i,head=>head+renewal[1]):renewal[1]+guarded;
}
const phase=['before','after'].includes(process.env.BANK_LIST_BUTTONS_CAPTURE)?process.env.BANK_LIST_BUTTONS_CAPTURE:null;
const artifacts=resolve('..','banking-list-buttons-qa-20261105'),captured=new Set(),measurements=[];
after(async()=>{if(phase){await mkdir(artifacts,{recursive:true});await writeFile(resolve(artifacts,phase+'-metrics.json'),JSON.stringify(measurements,null,2)+'\n');}});

async function fixture(t,kind,width){
 const{page,baseURL}=await bankBrowserFixture(t,{viewport:{width,height:1000},timeout:10000});
 const unexpected=[];
 await page.addInitScript(()=>{
  localStorage.setItem('nexo_token','synthetic-bank-style-token');localStorage.setItem('nexo_company','1');localStorage.setItem('nexo_role','2');localStorage.setItem('nexo_device_token','synthetic-bank-style-device');
  window.NexoSessionRenewal={current:()=>({generation:'synthetic-bank-style-generation'})};
 });
 await page.route('**/*',async route=>{
  const request=route.request(),url=new URL(request.url());
  if(url.origin!==baseURL){await route.fallback();return;}
  if(url.pathname==='/bank-checks.html'||url.pathname==='/bank-deposits.html'){
   await route.fulfill({contentType:'text/html; charset=utf-8',body:served(await readFile(resolve(root,'.'+url.pathname),'utf8'))});return;
  }
  if(url.pathname==='/bank-check-entry.html'||url.pathname==='/bank-deposit-entry.html'){
   await route.fulfill({contentType:'text/html; charset=utf-8',body:'<!doctype html><html><body><main id="synthetic-create-route">Synthetic create destination</main></body></html>'});return;
  }
  if(url.pathname.startsWith('/api/')){
   let data;
   if(url.pathname===`/api/banking/${kind}/options`&&request.method()==='GET')data={subsidiary:{id:1,name:'Synthetic company'},accounts:[{id:5,bankId:1,bankName:'Synthetic bank',number:'000005',currencyCode:'CRC'}],access:{canView:true,canCreate:true,canEdit:true,canDelete:true}};
   else if(url.pathname===`/api/banking/${kind}/report`&&request.method()==='POST')data={rows:[],total:0,baseCurrency:'CRC'};
   else{unexpected.push(request.method()+' '+url.pathname);await route.fulfill({status:501,json:{error:{message:'Unmocked API is blocked'}}});return;}
   await route.fulfill({json:data});return;
  }
  await route.fallback();
 });
 await page.goto(baseURL);
 await page.setContent('<!doctype html><html><head><style>html,body{margin:0;width:100%;height:100%}iframe{display:block;width:100%;height:100vh;border:0}</style></head><body><iframe src="'+baseURL+(kind==='checks'?'/bank-checks.html':'/bank-deposits.html')+'"></iframe></body></html>');
 const frame=await(await page.locator('iframe').elementHandle()).contentFrame();
 await frame.waitForFunction(()=>document.querySelector('#count')?.textContent==='0 registros');
 assert.equal(await frame.locator('html').evaluate(el=>el.classList.contains('inside-erp-workspace')),true);
 assert.equal(await frame.locator('link[href*="gentia-theme.css"]').count(),1);
 assert.equal(await frame.locator('script[src*="gentia-brand.js"]').count(),1);
 assert.equal(await frame.evaluate(()=>[...document.styleSheets].some(sheet=>sheet.href?.includes('/gentia-theme.css')&&sheet.cssRules.length>0)),true,'The injected production theme must actually load');
 await frame.waitForFunction(()=>document.querySelector('.brand.gentia-brand-runtime img')?.naturalWidth>0);
 assert.equal(await frame.locator('.title-actions > *').count(),2);
 assert.deepEqual(unexpected,[]);
 return{page,frame};
}

async function colorMetrics(locator){return locator.evaluate(element=>{
 const rgba=value=>{const values=value.match(/[\d.]+/g)?.map(Number)||[0,0,0,0];return[...values.slice(0,3),values.length===4?values[3]:1];};
 const composite=(front,back)=>{const a=front[3]+back[3]*(1-front[3]);return a?[0,1,2].map(i=>(front[i]*front[3]+back[i]*back[3]*(1-front[3]))/a).concat(a):[0,0,0,0];};
 let background=[255,255,255,1];const ancestors=[];for(let node=element;node;node=node.parentElement)ancestors.unshift(node);
 for(const node of ancestors)background=composite(rgba(getComputedStyle(node).backgroundColor),background);
 const style=getComputedStyle(element),foreground=composite(rgba(style.color),background);
 const luminance=color=>color.slice(0,3).map(value=>value/255).map(value=>value<=.04045?value/12.92:((value+.055)/1.055)**2.4).reduce((sum,value,index)=>sum+value*[.2126,.7152,.0722][index],0);
 const a=luminance(foreground),b=luminance(background);
 return{text:element.textContent.trim(),color:style.color,backgroundColor:style.backgroundColor,backgroundImage:style.backgroundImage,effectiveBackground:background.slice(0,3),contrast:(Math.max(a,b)+.05)/(Math.min(a,b)+.05),opacity:Number(style.opacity)};
 });}

async function layoutMetrics(frame){return frame.evaluate(()=>{
 const rect=element=>{const box=element.getBoundingClientRect();return{x:box.x,y:box.y,width:box.width,height:box.height,right:box.right,bottom:box.bottom};};
 const title=document.querySelector('.title'),actions=document.querySelector('.title-actions'),buttons=[...actions.children];
 return{viewport:innerWidth,pageWidth:document.documentElement.scrollWidth,title:rect(title),actions:rect(actions),actionFlex:getComputedStyle(actions).flex,gap:parseFloat(getComputedStyle(actions).columnGap)||0,buttons:buttons.map(element=>{const range=document.createRange();range.selectNodeContents(element);return{...rect(element),text:element.textContent.trim(),scrollWidth:element.scrollWidth,clientWidth:element.clientWidth,textBox:rect({getBoundingClientRect:()=>range.getBoundingClientRect()})};})};
 });}

for(const kind of ['checks','deposits'])for(const width of [1536,390]){
 test(`${kind} ${width}: acciones legibles con tema y branding reales inyectados`,{timeout:30000},async t=>{
  const{page,frame}=await fixture(t,kind,width),controls=frame.locator('.title-actions > *'),colors=[];
  const layout=await layoutMetrics(frame);
  for(let index=0;index<2;index++)colors.push(await colorMetrics(controls.nth(index)));
  measurements.push({kind,width,layout,colors});t.diagnostic(JSON.stringify({kind,width,layout,colors}));
  if(phase&&!captured.has(kind+'-'+width)){await mkdir(artifacts,{recursive:true});await page.screenshot({path:resolve(artifacts,`${phase}-${kind}-${width}.png`),fullPage:true});captured.add(kind+'-'+width);}
  for(let index=0;index<2;index++){
   assert.ok(colors[index].contrast>=4.5,`${colors[index].text}: contraste ${colors[index].contrast.toFixed(2)} (<4.5), ${colors[index].color} sobre ${colors[index].backgroundColor}`);
   await controls.nth(index).hover();const hovered=await colorMetrics(controls.nth(index));assert.ok(hovered.contrast>=4.5,hovered.text+' pierde contraste en hover');
   await controls.nth(index).focus();const focused=await colorMetrics(controls.nth(index));assert.ok(focused.contrast>=4.5,focused.text+' pierde contraste al recibir foco');
  }
  await controls.nth(1).click();
  const dialog=frame.locator('dialog.bank-import-modal');
  assert.equal(await dialog.isVisible(),true,'Importar CSV debe abrir el diálogo');
  assert.equal(await dialog.locator('h2').textContent(),kind==='checks'?'Importar cheques o transferencias':'Importar depósitos bancarios');
  assert.equal(await dialog.locator('[data-file]').isVisible(),true);
  assert.equal(await dialog.locator('[data-confirm]').isDisabled(),true,'Abrir el diálogo no debe habilitar una importación sin vista previa');
  assert.deepEqual(await dialog.locator('a[download]').evaluateAll(links=>links.map(link=>link.getAttribute('href'))),['/plantilla-cheques-transferencias.csv','/plantilla-depositos-bancarios.csv']);
  await dialog.locator('[data-close]').first().click();assert.equal(await dialog.isVisible(),false);
  await controls.nth(0).click();
  await frame.waitForURL('**/'+(kind==='checks'?'bank-check-entry.html':'bank-deposit-entry.html'));
  assert.equal(await frame.locator('#synthetic-create-route').isVisible(),true,'Crear debe navegar al formulario correcto');
 });
 test(`${kind} ${width}: cabecera compacta y acciones completas sin recorte`,{timeout:30000},async t=>{
  const{frame}=await fixture(t,kind,width),layout=await layoutMetrics(frame);t.diagnostic(JSON.stringify({kind,width,layout}));
  assert.ok(layout.pageWidth<=width+1,'La página no debe desbordarse horizontalmente');
  for(const button of layout.buttons){
   assert.ok(button.x>=0&&button.right<=width+1,button.text+' sale de la pantalla');
   assert.ok(button.height>=40,button.text+' no tiene altura suficiente');
   assert.ok(button.scrollWidth<=button.clientWidth+1,button.text+' recorta el texto');
   assert.ok(button.textBox.x>=button.x-1&&button.textBox.right<=button.right+1&&button.textBox.bottom<=button.bottom+1,button.text+' tiene contenido fuera de sus límites');
  }
  const[a,b]=layout.buttons;
  assert.ok(a.right<=b.x+1||b.right<=a.x+1||a.bottom<=b.y+1||b.bottom<=a.y+1,'Las acciones se superponen');
  if(width>650){
   assert.ok(Math.abs(b.right-layout.title.right)<=2,'Las acciones deben terminar en el borde derecho de la cabecera');
   assert.ok(layout.actions.width<=a.width+b.width+layout.gap+3,'El grupo de acciones no debe expandirse dejando una franja vacía');
  }else{
   assert.ok(layout.actions.bottom-layout.title.bottom<=1,'Las acciones deben quedar dentro de la cabecera');
   assert.ok(layout.actions.width<=layout.title.width+1,'Las acciones móviles deben caber en el ancho disponible');
  }
 });
}
