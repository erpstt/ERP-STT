import assert from 'node:assert/strict';
import {test,before,beforeEach,afterEach,after} from 'node:test';
import {assertIsolatedTestArgs} from './lib/migration-preview.mjs';
assertIsolatedTestArgs();
const {isolatedCostaRicaRateRuntime,syntheticRateConfig,syntheticRateAuthorization}=await import('./fixtures/isolated-costa-rica-rate-runtime.mjs');
let runtime,service,client;
before(async()=>{
 runtime=await isolatedCostaRicaRateRuntime();
 service=await import('../dist/modules/configuration-catalogs/services/costa-rica-exchange-rate.service.js');
 client=await import('../dist/modules/configuration-catalogs/services/bccr-sdde.client.js');
});
beforeEach(()=>runtime.reset());
afterEach(()=>{runtime.assertClean();runtime.reset();});
after(async()=>{if(runtime)await runtime.close();});
const day='2040-05-15',privateContext='P164_SYNTHETIC_PRIVATE_PROVIDER_CONTEXT';
const currencies={USD:{currency_id:9101,currency_code:'USD'},CRC:{currency_id:9102,currency_code:'CRC'}};
const sourceContext={id:9201,revision:'P164_SYNTHETIC_REVISION'};
const saved={exchange_rate_id:9201,label:'P164_SYNTHETIC_SAVED_RATE'};
const expectedRate={monedaOrigen:'USD',monedaDestino:'CRC',fechaEfectiva:day,tipoCambio:4,tasaCompra:2,tasaVenta:4,fuente:'Banco Central de Costa Rica'};
const json=(body,status=200,headers={})=>new Response(JSON.stringify(body),{status,headers:{'Content-Type':'application/json',...headers}});
const series=(date,value)=>({estado:true,datos:[{series:[{fecha:date+'T12:00:00',valorDatoPorPeriodo:value}]}]});
function happy(overrides={}){
 runtime.useFetch(async request=>{
  if(overrides[request.kind])return overrides[request.kind](request);
  if(request.kind==='bccr')return json(series(day,request.indicator==='317'?2:4));
  if(request.kind==='currency')return json([currencies[request.url.searchParams.get('currency_code').slice(3)]]);
  if(request.kind==='context')return json(sourceContext);
  if(request.kind==='save'||request.kind==='ingest')return json(saved);
  assert.fail('Unexpected synthetic collaborator.');
 });
}
const kinds=()=>runtime.requests.map(request=>request.kind);
function onlySyntheticSupabaseHeaders(request,identity){
 assert.equal(request.identity,identity);
 if(identity==='automatic'){assert.equal(request.headers.get('apikey'),syntheticRateConfig.SUPABASE_SERVICE_ROLE_KEY);assert.equal(request.headers.has('Authorization'),false);}
 else{assert.equal(request.headers.get('apikey'),syntheticRateConfig.SUPABASE_ANON_KEY);assert.equal(request.headers.get('Authorization'),syntheticRateAuthorization);}
}

test('runtime uses only OS/synthetic environment and owns a separate empty working directory',()=>{
 const allowed=new Set(['SystemRoot','WINDIR','COMSPEC','PATHEXT','PATH','Path','TEMP','TMP',...Object.keys(syntheticRateConfig)]);
 assert.ok(Object.keys(process.env).every(key=>allowed.has(key)));
 for(const key of['ERP_TEST_EMAIL','ERP_TEST_PASSWORD','DATABASE_URL','SUPABASE_DB_HOST','SUPABASE_DB_PASSWORD','PGPASSWORD','SMTP_PASSWORD','NODE_OPTIONS','HTTP_PROXY','HTTPS_PROXY','ALL_PROXY','CHROME_PATH'])assert.equal(Object.hasOwn(process.env,key),false);
 assert.equal(process.cwd(),runtime.directory);assert.equal(process.env.BCCR_TOKEN,syntheticRateConfig.BCCR_TOKEN);assert.equal(process.env.SUPABASE_SERVICE_ROLE_KEY,syntheticRateConfig.SUPABASE_SERVICE_ROLE_KEY);
});

