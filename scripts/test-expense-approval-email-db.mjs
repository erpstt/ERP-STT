import assert from 'node:assert/strict';
import pg from 'pg';
import {readFile} from 'node:fs/promises';

if(process.loadEnvFile)process.loadEnvFile('.env');

const required=['SUPABASE_URL','SUPABASE_DB_PASSWORD'];
for(const name of required){
  if(!process.env[name])throw new Error(`Falta ${name} en el entorno.`);
}

const projectRef=new URL(process.env.SUPABASE_URL).hostname.split('.')[0];
const db=new pg.Client({
  host:process.env.SUPABASE_DB_HOST||'aws-0-us-east-1.pooler.supabase.com',
  port:Number(process.env.SUPABASE_DB_PORT||6543),
  database:process.env.SUPABASE_DB_NAME||'postgres',
  user:process.env.SUPABASE_DB_USER||`postgres.${projectRef}`,
  password:process.env.SUPABASE_DB_PASSWORD,
  ssl:{rejectUnauthorized:false},
  connectionTimeoutMillis:15000
});

function migrationBody(sql){
  return sql
    .replace(/^\uFEFF?\s*begin\s*;/i,'')
    .replace(/commit\s*;\s*$/i,'');
}

async function scalar(sql,args=[]){
  return (await db.query(sql,args)).rows[0]?.value;
}

async function expectFailure(run,pattern){
  await db.query('savepoint expected_failure');
  try{
    await assert.rejects(run,pattern);
  }finally{
    await db.query('rollback to savepoint expected_failure');
  }
}

function claims({email,sessionId,role}){
  return JSON.stringify({email,session_id:sessionId,role});
}

