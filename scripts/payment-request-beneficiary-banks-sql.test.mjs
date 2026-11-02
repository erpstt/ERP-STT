import assert from 'node:assert/strict';
import {test,before,after} from 'node:test';
import {PGlite} from '@electric-sql/pglite';
import {setupPaymentRequestBeneficiaryBanks} from './fixtures/setup-payment-request-beneficiary-banks.mjs';

const db=new PGlite();
let installation;
before(async()=>{installation=await setupPaymentRequestBeneficiaryBanks(db);});
after(()=>db.close());
async function tx(t){await db.exec('reset role;begin');t.after(()=>db.exec('rollback;reset role'));}
async function assume(user=1,role=1,sid=1){
  await db.exec('reset role');
  await db.query("insert into user_role_sessions values('fixture',$1,$2) on conflict(session_id) do update set user_id=$1,role_id=$2",[user,role]);
  await db.query("insert into user_company_sessions values('fixture',$1,$2) on conflict(session_id) do update set user_id=$1,subsidiary_id=$2",[user,sid]);
  await db.query("select set_config('request.jwt.claims',$1,false)",[JSON.stringify({sub:`00000000-0000-0000-0000-${String(user).padStart(12,'0')}`,session_id:'fixture'})]);
  await db.exec('set role authenticated');
}
async function denied(sql,params=[],code='42501'){
  await db.exec('savepoint denial');
  try{await assert.rejects(db.query(sql,params),error=>error.code===code,sql);}
  finally{await db.exec('rollback to savepoint denial;release savepoint denial');}
}
const options=async()=>(await db.query('select pr_options() data')).rows[0].data;
const detail=async id=>(await db.query('select pr_detail($1) data',[{id}])).rows[0].data;
const draft={type:'OTROS',currencyId:1,plannedDate:'2026-10-31',concept:'Synthetic beneficiary request',
  lines:[{accountId:203,entityType:'Otro Nombre',entityId:801,departmentId:21,concept:'Synthetic direct payment',amount:50}]};
const save=async(p=draft)=>(await db.query('select pr_save($1) data',[p])).rows[0].data;
async function transition(id,action){const h=(await detail(id)).header;return(await db.query('select pr_transition($1) data',[{id,version:h.version,transition:action}])).rows[0].data;}

test('migration preserves existing function privileges, policies and approved request data',async()=>{
  assert.deepEqual(installation.after,installation.before);
});

test('options projects both current bank accounts for all three beneficiary kinds without catalog grants',async t=>{
  await tx(t);await assume(1,2);
  const data=await options(),parties=data.beneficiaryBankAccounts;
  for(const [kind,id]of [['Proveedor',10],['Empleado',901],['Otro Nombre',801]]){
    const party=parties.find(x=>x.entityType===kind&&x.entityId===id);
    assert.ok(party);assert.equal(party.isActive,true);assert.deepEqual(party.accounts.map(x=>x.slot),['primary','secondary']);
    assert.equal(party.accounts[0].bankName,'Synthetic beneficiary bank');
    assert.equal(party.accounts[1].currencyCode,'CRC');
    assert.deepEqual(Object.keys(party).sort(),['accounts','beneficiaryName','entityId','entityType','isActive','name']);
  }
  assert.equal(parties.find(x=>x.entityType==='Proveedor'&&x.entityId===10).accounts[0].accountNumber,'00001001');
  const employee=parties.find(x=>x.entityType==='Empleado'&&x.entityId===901);
  assert.equal(employee.accounts[0].currencyId,null);assert.equal(employee.accounts[0].currencyCode,null);
  assert.deepEqual(parties.find(x=>x.entityType==='Otro Nombre'&&x.entityId===804).accounts,[]);
  assert.ok(data.otherNames.some(x=>x.id===801));assert.ok(!data.otherNames.some(x=>[802,803].includes(x.id)));
  assert.ok(!JSON.stringify(parties).includes('SECRET-FOREIGN'));
  for(const table of ['suppliers','employees','other_names'])await denied(`select * from ${table}`);
  await denied('select payment_request_private.beneficiary_bank_accounts()');
  await denied("select payment_request_private.beneficiary_bank_dto('Otro Nombre',801,'x',true,'{}')");
});