test('query preserves exact effective date, buy/sell parser values and the official request contract',async()=>{
 happy();assert.deepEqual(await service.obtenerTipoDeCambioCR(' usd ',' crc ',day),expectedRate);
 assert.deepEqual(kinds(),['bccr','bccr']);
 assert.deepEqual(runtime.requests.map(request=>request.indicator),['317','318']);
 for(const request of runtime.requests){
  assert.equal(request.method,'GET');assert.equal(request.url.searchParams.get('fechaInicio'),'2040/05/15');assert.equal(request.url.searchParams.get('fechaFin'),'2040/05/15');
  assert.equal(request.headers.get('Authorization'),'Bearer P164_SYNTHETIC_BCCR_TOKEN_NOT_A_CREDENTIAL');assert.equal(request.url.searchParams.has('token'),false);
  assert.ok(!String(request.url).includes(syntheticRateConfig.SUPABASE_SERVICE_ROLE_KEY));
 }
});

test('inverse pair and Costa Rica date conversion remain real, while same/invalid pairs require no provider IO',async()=>{
 happy();const inverse=await service.obtenerTipoDeCambioCR('CRC','USD',new Date('2040-05-16T05:00:00Z'));assert.equal(inverse.fechaEfectiva,day);assert.equal(inverse.tipoCambio,0.25);assert.equal(inverse.tasaCompra,2);
 runtime.reset();runtime.useFetch(()=>assert.fail('This case must not query a provider.'));
 const same=await service.obtenerTipoDeCambioCR('CRC','CRC',day);assert.equal(same.tipoCambio,1);
 await assert.rejects(service.obtenerTipoDeCambioCR('EUR','CRC',day),/admite USD y CRC/);await assert.rejects(service.obtenerTipoDeCambioCR('USD','CRC','2040-02-30'),/fecha efectiva/);
 assert.deepEqual(kinds(),[]);
});

test('rates from another date cannot substitute missing buy/sell for the requested day or cause persistence',async()=>{
 happy({bccr:()=>json(series('2040-05-14',9))});
 await assert.rejects(service.obtenerTipoDeCambioCR('USD','CRC',day),/no publicó compra y venta/);
 assert.deepEqual(kinds(),['bccr','bccr']);
});

test('malformed, empty and provider errors remain safe without exposing response context',async()=>{
 const failures=[
  ()=>new Response(privateContext,{status:401}),()=>new Response(privateContext,{status:403}),
  ()=>new Response(privateContext,{status:500}),()=>new Response(privateContext),
  ()=>json({estado:false,datos:[]}),()=>json({estado:true,datos:[]}),
  ()=>new Response(privateContext,{status:503,headers:{'Retry-After':'31'}}),
  ()=>{throw Error(privateContext);}
 ];
 for(const failure of failures){
  runtime.reset();happy({bccr:failure});
  await assert.rejects(service.obtenerTipoDeCambioCR('USD','CRC',day),error=>!error.message.includes(privateContext)&&!error.message.includes('P164_SYNTHETIC_BCCR_TOKEN'));
  assert.ok(runtime.requests.every(request=>request.kind==='bccr'));
 }
});

test('real series parser ignores nonpositive, nonnumeric and out-of-range values',async()=>{
 happy({bccr:()=>json({estado:true,datos:[{series:[
  {fecha:day,valorDatoPorPeriodo:null},{fecha:day,valorDatoPorPeriodo:0},{fecha:day,valorDatoPorPeriodo:-1},
  {fecha:day,valorDatoPorPeriodo:'Infinity'},{fecha:day,valorDatoPorPeriodo:{}},
  {fecha:'2040-05-14',valorDatoPorPeriodo:9},{fecha:day,valorDatoPorPeriodo:'4'}
 ]}]})});
 assert.deepEqual([...await client.obtenerSerieBCCR('318',day,day)],[[day,4]]);
});

test('retry is bounded and uses injected waiting rather than sleeping or performing real requests',async()=>{
 let attempts=0;const waits=[];
 happy({bccr:()=>++attempts<3?new Response(privateContext,{status:429,headers:{'Retry-After':'0'}}):json(series(day,4))});
 assert.deepEqual([...await client.obtenerSerieBCCR('318',day,day,{wait:async ms=>{waits.push(ms);}})],[[day,4]]);
 assert.equal(attempts,3);assert.deepEqual(waits,[1000,1000]);
 runtime.reset();attempts=0;waits.length=0;happy({bccr:()=>{attempts++;return new Response(privateContext,{status:429,headers:{'Retry-After':'0'}});}});
 await assert.rejects(client.obtenerSerieBCCR('318',day,day,{wait:async ms=>{waits.push(ms);}}),/limitando las consultas/);
 assert.equal(attempts,3);assert.deepEqual(waits,[1000,1000]);
});

