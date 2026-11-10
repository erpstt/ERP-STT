import assert from 'node:assert/strict';
import {test} from 'node:test';
import {expect} from '@playwright/test';
import {bankBrowserFixture} from './lib/bank-browser-fixture.mjs';

const version='20261110-list-pagination';
const escapeAttribute=value=>String(value).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
const nav=(page,id='rows')=>page.locator(`nav[data-pagination-for="${id}"]`);
const action=(page,name,id='rows')=>nav(page,id).locator(`[data-pagination-action="${name}"]`);
const ids=(page,id='rows')=>page.locator(`#${id}>[data-row-id]:visible`).evaluateAll(rows=>rows.map(row=>Number(row.dataset.rowId)));

// Only synthetic HTML and the real pagination module/CSS run here. The fixture
// aborts external origins, and every unexpected business API fails the test.
async function fixture(t,{count=548,width=1440,cards=0,label='Registros sintéticos',hidden=[],styleHidden=[],visibilityHidden=[],dynamic=false}={}){
  const{page,baseURL}=await bankBrowserFixture(t,{viewport:{width,height:900},timeout:8000}),apiCalls=[],errors=[];
  page.on('pageerror',error=>errors.push(error.message));
  const table=`<div class="table-scroll"><table><thead><tr><th><input id="all" type="checkbox" aria-label="Seleccionar filas"></th><th>Registro</th><th>Entrada</th><th>Acción</th></tr></thead><tbody id="rows" data-list-pagination data-pagination-label="${escapeAttribute(label)}" data-pagination-selection="all"></tbody></table></div>`;
  const dynamicShell='<main id="dynamicRoot" data-list-pagination-root><p id="loading">Cargando grupo sintético</p></main>';
  const html=`<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/list-pagination.css?v=${version}"><style>
    *{box-sizing:border-box}body{margin:0;font:14px/1.5 "Segoe UI",sans-serif;color:#17385f;background:#f5f7fb}main{width:100%;min-width:0;padding:14px}.card{min-width:0;margin:0 0 18px;padding:12px;background:white;border:1px solid #d8e2ef;border-radius:8px}.table-scroll,.matrix-scroll{max-width:100%;overflow:auto}table{border-collapse:collapse;width:100%;min-width:700px}th,td{text-align:left;padding:8px;border-bottom:1px solid #d8e2ef}td input[type=text]{width:160px}.workflow-row{display:flex;gap:14px;align-items:center;padding:10px;border-bottom:1px solid #d8e2ef}.workflow-row span{min-width:0;overflow-wrap:anywhere}input,button{font:inherit}form{margin:0 0 12px}form input{max-width:100%}
  </style></head><body>${dynamic?dynamicShell:`<main><form id="filters" data-list-pagination-filter="rows"><input id="filter" aria-label="Filtrar resultados"><button type="submit">Consultar</button></form><input id="allFilter" data-list-pagination-filter="*" aria-label="Filtro global"><section class="card">${table}</section>${cards?'<section class="card"><div id="cards" data-list-pagination data-pagination-item=".workflow-row" data-pagination-label="Flujos sintéticos"></div></section>':''}</main>`}
  <script>
    window.business={model:Array.from({length:${count}},(_,index)=>({id:index+1,label:'ROW-'+String(index+1).padStart(4,'0')})),selected:new Set(),clicks:[],query:'',hidden:new Set(${JSON.stringify(hidden)}),styleHidden:new Set(${JSON.stringify(styleHidden)}),visibilityHidden:new Set(${JSON.stringify(visibilityHidden)})};
    window.makeRow=function(record){const tr=document.createElement('tr');tr.dataset.rowId=record.id;tr.hidden=business.hidden.has(record.id)||!record.label.includes(business.query);if(business.styleHidden.has(record.id))tr.style.display='none';if(business.visibilityHidden.has(record.id))tr.style.visibility='hidden';
      const selectCell=tr.insertCell(),check=document.createElement('input');check.type='checkbox';check.value=record.id;check.checked=business.selected.has(record.id);check.setAttribute('aria-label','Seleccionar '+record.label);check.onchange=()=>{check.checked?business.selected.add(record.id):business.selected.delete(record.id)};selectCell.append(check);
      tr.insertCell().textContent=record.label;const input=document.createElement('input');input.type='text';input.value='Borrador '+record.id;input.setAttribute('aria-label','Entrada '+record.id);tr.insertCell().append(input);const button=document.createElement('button');button.type='button';button.textContent='Abrir '+record.id;button.onclick=()=>business.clicks.push(record.id);tr.insertCell().append(button);return tr;};
    window.renderRows=function(){document.getElementById('rows').replaceChildren(...business.model.map(makeRow));};
    window.applyFilter=function(value){business.query=value;for(const row of document.querySelectorAll('#rows>[data-row-id]'))row.hidden=business.hidden.has(Number(row.dataset.rowId))||!row.cells[1].textContent.includes(value);};
    if(document.getElementById('rows')){renderRows();document.getElementById('filter').oninput=event=>applyFilter(event.target.value);document.getElementById('filters').onsubmit=event=>event.preventDefault();document.getElementById('all').onchange=event=>{for(const record of business.model)if(!business.hidden.has(record.id)&&record.label.includes(business.query)){event.target.checked?business.selected.add(record.id):business.selected.delete(record.id);document.querySelector('#rows>[data-row-id="'+record.id+'"] input[type=checkbox]').checked=event.target.checked;}};}
    if(document.getElementById('cards'))for(let id=1;id<=${cards};id++){const row=document.createElement('article');row.className='workflow-row';row.dataset.rowId=id;const text=document.createElement('span');text.textContent='Flujo sintético '+id;row.append(text);document.getElementById('cards').append(row);}
  </script><script type="module">
    import * as api from '/list-pagination.js?v=${version}';window.paginationApi=api;
    if(${dynamic}){
      const{createApp,h,ref,nextTick,withDirectives,vShow}=await import('/assets/vue.js?v=20261102-a03-csp');
      window.mountGroup=async function(total=25){
        window.vueGroupApp?.unmount();
        const rows=ref(Array.from({length:total},(_,index)=>({id:index+1,label:'PERM-'+(index+1)}))),expanded=ref(false),drafts=ref({}),selected=ref(new Set()),revision=ref(0);
        window.vueGroupState={rows,expanded,drafts,selected,revision};
        window.setGroupExpanded=async value=>{expanded.value=value;await nextTick();};
        window.patchGroup=async()=>{rows.value=rows.value.map(row=>({...row}));revision.value++;await nextTick();};
        window.vueGroupApp=createApp({setup(){return()=>h('section',{id:'group',class:'card'},[
          h('p',{id:'vueRevision'},'Render '+revision.value),
          withDirectives(h('div',{class:'matrix-scroll'},[h('table',[h('tbody',{id:'matrixRows','data-list-pagination':'','data-pagination-label':'Permisos sintéticos','data-pagination-selection':'preserve'},rows.value.map(record=>h('tr',{key:record.id,'data-row-id':record.id},[
            h('td',[h('input',{type:'checkbox','aria-label':'Seleccionar permiso '+record.id,checked:selected.value.has(record.id),onChange:event=>{event.target.checked?selected.value.add(record.id):selected.value.delete(record.id);}})]),
            h('td',record.label),
            h('td',[h('input',{type:'text','aria-label':'Entrada permiso '+record.id,value:drafts.value[record.id]??('Borrador '+record.id),onInput:event=>{drafts.value[record.id]=event.target.value;}})]),
            h('td',[h('button',{type:'button',onClick:()=>business.clicks.push(record.id)},'Abrir '+record.id)])
          ])))])]),[[vShow,expanded.value]])
        ]);}});
        window.vueGroupApp.mount(document.getElementById('dynamicRoot'));await nextTick();
      };
    }
    window.paginationReady=true;
  </script></body></html>`;
  await page.route('**/*',async route=>{
    const url=new URL(route.request().url());if(url.origin!==baseURL)return route.fallback();
    if(url.pathname==='/pagination-fixture.html')return route.fulfill({contentType:'text/html; charset=utf-8',body:html});
    if(url.pathname.startsWith('/api/')){apiCalls.push(route.request().method()+' '+url.pathname);return route.fulfill({status:501,json:{error:{message:'No business APIs are allowed in this fixture'}}});}
    return route.fallback();
  });
  t.after(()=>{assert.deepEqual(apiCalls,[]);assert.deepEqual(errors,[]);});
  await page.goto(baseURL+'/pagination-fixture.html');await page.waitForFunction(()=>window.paginationReady);
  if(!dynamic)await nav(page).waitFor({state:'attached'});
  return{page,apiCalls};
}

