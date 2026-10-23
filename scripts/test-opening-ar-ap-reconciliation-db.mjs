import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import pg from 'pg';

process.loadEnvFile?.('.env');
const projectRef=new URL(process.env.SUPABASE_URL).hostname.split('.')[0];
const db=new pg.Client({
 host:process.env.SUPABASE_DB_HOST||'aws-0-us-east-1.pooler.supabase.com',
 port:Number(process.env.SUPABASE_DB_PORT||6543),database:'postgres',
 user:process.env.SUPABASE_DB_USER||`postgres.${projectRef}`,
 password:process.env.SUPABASE_DB_PASSWORD,ssl:{rejectUnauthorized:false},
 application_name:'gentia_test_opening_ar_ap_reconciliation'
});
const migration=await readFile(new URL(
 '../supabase/migrations/20261022150000_opening_ar_ap_subledger_reconciliation.sql',import.meta.url
),'utf8');

await db.connect();
try{
 await db.query('begin');
 await db.query(migration);
 await db.query(migration);

 const installed=(await db.query(`
  select
   to_regclass('public.opening_ar_ap_gl_control_lines')is not null archive_table,
   to_regprocedure('public.opening_ar_ap_assert_account_routing(bigint)')is not null routing_guard,
   to_regprocedure('public.opening_ar_ap_apply_historical_values(bigint)')is not null apply_fx,
   to_regprocedure('public.opening_ar_ap_reconciliation(bigint)')is not null reconciliation,
   to_regprocedure('public.opening_balance_effective_summary(bigint)')is not null effective_summary,
   to_regprocedure('public.opening_balance_stage_before_ar_ap_reconciliation(jsonb)')is not null stage_wrapper,
   to_regprocedure('public.opening_balance_post_before_ar_ap_reconciliation(bigint)')is not null post_wrapper,
   to_regprocedure('public.opening_balance_reverse_before_ar_ap_reconciliation(bigint)')is not null reverse_wrapper
 `)).rows[0];
 assert.ok(Object.values(installed).every(Boolean),'No se instalaron todos los componentes CxC/CxP.');

 const definitions=(await db.query(`
  select
   pg_get_functiondef('public.opening_balance_post(bigint)'::regprocedure)post,
   pg_get_functiondef('public.opening_balance_reverse(bigint)'::regprocedure)reverse,
   pg_get_functiondef('public.opening_balance_preview(bigint)'::regprocedure)preview,
   pg_get_functiondef('public.opening_ar_ap_assert_account_routing(bigint)'::regprocedure)routing,
   pg_get_functiondef('public.opening_ar_ap_apply_historical_values(bigint)'::regprocedure)historical,
   pg_get_functiondef('public.opening_ar_ap_reconciliation(bigint)'::regprocedure)reconciliation
 `)).rows[0];
 assert.match(definitions.post,/opening_ar_ap_archive_control_lines/i);
 assert.match(definitions.post,/opening_ar_ap_assert_account_routing/i);
 assert.match(definitions.post,/receivable_account_id=line\.account_id/i);
 assert.match(definitions.post,/payable_account_id=line\.account_id/i);
 assert.match(definitions.reverse,/opening_balance_reverse_before_ar_ap_reconciliation/i);
 assert.match(definitions.routing,/for share/i);
 assert.match(definitions.routing,/Use la cuenta % y vuelva a validar/i);
 assert.match(definitions.preview,/Inferida del Mayor/i);
 assert.match(definitions.historical,/GL_RESIDUAL/i);
 assert.match(definitions.historical,/localEquivalent/i);
 assert.doesNotMatch(definitions.historical,/opening_balance_rate\s*\(/i);
 assert.match(definitions.historical,/resolve_customer_receivable_account/i);
 assert.match(definitions.historical,/resolve_supplier_payable_account/i);
 assert.match(definitions.reconciliation,/source_type='GL'/i);

 const fixture=(await db.query(`
  select run.id
  from public.opening_balance_runs run
  where run.status in('DRAFT','VALIDATED')
   and exists(select 1 from public.opening_balance_lines line where line.run_id=run.id and line.source_type='GL')
   and exists(select 1 from public.opening_balance_lines line where line.run_id=run.id and line.source_type in('AR','AP'))
  order by run.id desc limit 1
 `)).rows[0];

 let liveFixture=null;
 if(fixture){
  await db.query('select public.opening_ar_ap_assert_account_routing($1)',[fixture.id]);
  await db.query('select public.opening_ar_ap_apply_historical_values($1)',[fixture.id]);
  const reconciliation=(await db.query(
   'select public.opening_ar_ap_reconciliation($1)value',[fixture.id]
  )).rows[0].value;
  assert.ok(reconciliation.length>0,'La carga vigente no produjo conciliación CxC/CxP.');
  assert.ok(reconciliation.every(row=>row.balanced),JSON.stringify(reconciliation));
  const rateSources=(await db.query(`
   select source_type,opening_rate_source,count(*)::integer rows
   from public.opening_balance_lines where run_id=$1 and source_type in('AR','AP')
   group by source_type,opening_rate_source order by source_type,opening_rate_source
  `,[fixture.id])).rows;
  assert.ok(rateSources.some(row=>row.source_type==='AR'&&row.opening_rate_source==='GL_RESIDUAL'));
  assert.ok(rateSources.some(row=>row.source_type==='AP'&&row.opening_rate_source==='LOCAL_CURRENCY'));

  const effective=(await db.query(
   'select public.opening_balance_effective_summary($1)value',[fixture.id]
  )).rows[0].value;
  const gl=(await db.query(`
   select coalesce(sum(local_debit),0)debit,coalesce(sum(local_credit),0)credit,
    coalesce(sum(local_debit-local_credit),0)difference
   from public.opening_balance_lines where run_id=$1 and source_type='GL'
  `,[fixture.id])).rows[0];
  assert.equal(Number(effective.debit).toFixed(6),Number(gl.debit).toFixed(6));
  assert.equal(Number(effective.credit).toFixed(6),Number(gl.credit).toFixed(6));
  assert.equal(Number(effective.difference).toFixed(6),Number(gl.difference).toFixed(6));

  const currentKnown=(await db.query(`
   select exists(
    select 1 from public.opening_balance_lines line join public.chart_accounts account using(account_id)
    where line.run_id=$1 and line.source_type='GL'and account.account_number='113002'
     and abs(line.foreign_amount-393988.76)<=.005 and abs(line.local_debit-59492302.76)<=.005
   )value
  `,[fixture.id])).rows[0].value;
  if(currentKnown){
   assert.equal(Number(effective.difference).toFixed(2),'0.12',
    'El residual real del Mayor debe ser J$0,12 después de eliminar la duplicación.');
   assert.ok(Math.abs(Number(effective.difference))<1,
    'La conciliación no eliminó la duplicación de más de J$62 millones.');
  }

  const routingFixture=(await db.query(`
   select customer.customer_id,customer.is_intercompany,line.row_number,
    account.account_number,
    case when customer.is_intercompany then'113001'else'113002'end expected_account
   from public.opening_balance_lines line
   join public.opening_balance_runs run on run.id=line.run_id
   join public.chart_accounts account using(account_id)
   join public.customers customer on customer.tax_id=line.raw_data->>'entityTaxId'
    and(customer.primary_subsidiary_id=run.subsidiary_id or exists(
     select 1 from public.entity_subsidiaries scope
     where scope.customer_id=customer.customer_id and scope.subsidiary_id=run.subsidiary_id))
   where line.run_id=$1 and line.source_type='AR'
   order by line.row_number,customer.customer_id limit 1
  `,[fixture.id])).rows[0];
  if(routingFixture){
   await db.query('savepoint changed_entity_route');
   await db.query('update public.customers set is_intercompany=not coalesce(is_intercompany,false) where customer_id=$1',
    [routingFixture.customer_id]);
   let routingError=null;
   try{await db.query('select public.opening_ar_ap_assert_account_routing($1)',[fixture.id]);}
   catch(error){routingError=error;}
   await db.query('rollback to savepoint changed_entity_route');
   assert.ok(routingError,'El guard debe detectar una reclasificaciÃ³n del cliente despuÃ©s de validar.');
   assert.match(routingError.message,new RegExp(
    `CxC fila ${routingFixture.row_number}.*cuenta ${routingFixture.account_number}.*Use la cuenta ${routingFixture.expected_account}`,'i'
   ));
  }

  const context=(await db.query(`
   select users.email,session.session_id,auth_user.id sub,'authenticated' role
   from public.user_company_sessions session join public.users users using(user_id)
   join auth.users auth_user on lower(auth_user.email)=lower(users.email)
   join public.user_role_sessions role_session using(session_id,user_id)
   join public.roles role using(role_id)
   where session.subsidiary_id=(select subsidiary_id from public.opening_balance_runs where id=$1)
    and lower(role.role_name)in('administrador','administrator','admin')
   order by session.selected_at desc limit 1
  `,[fixture.id])).rows[0];
  if(context&&currentKnown){
   await db.query("select set_config('request.jwt.claims',$1,true)",[JSON.stringify(context)]);
   const preview=(await db.query(
    'select public.opening_balance_preview($1)value',[fixture.id]
   )).rows[0].value;
   assert.equal(Number(preview.summary.difference).toFixed(2),'0.12');
   assert.equal(Number(preview.summary.count),158,
    'La vista previa efectiva debe excluir las dos líneas de control duplicadas.');
   assert.ok(preview.arApReconciliation.every(row=>row.balanced));
   assert.equal(preview.arApSummary.documents,59);
   const auxiliaryRows=preview.rows.filter(row=>['AR','AP'].includes(row.sourceType));
   assert.ok(auxiliaryRows.length>0,'La vista previa no mostrÃ³ documentos CxC/CxP.');
   assert.ok(auxiliaryRows.every(row=>['Tasa informada','Moneda local','Inferida del Mayor'].includes(row.rateSourceLabel)),
    'Cada documento CxC/CxP debe explicar el origen de su tasa histÃ³rica.');
   assert.ok(!preview.rows.some(row=>row.sourceType==='GL'&&
    /^(113002|211001)\b/.test(String(row.account))),
   'La vista previa no debe volver a mostrar las líneas GL sustituidas por el auxiliar.');
   await db.query('savepoint post_balance_check');
   let postError=null;
   try{await db.query('select public.opening_balance_post($1)',[fixture.id]);}
   catch(error){postError=error;}
   await db.query('rollback to savepoint post_balance_check');
   assert.ok(postError,'La contabilización debió bloquear el residual del Mayor.');
   assert.match(postError.message,/apertura no cuadra.*0\.12/i);
   assert.equal(Number((await db.query(
    'select count(*)value from public.opening_ar_ap_gl_control_lines where run_id=$1',[fixture.id]
   )).rows[0].value),0,'El bloqueo debe revertir el archivado tentativo.');
  }

  await db.query('savepoint archive_check');
  const archived=Number((await db.query(
   'select public.opening_ar_ap_archive_control_lines($1)value',[fixture.id]
  )).rows[0].value);
  assert.ok(archived>0,'No se sustituyeron líneas de control del Mayor.');
  assert.equal(Number((await db.query(`
   select count(*)value from public.opening_balance_lines ledger
   where ledger.run_id=$1 and ledger.source_type='GL'and exists(
    select 1 from public.opening_balance_lines auxiliary where auxiliary.run_id=ledger.run_id
     and auxiliary.source_type in('AR','AP')and auxiliary.account_id=ledger.account_id
     and auxiliary.currency_id=ledger.currency_id)
  `,[fixture.id])).rows[0].value),0);
  const after=(await db.query(
   'select public.opening_ar_ap_reconciliation($1)value',[fixture.id]
  )).rows[0].value;
  assert.ok(after.every(row=>row.balanced),'El snapshot dejó de conciliar tras sustituir el Mayor.');
  await db.query('rollback to savepoint archive_check');
  liveFixture={runId:Number(fixture.id),groups:reconciliation.length,
   debit:Number(effective.debit),credit:Number(effective.credit),difference:Number(effective.difference)};
 }

 await db.query('rollback');
 console.log(JSON.stringify({installed:true,liveFixture,rollback:true}));
}catch(error){
 await db.query('rollback').catch(()=>{});
 throw error;
}finally{
 await db.end();
}
