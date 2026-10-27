import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

process.env.SUPABASE_URL='https://example.supabase.test';
process.env.SUPABASE_ANON_KEY='test-anon-key';

const {registerStatementBankFees}=await import('../dist/modules/banking-catalogs/bank-fee.service.js');
const migration=readFileSync(
  new URL('../supabase/migrations/20261027200000_bank_reconciliation_statement_fees.sql',import.meta.url),
  'utf8'
);
const server=readFileSync(new URL('../src/server.ts',import.meta.url),'utf8');

function response(body,status=200){
  return new Response(JSON.stringify(body),{
    status,
    headers:{'Content-Type':'application/json'}
  });
}

test('envia el lote seleccionado al RPC atomico sin transformar sus identificadores',async t=>{
  const originalFetch=globalThis.fetch;
  t.after(()=>{globalThis.fetch=originalFetch;});
  let requestUrl='';
  let requestBody={};
  globalThis.fetch=async(input,init={})=>{
    requestUrl=String(input);
    requestBody=JSON.parse(String(init.body));
    return response({createdCount:2,totalAmount:35.25,matchedStatementLineIds:[41,42]});
  };

  const payload={
    p_bank_account_id:7,
    p_cutoff:'2026-10-27',
    p_statement_line_ids:[41,42]
  };
  const result=await registerStatementBankFees('Bearer test',payload);

  assert.match(requestUrl,/\/rest\/v1\/rpc\/register_bank_statement_fees$/);
  assert.deepEqual(requestBody,payload);
  assert.equal(result.createdCount,2);
  assert.equal(result.totalAmount,35.25);
});

test('la ruta exige permiso de creacion de comisiones bancarias',()=>{
  assert.match(server,/bank-reconciliation\/bank-fees/);
  assert.match(server,/assertRoleAccess\(authorization,'banking:bank-fees','create'\)/);
  assert.match(server,/registerStatementBankFees\(authorization/);
});

test('el RPC limita la seleccion a la subsidiaria, cuenta, fecha y extracto exactos',()=>{
  assert.match(migration,/active_subsidiary_id\(\)/);
  assert.match(migration,/account\.subsidiary_id=active_subsidiary_key/);
  assert.match(migration,/statement\.bank_account_id=p_bank_account_id/);
  assert.match(migration,/statement\.statement_date=p_cutoff/);
  assert.match(migration,/statement_line\.statement_id=statement_key/);
  assert.match(migration,/statement_line\.bank_date<=p_cutoff/);
});

test('solo registra retiros pendientes, bloquea concurrencia y evita duplicados',()=>{
  assert.match(migration,/for update;/);
  assert.match(migration,/statement_line\.amount<0/);
  assert.match(migration,/statement_line\.reconciliation_status='PENDIENTE'/);
  assert.match(migration,/not exists\([\s\S]*bank_reconciliation_match/);
  assert.match(migration,/requested_count<>distinct_count/);
  assert.match(migration,/eligible_count<>distinct_count/);
});

test('el flujo desde extracto admite sobregiro solo dentro del helper privado',()=>{
  assert.match(migration,/post_bank_fee_internal\([\s\S]*p_allow_statement_overdraft boolean default false/);
  assert.match(migration,/not coalesce\(p_allow_statement_overdraft,false\)[\s\S]*bank_account_row\.balance<amount_value/);
  assert.match(migration,/return public\.post_bank_fee_internal\(p_payload,false\)/);
  assert.match(migration,/public\.post_bank_fee_internal\(jsonb_build_object\([\s\S]*\),true\);/);
  assert.match(migration,/revoke all on function public\.post_bank_fee_internal\(jsonb,boolean\)[\s\S]*authenticated,service_role/);
});

test('crea la comision, el asiento y la conciliacion en una sola transaccion',()=>{
  for(const expected of[
    'insert into public."transaction"',
    'insert into public.journal(',
    'insert into public.journal_line(',
    'insert into public.bank_fee(',
    'insert into public.bank_transaction(',
    'insert into public.bank_reconciliation_match(',
    "set reconciliation_status='CONCILIADO'",
    "set reconciliation_status='CONCILIADO'"
  ])assert.ok(migration.includes(expected),`Falta ${expected}`);
  assert.match(migration,/bank_fee_expense_account\(active_subsidiary_key\)/);
  assert.match(migration,/ensure_open_bank_reconciliation\(p_bank_account_id,p_cutoff\)/);
  assert.match(migration,/'createdCount',created_count/);
  assert.match(migration,/'totalAmount',total_amount/);
});
