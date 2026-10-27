import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import pg from 'pg';

process.loadEnvFile?.('.env');

const projectRef = new URL(process.env.SUPABASE_URL).hostname.split('.')[0];
const db = new pg.Client({
  host: process.env.SUPABASE_DB_HOST || 'aws-0-us-east-1.pooler.supabase.com',
  port: Number(process.env.SUPABASE_DB_PORT || 6543),
  database: process.env.SUPABASE_DB_NAME || 'postgres',
  user: process.env.SUPABASE_DB_USER || `postgres.${projectRef}`,
  password: process.env.SUPABASE_DB_PASSWORD || process.env.PGPASSWORD,
  ssl: { rejectUnauthorized: false },
  connectionTimeoutMillis: 15000
});

const migrationBody = source => source
  .replace(/^\uFEFF?\s*begin\s*;\s*/i, '')
  .replace(/\s*commit\s*;\s*notify\s+pgrst\s*,\s*'reload schema'\s*;\s*$/i, '');

const rpc = async (name, payload = null) => {
  const params = payload === null ? [] : [JSON.stringify(payload)];
  const argument = payload === null ? '' : '$1::jsonb';
  return (await db.query(`select public.${name}(${argument}) value`, params)).rows[0].value;
};

await db.connect();
try {
  await db.query('begin');
  await db.query("set local statement_timeout='120s'");
  const hadDepartmentColumn = (await db.query(`select 1
    from information_schema.columns
    where table_schema='public' and table_name='solicitudes_pago_lineas'
      and column_name='id_departamento'`)).rowCount === 1;
  const protectedLineIds = (await db.query(hadDepartmentColumn
    ? `select line.id from public.solicitudes_pago_lineas line
       join public.solicitudes_pago request on request.id=line.id_solicitud
       where request.estado in('APLICADO','ANULADO')
         and line.id_departamento is null`
    : `select line.id from public.solicitudes_pago_lineas line
       join public.solicitudes_pago request on request.id=line.id_solicitud
       where request.estado in('APLICADO','ANULADO')`)).rows.map(row => row.id);
  const migration = await readFile(new URL(
    '../supabase/migrations/20261027120000_payment_request_line_dimensions.sql',
    import.meta.url
  ), 'utf8');
  await db.query(migrationBody(migration));

  const column = (await db.query(`select 1
    from information_schema.columns
    where table_schema='public' and table_name='solicitudes_pago_lineas'
      and column_name='id_departamento'`)).rowCount;
  assert.equal(column, 1);
  const costCenterDepartmentColumn = (await db.query(`select 1
    from information_schema.columns
    where table_schema='public' and table_name='cost_centers'
      and column_name='department_id'`)).rowCount;
  assert.equal(costCenterDepartmentColumn, 1,
    'No se agrego el departamento explicito al centro de costos.');

  const missedClientBackfill = (await db.query(`select count(*)::int total
    from public.cost_centers center
    join public.customers customer on customer.customer_id=center.customer_id
    join public.departments department
      on department.department_id=customer.department_id
    where upper(center.cost_center_type)='CLIENTE'
      and center.department_id is distinct from customer.department_id
      and not department.is_inactive
      and lower(department.type)='cliente'
      and(
        department.subsidiary_id=center.subsidiary_id
        or exists(
          select 1 from public.department_subsidiaries scope
          where scope.department_id=department.department_id
            and scope.subsidiary_id=center.subsidiary_id
        )
      )`)).rows[0].total;
  assert.equal(missedClientBackfill, 0,
    'No se completo el departamento de un centro CLIENTE derivable.');

  const syncCandidate = (await db.query(`select
      customer.customer_id,min(center.subsidiary_id) subsidiary_id
    from public.customers customer
    join public.cost_centers center on center.customer_id=customer.customer_id
    where upper(center.cost_center_type)='CLIENTE'
    group by customer.customer_id
    order by customer.customer_id
    limit 1`)).rows[0];
  assert.ok(syncCandidate,
    'Se necesita un cliente con centro de costos para probar la sincronizacion.');
  const syncDepartment = (await db.query(`insert into public.departments(
      name,type,subsidiary_id,is_inactive
    )values($1,'Cliente',$2,false)
    returning department_id`, [
    `PRUEBA SINCRONIZACION ${Date.now()}`, syncCandidate.subsidiary_id
  ])).rows[0];
  await db.query(`insert into public.department_subsidiaries(
      department_id,subsidiary_id
    )
    select $1,scope.subsidiary_id
    from(
      select subsidiary_id from public.entity_subsidiaries where customer_id=$2
      union
      select subsidiary_id from public.cost_centers where customer_id=$2
    )scope
    on conflict do nothing`, [syncDepartment.department_id, syncCandidate.customer_id]);
  await db.query(`update public.customers set department_id=$1
    where customer_id=$2`, [
    syncDepartment.department_id, syncCandidate.customer_id
  ]);
  const unsynchronizedCenters = (await db.query(`select count(*)::int total
    from public.cost_centers
    where customer_id=$1 and upper(cost_center_type)='CLIENTE'
      and department_id is distinct from $2`, [
    syncCandidate.customer_id, syncDepartment.department_id
  ])).rows[0].total;
  assert.equal(unsynchronizedCenters, 0,
    'Cambiar el departamento del cliente no sincronizo sus centros de costos.');

  if (protectedLineIds.length) {
    const changedHistory = (await db.query(`select count(*)::int total
      from public.solicitudes_pago_lineas
      where id=any($1::bigint[]) and id_departamento is not null`, [protectedLineIds])).rows[0].total;
    assert.equal(changedHistory, 0, 'El backfill modificó solicitudes aplicadas o anuladas.');
  }

  const unresolvedDerivable = (await db.query(`with candidates as(
      select line.id,count(distinct source.department_id) department_count
      from public.solicitudes_pago_lineas line
      join public.solicitudes_pago request on request.id=line.id_solicitud
      left join public.employees employee on employee.employee_id=line.id_empleado
      left join public.customers customer on customer.customer_id=line.id_cliente
      left join public.cost_centers center on center.cost_center_id=line.id_centro_costo
      left join public.customers center_customer on center_customer.customer_id=center.customer_id
      cross join lateral(values(employee.department_id),(customer.department_id),
        (center.department_id),(center_customer.department_id))source(department_id)
      join public.departments department on department.department_id=source.department_id
       and not department.is_inactive
       and(department.subsidiary_id=request.id_subsidiaria or exists(
        select 1 from public.department_subsidiaries scope
        where scope.department_id=department.department_id and scope.subsidiary_id=request.id_subsidiaria
       ))
      where request.tipo_solicitud='OTROS'
        and request.estado in('BORRADOR','APROBADO','RECHAZADO')
        and line.id_departamento is null and source.department_id is not null
      group by line.id
    )select count(*)::int total from candidates where department_count=1`)).rows[0].total;
  assert.equal(unresolvedDerivable, 0, 'Quedaron solicitudes abiertas con un departamento derivable sin completar.');

  const legacyApproved = (await db.query(`select line.id,line.id_departamento,
      employee.department_id employee_department
    from public.solicitudes_pago request
    join public.solicitudes_pago_lineas line on line.id_solicitud=request.id
    left join public.employees employee on employee.employee_id=line.id_empleado
    where request.id=29 and request.tipo_solicitud='OTROS'
      and request.estado='APROBADO'`)).rows;
  if (legacyApproved.length) {
    assert.ok(legacyApproved.every(row => row.id_departamento != null));
    assert.ok(legacyApproved.every(row => String(row.id_departamento) === String(row.employee_department)));
  }

  const unresolvedTaxAgency = (await db.query(`select line.id_departamento
    from public.solicitudes_pago request
    join public.solicitudes_pago_lineas line on line.id_solicitud=request.id
    where request.id=99 and request.tipo_solicitud='OTROS'
      and line.tipo_tercero='Agencia Tributaria'`)).rows;
  if (unresolvedTaxAgency.length) {
    assert.ok(unresolvedTaxAgency.every(row => row.id_departamento == null));
  }

  const context = (await db.query(`select
      account.user_id,account.email,account.auth_user_id::text sub,
      company_session.session_id,company_session.subsidiary_id
    from public.user_company_sessions company_session
    join public.users account using(user_id)
    join public.user_role_sessions role_session
      on role_session.session_id=company_session.session_id
      and role_session.user_id=company_session.user_id
    join public.roles role using(role_id)
    where account.is_active
      and lower(role.role_name)in('administrador','administrator','admin')
      and exists(
        select 1 from public.tax_agency_subsidiaries agency
        where agency.subsidiary_id=company_session.subsidiary_id
      )
      and exists(
        select 1 from public.departments department
        where not department.is_inactive
          and lower(department.type)='interno'
          and(
            department.subsidiary_id=company_session.subsidiary_id
            or exists(
              select 1 from public.department_subsidiaries scope
              where scope.department_id=department.department_id
                and scope.subsidiary_id=company_session.subsidiary_id
            )
          )
      )
    order by company_session.selected_at desc
    limit 1`)).rows[0];
  assert.ok(context, 'No existe una sesión administrativa con agencia y departamentos.');
  await db.query("select set_config('request.jwt.claims',$1,true)", [JSON.stringify(context)]);

  if (legacyApproved.length) {
    const legacySubsidiary = (await db.query(
      'select id_subsidiaria from public.solicitudes_pago where id=29'
    )).rows[0]?.id_subsidiaria;
    if (String(legacySubsidiary) === String(context.subsidiary_id)) {
      await db.query('select public.pr_validate(29)');
    }
  }

  const options = await rpc('pr_options');
  assert.ok(options.departments.length > 0, 'pr_options no devolvió departamentos.');
  assert.ok(options.accounts.length > 0, 'pr_options no devolvió cuentas permitidas.');
  assert.ok(options.taxAgencies.length > 0, 'pr_options no devolvió agencias tributarias.');
  assert.ok(options.departments.every(item => ['Cliente', 'Interno'].includes(item.type)));
  assert.ok(options.costCenters.every(item => 'type' in item && 'departmentId' in item));

  const department = options.departments.find(item => item.type === 'Interno');
  assert.ok(department, 'La subsidiaria de prueba no tiene departamento Interno.');
  const account = options.accounts[0];
  const agency = options.taxAgencies[0];
  const baseCurrencyId = options.baseCurrencyId;
  const internalCenter = (await db.query(`insert into public.cost_centers(
      code,name,subsidiary_id,cost_center_type,department_id,is_inactive
    )values('TEMP','Centro interno de prueba',$1,'INTERNO',$2,false)
    returning cost_center_id,department_id`, [
    context.subsidiary_id, department.id
  ])).rows[0];
  assert.equal(String(internalCenter.department_id), String(department.id));
  const optionsWithInternalCenter = await rpc('pr_options');
  const returnedInternalCenter = optionsWithInternalCenter.costCenters.find(
    item => String(item.id) === String(internalCenter.cost_center_id)
  );
  assert.equal(String(returnedInternalCenter?.departmentId), String(department.id));
  assert.equal(returnedInternalCenter?.type, 'INTERNO');
  const testNumber = `TEST-DIM-${Date.now()}`;
  const requestId = (await db.query(`insert into public.solicitudes_pago(
      numero,id_subsidiaria,id_moneda,tipo_solicitud,fecha_pago_programada,
      id_solicitante,concepto,total
    )values($1,$2,$3,'OTROS',current_date,$4,'Prueba dimensiones',0.01)
    returning id`, [testNumber, context.subsidiary_id, baseCurrencyId, context.user_id])).rows[0].id;
  await db.query(`insert into public.solicitudes_pago_lineas(
      id_solicitud,id_cuenta_contable,tipo_tercero,id_agencia_tributaria,
      id_departamento,id_centro_costo,concepto,monto
    )values($1,$2,'Agencia Tributaria',$3,$4,$5,'Impuesto de prueba',0.01)`, [
    requestId, account.id, agency.id, department.id,
    internalCenter.cost_center_id
  ]);

  await db.query('select public.pr_validate($1)', [requestId]);
  const detail = await rpc('pr_detail', { id: requestId });
  assert.equal(String(detail.lines[0].id_departamento), String(department.id));
  assert.equal(detail.lines[0].departmentType, department.type);
  assert.equal(detail.lines[0].department, department.name);

  const report = await rpc('run_payment_request_report', {
    subsidiaryId: context.subsidiary_id,
    dateFrom: new Date().toISOString().slice(0, 10),
    dateTo: new Date().toISOString().slice(0, 10),
    search: testNumber
  });
  assert.equal(report.rows.length, 1);
  assert.equal(String(report.rows[0].lines[0].departments[0].id), String(department.id));

  const executeDefinition = (await db.query(
    "select pg_get_functiondef('public.pr_execute_without_budget(jsonb)'::regprocedure) definition"
  )).rows[0].definition;
  const emailDefinition = (await db.query(
    "select pg_get_functiondef('public.expense_approval_email_snapshot(bigint,bigint,bigint)'::regprocedure) definition"
  )).rows[0].definition;
  assert.match(executeDefinition, /'department_id'\s*,\s*id_departamento/);
  assert.match(emailDefinition, /coalesce\(\s*l\.id_departamento\s*,/);
  const validationDefinition = (await db.query(
    "select pg_get_functiondef('public.pr_validate(bigint)'::regprocedure) definition"
  )).rows[0].definition;
  assert.doesNotMatch(validationDefinition, /cost_center\.cost_center_type\s*=\s*'INTERNO'\s+or/i);
  assert.match(validationDefinition,
    /coalesce\(cost_center\.department_id\s*,\s*owner\.department_id\)\s*=\s*line_row\.id_departamento/i);

  console.log(JSON.stringify({
    passed: true,
    rollback: true,
    department: department.name,
    optionsCascadeReady: true,
    costCenterDepartmentBackfillReady: true,
    customerDepartmentChangesSynchronizeCenters: true,
    internalCenterUsesExplicitDepartmentLink: true,
    legacyDerivableRequestsBackfilled: true,
    unresolvedTaxAgencyLeftForEditing: true,
    appliedAndCancelledHistoryPreserved: true,
    requestDimensionPersisted: true,
    reportUsesSelectedDepartment: true,
    paymentPropagationReady: true,
    emailUsesSelectedDepartment: true
  }));
} finally {
  await db.query('rollback').catch(() => {});
  await db.end();
}
