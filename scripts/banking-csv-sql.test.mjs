import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {test,before,after} from 'node:test';
import {PGlite} from '@electric-sql/pglite';
import {setupBankingCsvImport} from './fixtures/setup-banking-csv-import.mjs';
const db=new PGlite();
const read=async name=>(await readFile(new URL(name,import.meta.url),'utf8')).replace(/\r\n/g,'\n');
before(async()=>{
 await setupBankingCsvImport(db);
 await db.exec('begin');try{await db.exec(await read('../supabase/migrations/20261105184055_add_banking_csv_atomic_import.sql'));await db.exec('commit');}catch(e){await db.exec('rollback');delete e.query;throw e;}
});
after(()=>db.close());
async function tx(t){await db.exec('reset role;begin');t.after(()=>db.exec('rollback;reset role'));}
async function assume(user=1,role=1,sid=1,session='fixture'){
 await db.exec('reset role');
 await db.query('insert into user_role_sessions values($1,$2,$3) on conflict(session_id) do update set user_id=$2,role_id=$3',[session,user,role]);
 await db.query('insert into user_company_sessions values($1,$2,$3) on conflict(session_id) do update set user_id=$2,subsidiary_id=$3',[session,user,sid]);
 await db.query("select set_config('request.jwt.claims',$1,false)",[JSON.stringify({sub:`00000000-0000-0000-0000-${String(user).padStart(12,'0')}`,session_id:session})]);await db.exec('set role authenticated');
}
async function rows(kind='CHECKS'){
 const file=kind==='CHECKS'?'plantilla-cheques-transferencias.csv':'plantilla-depositos-bancarios.csv';
 const [head,...lines]=(await read('../public/'+file)).replace(/^\uFEFF/,'').trimEnd().split('\n');
 const keys=head.split(';');
 return lines.map(line=>Object.fromEntries(keys.map((key,index)=>[key,line.split(';')[index]]))).map(row=>({...row,fecha:'2026-10-10',cuenta_bancaria:'DEMO-A',moneda:'USD',tipo_cambio:'1',numero_cuenta:'103',metodo_pago:'TRANSFERENCIA'}));
}
const preview=async(kind,data)=>(await db.query('select banking_csv_preview($1,$2,$3) data',[kind,data,1])).rows[0].data;
const confirm=async(kind,data,p)=>(await db.query('select banking_csv_import($1,$2,$3,$4,$5,$6) data',[kind,data,1,p.context,p.fingerprint,p.validationDigest])).rows[0].data;
async function snapshot(){await db.exec('reset role');const value=(await db.query(`select jsonb_build_object(
 'checks',(select count(*)from bank_check),'deposits',(select count(*)from bank_deposit),'transactions',(select count(*)from public."transaction"),
 'journals',(select count(*)from journal),'lines',(select count(*)from journal_line),'gl',(select count(*)from gl_impact),
 'bankTransactions',(select count(*)from bank_transaction),'receipts',(select count(*)from banking_csv_private.imports),'references',(select count(*)from banking_csv_private.documents),
 'banks',(select jsonb_agg(jsonb_build_array(bank_account_id,balance)order by bank_account_id)from bank_account),
 'sequences',(select jsonb_object_agg(sequencename,last_value)from pg_sequences where schemaname='public'))data`)).rows[0].data;await db.exec('set role authenticated');return value;}