test('548 elementos permanecen en DOM y se recorren en 55 páginas con tamaños 10,25,50,100',{timeout:45000},async t=>{
  const{page}=await fixture(t);
  await expect(page.locator('#rows>tr')).toHaveCount(548);await expect.poll(()=>ids(page)).toEqual([1,2,3,4,5,6,7,8,9,10]);
  await expect(nav(page).locator('.list-pagination-info')).toHaveText('Mostrando 1–10 de 548 registros');await expect(nav(page).locator('.list-pagination-caption')).toHaveText('Página 1 de 55');
  await expect(action(page,'first')).toBeDisabled();await expect(action(page,'previous')).toBeDisabled();
  await action(page,'next').click();assert.deepEqual(await ids(page),[11,12,13,14,15,16,17,18,19,20]);await action(page,'previous').click();
  await action(page,'last').click();assert.deepEqual(await ids(page),[541,542,543,544,545,546,547,548]);await expect(nav(page).locator('.list-pagination-caption')).toHaveText('Página 55 de 55');await expect(action(page,'next')).toBeDisabled();
  await action(page,'first').click();
  for(const size of[25,50,100,10]){await action(page,'last').click();await nav(page).locator('select').selectOption(String(size));await expect(nav(page).locator('.list-pagination-caption')).toHaveText('Página 1 de '+Math.ceil(548/size));assert.equal((await ids(page)).length,size);}
  await expect(page.locator('#rows>tr')).toHaveCount(548);
});

