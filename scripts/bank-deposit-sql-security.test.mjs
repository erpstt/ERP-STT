import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {test,before,after} from 'node:test';
import {PGlite} from '@electric-sql/pglite';
import {loadLegacyJournalFunctions} from './fixtures/load-legacy-journal-functions.mjs';
const db=new PGlite();const read=p=>readFile(new URL(p,import.meta.url),'utf8');
before(async()=>{
 for(const file of ['consolidation-security.sql','bank-transfer-security.sql','manual-journal-security.sql'])await db.exec(await read('./fixtures/'+file));
 const dims=await read('./journal-csv-test-fixture.sql');await db.exec(dims.slice(dims.indexOf('create table customers')));
 await db.exec('alter table cost_centers add column is_inactive boolean default false;alter table employees add column is_active boolean default true');
 await loadLegacyJournalFunctions(db);
 await db.exec('begin');await db.exec(await read('../supabase/migrations/20261031022533_secure_manual_journals.sql'));await db.exec('commit');
 await db.exec(await read('./fixtures/bank-deposit-security.sql'));
 await db.exec(await read('../supabase/migrations/20260902130000_bank_deposit_transaction.sql'));
 await db.exec(await read('../supabase/migrations/20260902150000_manage_bank_deposits.sql'));
 await db.exec('alter table bank_deposit enable row level security;grant all on bank_deposit,bank_deposit_line to authenticated;create policy old_deposit_all on bank_deposit for all to authenticated using(true) with check(true)');
 await db.exec('begin');await db.exec(await read('../supabase/migrations/20261031024434_secure_bank_deposits.sql'));await db.exec('commit');
 await db.exec(await read('./fixtures/bank-account-security.sql'));
 await db.exec('begin');await db.exec(await read('../supabase/migrations/20261031031441_secure_bank_account_writes.sql'));await db.exec('commit');
});
after(()=>db.close());
async function tx(t){await db.exec('reset role;begin');t.after(()=>db.exec('rollback;reset role'));}
async function assume(user=1,role=1,sid=1){
 await db.exec('reset role');
 await db.query(`insert into user_role_sessions values('fixture',$1,$2) on conflict(session_id) do update set user_id=$1,role_id=$2`,[user,role]);
 await db.query(`insert into user_company_sessions values('fixture',$1,$2) on conflict(session_id) do update set user_id=$1,subsidiary_id=$2`,[user,sid]);
 await db.query(`select set_config('request.jwt.claims',$1,false)`,[JSON.stringify({sub:`00000000-0000-0000-0000-${String(user).padStart(12,'0')}`,session_id:'fixture'})]);
 await db.exec('set role authenticated');
}
async function denied(sql,params=[],code='42501'){
 await db.exec('savepoint denial');try{await assert.rejects(db.query(sql,params),e=>e.code===code);}
 finally{await db.exec('rollback to savepoint denial;release savepoint denial');}
}
const payload={bank_account_id:1,deposit_date:'2026-10-10',currency_id:1,exchange_rate:1,fiscal_period_id:10,location_id:1,memo:'Synthetic deposit',lines:[{amount:100,account_id:103,payment_method_id:1}]};
const save=async p=>(await db.query('select save_bank_deposit($1) data',[p||payload])).rows[0].data;
const rpcs=['bank_deposit_options()',"bank_deposit_report('{}')",'bank_deposit_detail(0)',"save_bank_deposit('{}')","update_bank_deposit(0,'{}')",'delete_bank_deposit(0)'];

test('los seis RPC exigen identidad y permiso; anon/service_role no ejecutan APIs ni cuerpos privados',async t=>{
 await tx(t);for(const role of ['anon','service_role']){await db.exec(`reset role;set role ${role}`);for(const rpc of rpcs)await denied('select '+rpc);}
 await assume(2,4);for(const rpc of rpcs)await denied('select '+rpc);
 await assume();await denied("select bank_deposit_private.save_bank_deposit('{}')");
});

test('deposito autorizado contabiliza saldos y asiento, y solo lectura consulta sin crear',async t=>{
 await tx(t);await assume();const result=await save();assert.ok(result.depositId);assert.equal(result.total,100);
 await db.exec('reset role');assert.equal((await db.query('select balance::float8 balance from bank_account where bank_account_id=1')).rows[0].balance,1100);
 const sums=(await db.query('select sum(debit)::float8 debit,sum(credit)::float8 credit from journal_line where journal_id=$1',[result.journalId])).rows[0];assert.deepEqual(sums,{debit:100,credit:100});
 await assume(1,3);const detail=(await db.query('select bank_deposit_detail($1) data',[result.depositId])).rows[0].data;assert.equal(detail.lines.length,1);assert.equal(detail.impact.length,2);
 const report=(await db.query('select bank_deposit_report($1) data',[{dateFrom:'2026-10-01',dateTo:'2026-10-31'}])).rows[0].data;assert.equal(report.rows.length,1);assert.equal(report.total,100);
 await denied('select save_bank_deposit($1)',[payload]);
});

test('editar y eliminar requieren acciones separadas y revierten correctamente saldos y documentos',async t=>{
 await tx(t);await assume();const original=await save();await denied('select delete_bank_deposit($1)',[original.depositId]);
 await assume(1,2);const changed={...payload,bank_account_id:2,lines:[{amount:150,account_id:103}]};
 await db.query('select update_bank_deposit($1,$2)',[original.depositId,changed]);await denied('select delete_bank_deposit($1)',[original.depositId]);
 await db.exec('reset role');assert.deepEqual((await db.query('select balance::float8 balance from bank_account where bank_account_id in(1,2) order by bank_account_id')).rows,[{balance:1000},{balance:1150}]);
 await assume(1,6);assert.equal((await db.query('select delete_bank_deposit($1) data',[original.depositId])).rows[0].data.success,true);
 await db.exec('reset role');assert.equal((await db.query('select balance::float8 balance from bank_account where bank_account_id=2')).rows[0].balance,1000);
 for(const table of ['bank_deposit','bank_deposit_line','journal','journal_line','bank_transaction','"transaction"'])assert.equal((await db.query('select count(*)::int count from '+table)).rows[0].count,0);
});

