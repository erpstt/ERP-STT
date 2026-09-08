import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
const source = (await readFile(new URL('../public/workspace-navigation.js',import.meta.url),'utf8')).replace('export function','function');
function setup({url='https://erp.test/',pending,token='session'}={}) {
  const values = new Map(pending ? [['nexo_workspace_redirect',JSON.stringify(pending)]] : []);
  const location = new URL(url), replaced=[];
  const context = vm.createContext({URL,location,history:{state:null,replaceState:(_state,_title,path)=>replaced.push(path)},localStorage:{getItem:()=>token},sessionStorage:{getItem:key=>values.get(key)||null,removeItem:key=>values.delete(key)}});
  vm.runInContext(source,context);
  return {open:()=>context.initialWorkspace(),values,replaced};
}
test('an old credit-note workspace URL opens home and removes the destination',()=>{
  const app=setup({url:'https://erp.test/?workspace=%2Fsales-note-entry.html%3Fkind%3DCREDIT'});
  assert.equal(app.open(),''); assert.deepEqual(app.replaced,['/']);
});
test('normal entry and expired handoffs open home',()=>{
  assert.equal(setup().open(),'');
  assert.equal(setup({pending:{path:'/sales-note-entry.html?kind=CREDIT',createdAt:Date.now()-60000}}).open(),'');
});
test('an intentional direct page opens once within an authenticated session',()=>{
  const app=setup({pending:{path:'/journal-import.html',createdAt:Date.now()}});
  assert.equal(app.open(),'/journal-import.html'); assert.equal(app.open(),'');
});
test('login never inherits a pending form',()=>{
  const app=setup({token:null,pending:{path:'/sales-note-entry.html?kind=CREDIT',createdAt:Date.now()}});
  assert.equal(app.open(),''); assert.equal(app.values.size,0);
});
test('external and malformed handoffs are rejected',()=>{
  for(const path of ['//external.test/','https://external.test/','javascript:alert(1)',null]) assert.equal(setup({pending:{path,createdAt:Date.now()}}).open(),'');
});

test('shell links keep working after Vue replaces the session-loading root',async()=>{
  const appSource=(await readFile(new URL('../public/app.js',import.meta.url),'utf8')).replace(/^import .*;\r?\n/gm,'');
  let component,listener,restores=0;
  const container={addEventListener:(name,callback)=>{assert.equal(name,'click');listener=callback;}};
  const context=vm.createContext({URL,location:new URL('https://erp.test/'),document:{createElement:()=>({}),head:{append(){}},getElementById:id=>{assert.equal(id,'app');return container;}},createApp:options=>{component=options;return {mount(){}};}});
  vm.runInContext(appSource,context);
  const app={...component.methods,workspaceUrl:'',sidebarOpen:true,deviceToken(){},restoreSession(){restores++;},$el:{addEventListener(){throw Error('Do not attach navigation to the temporary loading root');}}};
  component.mounted.call(app);
  app.$el={}; // The authenticated view replaces the original root.
  let prevented=false;
  const link={href:'https://erp.test/journal-import.html',target:'',hasAttribute:()=>false,getAttribute:()=>'/journal-import.html'};
  listener({target:{closest:()=>link},preventDefault(){prevented=true;}});
  assert.equal(prevented,true);
  assert.equal(app.workspaceUrl,'/journal-import.html');
  assert.equal(app.sidebarOpen,false);
  assert.equal(restores,1); // Opening the page must not start another session restore.
});