test('selección, entradas y listeners sobreviven al cambiar página y seleccionar todos abarca resultados completos',{timeout:30000},async t=>{
  const{page}=await fixture(t,{count:35});
  await page.locator('#rows>[data-row-id="1"] input[type=checkbox]').check();await page.locator('#rows>[data-row-id="1"] input[type=text]').fill('Borrador conservado');await page.getByRole('button',{name:'Abrir 1',exact:true}).click();
  await action(page,'next').click();await page.locator('#rows>[data-row-id="11"] input[type=checkbox]').check();await action(page,'first').click();
  await expect(page.locator('#rows>[data-row-id="1"] input[type=checkbox]')).toBeChecked();await expect(page.locator('#rows>[data-row-id="1"] input[type=text]')).toHaveValue('Borrador conservado');await page.getByRole('button',{name:'Abrir 1',exact:true}).click();
  assert.deepEqual(await page.evaluate(()=>[...business.selected]),[1,11]);assert.deepEqual(await page.evaluate(()=>business.clicks),[1,1]);
  await expect(page.locator('#all')).toHaveAttribute('aria-label','Seleccionar todos los resultados');await expect(nav(page).locator('.list-pagination-selection')).toContainText('todos los resultados');
  await page.locator('#all').check();assert.equal(await page.locator('#rows input[type=checkbox]:checked').count(),35);assert.equal(await page.evaluate(()=>business.selected.size),35);
  await action(page,'last').click();await expect(page.locator('#rows>[data-row-id="35"] input[type=checkbox]')).toBeChecked();
});

