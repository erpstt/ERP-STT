import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {test,before,after} from 'node:test';
import {PGlite} from '@electric-sql/pglite';
import {loadLegacyJournalFunctions} from './fixtures/load-legacy-journal-functions.mjs';
const db=new PGlite();const read=p=>readFile(new URL(p,import.meta.url),'utf8');
before(async()=>{
 for(const f of ['consolidation-security.sql','bank-transfer-security.sql','manual-journal-security.sql'])await db.exec(await read('./fixtures/'+f));
 const dims=await read('./journal-csv-test-fixture.sql');await db.exec(dims.slice(dims.indexOf('create table customers')));
 await db.exec('alter table cost_centers add column is_inactive boolean default false;alter table employees add column is_active boolean default true');
 await loadLegacyJournalFunctions(db);
 await db.exec('begin');await db.exec(await read('../supabase/migrations/20261031022533_secure_manual_journals.sql'));await db.exec('commit');
 await db.exec(await read('./fixtures/bank-deposit-security.sql'));
 await db.exec(await read('../supabase/migrations/20260902090000_bank_account_transfers.sql'));
 await db.exec(await read('./fixtures/bank-account-security.sql'));
 await db.exec('begin');await db.exec(await read('../supabase/migrations/20261031031441_secure_bank_account_writes.sql'));await db.exec('commit');
 await db.exec(await read('./fixtures/bank-check-security.sql'));
 await db.exec(await read('../supabase/migrations/20260903100000_bank_checks_transfers_transaction.sql'));
 await db.exec(await read('../supabase/migrations/20260903110000_bank_check_periods.sql'));
 await db.exec('alter function save_bank_check_transfer(jsonb,bigint) rename to save_bank_check_transfer_without_tax_agency;alter table bank_check_line add column tax_agency_id bigint;alter table journal_line add column tax_agency_id bigint');
 const tax=await read('../supabase/migrations/20261027090000_tax_agency_payment_requests.sql');
 const wrapper=tax.match(/create or replace function public\.save_bank_check_transfer\([\s\S]*?\$\$[\s\S]*?\$\$;/i)?.[0];assert.ok(wrapper);await db.exec(wrapper);
 await db.exec("insert into role_access_matrix values(1,'banking:bank-checks',true,true,true,true),(2,'banking:bank-checks',true,true,false,false),(3,'banking:bank-checks',true,false,false,false),(6,'banking:bank-checks',false,false,false,true)");
 await db.exec('alter table bank_check enable row level security;grant all on bank_check,bank_check_line to authenticated;create policy old_all on bank_check for all to authenticated using(true) with check(true);grant update(amount) on bank_check to authenticated');
 await db.exec('begin');await db.exec(await read('../supabase/migrations/20261031114542_secure_bank_checks.sql'));await db.exec('commit');
});
after(()=>db.close());
async function tx(t){await db.exec('reset role;begin');t.after(()=>db.exec('rollback;reset role'));}
async function assume(user=1,role=1,sid=1){
 await db.exec('reset role');
 await db.query(`insert into user_role_sessions values('fixture',$1,$2) on conflict(session_id) do update set user_id=$1,role_id=$2`,[user,role]);
 await db.query(`insert into user_company_sessions values('fixture',$1,$2) on conflict(session_id) do update set user_id=$1,subsidiary_id=$2`,[user,sid]);
 await db.query(`select set_config('request.jwt.claims',$1,false)`,[JSON.stringify({sub:`00000000-0000-0000-0000-${String(user).padStart(12,'0')}`,session_id:'fixture'})]);await db.exec('set role authenticated');
}
async function denied(sql,params=[],code='42501'){
 await db.exec('savepoint denial');try{await assert.rejects(db.query(sql,params),e=>e.code===code);}
 finally{await db.exec('rollback to savepoint denial;release savepoint denial');}
}
const payload={payment_type:'CHEQUE',bank_account_id:1,currency_id:1,exchange_rate:1,payment_date:'2026-10-10',fiscal_period_id:10,location_id:1,bank_reference:'SYNTHETIC-REFERENCE',beneficiary:'Synthetic beneficiary',lines:[{amount:100,account_id:103}]};
const save=async(p=payload,id=null)=>(await db.query('select save_bank_check_transfer($1,$2) data',[p,id])).rows[0].data;
const rpcs=['bank_check_options()','bank_check_periods()',"bank_check_report('{}')",'bank_check_detail(0)',"save_bank_check_transfer('{}',null)","save_bank_check_transfer('{}',0)",'delete_bank_check_transfer(0)'];

test('seis RPC/siete acciones niegan anon, service_role y cuerpos privados; no hay alias legacy publico',async t=>{
 await tx(t);for(const role of ['anon','service_role']){await db.exec(`reset role;set role ${role}`);for(const rpc of rpcs)await denied('select '+rpc);}
 await assume();await denied("select bank_check_private.save_bank_check_transfer('{}',null)");await denied("select bank_check_private.save_bank_check_transfer_without_tax_agency('{}',null)");
 assert.equal((await db.query("select to_regprocedure('public.save_bank_check_transfer_without_tax_agency(jsonb,bigint)') f")).rows[0].f,null);
});
test('identidad, rol asignado activo y membresia vigentes preceden a cada operacion',async t=>{
 await tx(t);for(const identity of [[2,4,1],[1,5,1],[3,1,2]]){await assume(...identity);for(const rpc of rpcs)await denied('select '+rpc);}
 await db.exec('reset role;update users set is_active=false where user_id=4');await assume(4,5);for(const rpc of rpcs)await denied('select '+rpc);
 await db.exec('reset role;delete from user_subsidiaries where user_id=1 and subsidiary_id=1');await assume();await denied('select bank_check_options()');
});
test('cheque y transferencia legitimos contabilizan y eliminan restaurando saldo; reader no puede crear',async t=>{
 await tx(t);await assume();
 for(const payment_type of ['CHEQUE','TRANSFERENCIA']){
  const r=await save({...payload,payment_type});await db.exec('reset role');
  assert.equal((await db.query('select balance::float8 b from bank_account where bank_account_id=1')).rows[0].b,900);
  const sum=(await db.query('select sum(debit)::float8 d,sum(credit)::float8 c from journal_line where journal_id=$1',[r.journalId])).rows[0];assert.deepEqual(sum,{d:100,c:100});
  await assume(1,3);const detail=(await db.query('select bank_check_detail($1) d',[r.checkId])).rows[0].d;assert.equal(detail.lines.length,1);await denied('select save_bank_check_transfer($1,null)',[payload]);
  await assume(1,6);await denied('select bank_check_detail($1)',[r.checkId]);await db.query('select delete_bank_check_transfer($1)',[r.checkId]);
  await db.exec('reset role');assert.equal((await db.query('select balance::float8 b from bank_account where bank_account_id=1')).rows[0].b,1000);await assume();
 }
});
test('edicion cambia banco y tipo, conserva saldos y sincroniza tipo/beneficiario del movimiento',async t=>{
 await tx(t);await assume();const r=await save();await save({...payload,bank_account_id:2,payment_type:'TRANSFERENCIA',beneficiary:'Changed synthetic beneficiary',lines:[{amount:120,account_id:103}]},r.checkId);
 await db.exec('reset role');assert.deepEqual((await db.query('select balance::float8 b from bank_account where bank_account_id in(1,2) order by bank_account_id')).rows,[{b:1000},{b:880}]);
 assert.deepEqual((await db.query('select tran_type,beneficiary from bank_transaction')).rows[0],{tran_type:'TRANSFERENCIA',beneficiary:'Changed synthetic beneficiary'});
 await assume();await db.query('select delete_bank_check_transfer($1)',[r.checkId]);await db.exec('reset role');assert.deepEqual((await db.query('select balance::float8 b from bank_account where bank_account_id in(1,2) order by bank_account_id')).rows,[{b:1000},{b:1000}]);
});
test('saldo reintegrado al banco original no financia un banco nuevo; mismo banco si recibe reintegro',async t=>{
 await tx(t);await assume();const r=await save();await db.exec('reset role;update bank_account set balance=50 where bank_account_id=2');await assume();
 await denied('select save_bank_check_transfer($1,$2)',[{...payload,bank_account_id:2,lines:[{amount:100,account_id:103}]},r.checkId],'55000');
 await save({...payload,lines:[{amount:950,account_id:103}]},r.checkId);await db.exec('reset role');assert.equal((await db.query('select balance::float8 b from bank_account where bank_account_id=1')).rows[0].b,50);
});
test('alcance de banco, moneda, ledger, ubicacion, entidades y dimensiones es obligatorio',async t=>{
 await tx(t);await assume();
 for(const change of [{bank_account_id:3},{bank_account_id:4},{currency_id:2},{location_id:2},
 {lines:[{amount:1,account_id:104}]},{lines:[{amount:1,account_id:103,entity_type:'Proveedor',entity_id:99}]},
 {lines:[{amount:1,account_id:103,department_id:99}]},{lines:[{amount:1,account_id:103,entity_type:'Agencia Tributaria',entity_id:2}]}])await denied('select save_bank_check_transfer($1,null)',[{...payload,...change}]);
 await db.exec('reset role;update bank_account set is_credit_card=true where bank_account_id=2');await assume();await denied('select save_bank_check_transfer($1,null)',[{...payload,bank_account_id:2}]);
});
test('agencia tributaria autorizada conserva imputacion en egreso y asiento',async t=>{
 await tx(t);await assume();const r=await save({...payload,lines:[{amount:100,account_id:103,entity_type:'Agencia Tributaria',entity_id:1}]});
 await db.exec('reset role');assert.equal((await db.query('select tax_agency_id from bank_check_line where check_id=$1',[r.checkId])).rows[0].tax_agency_id,1);
 assert.equal((await db.query('select tax_agency_id from journal_line where journal_id=$1 and debit>0',[r.journalId])).rows[0].tax_agency_id,1);
});
test('importes/tasas no finitos o nulos y payload vacio no contabilizan',async t=>{
 await tx(t);await assume();for(const bad of [null,{}, {...payload,lines:[]},...['NaN','Infinity','-Infinity',null,0,-1].map(amount=>({...payload,lines:[{amount,account_id:103}]})),...['NaN','Infinity',null,0].map(exchange_rate=>({...payload,exchange_rate}))])await denied('select save_bank_check_transfer($1,null)',[bad],'22023');
 await db.exec('reset role');assert.equal((await db.query('select count(*) n from bank_check')).rows[0].n,0);
});
test('periodo original cerrado no se evade moviendo fecha a otro abierto',async t=>{
 await tx(t);await assume();const r=await save();await db.exec("reset role;update fiscal_periods set gl_closed=true where fiscal_period_id=10;insert into fiscal_periods(fiscal_period_id,subsidiary_id,start_date,end_date,is_closed) values(11,1,'2026-11-01','2026-11-30',false)");await assume();
 await denied('select save_bank_check_transfer($1,$2)',[{...payload,fiscal_period_id:11,payment_date:'2026-11-10'},r.checkId],'55000');await denied('select delete_bank_check_transfer($1)',[r.checkId],'55000');
});
test('movimiento conciliado y conciliacion cerrada impiden cambios; destino cerrado tampoco admite nuevos egresos',async t=>{
 await tx(t);await assume();const r=await save();await db.exec("reset role;update bank_transaction set reconciliation_status='CONCILIADO'");await assume();
 await denied('select save_bank_check_transfer($1,$2)',[payload,r.checkId],'55000');await denied('select delete_bank_check_transfer($1)',[r.checkId],'55000');
 await db.exec("reset role;update bank_transaction set reconciliation_status='PENDIENTE_EN_TRANSITO';insert into bank_reconciliation values(1,'2026-10-31','CERRADA')");await assume();await denied('select delete_bank_check_transfer($1)',[r.checkId],'55000');await denied('select save_bank_check_transfer($1,null)',[payload],'55000');
});
test('clasificacion historica inconsistente es legible, pero no editable ni eliminable',async t=>{
 await tx(t);await assume();const r=await save();await db.exec('reset role;update "transaction" set transaction_type_id=1');await assume();
 assert.ok((await db.query('select bank_check_detail($1) d',[r.checkId])).rows[0].d);await denied('select save_bank_check_transfer($1,$2)',[payload,r.checkId]);await denied('select delete_bank_check_transfer($1)',[r.checkId]);
});
test('lectura RLS/detalle/reporte no exponen bancos o asientos de otra subsidiaria',async t=>{
 await tx(t);await assume();const r=await save();await db.exec('reset role;update bank_check set bank_account_id=3');await assume();
 assert.equal((await db.query('select count(*) n from bank_check')).rows[0].n,0);assert.equal((await db.query('select count(*) n from bank_check_line')).rows[0].n,0);await denied('select bank_check_detail($1)',[r.checkId]);
 const report=(await db.query('select bank_check_report($1) d',[{dateFrom:'2026-10-01',dateTo:'2026-10-31'}])).rows[0].d;assert.equal(report.rows.length,0);
});
test('clientes no escriben directamente ni truncan tablas por ACL de tabla o columna',async t=>{
 await tx(t);for(const role of ['anon','authenticated','service_role']){await db.exec(`reset role;set role ${role}`);for(const table of ['bank_check','bank_check_line'])for(const sql of [`insert into ${table} default values`,`update ${table} set amount=1`,`delete from ${table}`,`truncate ${table}`])await denied(sql);}
});
test('caller de solicitudes conserva su permiso propio y ruta privada sin exigir permisos del catalogo',async t=>{
 await tx(t);await assume(1,7);await denied('select save_bank_check_transfer($1,null)',[payload]);await db.exec('set role service_role');
 const r=(await db.query('select pr_execute_without_budget($1) d',[payload])).rows[0].d;assert.ok(r.checkId);
});
