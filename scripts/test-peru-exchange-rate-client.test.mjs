import assert from 'node:assert/strict';
import {test} from 'node:test';

const {consultarSeriesSbs,obtenerTipoDeCambioPE}=await import('../dist/modules/configuration-catalogs/services/peru-exchange-rate.service.js');

const periods=(rows=[{name:'27.Oct.26',values:['3.446','3.452']}])=>JSON.stringify({
  config:{title:'Tipo de cambio'},periods:rows
});

test('recupera un challenge HTML mediante espera progresiva sin exponer su contenido',async()=>{
  const waits=[];let calls=0;
  const result=await consultarSeriesSbs('2026-10-22','2026-10-29',{
    fetch:async()=>++calls===1
      ?new Response('<!DOCTYPE html><script src="/_Incapsula_Resource"></script>',{status:200,headers:{'Content-Type':'text/html'}})
      :new Response(periods(),{status:200,headers:{'Content-Type':'text/html'}}),
    wait:async ms=>waits.push(ms),random:()=>0
  });
  assert.equal(calls,2);
  assert.deepEqual(waits,[750]);
  assert.equal(result.periods[0].values[1],'3.452');
});

test('reintenta un JSON con estructura inválida antes de aceptar períodos oficiales',async()=>{
  const waits=[];let calls=0;
  const result=await consultarSeriesSbs('2026-10-22','2026-10-29',{
    fetch:async()=>{calls++;if(calls===1)return new Response('{"periods":[null]}');if(calls===2)return new Response('{"periods":[{"name":"29.Oct.26","values":[]}]}');return new Response(periods());},
    wait:async ms=>waits.push(ms),random:()=>0
  });
  assert.equal(result.periods.length,1);
  assert.equal(calls,3);
  assert.deepEqual(waits,[750,1500]);
});

test('reintenta 503 y 429, limita Retry-After a 30 segundos y luego procesa la serie',async()=>{
  const waits=[];let calls=0;
  const result=await consultarSeriesSbs('2026-10-22','2026-10-29',{
    fetch:async()=>{
      calls++;
      if(calls===1)return new Response('indisponible',{status:503});
      if(calls===2)return new Response('limite',{status:429,headers:{'Retry-After':'90'}});
      return new Response(periods());
    },
    wait:async ms=>waits.push(ms),random:()=>0
  });
  assert.equal(result.periods.length,1);
  assert.equal(calls,3);
  assert.deepEqual(waits,[750,30000]);
});

test('reintenta timeout o error de red sin revelar el detalle interno',async()=>{
  const waits=[];let calls=0;
  const result=await consultarSeriesSbs('2026-10-22','2026-10-29',{
    fetch:async(_url,init)=>{calls++;assert.ok(init.signal instanceof AbortSignal);if(calls===1)throw new DOMException('socket privado','AbortError');return new Response(periods());},
    wait:async ms=>waits.push(ms),random:()=>0,timeoutMs:10
  });
  assert.equal(result.periods.length,1);
  assert.equal(calls,2);
  assert.deepEqual(waits,[750]);
});

test('agota los intentos ante HTML sin incluir el cuerpo de la respuesta',async()=>{
  const waits=[];let calls=0,caught;
  try{
    await consultarSeriesSbs('2026-10-22','2026-10-29',{
      fetch:async()=>{calls++;return new Response('<html>challenge-confidencial</html>');},
      wait:async ms=>waits.push(ms),random:()=>0
    });
  }catch(error){caught=error;}
  assert.ok(caught instanceof Error);
  assert.match(caught.message,/JSON válida después de 5 intentos/);
  assert.doesNotMatch(caught.message,/challenge-confidencial/);
  assert.equal(calls,5);
  assert.deepEqual(waits,[750,1500,3000,6000]);
});

test('un 4xx permanente falla inmediatamente y no expone el cuerpo',async()=>{
  let calls=0,caught;
  try{
    await consultarSeriesSbs('2026-10-22','2026-10-29',{
      fetch:async()=>{calls++;return new Response('detalle-secreto',{status:404});},
      wait:async()=>assert.fail('No debe reintentar un 404.')
    });
  }catch(error){caught=error;}
  assert.ok(caught instanceof Error);
  assert.match(caught.message,/estado 404/);
  assert.doesNotMatch(caught.message,/detalle-secreto/);
  assert.equal(calls,1);
});

test('mantiene el fallback oficial de siete días y usa la última venta válida',async t=>{
  t.mock.method(globalThis,'fetch',async()=>new Response(periods([
    {name:'26.Oct.26',values:['3.436','3.446']},
    {name:'27.Oct.26',values:['3.446','3.452']},
    {name:'28.Oct.26',values:['n.d.','n.d.']},
    {name:'29.Oct.26',values:['n.d.','n.d.']}
  ])));
  const result=await obtenerTipoDeCambioPE('USD','PEN','2026-10-29');
  assert.equal(result.fechaFuente,'2026-10-27');
  assert.equal(result.tasaCompra,3.446);
  assert.equal(result.tasaVenta,3.452);
  assert.equal(result.tipoCambio,3.452);
});

test('una respuesta oficial sin tasa válida no inventa valores ni reintenta',async t=>{
  let calls=0;
  t.mock.method(globalThis,'fetch',async()=>{calls++;return new Response(periods([{name:'29.Oct.26',values:['n.d.','n.d.']}]))});
  await assert.rejects(obtenerTipoDeCambioPE('USD','PEN','2026-10-29'),/7 días anteriores/);
  assert.equal(calls,1);
});
