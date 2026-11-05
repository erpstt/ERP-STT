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
const wizardCapture=process.env.BANK_CSV_WIZARD_CAPTURE==='1',wizardArtifacts=resolve('..','banking-csv-wizard-qa-20261105');
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

const csvText='documento_referencia;fecha;cuenta_bancaria\nSYN-000005;2026-11-05;000005\n';
const deferred=()=>{let release;const promise=new Promise(resolve=>{release=resolve;});return{promise,release};};
async function assertReviewViewport(frame,dialog){
 await frame.waitForFunction(()=>{const modal=document.querySelector('.bank-import-modal'),heading=modal.querySelector('[data-review-title]'),bounds=modal.getBoundingClientRect(),box=heading.getBoundingClientRect();return box.height>0&&box.top>=Math.max(bounds.top,0)-1&&box.bottom<=Math.min(bounds.bottom,innerHeight)+1;});
 assert.equal(await dialog.locator('.bank-import-instructions').evaluate(element=>element.open),false,'La validación debe cerrar las instrucciones expandidas y dejar la revisión a la vista');
 const visible=await dialog.locator('[data-review-title]').evaluate(element=>{const box=element.getBoundingClientRect(),modal=element.closest('dialog').getBoundingClientRect();return box.top>=Math.max(modal.top,0)-1&&box.bottom<=Math.min(modal.bottom,innerHeight)+1;});assert.equal(visible,true,'El encabezado de revisión debe quedar dentro del diálogo y de la pantalla');
}
test('CSV checks: error operativo HTTP503 conserva aviso visible sin revisión vacía y permite validar otra vez',{timeout:30000},async t=>{
 const{page,frame}=await fixture(t,'checks',390),calls=[],errors=[];page.on('pageerror',error=>errors.push(error.message));page.on('request',request=>{const path=new URL(request.url()).pathname;if(path.startsWith('/api/banking/csv/'))calls.push(path);});let previews=0;
 const valid={valid:true,created:0,entries:[{reference:'SYN-000005',type:'CHEQUE',date:'2026-11-05',bankAccount:'000005',currency:'CRC',amount:'12.345678',lineCount:1}],errors:[],totals:[{currency:'CRC',amount:'12.345678',localAmount:'12.345678',documents:1,lines:1}],alreadyImported:false,previewToken:'synthetic-retry-preview',expiresAt:new Date(Date.now()+900000).toISOString(),context:{subsidiaryId:1,roleId:2,userId:3,sessionId:'synthetic-session'}};
 await page.route('**/api/banking/csv/checks/preview',async route=>{previews++;await route.fulfill(previews===1?{status:503,json:{error:{message:'Servicio temporalmente no disponible. Vuelva a validar.'}}}:{json:valid});});await frame.getByRole('button',{name:'Importar CSV',exact:true}).click();const dialog=frame.locator('dialog.bank-import-modal');await dialog.locator('[data-file]').setInputFiles({name:'reintento.csv',buffer:Buffer.from(csvText)});await dialog.locator('.bank-import-instructions summary').click();assert.equal(await dialog.locator('.bank-import-instructions').evaluate(element=>element.open),true);await dialog.locator('[data-preview]').click();await frame.waitForFunction(()=>document.querySelector('.bank-import-modal').dataset.phase==='error');assert.equal(await dialog.locator('.bank-import-review-panel').isHidden(),true);assert.equal(await dialog.locator('[data-status]').isVisible(),true);assert.match(await dialog.locator('[data-status]').innerText(),/Servicio temporalmente no disponible/);assert.equal(await dialog.locator('[data-status]').evaluate(element=>{const box=element.getBoundingClientRect(),bounds=element.closest('dialog').getBoundingClientRect();return box.height>0&&box.top>=Math.max(0,bounds.top)-1&&box.bottom<=Math.min(innerHeight,bounds.bottom)+1;}),true);assert.equal(await dialog.locator('[data-confirm]').isDisabled(),true);assert.equal(await dialog.locator('[data-file]').isDisabled(),false);assert.equal(await dialog.locator('[data-preview]').isDisabled(),false);assert.equal(previews,1);assert.equal(calls.some(path=>path.endsWith('/import')),false);
 await dialog.locator('[data-preview]').click();await frame.waitForFunction(()=>document.querySelector('.bank-import-modal').dataset.phase==='review');await assertReviewViewport(frame,dialog);assert.equal(await dialog.locator('.bank-import-review-panel').isVisible(),true);assert.equal(await dialog.locator('[data-file-name]').textContent(),'reintento.csv');assert.equal(await dialog.locator('[data-confirm]').isDisabled(),false);assert.equal(previews,2);assert.equal(calls.some(path=>path.endsWith('/import')),false);assert.deepEqual(errors,[]);
});
for(const kind of['checks','deposits'])for(const width of[1536,390])test(`CSV ${kind} ${width}: asistente con tema real, plantilla única, archivo visible y guardado explícito`,{timeout:30000},async t=>{
 const{page,frame}=await fixture(t,kind,width),previewWait=deferred(),importWait=deferred(),calls=[],errors=[];page.on('pageerror',error=>errors.push(error.message));
 const result={valid:true,created:0,entries:[{reference:'SYN-000005',type:kind==='checks'?'CHEQUE':'DEPOSITO',date:'2026-11-05',bankAccount:'000005',currency:'CRC',amount:'12.345678',lineCount:1}],errors:[],totals:[{currency:'CRC',amount:'12.345678',localAmount:'12.345678',documents:1,lines:1}],alreadyImported:false,previewToken:'synthetic-wizard-preview',expiresAt:new Date(Date.now()+900000).toISOString(),context:{subsidiaryId:1,roleId:2,userId:3,sessionId:'synthetic-wizard-session'}};
 await page.route('**/api/banking/csv/**',async route=>{const req=route.request(),url=new URL(req.url()),body=JSON.parse(req.postData());assert.equal(url.pathname.startsWith('/api/banking/csv/'+kind+'/'),true);assert.equal(req.method(),'POST');calls.push({path:url.pathname,body});if(url.pathname.endsWith('/preview')){await previewWait.promise;await route.fulfill({json:result});}else{await importWait.promise;await route.fulfill({json:{...result,created:1}});}});
 const screenshot=async stage=>{if(wizardCapture){await mkdir(wizardArtifacts,{recursive:true});await page.screenshot({path:resolve(wizardArtifacts,`${kind}-${width}-${stage}.png`),fullPage:true});}};
 try{
  await frame.getByRole('button',{name:'Importar CSV',exact:true}).click();const dialog=frame.locator('dialog.bank-import-modal');assert.equal(await dialog.getAttribute('data-phase'),'upload');assert.equal(await dialog.locator('.step-upload').getAttribute('aria-current'),'step');assert.equal(await dialog.locator('.bank-import-steps li').count(),3);assert.equal(await dialog.locator('.bank-import-review-panel').isHidden(),true);
  const template=kind==='checks'?'/plantilla-cheques-transferencias.csv':'/plantilla-depositos-bancarios.csv';assert.deepEqual(await dialog.locator('a[download]').evaluateAll(nodes=>nodes.map(node=>node.getAttribute('href'))),[template]);assert.equal(await dialog.locator('.bank-import-template-link').getAttribute('href'),template);
  await dialog.locator('[data-file]').setInputFiles({name:'lote-000005.csv',mimeType:'text/csv',buffer:Buffer.from(csvText)});assert.equal(await dialog.locator('[data-file-name]').textContent(),'lote-000005.csv');assert.ok((await dialog.locator('[data-file-detail]').textContent()).trim());assert.equal(await dialog.locator('[data-confirm]').isDisabled(),true);assert.equal(calls.length,0);
  const layout=await dialog.evaluate(element=>{const rect=node=>{const r=node.getBoundingClientRect();return{x:r.x,y:r.y,width:r.width,height:r.height,right:r.right,bottom:r.bottom};};return{viewport:innerWidth,pageWidth:document.documentElement.scrollWidth,dialog:rect(element),cards:[...element.querySelector('.bank-import-upload-layout').children].map(rect),zone:rect(element.querySelector('.bank-import-file-zone')),fileName:rect(element.querySelector('[data-file-name]'))};});
  assert.equal(layout.cards.length,2);assert.ok(layout.pageWidth<=width+1);assert.ok(layout.dialog.x>=-1&&layout.dialog.right<=width+1);assert.ok(layout.zone.width>100&&layout.zone.height>=100);assert.ok(layout.fileName.x>=layout.zone.x-1&&layout.fileName.right<=layout.zone.right+1);if(width>650){assert.ok(Math.abs(layout.cards[0].y-layout.cards[1].y)<=2);assert.ok(layout.cards[0].right<=layout.cards[1].x+1);}else assert.ok(layout.cards[0].bottom<=layout.cards[1].y+1);
  await screenshot('upload');if(!(await dialog.locator('.bank-import-instructions').evaluate(element=>element.open)))await dialog.locator('.bank-import-instructions summary').click();assert.equal(await dialog.locator('.bank-import-instructions').evaluate(element=>element.open),true);assert.ok((await dialog.locator('.bank-import-instructions').innerText()).length>100);assert.ok((await dialog.locator('[data-action-hint]').innerText()).trim());
  await dialog.locator('[data-preview]').click();await frame.waitForFunction(()=>document.querySelector('.bank-import-modal').dataset.phase==='validating');assert.equal(calls.length,1);assert.equal(await dialog.locator('[data-confirm]').isDisabled(),true);previewWait.release();await frame.waitForFunction(()=>document.querySelector('.bank-import-modal').dataset.phase==='review');assert.equal(await dialog.locator('.step-review').getAttribute('aria-current'),'step');assert.equal(await dialog.locator('.bank-import-review-panel').isVisible(),true);assert.equal(await dialog.locator('[data-rows] tr').count(),1);assert.match(await dialog.locator('[data-summary]').innerText(),/12,345678/);assert.equal(calls.some(call=>call.path.endsWith('/import')),false);await assertReviewViewport(frame,dialog);await screenshot('review');
  await dialog.locator('[data-confirm]').click();await frame.waitForFunction(()=>document.querySelector('.bank-import-modal').dataset.phase==='importing');assert.equal(await dialog.locator('.step-save').getAttribute('aria-current'),'step');assert.equal(await dialog.locator('[data-file]').isDisabled(),true);assert.equal(await dialog.locator('[data-close]').first().isDisabled(),true);await frame.evaluate(()=>{document.querySelector('[data-confirm]').onclick();const modal=document.querySelector('.bank-import-modal');if(modal.dispatchEvent(new Event('cancel',{cancelable:true})))modal.close();});assert.equal(await dialog.isVisible(),true);assert.equal(calls.filter(call=>call.path.endsWith('/import')).length,1);assert.deepEqual(calls.at(-1).body,{csv:csvText,subsidiaryId:1,previewToken:'synthetic-wizard-preview'});importWait.release();await frame.waitForFunction(()=>document.querySelector('.bank-import-modal').dataset.phase==='done');assert.equal(await dialog.locator('[data-confirm]').isDisabled(),true);assert.match(await dialog.locator('[data-status]').innerText(),/1 documento/);await dialog.locator('[data-file]').setInputFiles({name:'nuevo-lote.csv',buffer:Buffer.from(csvText+'NEW\n')});assert.equal(await dialog.getAttribute('data-phase'),'upload');assert.equal(await dialog.locator('[data-file-name]').textContent(),'nuevo-lote.csv');assert.equal(await dialog.locator('[data-confirm]').isDisabled(),true);assert.equal(await dialog.locator('.bank-import-review-panel').isHidden(),true);assert.equal(calls.filter(call=>call.path.endsWith('/import')).length,1);assert.deepEqual(errors,[]);
 }finally{previewWait.release();importWait.release();}
});

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
  assert.deepEqual(await dialog.locator('a[download]').evaluateAll(links=>links.map(link=>link.getAttribute('href'))),[kind==='checks'?'/plantilla-cheques-transferencias.csv':'/plantilla-depositos-bancarios.csv']);
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
