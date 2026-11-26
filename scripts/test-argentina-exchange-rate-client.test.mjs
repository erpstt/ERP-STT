import assert from 'node:assert/strict';
import {test} from 'node:test';
import {consultarHistoricoBna,obtenerTipoDeCambioAR} from '../dist/modules/configuration-catalogs/services/argentina-exchange-rate.service.js';

const row=(date='25/11/2026',sell='1.625,0000')=>`<tr><td>Dolar U.S.A</td><td>1.575,0000</td><td>${sell}</td><td>${date}</td></tr>`;
test('recovers a temporary 403 using bounded backoff and the dated official endpoint',async()=>{
 let calls=0;const waits=[];
 const html=await consultarHistoricoBna('2026-11-25',{fetch:async(url,options)=>{
  calls++;assert.equal(new URL(url).origin,calls===2?'https://bna.com.ar':'https://www.bna.com.ar');assert.equal(new URL(url).searchParams.get('fecha'),'25/11/2026');assert.equal(new URL(url).searchParams.get('id'),'billetes');assert.ok(options.signal instanceof AbortSignal);
  return calls===1?new Response('private error page',{status:403}):new Response(row());
 },wait:async ms=>waits.push(ms)});
 assert.equal(calls,2);assert.deepEqual(waits,[750]);assert.match(html,/1.625,0000/);
});
test('persistent HTTP errors and connection failures stop at three attempts without exposing response contents',async()=>{
 for(const network of [false,true]){
  let calls=0;const waits=[];
  await assert.rejects(consultarHistoricoBna('2026-11-25',{fetch:async()=>{calls++;if(network)throw Error('private network detail');return new Response('private error page',{status:403});},wait:async ms=>waits.push(ms)}),error=>/3 intentos/.test(error.message)&&!error.message.includes('private')&&(network||/HTTP 403/.test(error.message)));
  assert.equal(calls,3);assert.deepEqual(waits,[750,1500]);
 }
});
test('permanent 404 and invalid dates do not retry',async()=>{
 let calls=0;
 await assert.rejects(consultarHistoricoBna('2026-11-25',{fetch:async()=>{calls++;return new Response('secret',{status:404});},wait:async()=>assert.fail('Unexpected retry')}),/estado 404/);assert.equal(calls,1);
 await assert.rejects(consultarHistoricoBna('2026-02-30',{fetch:async()=>assert.fail('Unexpected request')}),/fecha efectiva/);
});
test('selects only the requested dollar-bill date and preserves direct/inverse values',async t=>{
 let calls=0;
 t.mock.method(globalThis,'fetch',async()=>{calls++;return new Response(`<table>${row('24/11/2026','1.615,0000')}${row('26/11/2026','9.999,0000')}${row()}</table>`);});
 const direct=await obtenerTipoDeCambioAR('USD','ARS','2026-11-25');
 assert.equal(direct.fechaFuente,'2026-11-25');assert.equal(direct.tipoCambio,1625);assert.equal(direct.tasaCompra,1575);
 assert.equal((await obtenerTipoDeCambioAR('ARS','USD','2026-11-25')).tipoCambio,1/1625);
 assert.equal((await obtenerTipoDeCambioAR('USD','USD','2026-11-25')).tipoCambio,1);assert.equal(calls,2);
});
test('retains the explicit seven-day fallback and never assigns a future quotation',async t=>{
 let calls=0;
 t.mock.method(globalThis,'fetch',async()=>{calls++;return new Response(`<table>${row('24/11/2026','1.615,0000')}${row('26/11/2026','9.999,0000')}</table>`);});
 const rate=await obtenerTipoDeCambioAR('USD','ARS','2026-11-25');assert.equal(rate.fechaEfectiva,'2026-11-25');assert.equal(rate.fechaFuente,'2026-11-24');assert.equal(rate.tipoCambio,1615);assert.equal(calls,2);
});
