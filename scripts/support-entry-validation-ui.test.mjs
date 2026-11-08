import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import ts from 'typescript';
import {safeHttpUrl,configureAttachmentLink} from '../public/html-safety.js';
import {assertIsolatedTestArgs} from './lib/migration-preview.mjs';
assertIsolatedTestArgs();

const version='20261104-support-write-validation';
const bankEntryVersion='20261105-banking-functional';
const supplierEntryVersion='20261105-purchasing-functional-review';
const supplierInvoiceEntryVersion='20261108-supplier-invoice-duplicate';
const journalEntryVersion='20261104-journal-payment-route-id-guard';
const screens=[
 {name:'journal-entry'}, {name:'supplier-invoice-entry'}, {name:'supplier-note-entry'},
 {name:'bank-check-entry',script:'bank-check-entry-main'}, {name:'bank-deposit-entry'}
];
const bankUiSource=(await readFile(new URL('../public/bank-ui.js',import.meta.url),'utf8')).replace(/^export /gm,'');
function handler(sourceFile,id,event){
 const found=[];
 function visit(node){
  if(ts.isBinaryExpression(node)&&node.operatorToken.kind===ts.SyntaxKind.EqualsToken&&ts.isPropertyAccessExpression(node.left)&&node.left.name.text===event){
   const target=node.left.expression;
   if(ts.isCallExpression(target)&&ts.isIdentifier(target.expression)&&target.expression.text==='$'&&target.arguments.length===1&&ts.isStringLiteral(target.arguments[0])&&target.arguments[0].text===id)found.push(node.right.getText(sourceFile));
  }
  ts.forEachChild(node,visit);
 }
 visit(sourceFile);assert.equal(found.length,1,'Exactly one real handler must be exercised: '+id+'.'+event);
 return found[0];
}
for(const screen of screens){
 screen.source=await readFile(new URL('../public/'+(screen.script??screen.name)+'.js',import.meta.url),'utf8');
 screen.html=await readFile(new URL('../public/'+screen.name+'.html',import.meta.url),'utf8');
 const parsed=ts.createSourceFile(screen.name+'.js',screen.source,ts.ScriptTarget.Latest,true,ts.ScriptKind.JS);
 assert.equal(parsed.parseDiagnostics.length,0,'The real entry script must parse');
 screen.fileHandler=handler(parsed,'supportFiles','onchange');
 screen.linkHandler=handler(parsed,'addSupportLink','onclick');
 if(screen.name.startsWith('bank-')){
  const functions=[];function visit(node){if(ts.isFunctionDeclaration(node)&&node.name?.text==='syncSave')functions.push(node);ts.forEachChild(node,visit);}visit(parsed);
  assert.equal(functions.length,1,'Bank control locking must use the real entry implementation');
  screen.syncSave=functions[0].getText(parsed);
 }
}
function fixture(screen){
 const nodes=new Map(),items=[],status=[];
 const banking=screen.name.startsWith('bank-');
 let constructions=0,reads=0,renders=0,io=0;
 const node=id=>{
  if(!nodes.has(id))nodes.set(id,{value:'',textContent:'',files:[],dataset:{},disabled:false});
  return nodes.get(id);
 };
 class FileReader{
  constructor(){constructions++;}
  readAsDataURL(file){
   reads++;
   // Synthetic browser result; these tests exercise File.size and handler order,
   // while the separate server tests verify actual decoded byte lengths.
   this.result=`data:${file.type||'application/octet-stream'};base64,QQ==`;
   this.onload();
  }
 }
 const forbidden=()=>{io++;assert.fail('An attachment entry handler attempted external IO');};
 const storage={getItem(key){assert.ok(['nexo_token','nexo_company','nexo_role','nexo_device_token'].includes(key));return({'nexo_token':'synthetic-token','nexo_company':'1','nexo_role':'1','nexo_device_token':'synthetic-device'})[key];}};
 const context=vm.createContext({URL,safeHttpUrl,FileReader,$:node,supportItems:items,supports:items,viewMode:false,invoiceSaving:false,invoiceUploading:0,noteSaving:false,noteUploading:0,syncInvoiceControls(){},syncNoteControls(){},
  saving:false,uploading:false,savedResult:null,detailReady:true,id:null,depositId:null,
  data:{options:{access:{canCreate:true,canEdit:true}},depositOptions:{access:{canCreate:true,canEdit:true}}},retrySupports:node('retrySupports'),
  document:{querySelector(selector){assert.equal(selector,'main');return{querySelectorAll(selector){assert.equal(selector,'input,select,textarea,button');return[...nodes.values()];}};}},
  window:{NexoSessionRenewal:{current:()=>({generation:'synthetic-generation'})}},
  renderSupports:()=>{renders++;},hasPendingSupportChanges:()=>items.some(item=>item._new),invoiceId:null,
  setSupportStatus:(...value)=>status.push(value),api:forbidden,fetch:forbidden,
  localStorage:banking?storage:{getItem:forbidden},sessionStorage:banking?storage:{getItem:forbidden}});
 if(banking){new vm.Script(bankUiSource+'\n'+screen.syncSave+'\nconst entryContext=bankContext();').runInContext(context,{timeout:1000});}
 const addLink=new vm.Script('('+screen.linkHandler+')').runInContext(context,{timeout:1000});
 const changeFiles=new vm.Script('('+screen.fileHandler+')').runInContext(context,{timeout:1000});
 return{items,node,status,counts:()=>({constructions,reads,renders,io}),
  add(url,name='Synthetic receipt'){node('supportLinkUrl').value=url;node('supportLinkName').value=name;return addLink();},
  async upload(files){const target=node('supportFiles');target.files=files;target.value='synthetic-selection';await changeFiles({target});}
 };
}