test('los filtros explícitos reinician a uno y excluyen ocultos de negocio sin contarlos ni revelarlos',{timeout:30000},async t=>{
  const{page}=await fixture(t,{count:16,hidden:[2],styleHidden:[3],visibilityHidden:[4]});
  await expect(nav(page).locator('.list-pagination-info')).toHaveText('Mostrando 1–10 de 13 registros');assert.deepEqual(await ids(page),[1,5,6,7,8,9,10,11,12,13]);
  await action(page,'last').click();await page.getByRole('textbox',{name:'Filtrar resultados'}).fill('ROW-0016');await expect.poll(()=>ids(page)).toEqual([16]);await expect(nav(page).locator('.list-pagination-caption')).toHaveText('Página 1 de 1');
  await expect(nav(page)).toBeVisible();await page.getByRole('textbox',{name:'Filtrar resultados'}).fill('');await action(page,'last').click();await page.getByRole('button',{name:'Consultar',exact:true}).click();await expect(nav(page).locator('.list-pagination-caption')).toHaveText('Página 1 de 2');
  for(const id of[2,3,4])await expect(page.locator(`#rows>[data-row-id="${id}"]`)).toBeHidden();
  assert.equal(await page.locator('#rows>[data-row-id="2"]').getAttribute('hidden'),'');await expect(page.locator('#rows>[data-row-id="3"]')).toHaveCSS('display','none');await expect(page.locator('#rows>[data-row-id="4"]')).toHaveCSS('visibility','hidden');
});

test('un repintado completo conserva página y selección del modelo y eliminar filas ajusta el rango',{timeout:30000},async t=>{
  const{page}=await fixture(t,{count:30});await action(page,'last').click();await page.locator('#rows>[data-row-id="21"] input[type=checkbox]').check();
  await page.evaluate(()=>renderRows());await expect(nav(page).locator('.list-pagination-caption')).toHaveText('Página 3 de 3');await expect(page.locator('#rows>[data-row-id="21"] input[type=checkbox]')).toBeChecked();assert.deepEqual(await ids(page),[21,22,23,24,25,26,27,28,29,30]);
  await page.evaluate(()=>{business.model=business.model.filter(row=>row.id<=20);renderRows();});await expect(nav(page).locator('.list-pagination-caption')).toHaveText('Página 2 de 2');assert.deepEqual(await ids(page),[11,12,13,14,15,16,17,18,19,20]);
  await page.getByRole('button',{name:'Abrir 11',exact:true}).click();assert.deepEqual(await page.evaluate(()=>business.clicks),[11]);await expect(page.locator('nav[data-pagination-for="rows"]')).toHaveCount(1);
});

test('los placeholders no cuentan y los listados pequeños no muestran paginador hasta necesitarlo',{timeout:30000},async t=>{
  const{page}=await fixture(t,{count:0});
  await page.evaluate(()=>{const row=document.createElement('tr'),cell=row.insertCell();cell.colSpan=4;cell.textContent='No hay resultados';document.getElementById('rows').append(row);});
  await expect(nav(page)).toBeHidden();await expect(nav(page).locator('.list-pagination-info')).toHaveText('0 registros');await expect(page.getByText('No hay resultados',{exact:true})).toBeVisible();
  await page.evaluate(()=>{business.model=Array.from({length:10},(_,index)=>({id:index+1,label:'ROW-'+String(index+1).padStart(4,'0')}));renderRows();});await expect.poll(()=>ids(page)).toHaveLength(10);await expect(nav(page)).toBeHidden();
  await page.evaluate(()=>{business.model.push({id:11,label:'ROW-0011'});renderRows();});await expect(nav(page)).toBeVisible();await action(page,'last').click();await page.getByRole('textbox',{name:'Filtrar resultados'}).fill('ROW-0011');await expect.poll(()=>ids(page)).toEqual([11]);await expect(nav(page)).toBeVisible();await expect(nav(page).locator('.list-pagination-caption')).toHaveText('Página 1 de 1');
});