test('Other Names save keeps a typed FK, party name, version and original dimensions without posting',async t=>{
  await tx(t);await assume();const result=await save(),d=await detail(result.id);
  assert.equal(d.header.estado,'BORRADOR');assert.equal(d.header.journal_id,null);
  assert.equal(d.lines[0].id_otro_nombre,801);assert.equal(d.lines[0].party,'Synthetic other name');
  assert.equal(d.lines[0].id_departamento,21);assert.equal(d.lines[0].monto,50);
  assert.deepEqual(d.beneficiaryBankAccounts.map(x=>[x.entityType,x.entityId]),[['Otro Nombre',801]]);
  await save({...draft,id:result.id,version:d.header.version,concept:'Edited synthetic'});
  await denied('select pr_save($1)',[{...draft,id:result.id,version:d.header.version}],'55000');
  await db.exec('reset role');assert.equal((await db.query('select count(*) n from bank_transaction')).rows[0].n,0);
});

test('request integrity rejects an Other Name without its type and multiple third-party identities',async t=>{
  await tx(t);await assume();const r=await save();await db.exec('reset role');
  await denied('update solicitudes_pago_lineas set tipo_tercero=null where id_solicitud=$1',[r.id],'23514');
  await denied('update solicitudes_pago_lineas set id_proveedor=10 where id_solicitud=$1',[r.id],'23514');
  await assume();assert.equal((await detail(r.id)).lines[0].id_otro_nombre,801);
});

test('foreign, inactive and missing Other Names are rejected without bypassing existing account/dimension checks',async t=>{
  await tx(t);await assume();
  for(const entityId of [802,803,999])await denied('select pr_save($1)',[{...draft,lines:[{...draft.lines[0],entityId}]}],entityId===999?'23503':'42501');
  await denied('select pr_save($1)',[{...draft,lines:[{...draft.lines[0],departmentId:999}]}],'P0001');
  await denied('select pr_save($1)',[{...draft,lines:[{...draft.lines[0],accountId:104}]}],'42501');
  await assume(1,5);await denied('select pr_options()');await denied('select pr_save($1)',[draft]);
});

test('detail reads current instructions for referenced historical parties without modifying an approved request',async t=>{
  await tx(t);await assume();const r=await save();await transition(r.id,'SUBMIT');await assume(2,4);await transition(r.id,'APPROVE');
  const approved=await detail(r.id);assert.equal(approved.header.estado,'APROBADO');
  await db.exec('reset role');await db.query("update other_names set is_active=false,payment_account_number='00009999' where other_name_id=801");
  await assume(1,2);const refreshed=await detail(r.id);
  assert.deepEqual(refreshed.header,approved.header);assert.equal(refreshed.beneficiaryBankAccounts[0].isActive,false);
  assert.equal(refreshed.beneficiaryBankAccounts[0].accounts[0].accountNumber,'00009999');
  assert.ok(!(await options()).otherNames.some(x=>x.id===801));
  await denied('select pr_save($1)',[{...draft,id:r.id,version:approved.header.version}],'55000');
  await assume(1,1,2);await denied('select pr_detail($1)',[{id:r.id}]);
  await db.exec('reset role');await db.query('update other_names set subsidiary_id=2 where other_name_id=801');
  await assume();assert.deepEqual((await detail(r.id)).beneficiaryBankAccounts,[]);
});

test('direct supplier and employee requests show only the accounts of their referenced beneficiary',async t=>{
  await tx(t);await assume();
  for(const [entityType,entityId]of [['Proveedor',10],['Empleado',901]]){
    const r=await save({...draft,lines:[{...draft.lines[0],entityType,entityId}]});
    const d=await detail(r.id);
    assert.deepEqual(d.beneficiaryBankAccounts.map(x=>[x.entityType,x.entityId]),[[entityType,entityId]]);
    assert.equal(d.beneficiaryBankAccounts[0].accounts.length,2);
  }
});

