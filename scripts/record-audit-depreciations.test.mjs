import {test} from 'node:test';
import assert from 'node:assert/strict';
import {depreciationPreview} from '../dist/modules/fixed-asset-catalogs/fixed-assets.service.js';
test('depreciations link to the saved record and preserve authentication across pages',async()=>{
  const original=globalThis.fetch,originalUrl=process.env.SUPABASE_URL,originalKey=process.env.SUPABASE_ANON_KEY;
  process.env.SUPABASE_URL='https://audit-test.invalid';process.env.SUPABASE_ANON_KEY='test';
  const offsets=[];
  globalThis.fetch=async(input,init)=>{
    assert.equal(new Headers(init.headers).get('Authorization'),'Bearer user-test');
    const url=new URL(input);
    if(url.pathname.includes('/rpc/'))return Response.json({period:{id:9},rows:[{id:11,processed:true},{id:12,processed:true},{id:13,processed:false}]});
    assert.equal(url.searchParams.get('fiscal_period_id'),'eq.9');
    const offset=Number(url.searchParams.get('offset'));offsets.push(offset);
    return Response.json(offset===0?[{asset_id:11,depreciation_id:101}]:offset===1?[{asset_id:12,depreciation_id:102}]:[]);
  };
  try{
    const result=await depreciationPreview('Bearer user-test','2026-09-30');
    assert.deepEqual(result.rows.map(row=>row.depreciationId),[101,102,null]);
    assert.deepEqual(offsets,[0,1,2]);
  }finally{globalThis.fetch=original;if(originalUrl===undefined)delete process.env.SUPABASE_URL;else process.env.SUPABASE_URL=originalUrl;if(originalKey===undefined)delete process.env.SUPABASE_ANON_KEY;else process.env.SUPABASE_ANON_KEY=originalKey;}
});