async function denied(fn,code='42501'){await db.exec('savepoint deny');try{await assert.rejects(fn,e=>e.code===code);}finally{await db.exec('rollback to savepoint deny;release savepoint deny');}}
test('downloaded check template resolves groups through the real protected validators',async t=>{
 await tx(t);await assume();const data=await rows(),before=await snapshot();const p=await preview('CHECKS',data);assert.deepEqual(p.errors,[]);assert.equal(p.valid,true);assert.equal(p.entries.length,2);assert.equal(p.entries[0].lineCount,2);assert.deepEqual(await snapshot(),before,'preview must not consume any number, identity, balance or receipt');const result=await confirm('CHECKS',data,p);assert.equal(result.created,2);assert.ok(result.entries.every(x=>x.documentId&&x.journalId));assert.deepEqual(result.totals,[{currency:'USD',amount:'500.123456',localAmount:'500.123456',documents:2,lines:3}]);
 await db.exec('reset role');const books=(await db.query('select transaction_id,sum(debit_amount-credit_amount)::text balance from gl_impact where transaction_id is not null group by transaction_id')).rows;assert.equal(books.length,2);assert.ok(books.every(x=>Number(x.balance)===0));assert.equal((await db.query('select balance::text value from bank_account where bank_account_id=1')).rows[0].value,'499.876544');
});
test('downloaded deposit template imports methods, groups, balances and real GL without sequence use in preview',async t=>{
 await tx(t);await assume();const data=await rows('DEPOSITS'),before=await snapshot(),p=await preview('DEPOSITS',data);assert.deepEqual(p.errors,[]);assert.deepEqual(await snapshot(),before);const result=await confirm('DEPOSITS',data,p);assert.equal(result.created,2);assert.equal(result.totals[0].amount,'300.123456');await db.exec('reset role');assert.equal((await db.query('select count(*)::int n from bank_deposit_line where payment_method_id=1')).rows[0].n,3);assert.equal((await db.query('select balance::text n from bank_account where bank_account_id=1')).rows[0].n,'1300.123456');assert.equal((await db.query('select sum(debit_amount-credit_amount)::text n from gl_impact')).rows[0].n,'0.000000');
});
test('foreign check keeps original amounts and uses the explicit rate in real GL',async t=>{
 await tx(t);await assume();const [r]=await rows(),data=[{...r,documento_referencia:'FX-1',cuenta_bancaria:'SYN-FOREIGN',moneda:'CRC',tipo_cambio:'160.1234567890',importe:'100.123456'}];const p=await preview('CHECKS',data);assert.deepEqual(p.errors,[]);const result=await confirm('CHECKS',data,p);assert.equal(result.created,1);await db.exec('reset role');const gl=(await db.query('select sum(debit_amount)::text d,sum(credit_amount)::text c,sum(debit_fx)::text df,sum(credit_fx)::text cf from gl_impact where transaction_id is not null')).rows[0];assert.deepEqual(gl,{d:'16032.113880',c:'16032.113880',df:'100.123456',cf:'100.123456'});assert.equal(result.entries[0].amount,'100.123456');assert.equal(result.entries[0].localAmount,gl.d);
});
test('incompatible FX rounding is rejected by document before consuming numbers or financial writes',async t=>{
 await tx(t);await assume();const [r]=await rows();for(const kind of['CHECKS','DEPOSITS']){const data=[{...r,cuenta_bancaria:'SYN-FOREIGN',moneda:'CRC',tipo_cambio:'0.3333333333',importe:'1'},{...r,cuenta_bancaria:'SYN-FOREIGN',moneda:'CRC',tipo_cambio:'0.3333333333',importe:'1'}],before=await snapshot(),p=await preview(kind,data);assert.equal(p.valid,false);assert.equal(p.errors[0].row,2);assert.equal(p.errors[0].reference,r.documento_referencia);assert.match(p.errors[0].message,/-0\.000001/);assert.equal((await confirm(kind,data,p)).created,0);assert.deepEqual(await snapshot(),before);}
});
test('tax IDs, employee numbers and scoped dimensions resolve without exposing internal IDs',async t=>{
 await tx(t);await assume();const [r]=await rows();const data=[{...r,tipo_entidad:'CLIENTE',identificacion_entidad:'SYN-CUSTOMER-10',centro_costos:'Proyecto',clase:'Consultoria',acreedor_financiero:'Banco prueba',compania_relacionada:'Relacionada prueba'},
 {...r,documento_referencia:'EMP',tipo_entidad:'EMPLEADO',identificacion_entidad:'SYN-EMPLOYEE-10',departamento:'Administracion'},
 {...r,documento_referencia:'AGENCY',tipo_entidad:'AGENCIA_TRIBUTARIA',identificacion_entidad:'SYN-AGENCY-1'}];const p=await preview('CHECKS',data);assert.deepEqual(p.errors,[]);assert.equal((await confirm('CHECKS',data,p)).created,3);await db.exec('reset role');const lines=(await db.query('select customer_id,employee_id,tax_agency_id,department_id,cost_center_id,class_id,financial_creditor_id,related_company_id from bank_check_line order by check_line_id')).rows;assert.equal(lines[0].customer_id,10);assert.equal(lines[0].department_id,20);assert.equal(lines[0].cost_center_id,40);assert.equal(lines[0].class_id,30);assert.equal(lines[0].financial_creditor_id,50);assert.equal(lines[0].related_company_id,60);assert.equal(lines[1].employee_id,10);assert.equal(lines[2].tax_agency_id,1);
});
test('validation returns row errors and leaves every document, receipt and sequence unchanged',async t=>{
 await tx(t);await assume();const data=await rows();data[1].importe='1,234.50';data[2].numero_cuenta='104';const before=await snapshot(),p=await preview('CHECKS',data);assert.equal(p.valid,false);assert.ok(p.errors.some(e=>e.row===3&&e.field==='importe'));assert.ok(p.errors.some(e=>e.row===4));const result=await confirm('CHECKS',data,p);assert.equal(result.created,0);assert.equal(result.valid,false);assert.deepEqual(await snapshot(),before);
});
test('required document reference errors identify their source row',async t=>{
 await tx(t);await assume();const [r]=await rows(),before=await snapshot(),p=await preview('CHECKS',[{...r,documento_referencia:''}]);assert.equal(p.valid,false);assert.equal(p.errors[0].row,2);assert.equal(p.errors[0].field,'documento_referencia');assert.deepEqual(p.entries,[]);assert.equal((await confirm('CHECKS',[{...r,documento_referencia:''}],p)).created,0);assert.deepEqual(await snapshot(),before);
});
test('SQL row/document limits and maximum-size preview remain bounded and write-free',async t=>{
 await tx(t);await assume();const [r]=await rows();await denied(()=>preview('CHECKS',Array(2001).fill(r)),'22023');await denied(()=>preview('CHECKS',Array.from({length:201},(_,i)=>({...r,documento_referencia:'DOC-'+i}))),'22023');const before=await snapshot(),data=Array.from({length:2000},(_,i)=>({...r,importe:'0.000001',nota_linea:'Synthetic row '+i})),start=performance.now(),p=await preview('CHECKS',data);assert.equal(p.valid,true);assert.equal(p.entries[0].lineCount,2000);assert.equal(p.totals[0].amount,'0.002000');assert.deepEqual(await snapshot(),before);t.diagnostic('In-memory real-validator 2000-row preview: '+Math.round(performance.now()-start)+' ms; no network/production latency inference.');
});
test('mismatched headers, ambiguous names, foreign entities and internal IDs fail by row',async t=>{
 await tx(t);await assume();const [r]=await rows();for(const patch of[{tipo_entidad:'CLIENTE',identificacion_entidad:'SYN-CUSTOMER-11'},{tipo_entidad:'PROVEEDOR',identificacion_entidad:'ID:10'},{acreedor_financiero:'Duplicado'},{centro_costos:'ID:40'},{ubicacion:'Synthetic unassigned location'},{moneda:'USD',tipo_cambio:'2'}]){const p=await preview('CHECKS',[{...r,...patch}]);assert.equal(p.valid,false,JSON.stringify(patch));assert.equal(p.errors[0].row,2);}
 const data=[r,{...r,beneficiario:'Different beneficiary'}],p=await preview('CHECKS',data);assert.equal(p.valid,false);assert.match(p.errors[0].message,/encabezado/);assert.equal(p.errors[0].row,3);
});
test('cumulative outgoing totals are checked before any writer or numbering call',async t=>{
 await tx(t);await assume();const [r]=await rows(),data=[{...r,documento_referencia:'FIRST',importe:'600'},{...r,documento_referencia:'SECOND',importe:'600'}],before=await snapshot();const p=await preview('CHECKS',data);assert.equal(p.valid,false);assert.match(p.errors.at(-1).message,/acumulados/);assert.equal((await confirm('CHECKS',data,p)).created,0);assert.deepEqual(await snapshot(),before);
});
test('lost-response retries return the durable receipt and never debit or post twice',async t=>{
 await tx(t);await assume();const data=await rows(),p=await preview('CHECKS',data),first=await confirm('CHECKS',data,p),after=await snapshot();const again=await confirm('CHECKS',data,p);assert.equal(again.created,0);assert.equal(again.alreadyImported,true);assert.equal(again.receiptId,first.receiptId);assert.deepEqual(again.entries,first.entries);assert.deepEqual(await snapshot(),after);const repeatedPreview=await preview('CHECKS',data);assert.equal(repeatedPreview.alreadyImported,true);assert.equal(repeatedPreview.created,0);assert.deepEqual(await snapshot(),after);
});
test('reordering or editing an imported file cannot reuse a document reference',async t=>{
 await tx(t);await assume();const data=await rows(),p=await preview('CHECKS',data);await confirm('CHECKS',data,p);const before=await snapshot();for(const changed of[[...data].reverse(),data.map(r=>({...r,nota_linea:'changed'}))]){const next=await preview('CHECKS',changed);assert.equal(next.valid,false);assert.ok(next.errors.every(e=>/referencia ya/.test(e.message)));assert.equal((await confirm('CHECKS',changed,next)).created,0);}assert.deepEqual(await snapshot(),before);
});
test('preview is bound to exact file, company, role, Auth session and master-data state',async t=>{
 await tx(t);await assume();const data=await rows(),p=await preview('CHECKS',data);await denied(()=>confirm('CHECKS',data.map(r=>({...r,nota_linea:'changed'})),p),'55000');await assume(1,2);await denied(()=>confirm('CHECKS',data,p),'55000');await assume(1,1,1,'different');await denied(()=>confirm('CHECKS',data,p),'55000');await assume();await db.exec('reset role;update bank_account set balance=balance+1 where bank_account_id=1;set role authenticated');await denied(()=>confirm('CHECKS',data,p),'55000');
});
test('permission and active-company checks apply to preview, import and receipt recovery',async t=>{
 await tx(t);await assume();const data=await rows(),p=await preview('CHECKS',data);await assume(1,3);await denied(()=>preview('CHECKS',data));await denied(()=>confirm('CHECKS',data,p));await assume(1,1,2);await denied(()=>preview('CHECKS',data));await assume(2,1);await denied(()=>preview('CHECKS',data));await db.exec('reset role;insert into roles values(9,\'Blind writer\',false);insert into user_roles values(1,9);insert into role_access_matrix values(9,\'banking:bank-checks\',false,true,false,false)');await assume(1,9);await denied(()=>preview('CHECKS',data));await assume();await confirm('CHECKS',data,p);await assume(1,3);await denied(()=>preview('CHECKS',data));
});
test('new private objects are closed to client roles and no existing writer ACL is broadened',async t=>{
 await tx(t);await assume();for(const role of['anon','service_role']){await db.exec('reset role;set role '+role);await denied(()=>preview('CHECKS',[]));}await assume();await denied(()=>db.query('select *from banking_csv_private.imports'));await denied(()=>db.query("select banking_csv_private.build_batch('CHECKS','[]',1)"));await db.exec('reset role');const functions=(await db.query("select p.oid::regprocedure::text name,p.prosecdef,p.proconfig,has_function_privilege('anon',p.oid,'EXECUTE') anon,has_function_privilege('service_role',p.oid,'EXECUTE') service from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='banking_csv_private' or p.proname in('banking_csv_preview','banking_csv_import')")).rows;assert.ok(functions.every(f=>!f.anon&&!f.service));assert.ok(functions.every(f=>f.proconfig.some(v=>v.startsWith('search_path='))));
});
test('a late protected-writer failure rolls back the complete batch, receipt and balances',async t=>{
 await tx(t);await db.exec(`create function synthetic_csv_failure()returns trigger language plpgsql as $$begin if new.bank_reference='FAIL-WRITER'then raise exception using errcode='55000',message='Synthetic late failure';end if;return new;end$$;create trigger synthetic_csv_failure before insert on bank_check for each row execute function synthetic_csv_failure()`);await assume();const data=await rows();data[2].referencia_bancaria='FAIL-WRITER';const p=await preview('CHECKS',data);assert.equal(p.valid,true);const before=await snapshot();await denied(()=>confirm('CHECKS',data,p),'55000');const after=await snapshot();delete before.sequences;delete after.sequences;assert.deepEqual(after,before,'Postgres sequence gaps on a failed confirmed import are allowed; financial changes and receipts must roll back');
});
test('CSV GL deferral restores on/off/unset state and leaves complete balanced postings',async t=>{
 await tx(t);await assume();const [r]=await rows();for(const prior of['','off','on'])for(const kind of['CHECKS','DEPOSITS']){await db.query("select set_config('nexo.defer_journal_gl_sync',$1,true)",[prior]);const data=[{...r,documento_referencia:'GUC-'+prior+'-'+kind,importe:'1'}],p=await preview(kind,data);assert.equal(p.valid,true);assert.equal((await confirm(kind,data,p)).created,1);assert.equal((await db.query("select current_setting('nexo.defer_journal_gl_sync',true)value")).rows[0].value,prior);}await db.exec('reset role');const gl=(await db.query('select transaction_id,count(*)::int n,sum(debit_amount-credit_amount)::text balance from gl_impact where transaction_id is not null group by transaction_id')).rows;assert.equal(gl.length,6);assert.ok(gl.every(x=>x.n===2&&x.balance==='0.000000'));
});
test('twenty-line imports rebuild GL once per document instead of once per row',async t=>{
 await tx(t);await db.exec(`create table synthetic_csv_sync_calls(n integer);insert into synthetic_csv_sync_calls values(0);
 alter function public.sync_journal_gl_impacts(bigint)rename to synthetic_csv_real_sync;
 create function public.sync_journal_gl_impacts(jid bigint)returns void language plpgsql as $$begin update synthetic_csv_sync_calls set n=n+1;perform synthetic_csv_real_sync(jid);end$$`);await assume();const [r]=await rows();for(const kind of['CHECKS','DEPOSITS']){await db.exec('reset role;update synthetic_csv_sync_calls set n=0;set role authenticated');const data=Array.from({length:20},()=>({...r,documento_referencia:'SYNC-'+kind,importe:'1'})),p=await preview(kind,data);assert.equal(p.valid,true);assert.equal((await confirm(kind,data,p)).created,1);await db.exec('reset role');assert.equal((await db.query('select n from synthetic_csv_sync_calls')).rows[0].n,1);await db.exec('set role authenticated');}
});
test('unrepresentable local amounts fail by document during preview',async t=>{
 await tx(t);await assume();const [r]=await rows(),data=[{...r,cuenta_bancaria:'SYN-FOREIGN',moneda:'CRC',tipo_cambio:'999999999999',importe:'999999999999'}],before=await snapshot(),p=await preview('CHECKS',data);assert.equal(p.valid,false);assert.equal(p.errors[0].row,2);assert.match(p.errors[0].message,/precisión contable/);assert.deepEqual(await snapshot(),before);
});
