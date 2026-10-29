import assert from 'node:assert/strict';
import test from 'node:test';

const originalFetch=globalThis.fetch,originalUrl=process.env.SUPABASE_URL,originalKey=process.env.SUPABASE_ANON_KEY;
process.env.SUPABASE_URL='https://catalog-order.example.test';
process.env.SUPABASE_ANON_KEY='test-key';
const {getConfigurationCatalog,listConfigurationRows}=await import('../dist/modules/configuration-catalogs/configuration-catalogs.module.js');

test.after(()=>{
  globalThis.fetch=originalFetch;
  if(originalUrl===undefined)delete process.env.SUPABASE_URL;else process.env.SUPABASE_URL=originalUrl;
  if(originalKey===undefined)delete process.env.SUPABASE_ANON_KEY;else process.env.SUPABASE_ANON_KEY=originalKey;
});

test('tipos de cambio solicitan fecha descendente con ID como desempate estable',async()=>{
  const requested=[];
  globalThis.fetch=async input=>{
    const url=new URL(String(input)),table=url.pathname.split('/').at(-1);
    requested.push(url);
    if(table==='exchange_rates')return Response.json([
      {exchange_rate_id:9,effective_date:'2026-10-29',to_currency_id:2},
      {exchange_rate_id:8,effective_date:'2026-10-29',to_currency_id:3},
      {exchange_rate_id:7,effective_date:'2026-10-28',to_currency_id:2}
    ]);
    if(table==='payment_terms')return Response.json([
      {term_id:1,term_name:'Contado'},
      {term_id:2,term_name:'Neto 30'}
    ]);
    if(table==='user_role_sessions')return Response.json([{role_id:1}]);
    if(table==='roles')return Response.json([{role_name:'Administrador'}]);
    throw new Error(`Solicitud inesperada: ${url}`);
  };
  const payload=Buffer.from(JSON.stringify({session_id:'exchange-rate-order'})).toString('base64url');
  const rows=await listConfigurationRows(getConfigurationCatalog('exchange-rates'),`Bearer e30.${payload}.test`);
  const catalogRequest=requested.find(url=>url.pathname.endsWith('/exchange_rates'));
  assert.equal(catalogRequest?.searchParams.get('order'),'effective_date.desc,exchange_rate_id.desc');
  assert.deepEqual(rows.map(row=>row.exchange_rate_id),[9,8,7]);

  await listConfigurationRows(getConfigurationCatalog('payment-terms'),`Bearer e30.${payload}.test`);
  const genericCatalogRequest=requested.find(url=>url.pathname.endsWith('/payment_terms'));
  assert.equal(genericCatalogRequest?.searchParams.get('order'),'term_id.asc','Los demás catálogos deben conservar su orden por llave primaria.');
});