test('dos paginadores independientes, tarjetas y etiquetas hostiles caben en móvil y admiten filtro global',{timeout:30000},async t=>{
  const hostile='<img src=x onerror="window.paginationXss=true"> & <script>bad</script>',{page}=await fixture(t,{count:25,cards:15,width:390,label:hostile});
  await expect(page.locator('nav[data-pagination-for]')).toHaveCount(2);await expect(nav(page)).toHaveAttribute('aria-label','Paginación: '+hostile);await expect(page.locator('nav img,nav script')).toHaveCount(0);assert.equal(await page.evaluate(()=>window.paginationXss),undefined);
  await action(page,'next').click();assert.deepEqual(await ids(page),[11,12,13,14,15,16,17,18,19,20]);assert.deepEqual(await ids(page,'cards'),[1,2,3,4,5,6,7,8,9,10]);
  await action(page,'next','cards').click();assert.deepEqual(await ids(page,'cards'),[11,12,13,14,15]);await page.getByRole('textbox',{name:'Filtro global'}).fill('recalcular');await expect(nav(page).locator('.list-pagination-caption')).toHaveText('Página 1 de 3');await expect(nav(page,'cards').locator('.list-pagination-caption')).toHaveText('Página 1 de 2');
  const geometry=await page.locator('nav[data-pagination-for]').evaluateAll(elements=>elements.map(element=>({width:innerWidth,documentWidth:document.documentElement.scrollWidth,box:element.getBoundingClientRect().toJSON(),controls:[...element.querySelectorAll('button,select')].map(control=>({rect:control.getBoundingClientRect().toJSON(),label:control.getAttribute('aria-label')}))})));
  for(const item of geometry){assert.ok(item.documentWidth<=item.width+1,JSON.stringify(item));assert.ok(item.box.left>=0&&item.box.right<=item.width+1,JSON.stringify(item));for(const control of item.controls){assert.ok(control.label);assert.ok(control.rect.height>=40,JSON.stringify(control));assert.ok(control.rect.left>=0&&control.rect.right<=item.width+1,JSON.stringify(control));}}
});

test('exportar DOM/modelo, mostrar todas las filas temporalmente e imprimir conservan datos y restauran la página',{timeout:30000},async t=>{
  const{page}=await fixture(t,{count:25,cards:15,hidden:[2],styleHidden:[3]});await action(page,'next').click();
  assert.equal(await page.evaluate(()=>business.model.length),25);await expect(page.locator('#rows>[data-row-id]')).toHaveCount(25);assert.equal((await ids(page)).length,10);
  const visible=await page.evaluate(()=>paginationApi.withAllListRowsVisible(async()=>{await Promise.resolve();return[...document.querySelectorAll('#rows>[data-row-id]')].filter(row=>getComputedStyle(row).display!=='none').map(row=>Number(row.dataset.rowId));}));assert.equal(visible.length,23);assert.ok(!visible.includes(2)&&!visible.includes(3));
  await expect(nav(page).locator('.list-pagination-caption')).toHaveText('Página 2 de 3');assert.equal((await ids(page)).length,10);
  await page.evaluate(async()=>{try{await paginationApi.withAllListRowsVisible(async()=>{throw Error('Synthetic failed export');});}catch(error){window.exportError=error.message;}});assert.equal(await page.evaluate(()=>window.exportError),'Synthetic failed export');assert.equal((await ids(page)).length,10);
  await page.emulateMedia({media:'print'});assert.equal((await ids(page)).length,23);assert.equal((await ids(page,'cards')).length,15);await expect(nav(page)).toBeHidden();await page.emulateMedia({media:'screen'});assert.equal((await ids(page)).length,10);
  await page.evaluate(()=>window.dispatchEvent(new Event('beforeprint')));assert.equal((await ids(page)).length,23);await page.evaluate(()=>window.dispatchEvent(new Event('afterprint')));await expect(nav(page).locator('.list-pagination-caption')).toHaveText('Página 2 de 3');assert.equal((await ids(page)).length,10);
  const domExport=await page.locator('#rows>[data-row-id]').evaluateAll(rows=>rows.map(row=>Number(row.dataset.rowId)));assert.deepEqual(domExport,Array.from({length:25},(_,index)=>index+1));
});