test('local Other Name Treasury execution preserves beneficiary identity, balanced amounts and dimensions',async t=>{
  await tx(t);await assume();const r=await save();await transition(r.id,'SUBMIT');await assume(2,4);await transition(r.id,'APPROVE');
  const header=(await detail(r.id)).header;await assume(1,2);
  const payload={id:r.id,version:header.version,date:'2026-10-31',rate:1,bankId:1,method:'TRANSFERENCIA',reference:'SYN-OTHER-NAME'};
  const result=(await db.query('select pr_execute($1) data',[payload])).rows[0].data;
  assert.ok(result.journalId);assert.equal((await detail(r.id)).header.estado,'APLICADO');
  assert.equal((await db.query('select pr_execute($1) data',[payload])).rows[0].data.journalId,result.journalId);
  await db.exec('reset role');
  const check=(await db.query('select other_name_id,entity_type,department_id,amount from bank_check_line')).rows;
  assert.deepEqual(check,[{other_name_id:801,entity_type:'Otro Nombre',department_id:21,amount:'50.000000'}]);
  const debit=(await db.query('select other_name_id,entity_type,department_id,debit,credit from journal_line where journal_id=$1 and debit>0',[result.journalId])).rows[0];
  assert.equal(debit.other_name_id,801);assert.equal(debit.entity_type,'Otro Nombre');assert.equal(debit.department_id,21);
  assert.equal(Number(debit.debit),50);assert.equal(Number(debit.credit),0);
  const sums=(await db.query('select sum(debit_amount)::float8 d,sum(credit_amount)::float8 c from gl_impact where transaction_id=(select transaction_id from journal where journal_id=$1)',[result.journalId])).rows[0];
  assert.deepEqual(sums,{d:50,c:50});
  assert.equal(Number((await db.query('select balance from bank_account where bank_account_id=1')).rows[0].balance),950);
  assert.equal((await db.query('select beneficiary from bank_check')).rows[0].beneficiary,'Synthetic other name');
});

test('production supplier/customer schema without is_inactive supports options and the complete Other Name lifecycle',async t=>{
  await tx(t);await db.exec('alter table suppliers drop column is_inactive;alter table customers drop column is_inactive');await assume();
  assert.equal((await options()).beneficiaryBankAccounts.find(x=>x.entityType==='Proveedor'&&x.entityId===10).isActive,true);
  const r=await save();assert.equal((await detail(r.id)).header.estado,'BORRADOR');
  await transition(r.id,'SUBMIT');await assume(2,4);await transition(r.id,'APPROVE');
  const h=(await detail(r.id)).header;await assume(1,2);
  const result=(await db.query('select pr_execute($1) data',[{id:r.id,version:h.version,date:'2026-10-31',rate:1,bankId:1,method:'TRANSFERENCIA',reference:'SYN-PRODUCTION-SCHEMA'}])).rows[0].data;
  assert.ok(result.journalId);assert.equal((await detail(r.id)).header.estado,'APLICADO');
  await db.exec('reset role');
  const sums=(await db.query('select sum(debit)::float8 d,sum(credit)::float8 c from journal_line where journal_id=$1',[result.journalId])).rows[0];
  assert.deepEqual(sums,{d:50,c:50});
  assert.equal((await db.query('select other_name_id from bank_check_line')).rows[0].other_name_id,801);
});

test('optional supplier inactivity still rejects direct requests when the flag exists',async t=>{
  await tx(t);await db.exec('update suppliers set is_inactive=true where supplier_id=10');await assume();
  assert.ok(!(await options()).beneficiaryBankAccounts.some(x=>x.entityType==='Proveedor'&&x.entityId===10));
  await denied('select pr_save($1)',[{...draft,lines:[{...draft.lines[0],entityType:'Proveedor',entityId:10}]}],'42501');
});

test('report and approval email resolve Other Name identity without bank instructions',async t=>{
  await tx(t);await assume();const r=await save();await transition(r.id,'SUBMIT');
  const reportOptions=(await db.query('select payment_request_report_options() data')).rows[0].data;
  assert.ok(reportOptions.thirdParties.some(x=>x.type==='Otro Nombre'&&x.id===801&&x.name==='Synthetic other name'));
  const report=(await db.query('select run_payment_request_report($1) data',[
    {dateFrom:'2026-01-01',dateTo:'2026-12-31',thirdPartyType:'Otro Nombre',thirdPartyId:801,search:'Synthetic other name'}
  ])).rows[0].data;
  assert.ok(JSON.stringify(report).includes('Synthetic other name'));
  assert.ok(!JSON.stringify(report).includes('00004004'));
  assert.ok(!JSON.stringify(report).includes('beneficiaryBankAccounts'));
  await db.exec('reset role');
  const step=(await db.query("select wi.id instance_id,ws.id step_id from wf_instances wi join wf_instance_steps ws on ws.instance_id=wi.id where wi.entity_type='PAYMENT_REQUEST' and wi.entity_id=$1",[r.id])).rows[0];
  const snapshot=(await db.query('select expense_approval_email_snapshot($1,$2,2) data',[step.instance_id,step.step_id])).rows[0].data;
  assert.equal(snapshot.lineas[0].tercero,'Synthetic other name');assert.equal(snapshot.lineas[0].tipoTercero,'Otro Nombre');
  assert.ok(!JSON.stringify(snapshot).includes('00004004'));
  assert.ok(!JSON.stringify(snapshot).includes('beneficiaryBankAccounts'));
});

