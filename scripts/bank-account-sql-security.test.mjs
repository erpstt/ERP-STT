import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {test,before,after} from 'node:test';
import {PGlite} from '@electric-sql/pglite';
const db=new PGlite();const read=p=>readFile(new URL(p,import.meta.url),'utf8');
before(async()=>{
 for(const file of ['consolidation-security.sql','bank-transfer-security.sql'])await db.exec(await read('./fixtures/'+file));
 await db.exec(await read('../supabase/migrations/20260902090000_bank_account_transfers.sql'));
 await db.exec('begin');await db.exec(await read('../supabase/migrations/20261031015835_secure_bank_transfers.sql'));await db.exec('commit');
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
const payload={account_number:'SYNTHETIC-NEW',bank_id:1,subsidiary_id:1,currency_id:1,account_id:101,country_id:1,is_credit_card:false};
const create=async p=>(await db.query('select create_bank_account($1) data',[p||payload])).rows[0].data;
const rpcs=["create_bank_account('{}')","update_bank_account(1,'{}')",'delete_bank_account(1)'];

test('anon/service_role no ejecutan RPC y cuerpos privados no son API de clientes',async t=>{
 await tx(t);for(const role of ['anon','service_role']){await db.exec(`reset role;set role ${role}`);for(const rpc of rpcs)await denied('select '+rpc);}
 await assume();await denied("select bank_account_private.mutate(null,'{}','create')");
});
test('rol activo, identidad y membresia se comprueban antes de escribir',async t=>{
 await tx(t);
 for(const identity of [[2,4,1],[1,3,1],[1,5,1],[3,1,2]]){await assume(...identity);for(const rpc of rpcs)await denied('select '+rpc);}
 await db.exec('reset role;update users set is_active=false where user_id=4');await assume(4,5);for(const rpc of rpcs)await denied('select '+rpc);
 await db.exec('reset role;delete from user_subsidiaries where user_id=1 and subsidiary_id=1');await assume();await denied('select create_bank_account($1)',[payload]);
});
test('administracion legitima crea en cero, permite editar metadatos y eliminar cuenta sin actividad',async t=>{
 await tx(t);await assume();const row=await create();assert.equal(Number(row.balance),0);
 const edited=(await db.query('select update_bank_account($1,$2) data',[row.bank_account_id,{account_number:'SYNTHETIC-EDIT',iban:'SYNTHETIC-IBAN'}])).rows[0].data;
 assert.equal(edited.account_number,'SYNTHETIC-EDIT');assert.equal(Number(edited.balance),0);
 await db.query('select update_bank_account($1,$2)',[row.bank_account_id,{account_id:102,is_credit_card:true}]);
 await db.query('select delete_bank_account($1)',[row.bank_account_id]);
 await db.exec('reset role');assert.equal((await db.query('select 1 from bank_account where bank_account_id=$1',[row.bank_account_id])).rows.length,0);
});
test('permiso create no concede edit/delete; administrador tampoco elude subsidiaria',async t=>{
 await tx(t);await assume(1,2);const row=await create();await denied('select update_bank_account($1,$2)',[row.bank_account_id,{}]);await denied('select delete_bank_account($1)',[row.bank_account_id]);
 await assume(4,5);await denied('select update_bank_account(3,$1)',[{}]);await denied('select delete_bank_account(3)');await denied('select create_bank_account($1)',[{...payload,subsidiary_id:2}]);
});
test('saldo nunca es editable; saldo inicial diferente de cero, no finito, nulo o campos audit falsificados son rechazados',async t=>{
 await tx(t);await assume();const row=await create({...payload,balance:0});
 for(const balance of [1,-1,'NaN','Infinity','-Infinity',null])await denied('select create_bank_account($1)',[{...payload,balance}],'22023');
 for(const balance of [0,1,null,'NaN'])await denied('select update_bank_account($1,$2)',[row.bank_account_id,{balance}],'22023');
 for(const extra of [{bank_account_id:1},{created_by_email:'forged'},{updated_by_id:'forged'}])await denied('select create_bank_account($1)',[{...payload,...extra}],'22023');
});
test('pais, banco, moneda y cuenta contable deben ser validos y de la subsidiaria',async t=>{
 await tx(t);await assume();
 for(const bad of [{bank_id:2},{country_id:2},{subsidiary_id:2},{currency_id:999},{account_id:104}])await denied('select create_bank_account($1)',[{...payload,...bad}]);
 for(const field of ['is_inactive','is_summary','accepts_entries','currency_id']){
  await db.exec('reset role');await db.query(`update chart_accounts set ${field}=$1 where account_id=101`,[field==='currency_id'?2:field!=='accepts_entries']);await assume();await denied('select create_bank_account($1)',[payload]);
  await db.exec('reset role');await db.query(`update chart_accounts set ${field}=$1 where account_id=101`,[field==='currency_id'?null:field==='accepts_entries']);
 }
});
test('cuenta con saldo o referencia no se elimina ni cambia su enlace contable aunque saldo sea cero',async t=>{
 await tx(t);await assume();await denied('select delete_bank_account(1)',[],'55000');await denied('select update_bank_account(1,$1)',[{account_id:102}],'55000');
 const row=await create();await db.exec('reset role');await db.query('insert into synthetic_opening_account values(1,$1)',[row.bank_account_id]);await assume();
 for(const change of [{bank_id:2,country_id:2},{account_id:102},{currency_id:2},{is_credit_card:true}]){
  // Valid scope is checked before historical linkage; bank/country mismatch remains denied.
  await denied('select update_bank_account($1,$2)',[row.bank_account_id,change],change.bank_id?'42501':'55000');
 }
 await denied('select delete_bank_account($1)',[row.bank_account_id],'55000');
 const edited=(await db.query('select update_bank_account($1,$2) data',[row.bank_account_id,{iban:'REFERENCE-PRESERVED'}])).rows[0].data;assert.equal(edited.iban,'REFERENCE-PRESERVED');
});
test('privilegios por tabla y columna no permiten DML/TRUNCATE incluso a service_role',async t=>{
 await tx(t);
 for(const role of ['anon','authenticated','service_role']){await db.exec(`reset role;set role ${role}`);
  for(const sql of ['insert into bank_account default values','update bank_account set balance=0','update bank_account set account_number=\'FORGED\'','delete from bank_account','truncate bank_account'])await denied(sql);
 }
});
test('transferencia autorizada sigue modificando saldos mediante su funcion privada tras revocar DML',async t=>{
 await tx(t);await assume();const result=(await db.query('select create_bank_transfer($1) data',[{transferDate:'2026-10-10',sourceAccountId:1,destinationAccountId:2,sourceAmount:100,destinationAmount:100}])).rows[0].data;assert.ok(result.transferId);
 await db.exec('reset role');assert.deepEqual((await db.query('select balance::float8 balance from bank_account where bank_account_id in(1,2) order by bank_account_id')).rows,[{balance:900},{balance:1100}]);
});
