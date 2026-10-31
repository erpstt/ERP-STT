import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {test,before,after} from 'node:test';
import {PGlite} from '@electric-sql/pglite';

const db=new PGlite();
const read=name=>readFile(new URL(name,import.meta.url),'utf8');
before(async()=>{
 await db.exec(await read('./fixtures/consolidation-security.sql'));
 await db.exec(await read('./fixtures/bank-transfer-security.sql'));
 await db.exec(await read('../supabase/migrations/20260902090000_bank_account_transfers.sql'));
 await db.exec('begin');
 await db.exec(await read('../supabase/migrations/20261031015835_secure_bank_transfers.sql'));
 await db.exec('commit');
});
after(async()=>db.close());
async function transaction(t){await db.exec('reset role;begin');t.after(async()=>db.exec('rollback;reset role'));}
async function assume(user=1,role=1,sid=1){
 await db.exec('reset role');
 await db.query(`insert into user_role_sessions values('fixture',$1,$2) on conflict(session_id) do update set user_id=$1,role_id=$2`,[user,role]);
 await db.query(`insert into user_company_sessions values('fixture',$1,$2) on conflict(session_id) do update set user_id=$1,subsidiary_id=$2`,[user,sid]);
 await db.query(`select set_config('request.jwt.claims',$1,false)`,[JSON.stringify({sub:`00000000-0000-0000-0000-${String(user).padStart(12,'0')}`,session_id:'fixture',role:'authenticated'})]);
 await db.exec('set role authenticated');
}
async function denied(sql,code='42501',params=[]){
 await db.exec('savepoint expected_denial');
 try{await assert.rejects(db.query(sql,params),e=>e.code===code);}
 finally{await db.exec('rollback to savepoint expected_denial;release savepoint expected_denial');}
}
const payload={transferDate:'2026-10-10',sourceAccountId:1,destinationAccountId:2,sourceAmount:100,destinationAmount:100};
const create=async(p=payload)=>(await db.query('select create_bank_transfer($1) data',[p])).rows[0].data;
const rpcs=['bank_transfer_options()',"create_bank_transfer('{}')","run_bank_transfer_report('{}')",'bank_transfer_journal(0)'];

test('anon y service_role no ejecutan RPC; calculos privados no son API para usuarios',async t=>{
 await transaction(t);
 for(const role of ['anon','service_role']){await db.exec(`reset role;set role ${role}`);for(const rpc of rpcs)await denied(`select public.${rpc}`);}
 await assume();await denied('select bank_transfer_private.create_bank_transfer(\'{}\')');
});

test('los cuatro RPC comprueban rol activo, membresia y usuario activo antes de operar',async t=>{
 await transaction(t);
 for(const identity of [[2,4,1],[1,5,1],[3,1,2]]){await assume(...identity);for(const rpc of rpcs)await denied(`select public.${rpc}`);}
 await assume(1,3);await denied('select create_bank_transfer($1)','42501',[payload]);
 await db.exec('reset role;delete from user_subsidiaries where user_id=1 and subsidiary_id=1');await assume();
 await denied('select bank_transfer_options()');
 await db.exec('reset role;update users set is_active=false where user_id=4');await assume(4,5);
 await denied('select bank_transfer_options()');
});

test('transferencia legitima conserva saldos, asiento y movimientos; lectura no permite crear',async t=>{
 await transaction(t);await assume();
 const options=(await db.query('select bank_transfer_options() data')).rows[0].data;
 assert.equal(options.subsidiaryId,1);assert.ok(options.accounts.every(a=>a.id!==3));
 const result=await create();assert.ok(result.transferId);assert.ok(result.journalId);
 await db.exec('reset role');
 assert.deepEqual((await db.query('select bank_account_id,balance::float8 balance from bank_account where bank_account_id in(1,2) order by bank_account_id')).rows,
 [{bank_account_id:1,balance:900},{bank_account_id:2,balance:1100}]);
 const journal=(await db.query('select total_debit::float8 debit,total_credit::float8 credit from journal')).rows[0];
 assert.deepEqual(journal,{debit:100,credit:100});assert.equal((await db.query('select * from bank_transaction')).rows.length,2);
 await assume(1,3);
 const detail=(await db.query('select bank_transfer_journal($1) data',[result.transferId])).rows[0].data;
 assert.equal(detail.lines.length,2);
 const report=(await db.query('select run_bank_transfer_report($1) data',[{dateFrom:'2026-10-01',dateTo:'2026-10-31'}])).rows[0].data;
 assert.equal(report.rows.length,1);assert.equal(report.summary.totalTransferred,100);
 await denied('select create_bank_transfer($1)','42501',[payload]);
});

