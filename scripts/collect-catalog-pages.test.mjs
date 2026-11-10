import assert from 'node:assert/strict';
import {test} from 'node:test';
import {collectCatalogPages} from '../dist/core/database/collect-catalog-pages.js';

function fixture(rows,{maximum=500,withCount=true,failOffset=null,mutatePage=null,countFor=()=>rows.length}={}){
  const calls=[];
  const load=async(query,init,observe)=>{
    const url=new URL(query,'https://catalog.example.invalid'),offset=Number(url.searchParams.get('offset')),limit=Number(url.searchParams.get('limit'));
    assert.equal(new Headers(init.headers).get('prefer'),'count=exact');calls.push({offset,limit,query});
    if(offset===failOffset){observe(new Response('PRIVATE_SQL',{status:500}));throw Error('PRIVATE_SQL');}
    const page=rows.slice(offset,offset+Math.min(maximum,limit)),headers=withCount?{'Content-Range':page.length?`${offset}-${offset+page.length-1}/${countFor(offset)}`:`*/${countFor(offset)}`}:{},response=Response.json(page,{headers});
    observe(response);return mutatePage?mutatePage(page,offset):page;
  };
  return{calls,load};
}
const records=count=>Array.from({length:count},(_,index)=>({id:index+1,name:`Registro ${index+1}`}));
const query='?select=id,name&order=id.asc&subsidiary_id=eq.9';
const incomplete=error=>error.status===503&&error.message==='No fue posible cargar el catálogo completo. Reintente la consulta.';

test('a complete short or empty collection needs one provider request when exact count is present',async()=>{
  const short=fixture(records(7));assert.equal((await collectCatalogPages('id',query,short.load)).length,7);assert.equal(short.calls.length,1);
  const empty=fixture([]);assert.deepEqual(await collectCatalogPages('id',query,empty.load),[]);assert.equal(empty.calls.length,1);
});
test('all rows beyond the provider default limit are collected in the existing order',async()=>{
  const rows=records(1501),f=fixture(rows);assert.deepEqual(await collectCatalogPages('id',query,f.load),rows);
  assert.deepEqual(f.calls.map(call=>call.offset),[0,500,1000,1500]);
  assert.ok(f.calls.every(call=>call.query.startsWith(query+'&limit=500&offset=')));
});
test('a configured provider maximum below the requested limit does not truncate a short response',async()=>{
  const rows=records(1205),f=fixture(rows,{maximum:100});assert.deepEqual(await collectCatalogPages('id',query,f.load),rows);
  assert.deepEqual(f.calls.map(call=>call.offset),Array.from({length:13},(_,index)=>index*100));
});
test('without Content-Range a short page is followed until an empty page confirms completion',async()=>{
  const rows=records(7),f=fixture(rows,{maximum:3,withCount:false});assert.deepEqual(await collectCatalogPages('id',query,f.load),rows);
  assert.deepEqual(f.calls.map(call=>call.offset),[0,3,6,7]);
});
test('a failed later page rejects the collection without publishing partial rows or provider details',async()=>{
  const f=fixture(records(1001),{failOffset:500});await assert.rejects(collectCatalogPages('id',query,f.load),incomplete);assert.equal(f.calls.length,2);
});
test('a duplicate primary key or repeated provider page is an error rather than a silent deduplication',async()=>{
  const f=fixture(records(1001),{mutatePage:(page,offset)=>offset===500?[{id:1},...page.slice(1)]:page});
  await assert.rejects(collectCatalogPages('id',query,f.load),incomplete);assert.equal(f.calls.length,2);
});
test('invalid response shapes and missing primary keys reject the entire load',async()=>{
  const object=fixture(records(1),{mutatePage:()=>({rows:[]})});await assert.rejects(collectCatalogPages('id',query,object.load),incomplete);
  const missing=fixture(records(1),{mutatePage:()=>[{name:'Sin ID'}]});await assert.rejects(collectCatalogPages('id',query,missing.load),incomplete);
});
test('a changing exact total or an early empty page cannot be reported as complete',async()=>{
  const changed=fixture(records(1001),{countFor:offset=>offset===0?1001:1002});await assert.rejects(collectCatalogPages('id',query,changed.load),incomplete);
  const empty=fixture(records(1001),{mutatePage:(page,offset)=>offset?[]:page});await assert.rejects(collectCatalogPages('id',query,empty.load),incomplete);
});
test('an invalid range is rejected instead of hiding inconsistent pagination metadata',async()=>{
  await assert.rejects(collectCatalogPages('id',query,async(_query,_init,observe)=>{observe(Response.json([{id:1}],{headers:{'Content-Range':'4-4/1'}}));return[{id:1}];}),incomplete);
});
test('authorization failures keep their status while private provider bodies remain hidden',async()=>{
  for(const status of [401,403])await assert.rejects(collectCatalogPages('id',query,async(_query,_init,observe)=>{observe(new Response('PRIVATE_SQL',{status}));throw Error('PRIVATE_SQL');}),error=>error.status===status&&!error.message.includes('PRIVATE'));
});
