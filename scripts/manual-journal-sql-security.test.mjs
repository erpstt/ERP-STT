import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {test,before,after} from 'node:test';
import {PGlite} from '@electric-sql/pglite';
import {loadLegacyJournalFunctions} from './fixtures/load-legacy-journal-functions.mjs';
const db=new PGlite();const read=p=>readFile(new URL(p,import.meta.url),'utf8');
before(async()=>{
 await db.exec(await read('./fixtures/consolidation-security.sql'));
 await db.exec(await read('./fixtures/bank-transfer-security.sql'));
 await db.exec(await read('../supabase/migrations/20260902090000_bank_account_transfers.sql'));
 await db.exec('begin');await db.exec(await read('../supabase/migrations/20261031015835_secure_bank_transfers.sql'));await db.exec('commit');
 await db.exec(await read('./fixtures/manual-journal-security.sql'));
 const dims=await read('./journal-csv-test-fixture.sql');await db.exec(dims.slice(dims.indexOf('create table customers')));
 await db.exec('alter table cost_centers add column is_inactive boolean default false;alter table employees add column is_active boolean default true');
 await loadLegacyJournalFunctions(db);
 await db.exec('begin');await db.exec(await read('../supabase/migrations/20261031022533_secure_manual_journals.sql'));await db.exec('commit');
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
const payload={journal_type:'Asiento de Diario General',journal_date:'2026-10-10',currency_id:1,fiscal_period_id:10,exchange_rate:1,memo:'Synthetic journal',lines:[{account_id:101,debit:100,credit:0},{account_id:102,debit:0,credit:100}]};
const rows=[{asiento_referencia:'SYNTHETIC',tipo_asiento:'ASI_DIA',fecha:'2026-10-10',moneda:'USD',tipo_cambio:'1',nota_asiento:'Synthetic CSV',numero_cuenta:'101',debito:'100',credito:'0',nota_linea:'',mes_servicio:''},{asiento_referencia:'SYNTHETIC',tipo_asiento:'ASI_DIA',fecha:'2026-10-10',moneda:'USD',tipo_cambio:'1',nota_asiento:'Synthetic CSV',numero_cuenta:'102',debito:'0',credito:'100',nota_linea:'',mes_servicio:''}];
const create=async p=>(await db.query('select create_journal_entry($1) id',[p||payload])).rows[0].id;

test('anon, service_role y roles sin permiso no acceden a RPC ni helpers antiguos',async t=>{
 await tx(t);
 for(const role of ['anon','service_role']){await db.exec(`reset role;set role ${role}`);for(const sql of ["select create_journal_entry('{}')","select update_journal_entry(0,'{}')","select import_journal_csv('[]',false,1)",'select reverse_journal_entry(0)'])await denied(sql);}
 await assume(2,4);for(const sql of ["select create_journal_entry('{}')","select update_journal_entry(0,'{}')","select import_journal_csv('[]',true,1)"])await denied(sql);
 await assume();await denied("select create_journal_entry_without_service_country('{}')");await denied("select journal_entry_private.create_journal_entry('{}')");await denied("select next_manual_journal_number('Estándar',1)");
});

test('crear y editar con permisos separados conserva equilibrio y dimensiones de servicio',async t=>{
 await tx(t);await assume();const id=await create();
 await assume(1,2);await db.query('select update_journal_entry($1,$2)',[id,{...payload,memo:'Updated synthetic journal'}]);
 const result=(await db.query('select memo,total_debit::float8 debit,total_credit::float8 credit from journal where journal_id=$1',[id])).rows[0];
 assert.deepEqual(result,{memo:'Updated synthetic journal',debit:100,credit:100});
 await denied('select create_journal_entry($1)',[payload]);
 await assume();const pending={...payload,journal_type:'Asientos Pendientes de Facturar',lines:payload.lines.map(l=>({...l,service_country_id:1,service_month:'2026-09'}))};
 const pid=await create(pending);const saved=(await db.query('select service_country_id,service_month from journal_line where journal_id=$1',[pid])).rows;
 assert.equal(saved.length,2);assert.ok(saved.every(l=>l.service_country_id===1&&l.service_month==='2026-09'));
});

test('cuentas, monedas, entidades, dimensiones y subsidiarias ajenas son rechazadas',async t=>{
 await tx(t);await assume();
 for(const p of [{...payload,currency_id:2},{...payload,lines:[{...payload.lines[0],account_id:104},payload.lines[1]]},
 {...payload,lines:[{...payload.lines[0],entity_type:'Cliente',entity_id:11},payload.lines[1]]}])await denied('select create_journal_entry($1)',[p]);
 await assume(3,1,2);await denied('select create_journal_entry($1)',[payload]);
 await assume();await denied('select import_journal_csv($1,false,2)',[rows]);
 await db.exec('reset role;delete from user_subsidiaries where user_id=1 and subsidiary_id=1');await assume();await denied('select create_journal_entry($1)',[payload]);
});

test('periodos cerrados y asientos automaticos no se editan moviendolos a otro periodo',async t=>{
 await tx(t);await assume();const id=await create();
 await db.exec("reset role;insert into fiscal_periods(fiscal_period_id,subsidiary_id,start_date,end_date,is_closed) values(11,1,'2026-10-01','2026-10-31',false);update fiscal_periods set is_closed=true where fiscal_period_id=10");
 await assume();await denied('select update_journal_entry($1,$2)',[id,{...payload,fiscal_period_id:11}],'55000');
 await denied('select create_journal_entry($1)',[payload],'55000');
 await db.exec("reset role;update fiscal_periods set is_closed=false where fiscal_period_id=10;update journal set journal_type='Estándar' where journal_id="+id);
 await assume();await denied('select update_journal_entry($1,$2)',[id,payload],'55000');
});

test('importacion valida usa RPC autorizado, conserva idempotencia y preview no crea asientos',async t=>{
 await tx(t);await assume(1,3);
 const preview=(await db.query('select import_journal_csv($1,true,1) data',[rows])).rows[0].data;
 assert.equal(preview.valid,true);assert.equal(preview.created,0);await denied('select import_journal_csv($1,false,1)',[rows]);
 await assume();const posted=(await db.query('select import_journal_csv($1,false,1) data',[rows])).rows[0].data;
 assert.equal(posted.valid,true);assert.equal(posted.created,1);
 const repeat=(await db.query('select import_journal_csv($1,false,1) data',[rows])).rows[0].data;assert.equal(repeat.alreadyImported,true);
 assert.equal((await db.query('select * from journal')).rows.length,1);
});

test('escritura directa en encabezados, lineas y recibos esta revocada',async t=>{
 await tx(t);await assume();await create();
 for(const table of ['journal','journal_line','journal_csv_imports'])for(const statement of [`insert into ${table} default values`,`delete from ${table}`,`truncate ${table}`])await denied(statement);
 await denied('update journal set total_debit=1');await denied('update journal_line set debit=1');
});

test('montos negativos, NaN, Infinity y asientos desbalanceados no dejan escrituras',async t=>{
 await tx(t);await assume();
 for(const p of [{...payload,exchange_rate:'Infinity'},{...payload,lines:[{...payload.lines[0],debit:'NaN'},payload.lines[1]]},
 {...payload,lines:[{...payload.lines[0],debit:-100},payload.lines[1]]}])await denied('select create_journal_entry($1)',[p],'22023');
 await denied('select create_journal_entry($1)',[{...payload,lines:[{...payload.lines[0],debit:99},payload.lines[1]]}],'P0001');
 assert.equal((await db.query('select * from journal')).rows.length,0);
});

test('compatibilidad de llamadas internas de activos sin habilitar creador privado a clientes',async t=>{
 await tx(t);await assume(1,3);await denied('select create_journal_entry($1)',[payload]);
 await db.exec('reset role');const assetPayload={...payload,journal_type:'Estándar'};
 const first=(await db.query('select process_fixed_asset_proposals($1) id',[assetPayload])).rows[0].id;
 const second=(await db.query("select run_fixed_asset_depreciation('2026-10-10',$1) id",[assetPayload])).rows[0].id;
 assert.ok(first);assert.ok(second);assert.notEqual(first,second);
 await assume(1,3);await denied('select journal_entry_private.create_journal_entry($1)',[assetPayload]);
});

test('transferencias autorizadas siguen contabilizando tras revocar DML directo en journal',async t=>{
 await tx(t);await db.exec("insert into role_access_matrix values(3,'banking:bank-transfers',true,true,false,false)");
 await assume(1,3);await denied('select create_journal_entry($1)',[payload]);
 const transfer=(await db.query('select create_bank_transfer($1) data',[{transferDate:'2026-10-10',sourceAccountId:1,destinationAccountId:2,sourceAmount:10,destinationAmount:10}])).rows[0].data;
 assert.ok(transfer.journalId);await db.exec('reset role');
 const sums=(await db.query('select total_debit::float8 debit,total_credit::float8 credit from journal where journal_id=$1',[transfer.journalId])).rows[0];
 assert.deepEqual(sums,{debit:10,credit:10});
});

test('reversion requiere permiso tecnico del rol activo, subsidiaria seleccionada y estado vigente',async t=>{
 await tx(t);await assume();const id=await create();
 await denied('select reverse_journal_entry($1)',[id]);
 await assume(1,2,2);await denied('select reverse_journal_entry($1)',[id]);
 await assume(1,2);const reversed=(await db.query('select reverse_journal_entry($1) id',[id])).rows[0].id;
 assert.ok(reversed);assert.equal((await db.query('select status from journal where journal_id=$1',[id])).rows[0].status,'ANULADO');
 const sums=(await db.query('select sum(debit)::float8 debit,sum(credit)::float8 credit from journal_line where journal_id=$1',[reversed])).rows[0];assert.deepEqual(sums,{debit:100,credit:100});
 await denied('select reverse_journal_entry($1)',[id],'55000');
});
