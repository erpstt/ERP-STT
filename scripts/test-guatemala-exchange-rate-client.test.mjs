import assert from 'node:assert/strict';
import {test} from 'node:test';
import {consultarBanguat,parseBanguatRate} from '../dist/modules/configuration-catalogs/services/banguat-client.js';
import {obtenerTipoDeCambioGT} from '../dist/modules/configuration-catalogs/services/guatemala-exchange-rate.service.js';

const record=(date='25/11/2026',sell='7.64778',currency='2')=>`<Var><moneda>${currency}</moneda><fecha>${date}</fecha><venta>${sell}</venta><compra>7.64778</compra></Var>`;
const xml=records=>`<TipoCambioRangoResponse><TipoCambioRangoResult><Vars>${records}</Vars></TipoCambioRangoResult></TipoCambioRangoResponse>`;

test('matches the requested date and USD record, not an older date or another currency',()=>{
 const data=xml(record('24/11/2026','7.6')+record('25/11/2026','99','3')+record());
 assert.equal(parseBanguatRate(data,'2026-11-25').tasaVenta,7.64778);
 assert.throws(()=>parseBanguatRate(xml(record('24/11/2026')),'2026-11-25'),/fecha solicitada/);
 for(const value of ['0','-2','NaN','Infinity',''])assert.throws(()=>parseBanguatRate(xml(record('25/11/2026',value)),'2026-11-25'),/inválida/);
});
test('recovers from a network failure using the other official HTTPS host and bounded backoff',async()=>{
 const calls=[],waits=[];
 const result=await consultarBanguat('2026-11-25',{fetch:async(url,options)=>{
  calls.push({url,options});
  if(calls.length===1)throw Object.assign(Error('fetch failed'),{cause:{code:'UND_ERR_SOCKET'}});
  return new Response(xml(record()));
 },wait:async ms=>waits.push(ms)});
 assert.equal(result.tasaVenta,7.64778);
 assert.deepEqual(calls.map(c=>new URL(c.url).host),['www.banguat.gob.gt','banguat.gob.gt']);
 assert.deepEqual(waits,[1000]);
 assert.match(calls[1].options.body,/<fechainit>25\/11\/2026<\/fechainit>/);
 assert.equal(calls[1].options.method,'POST');
 assert.ok(calls.every(c=>c.options.signal instanceof AbortSignal&&c.url.startsWith('https://')));
});
test('retries temporary HTTP failures but stops after three attempts and reports the network cause safely',async()=>{
 let calls=0;const waits=[];
 await assert.rejects(consultarBanguat('2026-11-25',{fetch:async()=>{calls++;if(calls===1)return new Response('Unavailable',{status:503});throw Object.assign(Error('fetch failed SECRET'),{cause:{code:'UND_ERR_CONNECT_TIMEOUT',message:'SECRET'}});},wait:async ms=>waits.push(ms)}),error=>/3 intentos/.test(error.message)&&/UND_ERR_CONNECT_TIMEOUT/.test(error.message)&&!error.message.includes('SECRET'));
 assert.equal(calls,3);assert.deepEqual(waits,[1000,3000]);
});
test('does not retry a permanent HTTP error, invalid date, stale data or invalid rate',async()=>{
 for(const response of [()=>new Response('Bad request',{status:400}),()=>new Response(xml(record('24/11/2026'))),()=>new Response(xml(record('25/11/2026','0')))]){
  let calls=0;await assert.rejects(consultarBanguat('2026-11-25',{fetch:async()=>{calls++;return response();},wait:async()=>assert.fail('Unexpected retry')}));assert.equal(calls,1);
 }
 await assert.rejects(consultarBanguat('2026-02-30',{fetch:async()=>assert.fail('Unexpected request')}),/fecha efectiva/);
});
test('the existing service preserves direct, inverse and same-currency behavior',async()=>{
 const original=globalThis.fetch;let calls=0;
 globalThis.fetch=async()=>{calls++;return new Response(xml(record()));};
 try{
  assert.equal((await obtenerTipoDeCambioGT('USD','GTQ','2026-11-25')).tipoCambio,7.64778);
  assert.equal((await obtenerTipoDeCambioGT('GTQ','USD','2026-11-25')).tipoCambio,1/7.64778);
  assert.equal((await obtenerTipoDeCambioGT('USD','USD','2026-11-25')).tipoCambio,1);
  assert.equal(calls,2);
 }finally{globalThis.fetch=original;}
});
