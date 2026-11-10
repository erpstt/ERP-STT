import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import {safeNavigationUrl} from '../public/html-safety.js';
const source = (await readFile(new URL('../public/workspace-navigation.js',import.meta.url),'utf8')).replace(/^export (?=function\b)/gm,'');
function setup({url='https://erp.test/',pending,token='session'}={}) {
  const values = new Map(pending ? [['nexo_workspace_redirect',JSON.stringify(pending)]] : []);
  const location = new URL(url), replaced=[];
  const context = vm.createContext({URL,location,history:{state:null,replaceState:(_state,_title,path)=>replaced.push(path)},localStorage:{getItem:()=>token},sessionStorage:{getItem:key=>values.get(key)||null,removeItem:key=>values.delete(key)}});
  vm.runInContext(source,context);
  return {open:()=>context.initialWorkspace(),pending:()=>context.getPendingWorkspace(),consume:()=>context.consumePendingWorkspace(),values,replaced};
}
test('an old credit-note workspace URL opens home and removes the destination',()=>{
  const app=setup({url:'https://erp.test/?workspace=%2Fsales-note-entry.html%3Fkind%3DCREDIT'});
  assert.equal(app.open(),''); assert.deepEqual(app.replaced,['/']);
});
test('normal entry and expired handoffs open home',()=>{
  assert.equal(setup().open(),'');
  const app=setup({pending:{path:'/sales-note-entry.html?kind=CREDIT',createdAt:Date.now()-31*60*1000}});
  assert.equal(app.open(),'');assert.equal(app.pending(),null);assert.equal(app.values.size,0);
});
test('an intentional direct page waits for authorized context and is consumed once',()=>{
  const app=setup({pending:{path:'/journal-import.html',createdAt:Date.now()}});
  assert.equal(app.open(),'');assert.equal(app.pending()?.path,'/journal-import.html');
  assert.equal(app.consume()?.path,'/journal-import.html');assert.equal(app.consume(),null);assert.equal(app.values.size,0);
});
test('login keeps a direct form unopened until the session context authorizes it',()=>{
  const app=setup({token:null,pending:{path:'/sales-note-entry.html?kind=CREDIT',createdAt:Date.now()}});
  assert.equal(app.open(),'');assert.equal(app.open(),'');
  assert.equal(app.pending()?.path,'/sales-note-entry.html?kind=CREDIT');assert.equal(app.values.size,1);
});
test('external and malformed handoffs are rejected',()=>{
  for(const path of ['//external.test/','https://external.test/','javascript:alert(1)',null]){
    const app=setup({pending:{path,createdAt:Date.now()}});
    assert.equal(app.open(),'');assert.equal(app.pending(),null);assert.equal(app.values.size,0);
  }
});