test('cuentas bancarias y contables ajenas, comisiones ajenas e importes no finitos son rechazados sin escribir',async t=>{
 await transaction(t);await assume();
 for(const invalid of [{...payload,destinationAccountId:3},{...payload,destinationAccountId:4},
 {...payload,commissionAmount:1,commissionAccountId:104},{...payload,commissionAmount:1,commissionAccountId:101}])await denied('select create_bank_transfer($1)','42501',[invalid]);
 for(const invalid of [{...payload,sourceAmount:null},{...payload,destinationAmount:'NaN'},
 {...payload,sourceAmount:'Infinity'},{...payload,commissionAmount:'-Infinity'},{...payload,destinationAccountId:1}])
 await denied('select create_bank_transfer($1)','22023',[invalid]);
 await db.exec('reset role');assert.equal((await db.query('select * from bank_transfer')).rows.length,0);
 assert.equal((await db.query('select * from journal')).rows.length,0);
 assert.equal((await db.query('select balance::float8 balance from bank_account where bank_account_id=1')).rows[0].balance,1000);
});

test('comision valida se contabiliza con saldo y asiento equilibrados',async t=>{
 await transaction(t);await assume();await create({...payload,commissionAmount:5,commissionAccountId:103});
 await db.exec('reset role');
 const j=(await db.query('select total_debit::float8 debit,total_credit::float8 credit from journal')).rows[0];assert.deepEqual(j,{debit:105,credit:105});
 const lines=(await db.query('select sum(debit_fx)::float8 debit,sum(credit_fx)::float8 credit from journal_line')).rows[0];assert.deepEqual(lines,{debit:105,credit:105});
 assert.equal((await db.query('select balance::float8 balance from bank_account where bank_account_id=1')).rows[0].balance,895);
});

test('RLS y consulta de asiento niegan subsidiarias ajenas y bloquean escritura directa',async t=>{
 await transaction(t);await assume();const own=await create();
 await db.exec('reset role');await db.query('insert into bank_transfer(transfer_number,from_account_id,to_account_id,amount,transfer_date,subsidiary_id,accreditation_date,source_amount,destination_amount,applied_exchange_rate,source_base_rate,destination_base_rate,source_base_amount,destination_base_amount,journal_id) values(\'FOREIGN\',3,3,1,\'2026-10-10\',2,\'2026-10-10\',1,1,1,1,1,1,1,$1)',[own.journalId]);
 await assume(1,3);assert.equal((await db.query('select * from bank_transfer')).rows.length,1);
 const foreign=(await db.query('select transfer_id from bank_transfer where transfer_number=\'FOREIGN\'')).rows;assert.equal(foreign.length,0);
 await denied('select bank_transfer_journal(999999)');
 for(const sql of ['insert into bank_transfer default values','update bank_transfer set amount=1','delete from bank_transfer','truncate bank_transfer'])await denied(sql);
 await assume(2,4);assert.equal((await db.query('select * from bank_transfer')).rows.length,0);
});

test('punteros inconsistentes no exponen datos de cuentas o asientos de otra subsidiaria',async t=>{
 await transaction(t);await assume();const own=await create();
 await db.exec('reset role');await db.query('update bank_transfer set to_account_id=3 where transfer_id=$1',[own.transferId]);
 await assume();await denied(`select bank_transfer_journal(${own.transferId})`);
 const report=(await db.query('select run_bank_transfer_report($1) data',[{dateFrom:'2026-10-01',dateTo:'2026-10-31'}])).rows[0].data;assert.equal(report.rows.length,0);
 await db.exec('reset role');await db.query('update bank_transfer set to_account_id=2 where transfer_id=$1',[own.transferId]);
 await db.query('update journal set subsidiary_id=2 where journal_id=$1',[own.journalId]);
 await assume();await denied(`select bank_transfer_journal(${own.transferId})`);
});
