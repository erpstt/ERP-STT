import assert from'node:assert/strict';
import{before,after,test}from'node:test';
import{PGlite}from'@electric-sql/pglite';
import{setupTreasuryManagerExecution,applyTreasuryManagerExecutionMigration,treasuryManagerExecutionSql}from'./fixtures/setup-treasury-manager-execution.mjs';
import{assertIsolatedTestArgs}from'./lib/migration-preview.mjs';
assertIsolatedTestArgs();
const db=new PGlite();let metadataBefore,baselineSource,permissionsBefore,postingBefore;
const q=async(sql,p=[])=>(await db.query(sql,p)).rows[0]?.d;
const draft={type:'OTROS',currencyId:1,plannedDate:'2026-10-31',concept:'Synthetic Treasury manager request',lines:[{accountId:203,entityType:'Proveedor',entityId:10,departmentId:21,concept:'Synthetic approved amount',amount:200}]};
async function assume(user=1,role=1,sid=1){
 await db.exec('reset role');await db.query("insert into user_role_sessions values('fixture',$1,$2)on conflict(session_id)do update set user_id=$1,role_id=$2",[user,role]);await db.query("insert into user_company_sessions values('fixture',$1,$2)on conflict(session_id)do update set user_id=$1,subsidiary_id=$2",[user,sid]);
 await db.query("select set_config('request.jwt.claims',$1,false)",[JSON.stringify({sub:`00000000-0000-0000-0000-${String(user).padStart(12,'0')}`,session_id:'fixture'})]);await db.exec('set role authenticated');
}
async function tx(t){await db.exec('reset role;begin');t.after(()=>db.exec('rollback;reset role'));await assume();}
async function denied(sql,p=[],code='42501'){await db.exec('savepoint denial');try{await assert.rejects(db.query(sql,p),e=>e.code===code);}finally{await db.exec('rollback to denial;release denial');}}
const detail=async id=>q('select pr_detail($1)d',[{id}]);
const save=async(p=draft)=>q('select pr_save($1)d',[p]);
async function transition(id,transition){const h=(await detail(id)).header;return q('select pr_transition($1)d',[{id,version:h.version,transition}]);}
async function approved(p=draft){await assume();const r=await save(p);await transition(r.id,'SUBMIT');await assume(2,4);await transition(r.id,'APPROVE');await assume(1,6);return r.id;}
async function executeInput(id){const h=(await detail(id)).header;return{id,version:h.version,date:'2026-10-31',rate:1,bankId:1,method:'TRANSFERENCIA',reference:'SYN-MANAGER-200'};}
const execute=p=>q('select pr_execute($1)d',[p]);
const metadata=async()=>(await db.query("select oid,oid::regprocedure::text signature,proowner,proacl::text,proconfig,provolatile,prosecdef,proisstrict,proparallel from pg_proc where oid in('public.pr_can_execute()'::regprocedure,'public.pr_detail(jsonb)'::regprocedure,'public.pr_execute(jsonb)'::regprocedure,'payment_request_private.execute_access(jsonb)'::regprocedure)order by oid")).rows;
const permissions=()=>q("select jsonb_build_object('roles',(select jsonb_agg(to_jsonb(r)order by role_id)from roles r),'grants',(select jsonb_agg(to_jsonb(r)order by role_id,resource_key)from role_access_matrix r),'permissions',(select jsonb_agg(to_jsonb(p)order by permission_id)from permissions p),'rolePermissions',(select jsonb_agg(to_jsonb(p)order by role_id,permission_id)from role_permissions p))d");
const postingState=()=>q("select jsonb_build_object('banks',(select jsonb_agg(to_jsonb(x)order by bank_account_id)from bank_account x),'bankTransactions',(select jsonb_agg(to_jsonb(x)order by bank_tran_id)from bank_transaction x),'journals',(select jsonb_agg(to_jsonb(x)order by journal_id)from journal x),'lines',(select jsonb_agg(to_jsonb(x)order by journal_line_id)from journal_line x),'gl',(select jsonb_agg(to_jsonb(x)order by gl_impact_id)from gl_impact x),'payments',(select jsonb_agg(to_jsonb(x)order by payment_id)from supplier_payment x))d");
const capability=async(role=6,user=1,sid=1)=>{await assume(user,role,sid);await db.exec('reset role');return q('select public.pr_can_execute()d');};
before(async()=>{await setupTreasuryManagerExecution(db);metadataBefore=await metadata();baselineSource=await q("select prosrc d from pg_proc where oid='public.pr_can_execute()'::regprocedure");permissionsBefore=await permissions();postingBefore=await postingState();await applyTreasuryManagerExecutionMigration(db);});
after(()=>db.close());

