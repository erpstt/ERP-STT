import assert from 'node:assert/strict';

process.env.SUPABASE_URL='https://catalog-test.invalid';
process.env.SUPABASE_ANON_KEY='test-anon-key';

const calls=[];
globalThis.fetch=async(input,init={})=>{
  const url=new URL(String(input));
  const body=init.body?JSON.parse(String(init.body)):null;
  calls.push({path:url.pathname,method:init.method??'GET',body});
  if(url.pathname.endsWith('/rpc/chart_accounts_catalog'))return Response.json([{account_id:7,account_number:'100001',account_name:'Caja',subsidiary_ids:[1,2],account_group_code:'100',account_group_name:'Efectivo'}]);
  if(url.pathname.endsWith('/rpc/save_chart_account_catalog'))return Response.json({account_id:body.p_account_id??8,account_number:body.p_account_id?'100001':'100002',account_name:body.p_payload.account_name,subsidiary_ids:body.p_subsidiary_ids});
  throw new Error(`Solicitud inesperada: ${init.method??'GET'} ${url}`);
};

const {getAccountingCatalog,listAccountingRows,createAccountingRow,updateAccountingRow}=await import('../dist/modules/accounting-catalogs/accounting-catalogs.module.js');
const catalog=getAccountingCatalog('chart-accounts');
const base={account_group_id:1,account_name:'Banco',level:4,nature:'Deudora',financial_statement:'Balance General',category:'Activo',cash_flow_activity:'EFECTIVO_EQUIVALENTE',accepts_entries:true,full_ifrs_only:false,pending_fx_revaluation:false,is_inactive:false};

const rows=await listAccountingRows(catalog,'Bearer test');
assert.deepEqual(rows[0].subsidiary_ids,[1,2]);

const created=await createAccountingRow(catalog,'Bearer test',{...base,subsidiary_ids:[1,2,2]});
assert.deepEqual(created.subsidiary_ids,[1,2]);
assert.equal(calls.at(-1).body.p_account_id,null);
assert.deepEqual(calls.at(-1).body.p_subsidiary_ids,[1,2]);
assert.equal(calls.at(-1).body.p_payload.account_name,'Banco');

const updated=await updateAccountingRow(catalog,'Bearer test',7,{...base,account_name:'Caja principal',subsidiary_ids:['2']});
assert.deepEqual(updated.subsidiary_ids,[2]);
assert.equal(calls.at(-1).body.p_account_id,7);
assert.deepEqual(calls.at(-1).body.p_subsidiary_ids,[2]);

await assert.rejects(()=>updateAccountingRow(catalog,'Bearer test',7,{...base,subsidiary_ids:[]}),/Seleccione al menos una subsidiaria/);
assert.equal(calls.filter(call=>call.path.endsWith('/account_subsidiaries')).length,0);

console.log(JSON.stringify({optimizedCatalog:true,atomicCreateAndAssignments:true,editSubset:true,emptySelectionRejected:true,legacyMatrixDownloads:0}));
