import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {test,before,after} from 'node:test';
import {PGlite} from '@electric-sql/pglite';
import {loadLegacyJournalFunctions} from './fixtures/load-legacy-journal-functions.mjs';
const db=new PGlite();const read=p=>readFile(new URL(p,import.meta.url),'utf8');
before(async()=>{
 for(const f of ['consolidation-security.sql','bank-transfer-security.sql','manual-journal-security.sql'])await db.exec(await read('./fixtures/'+f));
 const dims=await read('./journal-csv-test-fixture.sql');await db.exec(dims.slice(dims.indexOf('create table customers')));
 await loadLegacyJournalFunctions(db);await db.exec('begin');await db.exec(await read('../supabase/migrations/20261031022533_secure_manual_journals.sql'));await db.exec('commit');
 await db.exec(await read('./fixtures/bank-deposit-security.sql'));
 await db.exec(await read('../supabase/migrations/20260902090000_bank_account_transfers.sql'));
 await db.exec(await read('./fixtures/bank-account-security.sql'));
 await db.exec('begin');await db.exec(await read('../supabase/migrations/20261031031441_secure_bank_account_writes.sql'));await db.exec('commit');
 await db.exec(await read('./fixtures/bank-fee-security.sql'));
 for(const f of ['20260903180000_bank_fees_transaction.sql','20260903190000_fix_bank_fee_options.sql','20260903200000_manage_bank_fees.sql','20261027200000_bank_reconciliation_statement_fees.sql'])await db.exec(await read('../supabase/migrations/'+f));
 // Reproduce the later shared helper, including its permissive unassigned-account fallback.
 await db.exec(`create or replace function public.bank_fee_expense_account(p_sid bigint) returns bigint language sql stable as $$select a.account_id from chart_accounts a where lower(a.account_name) like '%comisi%' and(exists(select 1 from account_subsidiaries s where s.account_id=a.account_id and s.subsidiary_id=p_sid and s.is_active) or not exists(select 1 from account_subsidiaries s where s.account_id=a.account_id)) order by a.account_number limit 1$$`);
 await db.exec("insert into role_access_matrix values(1,'banking:bank-fees',true,true,true,true),(2,'banking:bank-fees',false,false,true,false),(3,'banking:bank-fees',true,false,false,false),(6,'banking:bank-fees',false,false,false,true)");
 await db.exec('grant all on bank_fee to authenticated;grant update(amount) on bank_fee to authenticated');
 await db.exec('begin');await db.exec(await read('../supabase/migrations/20261031121106_secure_bank_fees.sql'));await db.exec('commit');
});
after(()=>db.close());
async function tx(t){await db.exec('reset role;begin');t.after(()=>db.exec('rollback;reset role'));}
async function assume(user=1,role=1,sid=1){await db.exec('reset role');
 await db.query(`insert into user_role_sessions values('fixture',$1,$2) on conflict(session_id) do update set user_id=$1,role_id=$2`,[user,role]);
 await db.query(`insert into user_company_sessions values('fixture',$1,$2) on conflict(session_id) do update set user_id=$1,subsidiary_id=$2`,[user,sid]);
 await db.query(`select set_config('request.jwt.claims',$1,false)`,[JSON.stringify({sub:`00000000-0000-0000-0000-${String(user).padStart(12,'0')}`,session_id:'fixture'})]);await db.exec('set role authenticated');}