test('raíces Vue dinámicas y grupos v-show preservan entradas y no crean paginadores duplicados',{timeout:30000},async t=>{
  const{page}=await fixture(t,{dynamic:true});await page.evaluate(()=>mountGroup(25));await nav(page,'matrixRows').waitFor({state:'attached'});await expect(nav(page,'matrixRows')).toBeHidden();
  await expect(page.locator('#group')).toBeVisible();await expect(page.locator('#group>.matrix-scroll')).toHaveCSS('display','none');
  await page.evaluate(()=>setGroupExpanded(true));await expect.poll(()=>ids(page,'matrixRows')).toEqual([1,2,3,4,5,6,7,8,9,10]);assert.equal(await nav(page,'matrixRows').evaluate(element=>element.parentElement.className),'matrix-scroll');
  await action(page,'next','matrixRows').click();const input=page.locator('#matrixRows>[data-row-id="11"] input[type=text]');await input.fill('Cambio sin guardar');await page.locator('#matrixRows>[data-row-id="11"] input[type=checkbox]').check();
  await page.evaluate(async()=>{window.retainedInput=document.querySelector('#matrixRows>[data-row-id="11"] input[type=text]');await setGroupExpanded(false);});await expect(input).toBeHidden();await expect(nav(page,'matrixRows')).toBeHidden();await expect(page.locator('#group')).toBeVisible();
  await page.evaluate(()=>setGroupExpanded(true));await expect(input).toHaveValue('Cambio sin guardar');await expect(input).toBeVisible();await expect(page.locator('#matrixRows>[data-row-id="11"] input[type=checkbox]')).toBeChecked();await expect(nav(page,'matrixRows')).toBeVisible();await expect(nav(page,'matrixRows').locator('.list-pagination-caption')).toHaveText('Página 2 de 3');
  await page.evaluate(()=>patchGroup());await expect(page.locator('#vueRevision')).toHaveText('Render 1');await expect(input).toHaveValue('Cambio sin guardar');await expect(page.locator('#matrixRows>[data-row-id="11"] input[type=checkbox]')).toBeChecked();assert.equal(await input.evaluate(element=>element===window.retainedInput),true);assert.deepEqual(await page.evaluate(()=>({draft:vueGroupState.drafts.value[11],selected:[...vueGroupState.selected.value]})),{draft:'Cambio sin guardar',selected:[11]});
  await expect(nav(page,'matrixRows').locator('.list-pagination-caption')).toHaveText('Página 2 de 3');await page.evaluate(()=>{paginationApi.initListPagination(document.getElementById('dynamicRoot'));paginationApi.initListPagination(document.getElementById('dynamicRoot'));});await expect(page.locator('nav[data-pagination-for]')).toHaveCount(1);
  await page.evaluate(()=>mountGroup(15));await page.evaluate(()=>setGroupExpanded(true));await expect(page.locator('nav[data-pagination-for]')).toHaveCount(1);await expect(nav(page,'matrixRows').locator('.list-pagination-caption')).toHaveText('Página 1 de 2');await expect.poll(()=>ids(page,'matrixRows')).toHaveLength(10);
});

test('pagehide y pageshow persistido reactivan observadores sin perder controles ni duplicar navegación',{timeout:30000},async t=>{
  const{page}=await fixture(t,{count:25});await action(page,'next').click();await page.locator('#rows>[data-row-id="11"] input[type=text]').fill('Borrador BFCache');await page.locator('#rows>[data-row-id="11"] input[type=checkbox]').check();
  await page.evaluate(()=>window.dispatchEvent(new PageTransitionEvent('pagehide',{persisted:true})));await expect(page.locator('nav[data-pagination-for]')).toHaveCount(0);assert.equal((await ids(page)).length,25);
  await page.evaluate(()=>window.dispatchEvent(new PageTransitionEvent('pageshow',{persisted:true})));await expect(page.locator('nav[data-pagination-for]')).toHaveCount(1);await expect(nav(page).locator('.list-pagination-caption')).toHaveText('Página 1 de 3');await action(page,'next').click();await expect(page.locator('#rows>[data-row-id="11"] input[type=text]')).toHaveValue('Borrador BFCache');await expect(page.locator('#rows>[data-row-id="11"] input[type=checkbox]')).toBeChecked();
  await page.evaluate(()=>{business.model=business.model.slice(0,15);renderRows();});await expect(nav(page).locator('.list-pagination-caption')).toHaveText('Página 2 de 2');assert.deepEqual(await ids(page),[11,12,13,14,15]);
});