test('shell links keep working after Vue replaces the session-loading root',async()=>{
  const appSource=(await readFile(new URL('../public/app.js',import.meta.url),'utf8')).replace(/^import .*;\r?\n/gm,'');
  let component,listener,restores=0,watchStopped=false;
  const location=new URL('https://erp.test/'),values=new Map(),storage={getItem:key=>values.get(key)??null,removeItem:key=>values.delete(key)},windowListeners=new Map(),mediaQueries=new Map();
  const supportedEvents=new Set(['keydown','nexo:session-ended','nexo:session-revocation-error','gentia:language-changed','storage','pagehide','nexo:open-workspace']);
  function addListener(registry,name,callback){assert.equal(typeof callback,'function');const listeners=registry.get(name)??new Set();listeners.add(callback);registry.set(name,listeners);}
  function removeListener(registry,name,callback){assert.equal(registry.get(name)?.delete(callback),true,`Remove the registered ${name} listener`);}
  const container={addEventListener:(name,callback,capture)=>{assert.equal(name,'click');assert.equal(capture,true);assert.equal(listener,undefined);listener=callback;}};
  const window={location,
    matchMedia(query){
      assert.ok(['(min-width: 900px)','(prefers-reduced-motion: reduce)','(max-width: 800px)'].includes(query),`Known shell media query: ${query}`);
      if(!mediaQueries.has(query)){const listeners=new Map();mediaQueries.set(query,{media:query,matches:query==='(min-width: 900px)',listeners,
        addEventListener(name,callback){assert.equal(name,'change');addListener(listeners,name,callback);},
        removeEventListener(name,callback){assert.equal(name,'change');removeListener(listeners,name,callback);}});}
      return mediaQueries.get(query);
    },
    addEventListener(name,callback){assert.ok(supportedEvents.has(name),`Known shell event: ${name}`);addListener(windowListeners,name,callback);},
    removeEventListener(name,callback){assert.ok(supportedEvents.has(name));removeListener(windowListeners,name,callback);},
    open(){throw Error('Internal workspace navigation must not open another window');}
  };
  const context=vm.createContext({URL,URLSearchParams,location,window,navigator:{deviceMemory:4},localStorage:storage,sessionStorage:storage,history:{state:null,replaceState(){throw Error('No redirect is pending');}},
    safeNavigationUrl:(value,base=location.origin)=>safeNavigationUrl(value,base),render(){},bankContext:()=> 'synthetic-workspace-context',
    fetch:async path=>{assert.equal(path,'/api/security/turnstile/config');return{ok:true,json:async()=>({enabled:false})};},
    document:{createElement:tag=>{assert.equal(tag,'link');return{};},head:{append(){}},getElementById:id=>{assert.equal(id,'app');return container;}},
    createApp:options=>{component=options;return {config:{compilerOptions:{}},mount(selector){assert.equal(selector,'#app');}};}});
  vm.runInContext(source,context);
  vm.runInContext(appSource,context);
  const app={...component.data(),...component.methods,workspaceUrl:'',sidebarOpen:true,currentModule:'CORE',currentSection:'CORE',expandedModules:[],modules:[{name:'Fiscal',children:['Calendario tributario']}],
    deviceToken(){},restoreSession(){restores++;},$refs:{},$forceUpdate(){},$nextTick:callback=>Promise.resolve().then(()=>callback?.()),
    $watch(read,onChange){assert.equal(typeof read,'function');assert.equal(typeof onChange,'function');assert.equal(typeof read(),'string');return()=>{watchStopped=true;};},
    $el:{addEventListener(){throw Error('Do not attach navigation to the temporary loading root');}}};
  component.mounted.call(app);
  assert.equal(windowListeners.get('nexo:open-workspace')?.size,1);
  const workspaceListener=[...windowListeners.get('nexo:open-workspace')][0];
  app.$el={}; // The authenticated view replaces the original root.
  let prevented=false;
  const link={href:'https://erp.test/journal-import.html',target:'',hasAttribute:()=>false,getAttribute:()=>'/journal-import.html'};
  listener({target:{closest:()=>link},preventDefault(){prevented=true;}});
  assert.equal(prevented,true);
  assert.equal(app.workspaceUrl,'/journal-import.html');
  assert.equal(app.sidebarOpen,false);
  assert.equal(restores,1); // Opening the page must not start another session restore.
  workspaceListener({detail:{url:'/tax-calendar.html?notifications=1',module:'Fiscal',section:'Calendario tributario'}});
  assert.equal(app.workspaceUrl,'/tax-calendar.html?notifications=1');
  assert.equal(app.currentModule,'Fiscal');
  assert.equal(app.currentSection,'Calendario tributario');
  assert.deepEqual(app.expandedModules,['Fiscal']);
  assert.equal(restores,1); // La campana tampoco restaura ni recarga la sesión.
  await new Promise(resolve=>setImmediate(resolve)); // Complete the synthetic Turnstile config request.
  component.beforeUnmount.call(app);
  assert.equal(watchStopped,true);
  // Workspace delegation is attached once to the persistent shell, while view
  // lifecycle listeners and media subscriptions are released on unmount.
  for(const [name,listeners] of windowListeners)assert.equal(listeners.size,name==='nexo:open-workspace'?1:0);
  for(const query of mediaQueries.values())for(const listeners of query.listeners.values())assert.equal(listeners.size,0);
});
