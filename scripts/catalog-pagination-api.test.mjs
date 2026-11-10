import assert from 'node:assert/strict';
import {test} from 'node:test';
import {primeRoleAccessCache,invalidateRoleAccessCaches} from '../dist/modules/security-catalogs/role-access-matrix.module.js';

const definitions=[
  ['accounting','account-groups','getAccountingCatalog','listAccountingRows'],
  ['ai','ai-agents','getAiCatalog','listAiRows'],
  ['banking','bank-statements','getBankingCatalog','listBankingRows'],
  ['consolidation','intercompany-eliminations','getConsolidationCatalog','listConsolidationRows'],
  ['document','folders','getDocumentCatalog','listDocumentRows'],
  ['expense','expense-types','getExpenseCatalog','listExpenseRows'],
  ['fixed-asset','asset-depreciations','getFixedAssetCatalog','listFixedAssetRows'],
  ['purchasing','supplier-invoices','getPurchasingCatalog','listPurchasingRows'],
  ['sales','invoices','getSalesCatalog','listSalesRows'],
  ['security','password-history','getSecurityCatalog','listSecurityRows'],
  ['treasury','cashboxes','getTreasuryCatalog','listTreasuryRows'],
  ['transaction-engine','transactions','getTransactionEngineCatalog','listTransactionEngineRows']
];
const cases=await Promise.all(definitions.map(async([name,slug,get,list])=>{
  const module=await import(`../dist/modules/${name}-catalogs/${name}-catalogs.module.js`);
  return{name,slug,catalog:module[get](slug),list:module[list]};
}));
let sequence=0;
async function fixture(t,{catalog,count=1003,maximum=100,failOffset=null,admin=true,rpcResult=[]}={}){
  const auth=`Bearer synthetic-catalog-pagination-${++sequence}`,calls=[],originalFetch=globalThis.fetch,keys=['SUPABASE_URL','SUPABASE_ANON_KEY'],before=Object.fromEntries(keys.map(key=>[key,process.env[key]]));
  Object.assign(process.env,{SUPABASE_URL:'https://catalog-pagination.invalid',SUPABASE_ANON_KEY:'synthetic-public-key'});
  await primeRoleAccessCache(auth,{isAdmin:admin,grants:[]});
  const rows=catalog?Array.from({length:count},(_,index)=>({[catalog.primaryKey]:index+1,name:`Registro ${index+1}`,subsidiary_id:9,_revision:`rev-${index+1}`,_actions:{canEdit:false}})):[];
  globalThis.fetch=async(input,init={})=>{
    const url=new URL(String(input)),headers=new Headers(init.headers);assert.equal(url.origin,'https://catalog-pagination.invalid');
    assert.equal(headers.get('authorization'),auth);assert.equal(headers.get('apikey'),'synthetic-public-key');
    calls.push({url,method:init.method||'GET',prefer:headers.get('prefer'),body:init.body?JSON.parse(init.body):null});
    if(url.pathname.startsWith('/rest/v1/rpc/'))return Response.json(rpcResult);
    assert.equal(calls.at(-1).method,'GET');assert.equal(url.pathname,'/rest/v1/'+catalog.table);assert.equal(headers.get('prefer'),'count=exact');
    assert.equal(url.searchParams.get('order'),catalog.primaryKey+'.asc');
    const offset=Number(url.searchParams.get('offset')),limit=Number(url.searchParams.get('limit'));assert.equal(limit,500);
    if(offset===failOffset)return Response.json({message:'PRIVATE_SQL'},{status:500});
    const page=rows.slice(offset,offset+Math.min(maximum,limit));
    return Response.json(page,{headers:{'Content-Range':page.length?`${offset}-${offset+page.length-1}/${count}`:`*/${count}`}});
  };
  t.after(()=>{globalThis.fetch=originalFetch;for(const[key,value]of Object.entries(before))if(value===undefined)delete process.env[key];else process.env[key]=value;invalidateRoleAccessCaches();});
  return{auth,calls,rows};
}

for(const entry of cases)test(`${entry.name}: the authorized main catalog keeps all 1003 records despite a lower provider limit`,async t=>{
  const f=await fixture(t,{catalog:entry.catalog}),result=await entry.list(entry.catalog,f.auth);
  assert.deepEqual(result,f.rows);assert.equal(f.calls.length,11);assert.deepEqual(f.calls.map(call=>Number(call.url.searchParams.get('offset'))),Array.from({length:11},(_,index)=>index*100));
  if(entry.name==='security')assert.equal(f.calls[0].url.searchParams.get('select'),'history_id,user_id,created_at','The existing safe security projection must stay intact');
});

test('a short main catalog is one request and retains the array response and row permissions',async t=>{
  const entry=cases.find(item=>item.name==='sales'),f=await fixture(t,{catalog:entry.catalog,count:7});
  assert.deepEqual(await entry.list(entry.catalog,f.auth),f.rows);assert.equal(f.calls.length,1);
});
test('a failed second main-list page is rejected without partial results or SQL details',async t=>{
  const entry=cases.find(item=>item.name==='sales'),f=await fixture(t,{catalog:entry.catalog,maximum:500,failOffset:500});
  await assert.rejects(entry.list(entry.catalog,f.auth),error=>error.status===503&&!error.message.includes('PRIVATE'));assert.equal(f.calls.length,2);
});
test('existing catalog permission guards still reject before a provider query',async t=>{
  const entry=cases.find(item=>item.name==='expense'),f=await fixture(t,{catalog:entry.catalog,admin:false});
  await assert.rejects(entry.list(entry.catalog,f.auth),error=>error.status===403);assert.deepEqual(f.calls,[]);
});

const protectedCases=[
  ['core','countries','getCoreCatalog','listCatalogRows','core_dictionary_catalog',[]],
  ['organization','branches','getOrganizationCatalog','listOrganizationRows','organization_master_list',[]],
  ['configuration','exchange-rates','getConfigurationCatalog','listConfigurationRows','exchange_rate_catalog',[]],
  ['accounting','chart-accounts','getAccountingCatalog','listAccountingRows','chart_accounts_catalog',[]],
  ['security','login-history','getSecurityCatalog','listSecurityRows','security_connection_catalog',[]],
  ['inventory','products','getInventoryCatalog','listInventoryRows','inventory_master_data',{rows:[]}],
  ['entity','customers','getEntityCatalog','listEntityRows','entity_master_list',[]]
];
for(const[name,slug,get,list,rpc,result]of protectedCases)test(`${name}/${slug}: protected RPCs and reserved limits remain unchanged`,async t=>{
  const module=await import(`../dist/modules/${name}-catalogs/${name}-catalogs.module.js`),catalog=module[get](slug),f=await fixture(t,{rpcResult:result});
  await module[list](catalog,f.auth);assert.equal(f.calls.length,1);assert.equal(f.calls[0].url.pathname,'/rest/v1/rpc/'+rpc);
  assert.equal(f.calls[0].method,'POST');assert.equal(f.calls[0].prefer,null);assert.equal(f.calls[0].url.search,'');
});
