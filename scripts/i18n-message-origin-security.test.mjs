import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';
import {GentiaI18n} from '../public/i18n.js';

assert.deepEqual(process.argv.slice(2),[], 'This isolated test accepts no destinations or credentials');

test('language messages require the exact non-opaque current origin before changing or persisting a locale', t=>{
 const original=Object.getOwnPropertyDescriptor(globalThis,'location');
 t.after(()=>{if(original)Object.defineProperty(globalThis,'location',original);else delete globalThis.location;});
 Object.defineProperty(globalThis,'location',{configurable:true,writable:true,value:{origin:'https://erp.example.invalid'}});
 const engine=new GentiaI18n(),calls=[];
 engine.setLocale=(...args)=>{calls.push(args);return Promise.resolve('en');};
 const data={type:'gentia:language',locale:'en'};
 for(const origin of['','null',undefined,null,'https://evil.example.invalid','http://erp.example.invalid','https://erp.example.invalid:444','https://erp.example.invalid.evil.invalid'])engine.onMessage({origin,data});
 assert.deepEqual(calls,[]);
 for(const origin of[undefined,'','null']){
  globalThis.location=origin===undefined?undefined:{origin};
  engine.onMessage({origin:'https://erp.example.invalid',data});
  engine.onMessage({origin,data});
 }
 assert.deepEqual(calls,[]);
 globalThis.location={origin:'https://erp.example.invalid'};
 engine.onMessage({origin:location.origin,data:{type:'other',locale:'en'}});
 engine.onMessage({origin:location.origin,data:{type:'gentia:language'}});
 assert.deepEqual(calls,[]);
 engine.onMessage({origin:location.origin,data});
 engine.onMessage({origin:location.origin,data:{type:'gentia:language',locale:'POR'}});
 assert.deepEqual(calls,[['en',{persist:true,broadcast:false}],['POR',{persist:true,broadcast:false}]]);
 engine.destroy();
});

test('the shell and server-injected language module both select the origin-hardened version',async()=>{
 const version='20261107-auto-template-rates';
 for(const file of['../public/index.html','../src/server.ts']){
  const text=await readFile(new URL(file,import.meta.url),'utf8');
  assert.equal(text.split('/i18n.js?v='+version).length,2);
  assert.equal(text.includes('/i18n.js?v=20261102-request-beneficiary-banks'),false);
 }
});