test('subsidiaria seleccionada y membresia vigente se aplican tambien a detalle y RLS',async t=>{
 await tx(t);await assume();const result=await save();await assume(1,1,2);
 await denied('select bank_deposit_detail($1)',[result.depositId]);await denied('select update_bank_deposit($1,$2)',[result.depositId,payload]);
 for(const table of ['bank_deposit','bank_deposit_line'])assert.equal((await db.query('select * from '+table)).rows.length,0);
 await assume(2,4);assert.equal((await db.query('select * from bank_deposit')).rows.length,0);
 await db.exec('reset role;delete from user_subsidiaries where user_id=1 and subsidiary_id=1');await assume();await denied('select bank_deposit_options()');
});

test('cuentas bancarias, contrapartidas, ubicaciones, entidades y dimensiones ajenas se rechazan sin escribir',async t=>{
 await tx(t);await assume();
 for(const p of [{...payload,bank_account_id:3},{...payload,bank_account_id:4},{...payload,location_id:2},
 {...payload,lines:[{amount:100,account_id:104}]},{...payload,lines:[{amount:100,account_id:103,entity_type:'Cliente',entity_id:11}]},
 {...payload,lines:[{amount:100,account_id:103,department_id:22}]}])await denied('select save_bank_deposit($1)',[p]);
 assert.equal((await db.query('select * from bank_deposit')).rows.length,0);
});

test('NaN, Infinity, importes nulos/vacios y tasas invalidas no contabilizan',async t=>{
 await tx(t);await assume();for(const p of [{...payload,exchange_rate:null},{...payload,exchange_rate:'Infinity'},{...payload,lines:[]},
 {...payload,lines:[{amount:'NaN',account_id:103}]},{...payload,lines:[{amount:null,account_id:103}]},{...payload,lines:[{amount:-1,account_id:103}]}])
 await denied('select save_bank_deposit($1)',[p],'22023');
 await db.exec('reset role');assert.equal((await db.query('select count(*)::int count from journal')).rows[0].count,0);
});

test('periodo original cerrado no se evade cambiando a otro periodo abierto',async t=>{
 await tx(t);await assume();const result=await save();await db.exec("reset role;update fiscal_periods set gl_closed=true where fiscal_period_id=10;insert into fiscal_periods(fiscal_period_id,subsidiary_id,start_date,end_date,is_closed) values(11,1,'2026-10-01','2026-10-31',false)");
 await assume(1,2);await denied('select update_bank_deposit($1,$2)',[result.depositId,{...payload,fiscal_period_id:11}],'55000');
 await assume(1,6);await denied('select delete_bank_deposit($1)',[result.depositId],'55000');
});

test('movimientos conciliados o incluidos en conciliacion cerrada no se editan ni eliminan',async t=>{
 await tx(t);await assume();const result=await save();await db.exec("reset role;update bank_transaction set reconciliation_status='CONCILIADO'");
 await assume(1,2);await denied('select update_bank_deposit($1,$2)',[result.depositId,payload],'55000');await assume(1,6);await denied('select delete_bank_deposit($1)',[result.depositId],'55000');
 await db.exec("reset role;update bank_transaction set reconciliation_status='PENDIENTE_EN_TRANSITO';insert into bank_reconciliation values(1,'2026-10-31','CERRADA')");
 await assume(1,6);await denied('select delete_bank_deposit($1)',[result.depositId],'55000');
});

test('punteros contables o bancarios inconsistentes no permiten exponer o mutar otra subsidiaria',async t=>{
 await tx(t);await assume();const result=await save();await db.exec('reset role');await db.query('update journal set subsidiary_id=2 where journal_id=$1',[result.journalId]);
 await assume();await denied('select bank_deposit_detail($1)',[result.depositId]);await denied('select update_bank_deposit($1,$2)',[result.depositId,payload]);
 await db.exec('reset role');await db.query('update bank_deposit set bank_account_id=3 where deposit_id=$1',[result.depositId]);await assume();
 const report=(await db.query('select bank_deposit_report($1) data',[{dateFrom:'2026-10-01',dateTo:'2026-10-31'}])).rows[0].data;assert.equal(report.rows.length,0);
});

test('clientes no escriben ni truncan encabezados o lineas de depositos',async t=>{
 await tx(t);await assume();await save();for(const table of ['bank_deposit','bank_deposit_line']){
  for(const sql of [`insert into ${table} default values`,`delete from ${table}`,`truncate ${table}`])await denied(sql);
 }await denied('update bank_deposit set total_amount=1');await denied('update bank_deposit_line set amount=1');
});

test('clasificacion de origen inconsistente exige revision sin impedir la consulta autorizada',async t=>{
 await tx(t);await assume();const result=await save();await db.exec('reset role');
 await db.query('update "transaction" set transaction_type_id=1 where transaction_id=(select transaction_id from journal where journal_id=$1)',[result.journalId]);
 await assume(1,3);assert.ok((await db.query('select bank_deposit_detail($1) data',[result.depositId])).rows[0].data.deposit);
 await assume(1,2);await denied('select update_bank_deposit($1,$2)',[result.depositId,payload]);
 await assume(1,6);await denied('select delete_bank_deposit($1)',[result.depositId]);
 await db.exec('reset role');assert.equal((await db.query('select balance::float8 balance from bank_account where bank_account_id=1')).rows[0].balance,1100);
});
