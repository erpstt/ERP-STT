import {paginationWindow,pageSizes} from './pagination-window.js?v=20261110-list-pagination';

// Presentation only: application rows, event listeners, inputs and complete
// business collections remain intact when the visible page changes.
const controllers=new Map(),rootObservers=new Map();
let sequence=0,allRowsDepth=0,printing=false;
const marker='[data-list-pagination]';
const element=(tag,className,text)=>{const node=document.createElement(tag);if(className)node.className=className;if(text!=null)node.textContent=text;return node;};
const directItems=container=>Array.from(container.children).filter(item=>{
  const selector=container.dataset.paginationItem;
  if(selector){try{return item.matches(selector);}catch{return false;}}
  return item.tagName==='TR'&&!(item.cells.length===1&&item.cells[0].hasAttribute('colspan'));
});
function placement(container){
  const table=container.tagName==='TBODY'?container.closest('table'):null;
  if(!table)return{anchor:container,inside:false};
  for(let parent=table.parentElement;parent&&!['MAIN','BODY','SECTION'].includes(parent.tagName);parent=parent.parentElement){
    if(parent.matches('.matrix-scroll'))return{anchor:parent,inside:true};
    if(parent.matches('.table-scroll,.table-wrap,.table-wrapper,.table-shell')||['auto','scroll'].includes(getComputedStyle(parent).overflowX))return{anchor:parent,inside:false};
  }
  return{anchor:table,inside:false};
}

class ListPagination{
  constructor(container){
    this.container=container;this.page=1;this.size=10;this.items=[];this.everPaged=false;this.queued=false;
    this.originalId=container.id;if(!container.id)container.id=`list-pagination-items-${++sequence}`;
    const label=container.dataset.paginationLabel||'Listado';
    this.nav=element('nav','list-pagination');this.nav.setAttribute('aria-label',`Paginación: ${label}`);this.nav.dataset.paginationFor=container.id;
    this.info=element('p','list-pagination-info');this.info.setAttribute('role','status');this.info.setAttribute('aria-live','polite');
    const sizeLabel=element('label','list-pagination-size','Registros por página');this.select=element('select');this.select.setAttribute('aria-label',`Registros por página: ${label}`);
    for(const size of pageSizes)this.select.append(new Option(String(size),String(size)));this.select.value='10';sizeLabel.append(this.select);
    this.controls=element('div','list-pagination-controls');this.buttons={};
    this.caption=element('span','list-pagination-caption');
    for(const [action,title,text] of [['first','Primera página','«'],['previous','Página anterior','‹'],['next','Página siguiente','›'],['last','Última página','»']]){
      const button=element('button','',text);button.type='button';button.dataset.paginationAction=action;button.setAttribute('aria-label',title);button.setAttribute('aria-controls',container.id);button.title=title;
      if(action==='next')this.controls.append(this.caption);this.controls.append(button);this.buttons[action]=button;
    }
    this.selection=element('p','list-pagination-selection');this.selection.hidden=true;
    this.nav.append(this.info,sizeLabel,this.controls,this.selection);const place=placement(container);if(place.inside)place.anchor.prepend(this.nav);else place.anchor.before(this.nav);
    this.nav.addEventListener('click',event=>{const button=event.target.closest('[data-pagination-action]');if(!button||button.disabled)return;
      const window=paginationWindow(this.items.length,this.page,this.size),action=button.dataset.paginationAction;
      this.page=action==='first'?1:action==='previous'?window.page-1:action==='next'?window.page+1:window.pageCount;this.render();
    });
    this.select.addEventListener('change',()=>{this.size=Number(this.select.value);this.page=1;this.render();});
    this.observer=new MutationObserver(records=>{
      if(records.some(record=>(record.type==='childList'&&record.target===container)||(record.type==='attributes'&&record.target.parentElement===container)))this.schedule();
    });
    this.observer.observe(container,{childList:true,subtree:true,attributes:true,attributeFilter:['hidden','style','class']});
    this.refresh();
  }
  schedule(){if(this.queued)return;this.queued=true;queueMicrotask(()=>{this.queued=false;if(this.container.isConnected)this.refresh();else this.destroy();});}
  refresh(){
    const all=directItems(this.container);
    for(const item of all)item.removeAttribute('data-pagination-hidden');
    const items=all.filter(item=>!item.hidden&&getComputedStyle(item).display!=='none'&&getComputedStyle(item).visibility!=='hidden');
    // Filter controls explicitly reset the page. Other application updates,
    // including a deletion or selection repaint, retain and clamp the page.
    this.items=items;this.updateSelection();this.render();
  }
  updateSelection(){
    const mode=this.container.dataset.paginationSelection,hasChecks=this.items.some(item=>item.querySelector('input[type="checkbox"]'));
    this.selection.hidden=!mode||!hasChecks;
    if(this.selection.hidden)return;
    this.selection.textContent=mode==='all'?'La selección se conserva entre páginas. Seleccionar todos incluye todos los resultados.':'La selección se conserva entre páginas.';
    const header=this.container.closest('table')?.querySelector('thead input[type="checkbox"]');
    if(mode==='all'&&header){
      if(!this.headerOriginal)this.headerOriginal={element:header,label:header.getAttribute('aria-label'),title:header.getAttribute('title')};
      header.setAttribute('aria-label','Seleccionar todos los resultados');header.title='Seleccionar todos los resultados; la selección se conserva entre páginas.';
    }
  }
  render(){
    const window=paginationWindow(this.items.length,this.page,this.size);this.page=window.page;this.size=window.pageSize;
    this.items.forEach((item,index)=>{if(!allRowsDepth&&!printing&&(index<window.start||index>=window.end))item.dataset.paginationHidden='true';else item.removeAttribute('data-pagination-hidden');});
    this.everPaged=this.everPaged||window.total>10;this.nav.hidden=!this.everPaged&&window.pageSize===10;
    this.select.value=String(window.pageSize);this.info.textContent=window.total?`Mostrando ${window.from}–${window.to} de ${window.total} registros`:'0 registros';
    this.caption.textContent=`Página ${window.page} de ${window.pageCount}`;
    this.buttons.first.disabled=this.buttons.previous.disabled=window.page===1;
    this.buttons.next.disabled=this.buttons.last.disabled=window.page===window.pageCount;
  }
  showAll(){for(const item of directItems(this.container))item.removeAttribute('data-pagination-hidden');}
  destroy(){
    this.observer.disconnect();this.showAll();this.nav.remove();
    const original=this.headerOriginal;if(original&&original.element.isConnected){for(const [name,value]of [['aria-label',original.label],['title',original.title]]){if(value==null)original.element.removeAttribute(name);else original.element.setAttribute(name,value);}}
    if(!this.originalId&&this.container.id.startsWith('list-pagination-items-'))this.container.removeAttribute('id');controllers.delete(this.container);
  }
}