test('tax-agency requests retain their existing Treasury identity and balanced accounting',async t=>{
  await tx(t);await assume();
  const r=await save({...draft,lines:[{...draft.lines[0],entityType:'Agencia Tributaria',entityId:1}]});
  assert.deepEqual((await detail(r.id)).beneficiaryBankAccounts,[]);
  await transition(r.id,'SUBMIT');await assume(2,4);await transition(r.id,'APPROVE');
  const h=(await detail(r.id)).header;await assume(1,2);
  const result=(await db.query('select pr_execute($1) data',[{id:r.id,version:h.version,date:'2026-10-31',rate:1,bankId:1,method:'TRANSFERENCIA',reference:'SYN-AGENCY'}])).rows[0].data;
  await db.exec('reset role');
  assert.equal((await db.query('select tax_agency_id from bank_check_line')).rows[0].tax_agency_id,1);
  const journal=(await db.query('select tax_agency_id,other_name_id from journal_line where journal_id=$1 and debit>0',[result.journalId])).rows[0];
  assert.deepEqual(journal,{tax_agency_id:1,other_name_id:null});
  const sums=(await db.query('select sum(debit)::float8 d,sum(credit)::float8 c from journal_line where journal_id=$1',[result.journalId])).rows[0];
  assert.deepEqual(sums,{d:50,c:50});
});

test('CXP with the production supplier/customer schema resolves its supplier and posts through the existing engine',async t=>{
  await tx(t);await assume();
  const invoice={invoice_number:'SYN-BANK-CXP',invoice_type:'Factura estándar',supplier_id:10,payment_term_id:1,
    invoice_date:'2026-10-31',fiscal_period_id:10,currency_id:1,exchange_rate:1,memo:'Synthetic',
    lines:[{account_id:203,quantity:2,unit_price:50,tax_code_id:1,tax_rate:13,department_id:21}]};
  const invoiceId=(await db.query('select save_supplier_invoice($1,null) data',[invoice])).rows[0].data.invoiceId;
  await db.exec('reset role;alter table suppliers drop column is_inactive;alter table customers drop column is_inactive');
  const workflowId=(await db.query("insert into wf_workflows(nombre,entity_type,subsidiaria_id)values('Synthetic CXP bank','PAYMENT_REQUEST',1)returning id")).rows[0].id;
  await db.query("insert into wf_rules(workflow_id,nivel,nombre_nivel,usuario_aprobador_id,politica)values($1,1,'Approve',2,'CUALQUIERA')",[workflowId]);
  await assume();const r=await save({...draft,type:'CXP',supplierId:10,lines:[{invoiceId,amount:50}]});
  const d=await detail(r.id);assert.deepEqual(d.beneficiaryBankAccounts.map(x=>[x.entityType,x.entityId]),[['Proveedor',10]]);
  await transition(r.id,'SUBMIT');await assume(2,4);await transition(r.id,'APPROVE');
  const h=(await detail(r.id)).header;await assume(1,2);
  const result=(await db.query('select pr_execute($1) data',[{id:r.id,version:h.version,date:'2026-10-31',rate:1,bankId:1,method:'TRANSFERENCIA',reference:'SYN-CXP-BANK'}])).rows[0].data;
  assert.ok(result.journalId);assert.ok((await detail(r.id)).header.payment_id);
  await db.exec('reset role');assert.equal((await db.query('select count(*) n from supplier_payment')).rows[0].n,1);
  assert.equal((await db.query('select count(*) n from bank_check')).rows[0].n,0);
  assert.equal(Number((await db.query('select balance from bank_account where bank_account_id=1')).rows[0].balance),950);
});