test('strict helper patch changes only the two exact role names and preserves attributes, grants, and stored financial records',async t=>{
 await tx(t);await db.exec('reset role');assert.deepEqual(await metadata(),metadataBefore);assert.deepEqual(await permissions(),permissionsBefore);assert.deepEqual(await postingState(),postingBefore);
 const actual=await q("select prosrc d from pg_proc where oid='public.pr_can_execute()'::regprocedure");assert.equal(actual,baselineSource.replace("lower(r.role_name)in('tesoreria','tesorería','tesorero','tesorera','treasury')","lower(r.role_name)in('tesoreria','tesorería','tesorero','tesorera','treasury','encargado de tesorería','encargado de tesoreria')"));
 await db.exec('savepoint drift');try{await assert.rejects(db.exec(await treasuryManagerExecutionSql()),e=>e.code==='P0001');}finally{await db.exec('rollback to drift;release drift');}assert.equal(await q("select prosrc d from pg_proc where oid='public.pr_can_execute()'::regprocedure"),actual);
});

test('both exact Treasury manager spellings qualify while prefix or unrelated role names do not',async t=>{
 await tx(t);assert.equal(await capability(6),true);assert.equal(await capability(7),true);assert.equal(await capability(8),false);assert.equal(await capability(9),false);
});

test('the approved-request action becomes available with view/edit while approval remains assigned to its actual approver',async t=>{
 await tx(t);await assume();const r=await save();await transition(r.id,'SUBMIT');await assume(1,6);let d=await detail(r.id);assert.equal(d.actions.canApprove,false);assert.equal(d.actions.canExecute,false);await denied('select pr_transition($1)',[{id:r.id,version:d.header.version,transition:'APPROVE'}]);
 await assume(2,4);await transition(r.id,'APPROVE');await assume(1,6);d=await detail(r.id);assert.equal(d.actions.canExecute,true);assert.equal(d.actions.canApprove,false);assert.equal(d.actions.canEdit,false);assert.equal(d.actions.canCancel,false);
});

test('OTROS executes the real synthetic payment for 200, balances its journal and GL, and repeated execution is idempotent',async t=>{
 await tx(t);const id=await approved(),input=await executeInput(id),result=await execute(input);assert.ok(result.journalId);assert.equal((await detail(id)).header.estado,'APLICADO');await db.exec('reset role');const afterFirst=await postingState();
 assert.equal((await db.query('select balance::float8 from bank_account where bank_account_id=1')).rows[0].balance,800);
 assert.deepEqual((await db.query('select sum(debit)::float8 debit,sum(credit)::float8 credit from journal_line where journal_id=$1',[result.journalId])).rows[0],{debit:200,credit:200});
 assert.deepEqual((await db.query('select sum(debit_amount)::float8 debit,sum(credit_amount)::float8 credit from gl_impact where transaction_id=(select transaction_id from journal where journal_id=$1)',[result.journalId])).rows[0],{debit:200,credit:200});
 await assume(1,6);assert.equal((await execute(input)).journalId,result.journalId);await db.exec('reset role');assert.deepEqual(await postingState(),afterFirst);
});