export function initListPagination(root=document){
  const candidates=[];if(root.nodeType===1&&root.matches(marker))candidates.push(root);candidates.push(...root.querySelectorAll(marker));
  for(const container of candidates){if(!controllers.has(container)&&!container.parentElement?.closest(marker))controllers.set(container,new ListPagination(container));}
  return candidates.map(container=>controllers.get(container)).filter(Boolean);
}
export function refreshListPagination(root=document){for(const controller of controllers.values())if(root===document||root===controller.container||root.contains(controller.container))controller.refresh();}
export async function withAllListRowsVisible(callback){
  allRowsDepth++;for(const controller of controllers.values())controller.showAll();
  try{return await callback();}finally{allRowsDepth--;if(!allRowsDepth)for(const controller of controllers.values())controller.refresh();}
}
function resetForFilter(event){
  if(event.target.closest?.(marker)||event.target.closest?.('.list-pagination'))return;
  if(event.target.matches?.('input[type="checkbox"]')&&event.target.closest('table')?.querySelector(marker))return;
  const filter=event.target.closest?.('[data-list-pagination-filter]');if(!filter)return;
  if(event.type==='click'&&!event.target.closest('button,a,[role="tab"]'))return;
  const targets=filter.dataset.listPaginationFilter.split(',').map(value=>value.trim()).filter(Boolean);
  for(const controller of controllers.values())if(targets.includes('*')||targets.includes(controller.container.id)){controller.page=1;controller.render();}
}
function start(){
  initListPagination();
  // Vue replaces the children of these explicitly marked roots on mount.
  // Observe only opt-in roots; ordinary pages keep their existing tbody nodes.
  for(const root of document.querySelectorAll('[data-list-pagination-root]')){
    if(rootObservers.has(root))continue;
    const observer=new MutationObserver(records=>{
      for(const record of records)for(const node of record.addedNodes)if(node.nodeType===1&&(node.matches(marker)||node.querySelector(marker)))initListPagination(node);
      for(const controller of controllers.values())if(!controller.container.isConnected)controller.destroy();
    });observer.observe(root,{childList:true,subtree:true});rootObservers.set(root,observer);
  }
}
for(const type of ['input','change','submit','click'])document.addEventListener(type,resetForFilter,true);
window.addEventListener('beforeprint',()=>{printing=true;for(const controller of controllers.values())controller.showAll();});
window.addEventListener('afterprint',()=>{printing=false;if(!allRowsDepth)for(const controller of controllers.values())controller.refresh();});
window.addEventListener('pagehide',()=>{for(const observer of rootObservers.values())observer.disconnect();rootObservers.clear();for(const controller of [...controllers.values()])controller.destroy();});
window.addEventListener('pageshow',event=>{if(event.persisted)start();});
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',start,{once:true});else start();
