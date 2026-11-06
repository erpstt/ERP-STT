let nextId=0;
let activePicker=null;
const pickers=new WeakMap();
const fold=value=>String(value??'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLocaleLowerCase('es');

/** Keep the native select as the sole source of the selected record ID. */
export function enhancePaymentRequestSelect(select,{label='Seleccione una opción',placeholder='Buscar por número o nombre',isEnabled=()=>true,onQuery=()=>{}}={}){
 if(!select||select.tagName!=='SELECT')throw new TypeError('Se requiere un selector nativo.');
 if(pickers.has(select))return pickers.get(select);
 const doc=select.ownerDocument,view=doc.defaultView,id='request-smart-'+(++nextId);
 const original={required:select.required,tabindex:select.getAttribute('tabindex'),ariaHidden:select.getAttribute('aria-hidden'),nativeClass:select.classList.contains('request-smart-native'),customError:select.validity?.customError?select.validationMessage:''};
 const wrapper=doc.createElement('span'),input=doc.createElement('input');
 wrapper.className='request-smart-field';wrapper.dataset.kind=select.classList.contains('account')?'account':'entity';
 input.type='text';input.className='request-smart-input';input.placeholder=placeholder;input.autocomplete='off';input.spellcheck=false;input.required=original.required;
 input.setAttribute('aria-label',label);input.setAttribute('role','combobox');input.setAttribute('aria-autocomplete','list');input.setAttribute('aria-haspopup','listbox');input.setAttribute('aria-expanded','false');input.setAttribute('aria-controls',id+'-list');
 select.before(wrapper);wrapper.append(select,input);select.classList.add('request-smart-native');select.required=false;select.setAttribute('tabindex','-1');select.setAttribute('aria-hidden','true');select.setCustomValidity('');
 let destroyed=false,draft=false,lastValue=null,cacheKey='',cacheNodes=[],options=[],shown=[],active=-1,popup=null,list=null,notice=null,frame=0,blurTimer=0,openObserver=null,externalError=original.customError;
 const removers=[],openRemovers=[];
 const listen=(target,event,handler,settings,collection=removers)=>{target.addEventListener(event,handler,settings);collection.push(()=>target.removeEventListener(event,handler,settings));};
 function enabled(){try{return !destroyed&&!select.disabled&&!select.matches(':disabled')&&isEnabled()!==false;}catch{return false;}}
 function validity(){const selected=select.value!==''&&select.selectedIndex>=0;input.setCustomValidity(externalError||(!selected&&input.value.trim()?'Seleccione una opción de la lista para usar este valor.':''));}
 function refreshOptions(){
  const source=Array.from(select.options),key=source.map(option=>[option.value,option.label,option.disabled,option.hidden,option.parentElement?.disabled,option.dataset.search||''].join('\u001f')).join('\u001e');
  if(key===cacheKey&&source.length===cacheNodes.length&&source.every((option,index)=>option===cacheNodes[index]))return;cacheKey=key;cacheNodes=source;
  options=source.filter(option=>option.value!==''&&!option.disabled&&!option.hidden&&!option.parentElement?.disabled).map(option=>({option,id:option.value,label:option.label.trim(),search:fold(option.label+' '+(option.dataset.search||''))}));
 }
 function close(){
  if(frame){view.cancelAnimationFrame(frame);frame=0;}
  if(blurTimer){view.clearTimeout(blurTimer);blurTimer=0;}
  openRemovers.splice(0).forEach(remove=>remove());openObserver?.disconnect();openObserver=null;
  popup?.remove();popup=null;list=null;notice=null;shown=[];active=-1;input.setAttribute('aria-expanded','false');input.removeAttribute('aria-activedescendant');
  if(activePicker===handle)activePicker=null;
 }
 function anchorVisible(box){
  let left=0,top=0,right=view.innerWidth,bottom=view.innerHeight;
  for(let node=wrapper.parentElement;node&&node!==doc.body;node=node.parentElement){const style=view.getComputedStyle(node),bounds=node.getBoundingClientRect();if(/auto|scroll|hidden|clip/.test(style.overflowX)){left=Math.max(left,bounds.left);right=Math.min(right,bounds.right);}if(/auto|scroll|hidden|clip/.test(style.overflowY)){top=Math.max(top,bounds.top);bottom=Math.min(bottom,bounds.bottom);}}
  return box.width>0&&box.height>0&&box.right>left&&box.left<right&&box.bottom>top&&box.top<bottom;
 }
 function position(){
  if(!popup)return;
  const box=input.getBoundingClientRect();if(!enabled()||!input.isConnected||!select.isConnected||!anchorVisible(box)){close();return;}
  const margin=8,gap=5,width=Math.min(Math.max(box.width,wrapper.dataset.kind==='account'?240:210),Math.max(1,view.innerWidth-margin*2));
  const below=view.innerHeight-box.bottom-margin-gap,above=box.top-margin-gap,useBelow=below>=Math.min(240,popup.scrollHeight)||below>=above,available=Math.max(0,useBelow?below:above);
  if(available<44){close();return;}
  popup.style.width=width+'px';popup.style.maxHeight=Math.min(240,available)+'px';list.style.maxHeight=Math.max(0,Math.min(240,available)-(notice.hidden?0:notice.getBoundingClientRect().height))+'px';
  const height=popup.getBoundingClientRect().height;
  popup.style.left=Math.max(margin,Math.min(box.left,view.innerWidth-width-margin))+'px';popup.style.top=Math.max(margin,useBelow?box.bottom+gap:box.top-height-gap)+'px';
 }
 function schedulePosition(){if(!frame)frame=view.requestAnimationFrame(()=>{frame=0;position();});}
 function markActive(){
  if(!list)return;
  Array.from(list.children).forEach((node,index)=>{const current=index===active;node.classList.toggle('is-active',current);node.setAttribute('aria-selected',String(current));});
  const node=list.children[active];if(node){input.setAttribute('aria-activedescendant',node.id);node.scrollIntoView({block:'nearest'});}else input.removeAttribute('aria-activedescendant');
 }
 function query(){return !draft&&select.value&&input.value===select.selectedOptions[0]?.label.trim()?'':input.value;}
 function render(){
  if(!popup)return;refreshOptions();const tokens=fold(query()).split(/\s+/).filter(Boolean),matches=options.filter(option=>tokens.every(token=>option.search.includes(token))),previous=shown[active]?.option;
  shown=matches.slice(0,80);active=shown.findIndex(option=>option.option===previous);list.replaceChildren();
  for(const [index,option]of shown.entries()){const node=doc.createElement('div');node.className='request-smart-option';node.id=id+'-option-'+index;node.dataset.optionIndex=String(index);node.setAttribute('role','option');node.setAttribute('aria-selected','false');node.textContent=option.label;list.append(node);}
  notice.hidden=matches.length>0&&matches.length<=80;notice.textContent=matches.length>80?`Afine la búsqueda: se muestran 80 de ${matches.length} opciones.`:matches.length?'':'No hay coincidencias. Cambie la búsqueda.';
  markActive();position();
 }
 function open(){
  if(!enabled()||!input.isConnected)return;if(popup){render();return;}
  activePicker?.close();activePicker=handle;
  popup=doc.createElement('div');popup.className='request-smart-popup';popup.setAttribute('aria-label',label);list=doc.createElement('div');list.className='request-smart-list';list.id=id+'-list';list.setAttribute('role','listbox');notice=doc.createElement('div');notice.className='request-smart-notice';notice.setAttribute('role','status');notice.setAttribute('aria-live','polite');popup.append(list,notice);doc.body.append(popup);input.setAttribute('aria-expanded','true');
  listen(popup,'pointerdown',event=>{if(event.button===0)event.preventDefault();},false,openRemovers);
  listen(popup,'click',event=>{const node=event.target.closest('.request-smart-option');if(node&&list.contains(node))choose(Number(node.dataset.optionIndex));},false,openRemovers);
  listen(doc,'pointerdown',event=>{if(!wrapper.contains(event.target)&&!popup?.contains(event.target))close();},true,openRemovers);
  listen(view,'resize',schedulePosition,false,openRemovers);listen(view,'scroll',schedulePosition,true,openRemovers);
  if(view.visualViewport){listen(view.visualViewport,'resize',schedulePosition,false,openRemovers);listen(view.visualViewport,'scroll',schedulePosition,false,openRemovers);}
  if(view.MutationObserver){openObserver=new view.MutationObserver(schedulePosition);openObserver.observe(doc.body,{childList:true,subtree:true});}
  render();
 }
 function choose(index){
  const choice=shown[index];if(!choice||!enabled())return;
  if(!select.contains(choice.option)||choice.option.disabled||choice.option.parentElement?.disabled){sync();return;}
  select.selectedIndex=Array.from(select.options).indexOf(choice.option);lastValue=select.value;draft=false;externalError='';input.value=choice.label;validity();close();input.focus({preventScroll:true});select.dispatchEvent(new view.Event('change',{bubbles:true}));
 }
 function sync(){
  if(destroyed)return;
  if(select.required){input.required=true;select.required=false;}
  if(select.validity?.customError){externalError=select.validationMessage;select.setCustomValidity('');}
  const value=select.value,selected=select.selectedOptions[0];
  if(value!==lastValue||value!==''){input.value=value&&selected?selected.label.trim():'';draft=false;lastValue=value;}
  else if(!draft)input.value='';
  input.disabled=!enabled();wrapper.dataset.disabled=String(input.disabled);validity();
  if(input.disabled||!input.isConnected){close();return;}if(popup)render();
 }
 listen(input,'input',()=>{if(!enabled()){sync();return;}draft=true;externalError='';select.value='';lastValue='';validity();try{onQuery();}finally{if(!destroyed)open();}});
 const selectCanonicalText=()=>{if(!draft&&select.value!==''&&select.selectedIndex>=0)input.select();};
 listen(input,'focus',selectCanonicalText);
 listen(input,'click',()=>{selectCanonicalText();open();});
 listen(input,'keydown',event=>{
  if(!enabled()){close();return;}
  if(event.key==='ArrowDown'||event.key==='ArrowUp'){event.preventDefault();const wasOpen=!!popup;open();if(!popup||!shown.length)return;active=active<0?(event.key==='ArrowDown'?0:shown.length-1):(active+(event.key==='ArrowDown'?1:-1)+shown.length)%shown.length;if(!wasOpen&&event.key==='ArrowDown')active=0;markActive();}
  else if(event.key==='Enter'){event.preventDefault();if(popup&&active>=0)choose(active);else if(!select.value)open();}
  else if(event.key==='Escape'&&popup){event.preventDefault();event.stopPropagation();close();}
  else if(event.key==='Tab')close();
 });
 listen(input,'blur',()=>{blurTimer=view.setTimeout(()=>{blurTimer=0;if(!wrapper.contains(doc.activeElement)&&!popup?.contains(doc.activeElement))close();},0);});
 listen(select,'change',()=>{draft=false;externalError='';sync();});
 const observer=view.MutationObserver?new view.MutationObserver(sync):null;
 observer?.observe(select,{childList:true,subtree:true,characterData:true,attributes:true,attributeFilter:['disabled','required','label','value','selected','hidden']});
 for(let parent=wrapper.parentElement;parent;parent=parent.parentElement)if(parent.tagName==='FIELDSET')observer?.observe(parent,{attributes:true,attributeFilter:['disabled']});
 function destroy(){
  if(destroyed)return;close();destroyed=true;observer?.disconnect();removers.splice(0).forEach(remove=>remove());pickers.delete(select);
  select.required=original.required;select.setCustomValidity(original.customError);for(const [name,value]of [['tabindex',original.tabindex],['aria-hidden',original.ariaHidden]]){if(value===null)select.removeAttribute(name);else select.setAttribute(name,value);}if(!original.nativeClass)select.classList.remove('request-smart-native');
  if(wrapper.parentNode)wrapper.before(select);else select.remove();wrapper.remove();
 }
 const handle={close},api={input,sync,destroy,focus(){if(!destroyed){close();input.focus({preventScroll:true});}}};pickers.set(select,api);sync();return api;
}
