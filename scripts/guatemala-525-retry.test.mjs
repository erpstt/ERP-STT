import {test} from 'node:test';
import assert from 'node:assert/strict';
import {consultarBanguat} from '../dist/modules/configuration-catalogs/services/banguat-client.js';
const xml='<Vars><Var><moneda>2</moneda><fecha>26/11/2026</fecha><venta>7.64526</venta><compra>7.64526</compra></Var></Vars>';
test('525 retries with official alternate host and preserves dated rate',async()=>{const calls=[],waits=[];const rate=await consultarBanguat('2026-11-26',{fetch:async(url)=>{calls.push(url);return calls.length===1?new Response('',{status:525}):new Response(xml)},wait:async ms=>waits.push(ms)});assert.equal(calls.length,2);assert.equal(new URL(calls[1]).hostname,'banguat.gob.gt');assert.deepEqual(waits,[1000]);assert.equal(rate.tasaVenta,7.64526);});
test('persistent 525 stops after three attempts',async()=>{let calls=0;await assert.rejects(consultarBanguat('2026-11-26',{fetch:async()=>{calls++;return new Response('',{status:525})},wait:async()=>{}}),/3 intentos/);assert.equal(calls,3);});
test('business errors and wrong-date responses are not retried',async()=>{for(const response of [()=>new Response('',{status:400}),()=>new Response(xml.replaceAll('26/11/2026','25/11/2026'))]){let calls=0;await assert.rejects(consultarBanguat('2026-11-26',{fetch:async()=>{calls++;return response()},wait:async()=>{}}));assert.equal(calls,1);}});