async function denied(sql,params=[],code='42501'){await db.exec('savepoint denial');try{await assert.rejects(db.query(sql,params),e=>e.code===code);}finally{await db.exec('rollback to savepoint denial;release savepoint denial');}}
const payload={bank_account_id:1,fee_date:'2026-10-10',amount:100,reference:'SYNTHETIC'};
const save=async p=>(await db.query('select save_bank_fee($1) d',[p||payload])).rows[0].d;
const rpcs=['bank_fee_options()',"bank_fee_report('{}')",'bank_fee_detail(0)',"save_bank_fee('{}')","import_bank_fees('{}')","update_bank_fee(0,'{}')",'delete_bank_fee(0)',"register_bank_statement_fees(0,'2026-10-31','{}')"];
test('ocho RPC comprueban identidad/rol/membresia; anon/service_role no ejecutan ni privados',async t=>{await tx(t);
 for(const role of ['anon','service_role']){await db.exec(`reset role;set role ${role}`);for(const rpc of rpcs)await denied('select '+rpc);}
 for(const identity of [[2,4,1],[1,5,1],[3,1,2]]){await assume(...identity);for(const rpc of rpcs)await denied('select '+rpc);}
 await assume();await denied("select bank_fee_private.post_checked('{}',true)");await denied("select bank_fee_private.post_bank_fee_internal('{}',true)");
 await db.exec('reset role;delete from user_subsidiaries where user_id=1 and subsidiary_id=1');await assume();await denied('select bank_fee_options()');
});
test('comision manual contabiliza dos lineas equilibradas y eliminar restaura saldo',async t=>{await tx(t);await assume();const r=await save();
 const d=(await db.query('select bank_fee_detail($1) d',[r.id])).rows[0].d;assert.equal(d.impact.length,2);
 await db.exec('reset role');assert.deepEqual((await db.query('select sum(debit)::float8 d,sum(credit)::float8 c from journal_line where journal_id=$1',[r.journalId])).rows[0],{d:100,c:100});assert.equal((await db.query('select balance::float8 b from bank_account where bank_account_id=1')).rows[0].b,900);
 await assume(1,3);await denied('select save_bank_fee($1)',[payload]);await assume(1,6);await db.query('select delete_bank_fee($1)',[r.id]);await db.exec('reset role');assert.equal((await db.query('select balance::float8 b from bank_account where bank_account_id=1')).rows[0].b,1000);
});
test('editar solo requiere edit, regenera documento y cambia banco sin transferir su reintegro',async t=>{await tx(t);await assume();const r=await save();await assume(1,2);
 const updated=(await db.query('select update_bank_fee($1,$2) d',[r.id,{...payload,bank_account_id:2,amount:150}])).rows[0].d;assert.notEqual(updated.id,r.id);await denied('select save_bank_fee($1)',[payload]);await denied('select delete_bank_fee($1)',[updated.id]);
 await db.exec('reset role');assert.deepEqual((await db.query('select balance::float8 b from bank_account where bank_account_id in(1,2) order by bank_account_id')).rows,[{b:1000},{b:850}]);
});
test('importacion legitima es atomica y valida cada fila; error posterior no conserva contabilizacion parcial',async t=>{await tx(t);await assume();
 const rows=[{account:'DEMO-A',date:'2026-10-10',amount:10},{account:'DEMO-B',date:'2026-10-10',amount:20}];assert.equal((await db.query('select import_bank_fees($1) d',[{rows}])).rows[0].d.created,2);
 await denied('select import_bank_fees($1)',[{rows:[rows[0],{...rows[1],amount:'NaN'}]}],'22023');
 await db.exec('reset role');assert.equal((await db.query('select count(*) n from bank_fee')).rows[0].n,2);
});
test('alcance de banco/ledger/gasto es obligatorio y cuenta sin asignacion ya no es elegible',async t=>{await tx(t);await assume();
 for(const bank_account_id of [3,4])await denied('select save_bank_fee($1)',[{...payload,bank_account_id}]);
 await db.exec('reset role;delete from account_subsidiaries where account_id=103');await assume();await denied('select save_bank_fee($1)',[payload]);
 await db.exec('reset role;insert into account_subsidiaries values(103,1,true);update chart_accounts set is_summary=true where account_id=103');await assume();await denied('select save_bank_fee($1)',[payload]);
});
test('NaN/Infinity/nulos/tasas invalidas, tarjetas y sobregiro manual son rechazados',async t=>{await tx(t);await assume();
 for(const amount of [null,0,-1,'NaN','Infinity','-Infinity'])await denied('select save_bank_fee($1)',[{...payload,amount}],'22023');
 await denied('select save_bank_fee($1)',[{...payload,amount:1001,p_allow_statement_overdraft:true}],'55000');
 await db.exec('reset role;update bank_account set is_credit_card=true where bank_account_id=2');await assume();await denied('select save_bank_fee($1)',[{...payload,bank_account_id:2}]);
 await db.exec("reset role;update bank_account set currency_id=2 where bank_account_id=1;insert into exchange_rates values(2,1,'2026-10-10','NaN')");await assume();await denied('select save_bank_fee($1)',[payload],'22023');
});
test('periodo original cerrado no puede evadirse cambiando a fecha abierta',async t=>{await tx(t);await assume();const r=await save();await db.exec("reset role;update fiscal_periods set gl_closed=true where fiscal_period_id=10;insert into fiscal_periods(fiscal_period_id,subsidiary_id,start_date,end_date,is_closed) values(11,1,'2026-11-01','2026-11-30',false)");await assume();
 await denied('select update_bank_fee($1,$2)',[r.id,{...payload,fee_date:'2026-11-10'}],'55000');await denied('select delete_bank_fee($1)',[r.id],'55000');await denied('select save_bank_fee($1)',[payload],'55000');
});
test('conciliacion cerrada o movimiento conciliado bloquean mantenimiento',async t=>{await tx(t);await assume();const r=await save();await db.exec("reset role;update bank_transaction set reconciliation_status='CONCILIADO'");await assume();await denied('select delete_bank_fee($1)',[r.id],'55000');await denied('select update_bank_fee($1,$2)',[r.id,payload],'55000');
 await db.exec("reset role;update bank_transaction set reconciliation_status='PENDIENTE_EN_TRANSITO';insert into bank_reconciliation(bank_account_id,reconciliation_date,status) values(1,'2026-10-31','CERRADA')");await assume();await denied('select delete_bank_fee($1)',[r.id],'55000');await denied('select save_bank_fee($1)',[payload],'55000');
});
test('extracto confirmado permite sobregiro y concilia atomico; no se puede repetir o editar/eliminar despues',async t=>{await tx(t);await assume();await db.exec('reset role;update bank_account set balance=5 where bank_account_id=1');await assume();
 const r=(await db.query("select register_bank_statement_fees(1,'2026-10-31',array[1::bigint]) d")).rows[0].d;assert.equal(r.createdCount,1);
 await denied('select delete_bank_fee($1)',[r.feeIds[0]],'55000');await denied('select update_bank_fee($1,$2)',[r.feeIds[0],payload],'55000');
 await db.exec('reset role');assert.equal((await db.query('select balance::float8 b from bank_account where bank_account_id=1')).rows[0].b,-5);assert.equal((await db.query('select count(*) n from bank_reconciliation_match')).rows[0].n,1);
 await assume();await denied("select register_bank_statement_fees(1,'2026-10-31',array[1::bigint])",[],'P0001');
});
test('extracto rechaza lineas ajenas, duplicadas, invalidas y cierre sin contabilizacion parcial',async t=>{await tx(t);await assume();
 for(const ids of [[1,2],[1,1],[]])await denied("select register_bank_statement_fees(1,'2026-10-31',$1)",[ids],'P0001');
 await db.exec("reset role;update bank_statement_line set amount='NaN' where statement_line_id=3");await assume();await denied("select register_bank_statement_fees(1,'2026-10-31',array[1::bigint,3::bigint])",[],'P0001');
 await db.exec('reset role');assert.equal((await db.query('select count(*) n from bank_fee')).rows[0].n,0);
});
test('RLS, reporte y detalle no exponen punteros ajenos; clasificacion historica inconsistente no se modifica',async t=>{await tx(t);await assume();const r=await save();await db.exec('reset role;update "transaction" set transaction_type_id=1');await assume();assert.ok((await db.query('select bank_fee_detail($1) d',[r.id])).rows[0].d);await denied('select delete_bank_fee($1)',[r.id]);
 await db.exec('reset role;update bank_fee set bank_account_id=3');await assume();assert.equal((await db.query('select count(*) n from bank_fee')).rows[0].n,0);await denied('select bank_fee_detail($1)',[r.id]);const report=(await db.query('select bank_fee_report($1) d',[{dateFrom:'2026-10-01',dateTo:'2026-10-31'}])).rows[0].d;assert.equal(report.rows.length,0);
});
test('privilegios de tabla/columna no permiten DML/TRUNCATE ni publicar helper de sobregiro',async t=>{await tx(t);for(const role of ['anon','authenticated','service_role']){await db.exec(`reset role;set role ${role}`);for(const sql of ['insert into bank_fee default values','update bank_fee set amount=1','delete from bank_fee','truncate bank_fee'])await denied(sql);}
 await db.exec('reset role');assert.equal((await db.query("select to_regprocedure('public.post_bank_fee_internal(jsonb,boolean)') f")).rows[0].f,null);assert.ok((await db.query("select to_regprocedure('public.bank_fee_expense_account(bigint)') f")).rows[0].f);
});
