import test from 'node:test';
import assert from 'node:assert/strict';

process.env.SUPABASE_URL='https://example.supabase.co';
process.env.SUPABASE_ANON_KEY='test-key';

const {openingBalances}=await import('../dist/modules/accounting-catalogs/opening-balances.service.js');

test('el API traduce el statement_timeout de contabilizaci\u00f3n sin reintentar el POST',async()=>{
 const originalFetch=globalThis.fetch;
 let requests=0;
 globalThis.fetch=async()=>{
  requests++;
  return new Response(JSON.stringify({
   code:'57014',details:null,hint:null,message:'canceling statement due to statement timeout'
  }),{status:500,headers:{'content-type':'application/json'}});
 };
 try{
  await assert.rejects(
   openingBalances('Bearer test','post',{runId:155}),
   error=>{
    assert.equal(error.status,503);
    assert.equal(error.code,'OPENING_BALANCE_PROCESSING_TIMEOUT');
    assert.match(error.message,/contabilizaci\u00f3n super\u00f3 el tiempo/i);
    assert.match(error.message,/cancelada sin guardar cambios/i);
    return true;
   }
  );
  assert.equal(requests,1,'Una contabilizaci\u00f3n no debe reintentarse autom\u00e1ticamente.');
 }finally{globalThis.fetch=originalFetch;}
});