test('CXP executes its real supplier payment for 200 using only the request role grants',async t=>{
 await tx(t);const invoice={invoice_number:'SYN-MANAGER-INVOICE',invoice_type:'Factura estándar',supplier_id:10,payment_term_id:1,invoice_date:'2026-10-31',fiscal_period_id:10,currency_id:1,exchange_rate:1,memo:'Synthetic supplier invoice',lines:[{account_id:203,quantity:3,unit_price:100,tax_code_id:1,tax_rate:13,department_id:21}]};
 const invoiceId=(await q('select save_supplier_invoice($1,null)d',[invoice])).invoiceId;await db.exec('reset role');const workflow=(await db.query("insert into wf_workflows(nombre,entity_type,subsidiaria_id)values('Synthetic manager CXP','PAYMENT_REQUEST',1)returning id")).rows[0].id;
 await db.query("insert into wf_rules(workflow_id,nivel,nombre_nivel,usuario_aprobador_id,politica)values($1,1,'Synthetic invoice approval',2,'CUALQUIERA')",[workflow]);
 const id=await approved({...draft,type:'CXP',supplierId:10,lines:[{invoiceId,amount:200}]}),result=await execute(await executeInput(id));assert.ok(result.journalId);assert.equal((await detail(id)).header.estado,'APLICADO');await db.exec('reset role');
 assert.equal((await db.query('select balance::float8 from bank_account where bank_account_id=1')).rows[0].balance,800);
 assert.deepEqual((await db.query('select sum(debit)::float8 debit,sum(credit)::float8 credit from journal_line where journal_id=$1',[result.journalId])).rows[0],{debit:200,credit:200});
 assert.deepEqual((await db.query('select sum(debit_amount)::float8 debit,sum(credit_amount)::float8 credit from gl_impact where transaction_id=(select transaction_id from journal where journal_id=$1)',[result.journalId])).rows[0],{debit:200,credit:200});
 assert.equal((await db.query('select amount_paid::float8 from supplier_payment where payment_id=(select payment_id from solicitudes_pago where id=$1)',[id])).rows[0].amount_paid,200);
 assert.equal((await db.query("select count(*)::int n from role_access_matrix where role_id=6 and resource_key in('purchasing:supplier-payments','banking:bank-checks')")).rows[0].n,0);
});

test('missing read/edit access, a different active role, or missing active membership deny before posting',async t=>{
 await tx(t);const id=await approved(),input=await executeInput(id);await db.exec('reset role');const before=await postingState();
 await db.exec("update role_access_matrix set can_view=false,can_edit=false where role_id=6 and resource_key='treasury:payment-requests'");await assume(1,6);await denied('select pr_detail($1)',[{id}]);await denied('select pr_execute($1)',[input]);
 await db.exec("reset role;update role_access_matrix set can_view=true,can_edit=false where role_id=6 and resource_key='treasury:payment-requests'");await assume(1,6);assert.equal((await detail(id)).actions.canExecute,false);await denied('select pr_execute($1)',[input]);
 await db.exec("reset role;update role_access_matrix set can_edit=true where role_id=6 and resource_key='treasury:payment-requests'");await assume(1,3);assert.equal((await detail(id)).actions.canExecute,false);await denied('select pr_execute($1)',[input]);
 await db.exec('reset role;delete from user_roles where user_id=1 and role_id=6');await assume(1,6);await denied('select pr_execute($1)',[input]);await db.exec('reset role');assert.deepEqual(await postingState(),before);
});

test('a locked batch or wrong company keeps the action unavailable and blocks posting',async t=>{
 await tx(t);const id=await approved(),input=await executeInput(id);await db.exec('reset role');const before=await postingState();await db.query("update solicitudes_pago set payment_batch_id=900,batch_processing_status='LOCKED_IN_BATCH'where id=$1",[id]);await assume(1,6);assert.equal((await detail(id)).actions.canExecute,false);await denied('select pr_execute($1)',[input],'55000');
 await assume(1,6,2);await denied('select pr_detail($1)',[{id}]);await denied('select pr_execute($1)',[input]);await db.exec('reset role');assert.deepEqual(await postingState(),before);
});

test('existing Treasury roles, administrator behavior, and the exact authorized batch fallback remain intact',async t=>{
 await tx(t);for(const name of['Tesoreria','Tesorería','Tesorero','Tesorera','Treasury']){await db.exec('reset role');await db.query('update roles set role_name=$1 where role_id=2',[name]);assert.equal(await capability(2),true,name);}assert.equal(await capability(5,4),true);
 await db.exec('reset role');await db.query("insert into role_permissions(role_id,permission_id)select 9,permission_id from permissions where code='TREASURY_PAYMENT_BATCH_EXECUTE'");await db.exec("insert into payment_batches values(900,1,'FILE_GENERATED',1,1,'2026-10-31',1)");
 assert.equal(await capability(9),false,'A technical batch permission alone does not enable manual payments');
 await db.query("select set_config('nexo.payment_batch_id','900',true)");assert.equal(await q('select pr_can_execute()d'),true);
 await db.exec("update payment_batches set subsidiary_id=2 where batch_id=900");assert.equal(await q('select pr_can_execute()d'),false);
 await db.query("select set_config('nexo.payment_batch_id','not-a-number',true)");assert.equal(await q('select pr_can_execute()d'),false);
});