for(const screen of screens){
 test(screen.name+': new HTTP, credentialed, backslash and control-containing links append nothing',()=>{
  const urls=[
   'http://example.invalid/receipt','//example.invalid/receipt','javascript:alert(1)',
   'https://user@example.invalid/receipt','https://user:password@example.invalid/receipt',
   'https://example.invalid\\@other.invalid/receipt','https://example.invalid/a b',
   'https://example.invalid/\nreceipt','https://example.invalid/\rreceipt','https://example.invalid/\treceipt',
   'https://example.invalid/receipt\n','https://example.invalid/receipt\r\n','https://example.invalid/receipt\t',
   'https://example.invalid/\u0000receipt','https://example.invalid/\u007freceipt','https://example.invalid/\u0085receipt'
  ];
  for(const url of urls){
   const f=fixture(screen);f.add(url);
   assert.equal(f.items.length,0);assert.match(f.node('error').textContent,/https:\/\//i);
   assert.deepEqual(f.counts(),{constructions:0,reads:0,renders:0,io:0});
  }
 });

 test(screen.name+': new valid HTTPS links retain canonical href and hostname fallback',()=>{
  const f=fixture(screen);f.add(' HTTPS://EXAMPLE.INVALID:443/receipt?source=synthetic#page ','');
  assert.equal(f.items.length,1);assert.equal(f.items[0].support_type,'Enlace');
  assert.equal(f.items[0].support_url,'https://example.invalid/receipt?source=synthetic#page');
  assert.equal(f.items[0].display_name,'example.invalid');assert.equal(f.counts().renders,1);assert.equal(f.counts().io,0);
 });

 test(screen.name+': empty or oversized files show feedback without constructing FileReader',async()=>{
  for(const size of[0,5*1024*1024+1]){
   const f=fixture(screen);await f.upload([{name:'synthetic.txt',type:'text/plain',size}]);
   assert.equal(f.items.length,0);assert.equal(f.counts().constructions,0);assert.equal(f.counts().reads,0);assert.equal(f.counts().io,0);
   assert.match(f.node('error').textContent,/datos/);assert.match(f.node('error').textContent,/5 MB/);
  }
 });

 test(screen.name+': valid files keep browser metadata, five-MiB boundary and empty-MIME octet fallback',async()=>{
  const f=fixture(screen);
  const files=[
   {name:'synthetic.bin',type:'',size:1},
   {name:'synthetic.txt',type:'text/plain',size:5*1024*1024},
   {name:'synthetic.future',type:'application/vnd.synthetic.future+zip',size:1}
  ];
  await f.upload(files);assert.equal(f.items.length,3);assert.equal(f.counts().constructions,3);assert.equal(f.counts().reads,3);assert.equal(f.counts().io,0);
  for(let index=0;index<files.length;index++){
   const actual=f.items[index],original=files[index],mime=original.type||'application/octet-stream';
   assert.equal(actual.support_type,'Archivo');assert.equal(actual.display_name,original.name);assert.equal(actual.file_name,original.name);
   assert.equal(actual.file_size,original.size);assert.equal(actual.mime_type,mime);assert.equal(actual.file_data,`data:${mime};base64,QQ==`);
  }
 });

 test(screen.name+': mixed selections skip invalid files and read only the valid item',async()=>{
  const f=fixture(screen);await f.upload([
   {name:'empty.txt',type:'text/plain',size:0},
   {name:'oversized.txt',type:'text/plain',size:5*1024*1024+1},
   {name:'valid.txt',type:'text/plain',size:1}
  ]);
  assert.equal(f.items.length,1);assert.equal(f.items[0].file_name,'valid.txt');
  assert.equal(f.counts().constructions,1);assert.equal(f.counts().reads,1);assert.equal(f.counts().io,0);
 });
}

test('each own HTML and the bank-check wrapper point at the new entry-handler version',async()=>{
 for(const screen of screens){
  const scripts=[...screen.html.matchAll(/<script\b[^>]*\bsrc="([^"]+)"/g)].map(match=>match[1]);
  const expectedVersion=screen.name==='bank-check-entry'?'20261106-bank-check-beneficiary':screen.name==='bank-deposit-entry'?bankEntryVersion:screen.name==='supplier-invoice-entry'?supplierInvoiceEntryVersion:screen.name==='supplier-note-entry'?supplierEntryVersion:screen.name==='journal-entry'?journalEntryVersion:version;
  assert.equal(scripts.filter(src=>src==='/'+screen.name+'.js?v='+expectedVersion).length,1);
 }
 const wrapper=await readFile(new URL('../public/bank-check-entry.js',import.meta.url),'utf8');
 assert.ok(wrapper.includes("await import('./bank-check-entry-main.js?v="+bankEntryVersion+"')"));
});

test('the unchanged real history-link helper still renders safe HTTP attachments',()=>{
 const attributes=new Map();
 const link={removeAttribute(name){attributes.delete(name);}};
 assert.equal(configureAttachmentLink(link,{support_type:'Enlace',support_url:'http://example.invalid/historical'}),true);
 assert.equal(link.href,'http://example.invalid/historical');assert.equal(link.hidden,false);assert.equal(link.rel,'noopener noreferrer');
 assert.equal(safeHttpUrl('https://user:password@example.invalid/'),'');
});