test('manual save uses the caller and source context, preserving id/revision and exact persistence payload',async()=>{
 happy();const result=await service.consultarYGuardarTipoDeCambioCR(syntheticRateAuthorization,{monedaOrigen:'USD',monedaDestino:'CRC',fechaEfectiva:day});
 assert.deepEqual(result,{...expectedRate,guardado:true,registro:saved});assert.deepEqual(kinds(),['currency','currency','bccr','bccr','context','save']);
 for(const request of runtime.requests.filter(request=>request.kind!=='bccr'))onlySyntheticSupabaseHeaders(request,'manual');
 assert.deepEqual(runtime.requests.find(request=>request.kind==='context').body,{p_from:9101,p_to:9102,p_date:day});
 assert.deepEqual(runtime.requests.find(request=>request.kind==='save').body,{p_catalog:'exchange-rates',p_id:9201,p_payload:{from_currency_id:9101,to_currency_id:9102,effective_date:day,spot_rate:4,_revision:sourceContext.revision}});
});

test('manual context denial prevents persistence and retains a safe permission error',async()=>{
 happy({context:()=>json({code:'42501',message:privateContext},403)});
 await assert.rejects(service.consultarYGuardarTipoDeCambioCR(syntheticRateAuthorization,{fechaEfectiva:day}),error=>error.status===403&&!error.message.includes(privateContext));
 assert.equal(runtime.requests.filter(request=>request.kind==='context').length,1);assert.equal(runtime.requests.filter(request=>request.kind==='save'||request.kind==='ingest').length,0);
});

test('manual stale-revision rejection performs one write attempt and does not retry a POST',async()=>{
 happy({save:()=>json({code:'55000',message:privateContext},409)});
 await assert.rejects(service.consultarYGuardarTipoDeCambioCR(syntheticRateAuthorization,{fechaEfectiva:day}),error=>error.status===409&&!error.message.includes(privateContext));
 assert.equal(runtime.requests.filter(request=>request.kind==='save').length,1);assert.equal(runtime.requests.filter(request=>request.kind==='context').length,1);
});

test('automatic save uses synthetic secret apikey only and the dedicated ingestion RPC, without manual-context substitution',async()=>{
 happy();assert.deepEqual(await service.consultarYGuardarTipoDeCambioCRAutomatico(day),{...expectedRate,guardado:true,registro:saved});
 assert.equal(runtime.requests.filter(request=>request.kind==='currency').length,2);assert.equal(runtime.requests.filter(request=>request.kind==='bccr').length,2);
 assert.deepEqual(runtime.requests.filter(request=>request.kind==='context'||request.kind==='save'),[]);
 const ingestion=runtime.requests.filter(request=>request.kind==='ingest');assert.equal(ingestion.length,1);
 assert.deepEqual(ingestion[0].body,{p_from:9101,p_to:9102,p_date:day,p_rate:4});
 for(const request of runtime.requests.filter(request=>request.kind!=='bccr'))onlySyntheticSupabaseHeaders(request,'automatic');
});

test('automatic missing key or currency cannot proceed to provider lookup or ingestion',async()=>{
 delete process.env.SUPABASE_SERVICE_ROLE_KEY;
 try{await assert.rejects(service.consultarYGuardarTipoDeCambioCRAutomatico(day),/no está configurada/);assert.deepEqual(kinds(),[]);}
 finally{process.env.SUPABASE_SERVICE_ROLE_KEY=syntheticRateConfig.SUPABASE_SERVICE_ROLE_KEY;}
 happy({currency:()=>json([])});
 await assert.rejects(service.consultarYGuardarTipoDeCambioCRAutomatico(day),/no existe en el catálogo/);
 assert.ok(runtime.requests.every(request=>request.kind==='currency'));
});

test('automatic provider or ingestion rejection never creates a different persistence path',async()=>{
 happy({bccr:()=>json({estado:true,datos:[]})});
 await assert.rejects(service.consultarYGuardarTipoDeCambioCRAutomatico(day),/no publicó compra y venta/);assert.ok(!kinds().includes('ingest'));
 runtime.reset();happy({ingest:()=>json({code:'42501',message:privateContext},403)});
 await assert.rejects(service.consultarYGuardarTipoDeCambioCRAutomatico(day),error=>error.status===403&&!error.message.includes(privateContext));
 assert.equal(runtime.requests.filter(request=>request.kind==='ingest').length,1);assert.equal(runtime.requests.filter(request=>request.kind==='context'||request.kind==='save').length,0);
});
