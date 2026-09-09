import {test} from 'node:test';
import assert from 'node:assert/strict';
import {fechaCostaRica,esperaBCCR,obtenerSerieBCCR} from '../dist/modules/configuration-catalogs/services/bccr-sdde.client.js';
import {obtenerTipoDeCambioCR,consultarYGuardarTipoDeCambioCR} from '../dist/modules/configuration-catalogs/services/costa-rica-exchange-rate.service.js';
function env(t,key,value){const previous=process.env[key];process.env[key]=value;t.after(()=>{if(previous===undefined)delete process.env[key];else process.env[key]=previous;});}
const response=(series)=>new Response(JSON.stringify({estado:true,datos:[{series}]}));
test('Costa Rica date stays on the previous day before local midnight and rejects invalid dates',()=>{
  assert.equal(fechaCostaRica(new Date('2026-09-09T02:00:00Z')),'2026-09-08');
  assert.equal(fechaCostaRica('2026-09-08'),'2026-09-08');
  assert.throws(()=>fechaCostaRica('2026-02-30'));
  assert.throws(()=>fechaCostaRica('not a date'));
});
test('SDDE range, bearer token and series dates/values',async t=>{
  env(t,'BCCR_TOKEN','test-token');
  let calls=0;
  const result=await obtenerSerieBCCR('318','2026-09-01','2026-09-08',{fetch:async(url,init)=>{
    calls++;assert.equal(url.hostname,'apim.bccr.fi.cr');assert.match(url.pathname,/318\/series$/);
    assert.equal(url.searchParams.get('fechaInicio'),'2026/09/01');assert.equal(url.searchParams.get('fechaFin'),'2026/09/08');
    assert.equal(init.headers.Authorization,'Bearer test-token');assert.equal(url.searchParams.has('Token'),false);
    return response([{fecha:'2026-09-01',valorDatoPorPeriodo:'453.38'},{fecha:'2026-09-08T00:00:00',valorDatoPorPeriodo:454},{fecha:'2026-09-09',valorDatoPorPeriodo:455},{fecha:'2026-09-04',valorDatoPorPeriodo:null}]);
  }});
  assert.equal(calls,1);assert.deepEqual([...result],[['2026-09-01',453.38],['2026-09-08',454]]);
});
test('429 respects Retry-After and retries without real sleeps',async t=>{
  env(t,'BCCR_TOKEN','test-token');
  let calls=0;const waits=[];
  await obtenerSerieBCCR('317','2026-09-08','2026-09-08',{fetch:async()=>++calls===1?new Response('Try again in 26 seconds',{status:429,headers:{'Retry-After':'2'}}):response([]),wait:async ms=>waits.push(ms)});
  assert.equal(calls,2);assert.deepEqual(waits,[3000]);
  assert.equal(esperaBCCR(new Response('',{status:429}),'Try again in 26 seconds',0),27000);
});
test('unauthorized, unavailable and malformed replies fail safely',async t=>{
  env(t,'BCCR_TOKEN','test-token');
  for(const status of [401,403,500]) await assert.rejects(obtenerSerieBCCR('318','2026-09-08','2026-09-08',{fetch:async()=>new Response('secret body',{status})}),error=>!error.message.includes('secret body'));
  await assert.rejects(obtenerSerieBCCR('318','2026-09-08','2026-09-08',{fetch:async()=>new Response('not json')}),/JSON/);
  await assert.rejects(obtenerSerieBCCR('318','2026-09-08','2026-09-08',{fetch:async()=>new Response('Try again in 90 seconds',{status:429}),wait:async()=>assert.fail('Must not wait indefinitely')}),/91 segundos/);
});
test('sale and reciprocal use official sale; simultaneous requests share the two queries',async t=>{
  env(t,'BCCR_TOKEN','test-token');
  let calls=0;
  t.mock.method(globalThis,'fetch',async url=>{calls++;return response([{fecha:'2026-09-08',valorDatoPorPeriodo:url.pathname.includes('/317/')?446.5:453.38}]);});
  const [direct,inverse]=await Promise.all([obtenerTipoDeCambioCR('USD','CRC','2026-09-08'),obtenerTipoDeCambioCR('CRC','USD','2026-09-08')]);
  assert.equal(calls,2);assert.equal(direct.tipoCambio,453.38);assert.equal(inverse.tipoCambio,1/453.38);
  assert.equal(direct.tasaCompra,446.5);
});
test('missing requested date cannot be saved using a rate from another date',async t=>{
  env(t,'BCCR_TOKEN','test-token');
  t.mock.method(globalThis,'fetch',async()=>response([{fecha:'2026-09-07',valorDatoPorPeriodo:450}]));
  await assert.rejects(obtenerTipoDeCambioCR('USD','CRC','2026-09-08'),/no publicó/);
});
test('manual Costa Rica action persists USD/CRC regardless of active subsidiary currency',async t=>{
  env(t,'BCCR_TOKEN','test-token');
  env(t,'SUPABASE_URL','https://example.invalid');
  env(t,'SUPABASE_ANON_KEY','test');
  let stored;
  t.mock.method(globalThis,'fetch',async(raw,init)=>{
    const url=new URL(raw);
    if(url.hostname==='apim.bccr.fi.cr')return response([{fecha:'2026-09-08',valorDatoPorPeriodo:url.pathname.includes('/317/')?446.5:453.38}]);
    if(url.pathname==='/rest/v1/currencies'){const code=url.searchParams.get('currency_code').slice(3);return new Response(JSON.stringify([{currency_code:code,currency_id:code==='USD'?1:2}]));}
    assert.equal(url.pathname,'/rest/v1/exchange_rates');assert.equal(init.method,'POST');
    assert.equal(url.searchParams.get('on_conflict'),'from_currency_id,to_currency_id,effective_date');
    stored=JSON.parse(init.body);return new Response(JSON.stringify([{exchange_rate_id:99,...stored}]));
  });
  const result=await consultarYGuardarTipoDeCambioCR('Bearer test',{fechaEfectiva:'2026-09-08'});
  assert.equal(result.guardado,true);assert.deepEqual(stored,{from_currency_id:1,to_currency_id:2,effective_date:'2026-09-08',spot_rate:453.38});
});