await db.connect();
try{
  await db.query('begin');
  await db.query("set local lock_timeout='10s'");
  await db.query("set local statement_timeout='90s'");

  const migration=await readFile(
    new URL('../supabase/migrations/20261005100000_expense_approval_email_notifications.sql',import.meta.url),
    'utf8'
  );
  await db.query(migrationBody(migration));

  assert.equal(await scalar("select to_regclass('public.expense_approval_email_outbox') is not null value"),true);
  assert.equal(await scalar("select to_regprocedure('public.expense_approval_email_claim()') is not null value"),true);

  // Keep the worker assertions isolated if the migration was already present in
  // the target database. This update is part of the surrounding rollback.
  await db.query(`
    update public.expense_approval_email_outbox
       set status='OMITIDO',finished_at=coalesce(finished_at,now()),
           last_error=coalesce(last_error,'Aislado por prueba transaccional')
     where status='PENDIENTE'
  `);

  const admin=(await db.query(`
    select u.user_id,u.email,r.role_id,access.subsidiary_id
      from public.users u
      join public.user_roles membership using(user_id)
      join public.roles r using(role_id)
      join public.user_subsidiaries access using(user_id)
      join public.subsidiaries subsidiary using(subsidiary_id)
     where u.is_active and subsidiary.is_active
       and lower(r.role_name) in('administrador','administrator','admin')
     order by u.user_id,access.subsidiary_id
     limit 1
  `)).rows[0];
  assert.ok(admin,'Se requiere un administrador activo con acceso a una subsidiaria.');

  const stamp=`${Date.now()}-${Math.random().toString(36).slice(2,8)}`;
  const adminSession=`expense-email-admin-${stamp}`;
  await db.query(
    'insert into public.user_company_sessions(session_id,user_id,subsidiary_id)values($1,$2,$3)',
    [adminSession,admin.user_id,admin.subsidiary_id]
  );
  await db.query(
    'insert into public.user_role_sessions(session_id,user_id,role_id)values($1,$2,$3)',
    [adminSession,admin.user_id,admin.role_id]
  );
  await db.query("select set_config('request.jwt.claims',$1,true)",[
    claims({email:admin.email,sessionId:adminSession,role:'service_role'})
  ]);
  assert.equal(String(await scalar('select public.active_subsidiary_id() value')),String(admin.subsidiary_id));

  const customer=(await db.query(`
    select customer.customer_id
      from public.customers customer
     where customer.primary_subsidiary_id=$1
        or exists(
          select 1 from public.entity_subsidiaries access
           where access.customer_id=customer.customer_id and access.subsidiary_id=$1
        )
     order by customer.customer_id
     limit 1
  `,[admin.subsidiary_id])).rows[0];
  assert.ok(customer,'Se requiere un cliente habilitado en la subsidiaria de prueba.');

  const account=(await db.query(`
    select account_id
      from public.chart_accounts
     where public.pr_allowed_account(account_id)
     order by account_id
     limit 1
  `)).rows[0];
  assert.ok(account,'Se requiere una cuenta habilitada para solicitudes de tipo Otros.');

  const currency=(await db.query(
    'select currency_id from public.subsidiaries where subsidiary_id=$1',
    [admin.subsidiary_id]
  )).rows[0];
  assert.ok(currency?.currency_id,'La subsidiaria requiere moneda funcional.');

  const approver=(await db.query(`
    insert into public.users(email,password_hash,first_name,last_name,is_active)
    values($1,'test-only','Aprobador','Correo DB',true)
    returning user_id,email
  `,[`expense-approver-${stamp}@example.test`])).rows[0];
  await db.query(
    'insert into public.user_subsidiaries(user_id,subsidiary_id)values($1,$2)',
    [approver.user_id,admin.subsidiary_id]
  );

  const center=(await db.query(`
    insert into public.cost_centers(
      code,name,subsidiary_id,customer_id,cost_center_type,up_approver_id,is_inactive
    ) values($1,$2,$3,$4,'CLIENTE',$5,false)
    returning cost_center_id,code,name
  `,[
    `MAIL-${stamp}`.slice(0,40),
    `Centro de prueba correo ${stamp}`,
    admin.subsidiary_id,
    customer.customer_id,
    approver.user_id
  ])).rows[0];

  async function createAndSubmit(label,amount){
    const request=(await db.query(`
      insert into public.solicitudes_pago(
        numero,id_subsidiaria,id_moneda,tipo_solicitud,fecha_pago_programada,
        id_solicitante,concepto,total
      ) values($1,$2,$3,'OTROS',current_date,$4,$5,$6)
      returning id,numero,version
    `,[
      `MAIL-${label}-${stamp}`,
      admin.subsidiary_id,
      currency.currency_id,
      admin.user_id,
      `Concepto original ${label}`,
      amount
    ])).rows[0];

    await db.query(`
      insert into public.solicitudes_pago_lineas(
        id_solicitud,id_cuenta_contable,tipo_tercero,id_cliente,
        id_centro_costo,concepto,monto
      ) values($1,$2,'Cliente',$3,$4,$5,$6)
    `,[request.id,account.account_id,customer.customer_id,center.cost_center_id,`Detalle ${label}`,amount]);

    const submission=await scalar(`
      select public.pr_transition(jsonb_build_object(
        'id',$1::bigint,'version',$2::integer,'transition','SUBMIT'
      )) value
    `,[request.id,request.version]);
    assert.equal(String(submission.assignedApproverId),String(approver.user_id));

    const workflow=(await db.query(`
      select instance.id instance_id,instance.status,instance.current_level,
             step.id step_id,step.nivel,step.usuario_aprobador_id
        from public.wf_instances instance
        join public.wf_instance_steps step
          on step.instance_id=instance.id and step.nivel=instance.current_level
       where instance.entity_type='PAYMENT_REQUEST' and instance.entity_id=$1
       order by instance.id desc
       limit 1
    `,[request.id])).rows[0];
    assert.ok(workflow,'El envío debe crear una instancia y un nivel de aprobación.');
    assert.equal(String(workflow.usuario_aprobador_id),String(approver.user_id));
    return {...request,...workflow};
  }

  const settings=await scalar(
    "select public.expense_approval_email_settings('get','{}'::jsonb) value"
  );
  assert.equal(settings.canEdit,true);
  assert.equal(settings.template.tipo_notificacion,'SOLICITUD_GASTO_APROBACION');

  // Automatic enqueue + immutable business snapshot.
  const primary=await createAndSubmit('PRIMARY',17.25);
  let jobs=(await db.query(`
    select * from public.expense_approval_email_outbox
     where request_id=$1 order by created_at,id
  `,[primary.id])).rows;
  assert.equal(jobs.length,1);
  assert.equal(jobs[0].status,'PENDIENTE');
  assert.equal(String(jobs[0].recipient_user_id),String(approver.user_id));
  assert.equal(jobs[0].recipient_email,approver.email);
  assert.equal(jobs[0].payload.numero_solicitud,primary.numero);
  assert.equal(jobs[0].payload.concepto,'Concepto original PRIMARY');
  assert.equal(jobs[0].payload.centros_costos.length,1);
  assert.equal(String(jobs[0].payload.centros_costos[0].id),String(center.cost_center_id));
  assert.equal(jobs[0].payload.lineas.length,1);
  assert.equal(Number(jobs[0].payload.total),17.25);
  assert.match(jobs[0].deep_link,new RegExp(`id=${primary.id}(?:&|$)`));

  await db.query(
    "update public.solicitudes_pago set concepto='Concepto cambiado después de encolar' where id=$1",
    [primary.id]
  );
  assert.equal(
    await scalar('select payload->>\'concepto\' value from public.expense_approval_email_outbox where id=$1',[jobs[0].id]),
    'Concepto original PRIMARY'
  );

  // Re-running the notification hook cannot enqueue a duplicate for the same
  // step and recipient.
  await db.query('select public.wf_notify_level($1)',[primary.instance_id]);
  await db.query('select public.wf_notify_level($1)',[primary.instance_id]);
  assert.equal(
    Number(await scalar('select count(*) value from public.expense_approval_email_outbox where request_id=$1',[primary.id])),
    1
  );

  // Worker RPCs are private to service_role, even though their definitions are
  // SECURITY DEFINER.
  assert.equal(
    await scalar("select has_function_privilege('authenticated','public.expense_approval_email_claim()','EXECUTE') value"),
    false
  );
  assert.equal(
    await scalar("select has_function_privilege('service_role','public.expense_approval_email_claim()','EXECUTE') value"),
    true
  );
  assert.equal(
    await scalar("select has_table_privilege('authenticated','public.expense_approval_email_outbox','SELECT') value"),
    false
  );
  await expectFailure(async()=>{
    await db.query("select set_config('request.jwt.claims',$1,true)",[
      claims({email:admin.email,sessionId:adminSession,role:'authenticated'})
    ]);
    return db.query('select public.expense_approval_email_claim()');
  },/exclusiva del servicio|permission denied/i);
  await db.query("select set_config('request.jwt.claims',$1,true)",[
    claims({email:admin.email,sessionId:adminSession,role:'service_role'})
  ]);

  // Claim and finish are exercised without an SMTP client, so no real message
  // can leave this test.
  const claimed=await scalar('select public.expense_approval_email_claim() value');
  assert.ok(claimed,'El worker debe reclamar la notificación pendiente.');
  assert.equal(claimed.id,jobs[0].id);
  assert.equal(claimed.status,'ENVIANDO');
  assert.equal(Number(claimed.attempts),1);
  assert.ok(claimed.lease);
  assert.equal(await scalar('select public.expense_approval_email_claim() value'),null);
  assert.equal(await scalar(
    "select public.expense_approval_email_finish($1,$2,'ENVIADO',$3,null) value",
    [claimed.id,claimed.lease,'mock-expense-approval-message']
  ),true);
  assert.equal(await scalar(
    "select public.expense_approval_email_finish($1,$2,'ENVIADO',$3,null) value",
    [claimed.id,claimed.lease,'mock-expense-approval-message']
  ),false);
  const finished=(await db.query(`
    select status,message_id,sent_at,finished_at,lease,lease_until
      from public.expense_approval_email_outbox where id=$1
  `,[claimed.id])).rows[0];
  assert.equal(finished.status,'ENVIADO');
  assert.equal(finished.message_id,'mock-expense-approval-message');
  assert.ok(finished.sent_at&&finished.finished_at);
  assert.equal(finished.lease,null);

  // Confirmed temporary SMTP failures are retried with backoff, but only up
  // to three delivery attempts. No SMTP client participates in this test.
  const retryRequest=await createAndSubmit('RETRY',18.1);
  let retryClaim=await scalar('select public.expense_approval_email_claim() value');
  assert.equal(Number(retryClaim.attempts),1);
  assert.equal(await scalar(
    "select public.expense_approval_email_finish($1,$2,'REINTENTO',null,$3) value",
    [retryClaim.id,retryClaim.lease,'SMTP 451 temporal']
  ),true);
  let retryState=(await db.query(`
    select status,attempts,next_attempt_at>now() waiting,finished_at,lease
      from public.expense_approval_email_outbox where id=$1
  `,[retryClaim.id])).rows[0];
  assert.deepEqual(
    [retryState.status,Number(retryState.attempts),retryState.waiting,retryState.finished_at,retryState.lease],
    ['PENDIENTE',1,true,null,null]
  );
  assert.equal(await scalar('select public.expense_approval_email_claim() value'),null);

  await db.query('update public.expense_approval_email_outbox set next_attempt_at=now() where id=$1',[retryClaim.id]);
  retryClaim=await scalar('select public.expense_approval_email_claim() value');
  assert.equal(Number(retryClaim.attempts),2);
  await scalar(
    "select public.expense_approval_email_finish($1,$2,'REINTENTO',null,$3) value",
    [retryClaim.id,retryClaim.lease,'SMTP 451 temporal']
  );
  await db.query('update public.expense_approval_email_outbox set next_attempt_at=now() where id=$1',[retryClaim.id]);
  retryClaim=await scalar('select public.expense_approval_email_claim() value');
  assert.equal(Number(retryClaim.attempts),3);
  await scalar(
    "select public.expense_approval_email_finish($1,$2,'REINTENTO',null,$3) value",
    [retryClaim.id,retryClaim.lease,'SMTP 451 temporal']
  );
  retryState=(await db.query(`
    select status,attempts,finished_at,lease
      from public.expense_approval_email_outbox where id=$1
  `,[retryClaim.id])).rows[0];
  assert.equal(retryState.status,'ERROR');
  assert.equal(Number(retryState.attempts),3);
  assert.ok(retryState.finished_at);
  assert.equal(retryState.lease,null);

  // Role-based recipients are revalidated at claim time. Removing the role
  // after enqueue must cancel the email before any business data is sent.
  const roleRequest=await createAndSubmit('ROLE',18.2);
  await db.query('delete from public.expense_approval_email_outbox where request_id=$1',[roleRequest.id]);
  const temporaryRole=(await db.query(`
    insert into public.roles(role_name,description,is_system_role)
    values($1,'Rol temporal para validar destinatarios de correo',false)
    returning role_id
  `,[`EXPENSE_EMAIL_ROLE_${stamp}`])).rows[0];
  await db.query(
    'insert into public.user_roles(user_id,role_id)values($1,$2)',
    [approver.user_id,temporaryRole.role_id]
  );
  await db.query(`
    update public.wf_instance_steps
       set usuario_aprobador_id=null,rol_aprobador_id=$2
     where id=$1
  `,[roleRequest.step_id,temporaryRole.role_id]);
  await db.query('select public.wf_notify_level($1)',[roleRequest.instance_id]);
  assert.equal(
    await scalar('select status value from public.expense_approval_email_outbox where request_id=$1',[roleRequest.id]),
    'PENDIENTE'
  );
  await db.query(
    'delete from public.user_roles where user_id=$1 and role_id=$2',
    [approver.user_id,temporaryRole.role_id]
  );
  assert.equal(await scalar('select public.expense_approval_email_claim() value'),null);
  const removedRoleJob=(await db.query(`
    select status,last_error,finished_at
      from public.expense_approval_email_outbox where request_id=$1
  `,[roleRequest.id])).rows[0];
  assert.equal(removedRoleJob.status,'CANCELADO');
  assert.ok(removedRoleJob.finished_at);
  assert.match(removedRoleJob.last_error,/ya no está pendiente/i);

  // A disabled template records the business event but never exposes it to the
  // worker queue.
  await scalar("select public.expense_approval_email_settings('save',$1::jsonb) value",[JSON.stringify({
    subject:settings.template.asunto_template,
    body:settings.template.cuerpo_template,
    active:false
  })]);
  const disabled=await createAndSubmit('DISABLED',18.5);
  const disabledJob=(await db.query(`
    select status,last_error,finished_at
      from public.expense_approval_email_outbox where request_id=$1
  `,[disabled.id])).rows[0];
  assert.equal(disabledJob.status,'OMITIDO');
  assert.ok(disabledJob.finished_at);
  assert.match(disabledJob.last_error,/desactivada/i);

  await scalar("select public.expense_approval_email_settings('save',$1::jsonb) value",[JSON.stringify({
    subject:settings.template.asunto_template,
    body:settings.template.cuerpo_template,
    active:true
  })]);

  // If the request is approved before the worker reaches it, claim cancels the
  // obsolete job instead of sending a stale approval request.
  const stale=await createAndSubmit('STALE',19.75);
  const staleHeader=(await db.query(
    'select version from public.solicitudes_pago where id=$1',[stale.id]
  )).rows[0];
  await scalar(`
    select public.pr_transition(jsonb_build_object(
      'id',$1::bigint,'version',$2::integer,'transition','APPROVE'
    )) value
  `,[stale.id,staleHeader.version]);
  assert.equal(await scalar('select public.expense_approval_email_claim() value'),null);
  const staleJob=(await db.query(`
    select status,last_error,finished_at
      from public.expense_approval_email_outbox where request_id=$1
  `,[stale.id])).rows[0];
  assert.equal(staleJob.status,'CANCELADO');
  assert.ok(staleJob.finished_at);
  assert.match(staleJob.last_error,/ya no está pendiente/i);

  console.log(JSON.stringify({
    migration:true,
    expenseRequest:true,
    temporaryApprover:true,
    automaticEnqueue:true,
    immutableSnapshot:true,
    deduplication:true,
    claimLease:true,
    finishIdempotency:true,
    disabledTemplate:true,
    staleCancellation:true,
    removedRoleCancellation:true,
    boundedTransientRetry:true,
    serviceRoleOnly:true,
    rollback:true,
    emailsSent:0
  }));
}finally{
  await db.query('rollback').catch(()=>undefined);
  await db.end();
}
