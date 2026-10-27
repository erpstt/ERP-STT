import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import pg from 'pg';

process.loadEnvFile?.('.env');

const projectRef=new URL(process.env.SUPABASE_URL).hostname.split('.')[0];
const db=new pg.Client({
  host:process.env.SUPABASE_DB_HOST||'aws-0-us-east-1.pooler.supabase.com',
  port:Number(process.env.SUPABASE_DB_PORT||6543),
  database:process.env.SUPABASE_DB_NAME||'postgres',
  user:process.env.SUPABASE_DB_USER||`postgres.${projectRef}`,
  password:process.env.SUPABASE_DB_PASSWORD||process.env.PGPASSWORD,
  ssl:{rejectUnauthorized:false},
  connectionTimeoutMillis:15000
});

const migrationBody=source=>source
  .replace(/^\uFEFF?\s*begin\s*;\s*/i,'')
  .replace(/\s*commit\s*;\s*notify\s+pgrst\s*,\s*'reload schema'\s*;\s*$/i,'');

await db.connect();
try{
  await db.query('begin');
  await db.query("set local statement_timeout='120s'");

  const base=await readFile(new URL(
    '../supabase/migrations/20261027090000_tax_agency_payment_requests.sql',
    import.meta.url
  ),'utf8');
  const reporting=await readFile(new URL(
    '../supabase/migrations/20261027101000_payment_request_tax_agency_reporting.sql',
    import.meta.url
  ),'utf8');
  await db.query(migrationBody(base));
  await db.query(reporting);

  const context=(await db.query(`select
      account.user_id,account.email,account.auth_user_id::text sub,
      session.session_id,session.subsidiary_id
    from public.user_company_sessions session
    join public.users account using(user_id)
    join public.user_subsidiaries access
      on access.user_id=account.user_id
      and access.subsidiary_id=session.subsidiary_id
    join public.subsidiaries subsidiary
      on subsidiary.subsidiary_id=session.subsidiary_id
    where account.is_active
      and account.auth_user_id is not null
      and upper(subsidiary.name)=upper('S.T.T. HOLDINGS LIMITED')
    order by session.selected_at desc
    limit 1`)).rows[0];
  assert.ok(context,'Se requiere una sesion activa para S.T.T. HOLDINGS LIMITED.');
  await db.query("select set_config('request.jwt.claims',$1,true)",[
    JSON.stringify(context)
  ]);

  const agency=(await db.query(`select agency.tax_agency_id,agency.agency_name
    from public.tax_agency_subsidiaries scope
    join public.tax_agencies agency using(tax_agency_id)
    where scope.subsidiary_id=$1
    order by agency.tax_agency_id
    limit 1`,[context.subsidiary_id])).rows[0];
  assert.ok(agency,'La subsidiaria de prueba requiere una agencia tributaria.');
  await db.query(`update public.tax_agencies
    set tax_id='TAX-AGENCY-REPORT-TEST'
    where tax_agency_id=$1`,[agency.tax_agency_id]);

  const account=(await db.query(`select chart.account_id
    from public.chart_accounts chart
    where public.pr_allowed_account(chart.account_id)
    order by chart.account_id
    limit 1`)).rows[0];
  const subsidiary=(await db.query(`select currency_id
    from public.subsidiaries where subsidiary_id=$1`,[
      context.subsidiary_id
    ])).rows[0];
  assert.ok(account&&subsidiary,'Falta una cuenta permitida o moneda funcional.');

  const request=(await db.query(`insert into public.solicitudes_pago(
      numero,id_subsidiaria,id_moneda,tipo_solicitud,estado,
      fecha_solicitud,fecha_pago_programada,id_solicitante,concepto,total
    )values(
      'TEST-TAX-REPORT-'||txid_current()::text,$1,$2,'OTROS','BORRADOR',
      date '2026-10-27',date '2026-10-27',$3,
      'Pago de impuesto de prueba',1.23
    )returning id`,[
      context.subsidiary_id,subsidiary.currency_id,context.user_id
    ])).rows[0];
  const line=(await db.query(`insert into public.solicitudes_pago_lineas(
      id_solicitud,id_cuenta_contable,tipo_tercero,
      id_agencia_tributaria,concepto,monto
    )values($1,$2,'Agencia Tributaria',$3,'Impuesto de prueba',1.23)
    returning id`,[
      request.id,account.account_id,agency.tax_agency_id
    ])).rows[0];

  const options=(await db.query(
    'select public.payment_request_report_options() value'
  )).rows[0].value;
  const agencyKey=`Agencia Tributaria:${agency.tax_agency_id}`;
  const agencyOption=options.thirdParties.find(item=>item.key===agencyKey);
  assert.ok(agencyOption,'La agencia no aparece entre los terceros del reporte.');
  assert.equal(agencyOption.name,agency.agency_name);
  assert.equal(agencyOption.taxId,'TAX-AGENCY-REPORT-TEST');

  const filters={
    subsidiaryId:Number(context.subsidiary_id),
    dateFrom:'2026-10-27',dateTo:'2026-10-27',dateField:'REQUEST',
    thirdPartyKey:agencyKey,page:1,pageSize:50
  };
  const filtered=(await db.query(
    'select public.run_payment_request_report($1::jsonb) value',[filters]
  )).rows[0].value;
  assert.equal(filtered.total,1,'El filtro por agencia debe devolver la solicitud de prueba.');
  assert.equal(filtered.rows[0].thirdParties[0].key,agencyKey);
  assert.equal(filtered.rows[0].thirdParties[0].name,agency.agency_name);
  assert.equal(filtered.rows[0].thirdParties[0].taxId,'TAX-AGENCY-REPORT-TEST');
  assert.equal(filtered.rows[0].lines[0].partyName,agency.agency_name);
  assert.equal(filtered.rows[0].lines[0].partyTaxId,'TAX-AGENCY-REPORT-TEST');

  const searched=(await db.query(
    'select public.run_payment_request_report($1::jsonb) value',[
      {...filters,thirdPartyKey:null,search:agency.agency_name}
    ]
  )).rows[0].value;
  assert.ok(
    searched.rows.some(row=>Number(row.id)===Number(request.id)),
    'La busqueda por nombre de agencia no encontro la solicitud.'
  );

  const workflow=(await db.query(`insert into public.wf_instances(
      workflow_id,subsidiaria_id,entity_type,entity_id,amount,
      approval_context,current_level,status,requested_by
    )values(null,$1,'PAYMENT_REQUEST',$2,1.23,'{}',1,
      'PENDIENTE_APROBACION',$3)
    returning id`,[
      context.subsidiary_id,request.id,context.user_id
    ])).rows[0];
  const step=(await db.query(`insert into public.wf_instance_steps(
      instance_id,nivel,nombre_nivel,usuario_aprobador_id,
      politica,required_count,status
    )values($1,1,'Aprobacion fiscal',$2,'ANY',1,'PENDIENTE')
    returning id`,[workflow.id,context.user_id])).rows[0];
  const snapshot=(await db.query(`select
    public.expense_approval_email_snapshot($1,$2,$3)value`,[
      workflow.id,step.id,context.user_id
    ])).rows[0].value;
  assert.equal(snapshot.lineas.length,1);
  assert.equal(snapshot.lineas[0].tercero,agency.agency_name);
  assert.equal(snapshot.lineas[0].tipoTercero,'Agencia Tributaria');
  assert.equal(Number(snapshot.lineas[0].id),Number(line.id));

  console.log(JSON.stringify({
    passed:true,rollback:true,
    agency:agency.agency_name,
    reportOption:true,filter:true,search:true,emailSnapshot:true
  }));
  await db.query('rollback');
}catch(error){
  await db.query('rollback').catch(()=>{});
  throw error;
}finally{
  await db.end();
}
