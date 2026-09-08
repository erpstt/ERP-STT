import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
const source = await readFile(new URL('../public/journal-import.js',import.meta.url),'utf8');
function setup(responses) {
  class Element { constructor(){ this.children=[]; this.files=[]; this.disabled=false; this.hidden=false; this.textContent=''; } append(child){this.children.push(child);} replaceChildren(...children){this.children=children;} }
  const ids = Object.fromEntries(['company','file','validate','import','message','errors','preview','result','rows','saved'].map(id=>[id,new Element()]));
  const storage = { getItem:key=>({nexo_company:'1',nexo_company_name:'Empresa prueba',nexo_token:'test',nexo_device_token:'device'})[key]||null };
  const calls=[];
  const context = vm.createContext({ document:{getElementById:id=>ids[id],createElement:()=>new Element()},localStorage:storage,sessionStorage:storage,TextDecoder, fetch:async(url,options)=>{calls.push(JSON.parse(options.body)); return {ok:true,json:async()=>responses.shift()};} });
  vm.runInContext(source,context);
  ids.file.files=[{name:'asientos.csv',size:10,arrayBuffer:async()=>new TextEncoder().encode('csv-test').buffer}];
  return {ids,calls};
}
const preview={valid:true,created:0,entries:[{reference:'A',date:'2026-09-08',currency:'CRC',lines:2,debit:10,credit:10}],errors:[]};
test('preview precedes import, then records are shown and import is disabled',async()=>{
  const {ids,calls}=setup([preview,{valid:true,created:1,entries:[{reference:'A',journalNumber:'ASI-001'}],errors:[]}]);
  await ids.validate.onclick(); assert.equal(ids.import.disabled,false); assert.equal(ids.rows.children.length,1);
  await ids.import.onclick(); assert.equal(calls[0].preview,true); assert.equal(calls[1].preview,false); assert.equal(calls[1].csv,calls[0].csv);
  assert.equal(ids.import.disabled,true); assert.equal(ids.result.hidden,false); assert.match(ids.message.textContent,/1 asientos registrados/);
});
test('validation errors use text and prevent importing',async()=>{
  const {ids,calls}=setup([{valid:false,created:0,entries:[],errors:[{row:2,reference:'<script>',message:'Cuenta inválida'}]}]);
  await ids.validate.onclick(); assert.equal(ids.import.disabled,true); assert.match(ids.errors.children[0].textContent,/<script>/);
  await ids.import.onclick(); assert.equal(calls.length,1);
});
test('changing files invalidates preview and duplicate receipts disable import',async()=>{
  const {ids}=setup([preview,{valid:true,alreadyImported:true,created:1,entries:[{reference:'A',journalNumber:'ASI-001'}],errors:[]}]);
  await ids.validate.onclick(); ids.file.onchange(); assert.equal(ids.import.disabled,true); assert.equal(ids.preview.hidden,true);
  await ids.validate.onclick(); assert.equal(ids.import.disabled,true); assert.match(ids.message.textContent,/No se crearon duplicados/);
});
