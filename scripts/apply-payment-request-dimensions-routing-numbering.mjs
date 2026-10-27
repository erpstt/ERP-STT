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

const releaseManifest = [
  {
    path:'../supabase/migrations/20261027120000_payment_request_line_dimensions.sql',
    verifies:[
      'cost_centers.department_id','payment line department backfill',
      'cost center validation and customer synchronization triggers'
    ]
  },
  {
    path:'../supabase/migrations/20261027130000_payment_request_approval_routing.sql',
    verifies:[
      'multi-step approval route','dynamic current approver synchronization',
      'tax supervisor override'
    ]
  },
  {
    path:'../supabase/migrations/20261027140000_payment_request_number_sequence.sql',
    verifies:[
      'global SOL_PAG maximum','minimum eight-digit padding',
      'draft-only contingency renumbering'
    ]
  }
];
const migrations = releaseManifest.map(entry => entry.path);
const auditExecutionContext = 'migration-20261027-payment-request-release';

const migrationBody = source => source
  .replace(/^\uFEFF?\s*begin\s*;\s*/i, '')
  .replace(/\s*notify\s+pgrst\s*,\s*'reload schema'\s*;\s*/gi, '\n')
  .replace(/\s*commit\s*;\s*$/i, '');

const canonicalNumber = value => /^SOL_PAG-\d{8,}$/.test(String(value || ''));
const fallbackNumber = value => /^SOL_PAG-\d{17}$/.test(String(value || ''));
const canonicalSuffix = value => {
  const match = /^SOL_PAG-(\d{8,})$/.exec(String(value || ''));
  assert.ok(match,`N\u00famero SOL_PAG no can\u00f3nico: ${value}`);
  return BigInt(match[1]);
};

function assertDatabaseAudit(metadata,label) {
  assert.equal(metadata.updated_by_id,null,`${label}: updated_by_id no es de sistema.`);
  assert.equal(
    metadata.updated_by_email,'database@gentia.local',
    `${label}: el correo de auditor\u00eda no identifica a la base de datos.`
  );
  assert.equal(
    metadata.updated_by_name,'Proceso de base de datos',
    `${label}: el nombre de auditor\u00eda no identifica al proceso de base de datos.`
  );
  assert.equal(
    metadata.updated_actor_type,'SYSTEM_JOB',
    `${label}: el actor de auditor\u00eda no es SYSTEM_JOB.`
  );
  assert.match(
    String(metadata.updated_actor_source || ''),/^PostgreSQL \/ /,
    `${label}: el origen de auditor\u00eda no es PostgreSQL.`
  );
  assert.equal(
    metadata.updated_execution_context_id,auditExecutionContext,
    `${label}: el contexto de ejecuci\u00f3n de auditor\u00eda no coincide.`
  );
}

async function businessTotals() {
  return (await db.query(`select
    (select count(*)::text from public.solicitudes_pago) request_count,
    (select coalesce(sum(total),0)::text from public.solicitudes_pago) request_total,
    (select count(*)::text from public.solicitudes_pago_lineas) request_line_count,
    (select coalesce(sum(monto),0)::text from public.solicitudes_pago_lineas) request_line_total,
    (select count(*)::text from public.bank_check_line) bank_line_count,
    (select coalesce(sum(amount),0)::text from public.bank_check_line) bank_line_total,
    (select count(*)::text from public.journal_line) journal_line_count,
    (select coalesce(sum(debit),0)::text from public.journal_line) journal_debit,
    (select coalesce(sum(credit),0)::text from public.journal_line) journal_credit,
    (select coalesce(sum(debit_fx),0)::text from public.journal_line) journal_debit_fx,
    (select coalesce(sum(credit_fx),0)::text from public.journal_line) journal_credit_fx`)).rows[0];
}

async function immutableRequestNumbers() {
  return (await db.query(`select id,numero,estado
    from public.solicitudes_pago
    where estado<>'BORRADOR'
    order by id`)).rows;
}

async function request99() {
  return (await db.query(`select request.id,request.numero,request.estado,
      request.id_subsidiaria,request.version,
      subsidiary.tax_supervisor_user_id,
      count(line.id)::integer line_count,
      count(*)filter(where line.tipo_tercero='Agencia Tributaria')::integer tax_lines
    from public.solicitudes_pago request
    join public.subsidiaries subsidiary
      on subsidiary.subsidiary_id=request.id_subsidiaria
    left join public.solicitudes_pago_lineas line
      on line.id_solicitud=request.id
    where request.id=99
    group by request.id,subsidiary.tax_supervisor_user_id`)).rows[0] || null;
}

async function hasDepartmentColumn() {
  return (await db.query(`select exists(
      select 1
      from information_schema.columns
      where table_schema='public'
        and table_name='solicitudes_pago_lineas'
        and column_name='id_departamento'
    ) value`)).rows[0].value;
}

async function hasCostCenterDepartmentColumn() {
  return (await db.query(`select exists(
      select 1
      from information_schema.columns
      where table_schema='public'
        and table_name='cost_centers'
        and column_name='department_id'
    ) value`)).rows[0].value;
}

async function costCenterRecords(departmentColumnExists) {
  const departmentId = departmentColumnExists
    ? 'center.department_id::text'
    : 'null::text';
  return (await db.query(`select
      center.cost_center_id::text center_id,
      to_jsonb(center)-'department_id' record,
      to_jsonb(center)-array[
        'department_id','updated_by_id','updated_by_email','updated_by_name',
        'updated_actor_type','updated_actor_source',
        'updated_execution_context_id'
      ]::text[] business_record,
      jsonb_build_object(
        'updated_by_id',center.updated_by_id,
        'updated_by_email',center.updated_by_email,
        'updated_by_name',center.updated_by_name,
        'updated_actor_type',center.updated_actor_type,
        'updated_actor_source',center.updated_actor_source,
        'updated_execution_context_id',center.updated_execution_context_id
      ) audit,
      ${departmentId} department_id
    from public.cost_centers center
    order by center.cost_center_id`)).rows;
}

async function paymentLineRecords(departmentColumnExists) {
  const departmentId = departmentColumnExists
    ? 'line.id_departamento::text'
    : 'null::text';
  return (await db.query(`select
      line.id::text line_id,
      line.id_solicitud::text request_id,
      to_jsonb(line)-'id_departamento' record,
      to_jsonb(line)-array[
        'id_departamento','updated_by_id','updated_by_email','updated_by_name',
        'updated_actor_type','updated_actor_source',
        'updated_execution_context_id'
      ]::text[] business_record,
      jsonb_build_object(
        'updated_by_id',line.updated_by_id,
        'updated_by_email',line.updated_by_email,
        'updated_by_name',line.updated_by_name,
        'updated_actor_type',line.updated_actor_type,
        'updated_actor_source',line.updated_actor_source,
        'updated_execution_context_id',line.updated_execution_context_id
      ) audit,
      ${departmentId} department_id
    from public.solicitudes_pago_lineas line
    order by line.id`)).rows;
}

async function derivableClientCostCenters(departmentColumnExists) {
  const missingDepartment = departmentColumnExists
    ? 'and center.department_id is null'
    : '';
  return (await db.query(`select
      center.cost_center_id::text center_id,
      customer.department_id::text expected_department_id
    from public.cost_centers center
    join public.customers customer on customer.customer_id=center.customer_id
    join public.departments department
      on department.department_id=customer.department_id
    where upper(center.cost_center_type)='CLIENTE'
      ${missingDepartment}
      and not department.is_inactive
      and lower(department.type)='cliente'
      and(
        department.subsidiary_id=center.subsidiary_id
        or exists(
          select 1 from public.department_subsidiaries scope
          where scope.department_id=department.department_id
            and scope.subsidiary_id=center.subsidiary_id
        )
      )
    order by center.cost_center_id`)).rows;
}

async function derivableOpenLines(
  departmentColumnExists,costCenterDepartmentColumnExists
) {
  const missingDepartment = departmentColumnExists
    ? 'and line.id_departamento is null'
    : '';
  const costCenterDepartment = costCenterDepartmentColumnExists
    ? '(center.department_id),'
    : '';
  return (await db.query(`with safe_department as(
      select
        line.id::text line_id,
        request.id::text request_id,
        min(candidate.department_id)::text expected_department_id
      from public.solicitudes_pago_lineas line
      join public.solicitudes_pago request on request.id=line.id_solicitud
      left join public.employees employee on employee.employee_id=line.id_empleado
      left join public.customers customer on customer.customer_id=line.id_cliente
      left join public.cost_centers center on center.cost_center_id=line.id_centro_costo
      left join public.customers center_customer
        on center_customer.customer_id=center.customer_id
      cross join lateral(
        values(employee.department_id),(customer.department_id),
          ${costCenterDepartment}(center_customer.department_id)
      )candidate(department_id)
      join public.departments department
        on department.department_id=candidate.department_id
       and not department.is_inactive
       and(
         department.subsidiary_id=request.id_subsidiaria
         or exists(
           select 1 from public.department_subsidiaries scope
           where scope.department_id=department.department_id
             and scope.subsidiary_id=request.id_subsidiaria
         )
       )
      where request.tipo_solicitud='OTROS'
        and request.estado in(
          'BORRADOR','RECHAZADO','APROBADO'
        )
        ${missingDepartment}
        and candidate.department_id is not null
      group by line.id,request.id
      having count(distinct candidate.department_id)=1
    )
    select line_id,request_id,expected_department_id
    from safe_department
    order by line_id::bigint`)).rows;
}

async function protectedStateRecords(departmentColumnExists,states) {
  const departmentId = departmentColumnExists
    ? 'line.id_departamento::text'
    : 'null::text';
  const headers = (await db.query(`select
      request.id::text request_id,
      to_jsonb(request) record
    from public.solicitudes_pago request
    where request.estado=any($1::text[])
    order by request.id`,[states])).rows;
  const lines = (await db.query(`select
      request.id::text request_id,
      line.id::text line_id,
      to_jsonb(line)-'id_departamento' record,
      ${departmentId} department_id
    from public.solicitudes_pago request
    join public.solicitudes_pago_lineas line on line.id_solicitud=request.id
    where request.estado=any($1::text[])
    order by request.id,line.id`,[states])).rows;
  return { headers,lines };
}

async function request29(departmentColumnExists) {
  const missingDepartmentCount = departmentColumnExists
    ? 'count(*)filter(where line.id is not null and line.id_departamento is null)'
    : 'count(line.id)';
  return (await db.query(`select
      request.id,
      request.tipo_solicitud,
      request.estado,
      request.version,
      request.id_subsidiaria,
      count(line.id)::integer line_count,
      (${missingDepartmentCount})::integer missing_department_count
    from public.solicitudes_pago request
    left join public.solicitudes_pago_lineas line
      on line.id_solicitud=request.id
    where request.id=29
    group by request.id`)).rows[0] || null;
}

async function authorizedContext(subsidiaryId) {
  return (await db.query(`select
      account.email,account.auth_user_id::text sub,
      company_session.session_id,company_session.subsidiary_id
    from public.user_company_sessions company_session
    join public.users account using(user_id)
    where company_session.subsidiary_id=$1
      and account.is_active and account.auth_user_id is not null
      and exists(
        select 1 from public.user_subsidiaries access
        where access.user_id=account.user_id
          and access.subsidiary_id=company_session.subsidiary_id
      )
    order by company_session.selected_at desc
    limit 1`,[subsidiaryId])).rows[0] || null;
}

async function verifyCostCenterTriggers() {
  const autofillCandidate = (await db.query(`select
      center.cost_center_id,
      center.department_id::text original_department_id,
      customer.department_id::text expected_department_id
    from public.cost_centers center
    join public.customers customer on customer.customer_id=center.customer_id
    join public.departments department
      on department.department_id=customer.department_id
    where upper(center.cost_center_type)='CLIENTE'
      and center.department_id=customer.department_id
      and not department.is_inactive
      and lower(department.type)='cliente'
      and(
        department.subsidiary_id=center.subsidiary_id
        or exists(
          select 1 from public.department_subsidiaries scope
          where scope.department_id=department.department_id
            and scope.subsidiary_id=center.subsidiary_id
        )
      )
    order by center.cost_center_id
    limit 1`)).rows[0] || null;
  let autofillTested = false;
  if (autofillCandidate) {
    await db.query('savepoint verify_cost_center_autofill');
    const filled = (await db.query(`update public.cost_centers
      set department_id=null
      where cost_center_id=$1
      returning department_id::text`,[
      autofillCandidate.cost_center_id
    ])).rows[0];
    assert.equal(
      filled.department_id,autofillCandidate.expected_department_id,
      'El trigger no restaur\u00f3 el departamento heredado del cliente.'
    );
    await db.query('rollback to savepoint verify_cost_center_autofill');
    await db.query('release savepoint verify_cost_center_autofill');
    const restored = (await db.query(`select department_id::text
      from public.cost_centers where cost_center_id=$1`,[
      autofillCandidate.cost_center_id
    ])).rows[0];
    assert.equal(
      restored.department_id,autofillCandidate.original_department_id,
      'La prueba del trigger dej\u00f3 cambios en el centro de costos.'
    );
    autofillTested = true;
  }

  const syncCandidate = (await db.query(`select
      customer.customer_id,
      customer.department_id::text original_department_id,
      replacement.department_id::text replacement_department_id
    from public.customers customer
    cross join lateral(
      select candidate.department_id
      from public.departments candidate
      where not candidate.is_inactive
        and lower(candidate.type)='cliente'
        and candidate.department_id is distinct from customer.department_id
        and not exists(
          select 1
          from(
            select center.subsidiary_id
            from public.cost_centers center
            where center.customer_id=customer.customer_id
              and upper(center.cost_center_type)='CLIENTE'
            union
            select customer.primary_subsidiary_id
            union
            select scope.subsidiary_id
            from public.entity_subsidiaries scope
            where scope.customer_id=customer.customer_id
          )required_scope(subsidiary_id)
          where required_scope.subsidiary_id is not null
            and not(
              candidate.subsidiary_id=required_scope.subsidiary_id
              or exists(
                select 1 from public.department_subsidiaries department_scope
                where department_scope.department_id=candidate.department_id
                  and department_scope.subsidiary_id=required_scope.subsidiary_id
              )
            )
        )
      order by candidate.department_id
      limit 1
    )replacement
    where customer.department_id is not null
      and exists(
        select 1 from public.cost_centers center
        where center.customer_id=customer.customer_id
          and upper(center.cost_center_type)='CLIENTE'
      )
    order by customer.customer_id
    limit 1`)).rows[0] || null;
  let customerSyncTested = false;
  if (syncCandidate) {
    const before = (await db.query(`select
        customer.department_id::text customer_department_id,
        coalesce(jsonb_agg(jsonb_build_object(
          'id',center.cost_center_id::text,
          'departmentId',center.department_id::text
        )order by center.cost_center_id),'[]'::jsonb) centers
      from public.customers customer
      left join public.cost_centers center
        on center.customer_id=customer.customer_id
       and upper(center.cost_center_type)='CLIENTE'
      where customer.customer_id=$1
      group by customer.customer_id`,[syncCandidate.customer_id])).rows[0];
    await db.query('savepoint verify_customer_cost_center_sync');
    await db.query(`update public.customers set department_id=$1
      where customer_id=$2`,[
      syncCandidate.replacement_department_id,syncCandidate.customer_id
    ]);
    const unsynchronized = (await db.query(`select count(*)::integer total
      from public.cost_centers
      where customer_id=$1 and upper(cost_center_type)='CLIENTE'
        and department_id is distinct from $2`,[
      syncCandidate.customer_id,syncCandidate.replacement_department_id
    ])).rows[0].total;
    assert.equal(
      unsynchronized,0,
      'El cambio de departamento del cliente no sincroniz\u00f3 sus centros.'
    );
    await db.query('rollback to savepoint verify_customer_cost_center_sync');
    await db.query('release savepoint verify_customer_cost_center_sync');
    const after = (await db.query(`select
        customer.department_id::text customer_department_id,
        coalesce(jsonb_agg(jsonb_build_object(
          'id',center.cost_center_id::text,
          'departmentId',center.department_id::text
        )order by center.cost_center_id),'[]'::jsonb) centers
      from public.customers customer
      left join public.cost_centers center
        on center.customer_id=customer.customer_id
       and upper(center.cost_center_type)='CLIENTE'
      where customer.customer_id=$1
      group by customer.customer_id`,[syncCandidate.customer_id])).rows[0];
    assert.deepEqual(
      after,before,
      'La prueba de sincronizaci\u00f3n cliente-centros dej\u00f3 cambios.'
    );
    customerSyncTested = true;
  }
  return {
    autofillTested,
    customerSyncTested,
    skipped:!autofillTested || !customerSyncTested
  };
}

async function verifyWideSequence(requestId) {
  const transactionType = (await db.query(`select transaction_type_id
    from public.transaction_types
    where abbreviation='SOL_PAG'`)).rows[0];
  assert.ok(transactionType, 'No existe el tipo de transacci\u00f3n SOL_PAG.');
  const source = (await db.query(`select id_subsidiaria
    from public.solicitudes_pago where id=$1`,[requestId])).rows[0];
  const target = (await db.query(`select subsidiary_id
    from public.subsidiaries
    order by case when subsidiary_id<>$1 then 0 else 1 end,subsidiary_id
    limit 1`,[source.id_subsidiaria])).rows[0];
  assert.ok(target, 'No existe una subsidiaria para probar la secuencia SOL_PAG.');
  const sequenceBefore = (await db.query(`select to_jsonb(sequence) record
    from public.number_sequences sequence
    where scope_type='Transacci\u00f3n'
      and transaction_type_id=$1
      and subsidiary_id=$2`,[
    transactionType.transaction_type_id,target.subsidiary_id
  ])).rows[0];
  assert.ok(sequenceBefore, 'No existe la secuencia SOL_PAG que se debe probar.');
  const maximum = (await db.query(`select coalesce(max(
      (regexp_match(numero,'^SOL_PAG-([0-9]+)$'))[1]::bigint
    ),0)::text value
    from public.solicitudes_pago
    where numero~'^SOL_PAG-[0-9]+$'
      and numero!~'^SOL_PAG-[0-9]{17}$'`)).rows[0];
  const currentMaximum = BigInt(maximum.value);
  const wideBase = currentMaximum >= 99999999n
    ? currentMaximum + 1000n
    : 99999999n;

  await db.query('savepoint verify_wide_sol_pag_sequence');
  await db.query(`update public.number_sequences set current_number=0
    where scope_type='Transacci\u00f3n'
      and transaction_type_id=$1
      and subsidiary_id=$2`,[
    transactionType.transaction_type_id,target.subsidiary_id
  ]);
  const aligned = (await db.query(`select
      public.next_transaction_number($1,$2) value`,[
    transactionType.transaction_type_id,target.subsidiary_id
  ])).rows[0].value;
  assert.ok(canonicalNumber(aligned), 'La prueba gener\u00f3 un SOL_PAG no can\u00f3nico.');
  assert.ok(
    canonicalSuffix(aligned)>currentMaximum,
    'La secuencia no se aline\u00f3 por encima del m\u00e1ximo global.'
  );
  await db.query(`update public.number_sequences set current_number=$1
    where scope_type='Transacci\u00f3n'
      and transaction_type_id=$2
      and subsidiary_id=$3`,[
    wideBase.toString(),transactionType.transaction_type_id,target.subsidiary_id
  ]);
  const wide = (await db.query(`select
      public.next_transaction_number($1,$2) value`,[
    transactionType.transaction_type_id,target.subsidiary_id
  ])).rows[0].value;
  assert.ok(canonicalNumber(wide), 'La prueba gener\u00f3 un SOL_PAG amplio no can\u00f3nico.');
  assert.ok(
    canonicalSuffix(wide)>wideBase,
    'La secuencia no conserv\u00f3 todos los d\u00edgitos del consecutivo.'
  );
  assert.ok(
    wide.slice('SOL_PAG-'.length).length > 8,
    'La secuencia trunc\u00f3 un consecutivo mayor de ocho d\u00edgitos.'
  );
  await db.query('rollback to savepoint verify_wide_sol_pag_sequence');
  await db.query('release savepoint verify_wide_sol_pag_sequence');

  const sequenceAfter = (await db.query(`select to_jsonb(sequence) record
    from public.number_sequences sequence
    where scope_type='Transacci\u00f3n'
      and transaction_type_id=$1
      and subsidiary_id=$2`,[
    transactionType.transaction_type_id,target.subsidiary_id
  ])).rows[0];
  assert.deepEqual(
    sequenceAfter,sequenceBefore,
    'La prueba de numeraci\u00f3n dej\u00f3 cambios en la secuencia.'
  );
  return {
    aligned,
    wide,
    suffix:wide.slice('SOL_PAG-'.length),
    globalAlignment:true,
    supportsMoreThanEightDigits:true,
    crossSubsidiary:String(target.subsidiary_id)!==String(source.id_subsidiaria),
    rolledBack:true
  };
}

await db.connect();
try {
  await db.query('begin');
  await db.query("set local statement_timeout='180s'");
  await db.query("select set_config('lock_timeout','15s',true)");
  await db.query("select set_config('request.jwt.claims','{}',true)");
  await db.query("select set_config('request.headers',$1,true)",[
    JSON.stringify({'x-audit-execution-context-id':auditExecutionContext})
  ]);

  const totalsBefore = await businessTotals();
  const immutableBefore = await immutableRequestNumbers();
  const departmentColumnBefore = await hasDepartmentColumn();
  const costCenterDepartmentColumnBefore = await hasCostCenterDepartmentColumn();
  const costCentersBefore = await costCenterRecords(
    costCenterDepartmentColumnBefore
  );
  const paymentLinesBefore = await paymentLineRecords(departmentColumnBefore);
  const derivableCostCentersBefore = await derivableClientCostCenters(
    costCenterDepartmentColumnBefore
  );
  const derivableBefore = await derivableOpenLines(
    departmentColumnBefore,costCenterDepartmentColumnBefore
  );
  const pendingApprovalBefore = await protectedStateRecords(
    departmentColumnBefore,['PENDIENTE_APROBACION']
  );
  const protectedHistoricalBefore = await protectedStateRecords(
    departmentColumnBefore,['APLICADO','ANULADO']
  );
  const request29Before = await request29(departmentColumnBefore);
  const derivableRequest29Before = derivableBefore.filter(
    line => line.request_id === '29'
  );
  const shouldValidate29 = request29Before?.tipo_solicitud === 'OTROS'
    && request29Before.estado === 'APROBADO'
    && request29Before.line_count > 0
    && request29Before.missing_department_count === derivableRequest29Before.length;
  const requestBefore = await request99();
  assert.ok(requestBefore, 'No existe la solicitud de pago #99 que se debe verificar.');
  assert.ok(
    requestBefore.line_count > 0 && requestBefore.tax_lines > 0,
    'La solicitud #99 ya no contiene una l\u00ednea de Agencia Tributaria.'
  );
  assert.ok(
    requestBefore.tax_supervisor_user_id,
    'La subsidiaria de la solicitud #99 no tiene Supervisor tributario configurado.'
  );
  const shouldRenumber99 = requestBefore.estado === 'BORRADOR'
    && fallbackNumber(requestBefore.numero);

  const fallbackDraftsBefore = (await db.query(`select id,numero
    from public.solicitudes_pago
    where estado='BORRADOR' and numero~'^SOL_PAG-[0-9]{17}$'
    order by id`)).rows;

  for (const relativePath of migrations) {
    const source = await readFile(new URL(relativePath, import.meta.url), 'utf8');
    const sql = migrationBody(source);
    assert.ok(sql.trim(), `La migraci\u00f3n ${relativePath} qued\u00f3 vac\u00eda.`);
    assert.ok(!/^\s*begin\s*;/i.test(sql), `${relativePath} conserva BEGIN interno.`);
    assert.ok(!/\bcommit\s*;/i.test(sql), `${relativePath} conserva COMMIT interno.`);
    assert.ok(!/\bnotify\s+pgrst\b/i.test(sql), `${relativePath} conserva NOTIFY interno.`);
    if (relativePath.includes('20261027120000_')) {
      const stateFilter = sql.match(/request\.estado\s+in\s*\(([^)]*)\)/i);
      assert.ok(stateFilter, 'La migraci\u00f3n de dimensiones no limita el backfill por estado.');
      const backfillStates = [...stateFilter[1].matchAll(/'([^']+)'/g)]
        .map(match => match[1]);
      assert.deepEqual(
        backfillStates,['BORRADOR','RECHAZADO','APROBADO'],
        'La pol\u00edtica de estados del backfill no es la autorizada.'
      );
      assert.match(sql,/alter table public\.cost_centers[\s\S]*department_id bigint/i);
      assert.match(sql,/public\.validate_cost_center_department\(\)/i);
      assert.match(sql,/public\.sync_customer_cost_center_department\(\)/i);
      assert.match(sql,/\(center\.department_id\)/i);
    } else if (relativePath.includes('20261027130000_')) {
      assert.match(sql,/'steps'\s*,\s*route_steps/i);
      assert.match(sql,/jsonb_array_elements\(route_steps\)/i);
      assert.match(sql,/public\.pr_sync_dynamic_current_approver\(\)/i);
    } else if (relativePath.includes('20261027140000_')) {
      assert.match(sql,/length\(current_number::text\)\s*<\s*padding_length/i);
      assert.match(
        sql,
        /hashtextextended\('transaction-number:'\|\|target_type::text\s*,\s*0\)/i
      );
    }
    await db.query(sql);
  }

  const schema = (await db.query(`select
    exists(select 1 from information_schema.columns
      where table_schema='public' and table_name='cost_centers'
        and column_name='department_id') cost_center_department_column,
    exists(select 1 from pg_constraint
      where conrelid='public.cost_centers'::regclass
        and confrelid='public.departments'::regclass
        and contype='f'
        and position('(department_id)' in pg_get_constraintdef(oid))>0
        and position('ON DELETE RESTRICT' in pg_get_constraintdef(oid))>0
    ) cost_center_department_fk,
    exists(select 1 from pg_indexes
      where schemaname='public'
        and indexname='cost_centers_department_idx') cost_center_department_index,
    exists(select 1 from information_schema.columns
      where table_schema='public' and table_name='solicitudes_pago_lineas'
        and column_name='id_departamento') department_column,
    exists(select 1 from pg_indexes
      where schemaname='public'
        and indexname='solicitudes_pago_lineas_department_idx') department_index,
    exists(select 1 from pg_constraint
      where conrelid='public.solicitudes_pago'::regclass
        and conname='solicitudes_pago_approval_route_source_check'
        and position('TAX_SUPERVISOR' in pg_get_constraintdef(oid))>0
        and position('ADMIN_FALLBACK' in pg_get_constraintdef(oid))>0
    ) route_constraint,
    exists(select 1 from pg_trigger
      where tgrelid='public.cost_centers'::regclass
        and tgname='validate_cost_center_department_assignment'
        and tgfoid='public.validate_cost_center_department()'::regprocedure
        and not tgisinternal and tgenabled<>'D'
    ) cost_center_validation_trigger,
    exists(select 1 from pg_trigger
      where tgrelid='public.customers'::regclass
        and tgname='sync_customer_cost_center_department_assignment'
        and tgfoid='public.sync_customer_cost_center_department()'::regprocedure
        and not tgisinternal and tgenabled<>'D'
    ) customer_cost_center_sync_trigger,
    exists(select 1 from pg_trigger
      where tgrelid='public.wf_instances'::regclass
        and tgname='pr_sync_dynamic_current_approver_trigger'
        and tgfoid='public.pr_sync_dynamic_current_approver()'::regprocedure
        and not tgisinternal and tgenabled<>'D'
    ) dynamic_approver_sync_trigger`)).rows[0];
  assert.ok(
    Object.values(schema).every(value => value === true),
    `Esquema incompleto: ${JSON.stringify(schema)}`
  );

  const costCentersAfter = await costCenterRecords(true);
  assert.equal(
    costCentersAfter.length,costCentersBefore.length,
    'La migraci\u00f3n cambi\u00f3 la cantidad de centros de costos.'
  );
  const expectedCenterDepartments = new Map(
    derivableCostCentersBefore.map(center => [
      center.center_id,center.expected_department_id
    ])
  );
  const actualCenters = new Map(
    costCentersAfter.map(center => [center.center_id,center])
  );
  let verifiedCostCenterBackfills = 0;
  for (const before of costCentersBefore) {
    const after = actualCenters.get(before.center_id);
    assert.ok(after,`No se encontr\u00f3 el centro de costos #${before.center_id}.`);
    const expectedDepartment = expectedCenterDepartments.get(before.center_id);
    if (expectedDepartment !== undefined) {
      assert.deepEqual(
        after.business_record,before.business_record,
        `El centro de costos #${before.center_id} cambi\u00f3 campos de negocio.`
      );
      assert.equal(
        after.department_id,expectedDepartment,
        `El centro de costos #${before.center_id} no hered\u00f3 su departamento.`
      );
      assertDatabaseAudit(
        after.audit,`Centro de costos #${before.center_id}`
      );
      verifiedCostCenterBackfills+=1;
    } else {
      assert.deepEqual(
        after.record,before.record,
        `El centro de costos #${before.center_id} cambi\u00f3 sin ser derivable.`
      );
      assert.equal(
        after.department_id,before.department_id,
        `El centro de costos #${before.center_id} fue modificado sin ser derivable.`
      );
    }
  }
  const unresolvedCostCenters = await derivableClientCostCenters(true);
  assert.deepEqual(
    unresolvedCostCenters,[],
    'Quedaron centros de costos Cliente con departamento derivable sin completar.'
  );
  const costCenterTriggerProbe = await verifyCostCenterTriggers();

  const pendingApprovalAfter = await protectedStateRecords(
    true,['PENDIENTE_APROBACION']
  );
  assert.deepEqual(
    pendingApprovalAfter,pendingApprovalBefore,
    'El despliegue modific\u00f3 solicitudes o l\u00edneas PENDIENTE_APROBACION.'
  );
  const protectedHistoricalAfter = await protectedStateRecords(
    true,['APLICADO','ANULADO']
  );
  assert.deepEqual(
    protectedHistoricalAfter,protectedHistoricalBefore,
    'El despliegue modific\u00f3 solicitudes o l\u00edneas APLICADO/ANULADO.'
  );

  const paymentLinesAfter = await paymentLineRecords(true);
  assert.equal(
    paymentLinesAfter.length,paymentLinesBefore.length,
    'La migraci\u00f3n cambi\u00f3 la cantidad de l\u00edneas de solicitudes.'
  );
  const expectedLineDepartments = new Map(
    derivableBefore.map(line => [line.line_id,line.expected_department_id])
  );
  const actualPaymentLines = new Map(
    paymentLinesAfter.map(line => [line.line_id,line])
  );
  const backfilledLines = [];
  for (const before of paymentLinesBefore) {
    const after = actualPaymentLines.get(before.line_id);
    assert.ok(after,`No se encontr\u00f3 la l\u00ednea #${before.line_id}.`);
    assert.equal(
      after.request_id,before.request_id,
      `La l\u00ednea #${before.line_id} cambi\u00f3 de solicitud.`
    );
    const expectedDepartment = expectedLineDepartments.get(before.line_id);
    if (expectedDepartment !== undefined) {
      assert.deepEqual(
        after.business_record,before.business_record,
        `La l\u00ednea #${before.line_id} cambi\u00f3 campos de negocio.`
      );
      assert.equal(
        after.department_id,expectedDepartment,
        `La l\u00ednea #${before.line_id} no recibi\u00f3 el departamento derivado.`
      );
      assertDatabaseAudit(after.audit,`L\u00ednea de solicitud #${before.line_id}`);
      backfilledLines.push(after);
    } else {
      assert.deepEqual(
        after.record,before.record,
        `La l\u00ednea #${before.line_id} cambi\u00f3 sin ser derivable.`
      );
      assert.equal(
        after.department_id,before.department_id,
        `La l\u00ednea #${before.line_id} recibi\u00f3 un departamento no esperado.`
      );
    }
  }
  const unresolvedDerivableAfter = await derivableOpenLines(true,true);
  assert.deepEqual(
    unresolvedDerivableAfter,[],
    'Quedaron l\u00edneas OTROS abiertas con un departamento derivable sin completar.'
  );
  const request29AfterBackfill = await request29(true);
  if (request29Before) {
    assert.ok(request29AfterBackfill, 'La solicitud #29 desapareci\u00f3 durante el despliegue.');
    assert.equal(
      request29AfterBackfill.estado,request29Before.estado,
      'El backfill cambi\u00f3 el estado de la solicitud #29.'
    );
    assert.equal(
      request29AfterBackfill.version,request29Before.version,
      'El backfill cambi\u00f3 la versi\u00f3n de la solicitud #29.'
    );
    assert.equal(
      request29AfterBackfill.line_count,request29Before.line_count,
      'El backfill cambi\u00f3 la cantidad de l\u00edneas de la solicitud #29.'
    );
  }
  if (shouldValidate29) {
    assert.equal(
      request29AfterBackfill.missing_department_count,0,
      'La solicitud aprobada #29 conserv\u00f3 l\u00edneas sin departamento.'
    );
  }

  const functions = (await db.query(`select
    to_regprocedure('public.validate_cost_center_department()')is not null
      cost_center_validator,
    to_regprocedure('public.sync_customer_cost_center_department()')is not null
      customer_cost_center_sync,
    to_regprocedure('public.pr_resolve_payment_request_approver(bigint)')is not null resolver,
    to_regprocedure('public.pr_payment_request_admin_route(bigint,text)')is not null admin_fallback,
    to_regprocedure('public.pr_sync_dynamic_current_approver()')is not null
      dynamic_approver_sync,
    position('id_departamento' in pg_get_functiondef(
      'public.pr_save_without_budget(jsonb)'::regprocedure
    ))>0 save_department,
    position('id_departamento' in pg_get_functiondef(
      'public.pr_validate(bigint)'::regprocedure
    ))>0 validate_department,
    position('cost_center.department_id' in pg_get_functiondef(
      'public.pr_validate(bigint)'::regprocedure
    ))>0 validate_cost_center_department,
    position('department_id' in pg_get_functiondef(
      'public.pr_execute_without_budget(jsonb)'::regprocedure
    ))>0 execute_department,
    position('''departments''' in pg_get_functiondef(
      'public.pr_options()'::regprocedure
    ))>0 options_departments,
    position('cost_center.department_id' in pg_get_functiondef(
      'public.pr_options()'::regprocedure
    ))>0 options_cost_center_department,
    position('coalesce(l.id_departamento' in pg_get_functiondef(
      'public.run_payment_request_report(jsonb)'::regprocedure
    ))>0 report_department,
    position('cc.department_id' in pg_get_functiondef(
      'public.run_payment_request_report(jsonb)'::regprocedure
    ))>0 report_cost_center_department,
    position('l.id_departamento' in pg_get_functiondef(
      'public.expense_approval_email_snapshot(bigint,bigint,bigint)'::regprocedure
    ))>0 email_department,
    position('center.department_id' in pg_get_functiondef(
      'public.expense_approval_email_snapshot(bigint,bigint,bigint)'::regprocedure
    ))>0 email_cost_center_department,
    position('clock_timestamp()' in pg_get_functiondef(
      'public.pr_save_without_budget(jsonb)'::regprocedure
    ))=0 no_timestamp_fallback,
    position('pr_resolve_payment_request_approver' in pg_get_functiondef(
      'public.wf_start_entity_without_budget(text,bigint,jsonb)'::regprocedure
    ))>0 workflow_router,
    position('jsonb_array_elements(route_steps)' in pg_get_functiondef(
      'public.wf_start_entity_without_budget(text,bigint,jsonb)'::regprocedure
    ))>0 workflow_multistep,
    position('''steps''' in pg_get_functiondef(
      'public.pr_resolve_payment_request_approver(bigint)'::regprocedure
    ))>0 resolver_steps,
    position('assigned_approver_id' in pg_get_functiondef(
      'public.pr_sync_dynamic_current_approver()'::regprocedure
    ))>0 dynamic_approver_assignment,
    position('length(current_number::text)' in pg_get_functiondef(
      'public.next_transaction_number(bigint,bigint)'::regprocedure
    ))>0 wide_number_format,
    position('canonical_max' in pg_get_functiondef(
      'public.next_transaction_number(bigint,bigint)'::regprocedure
    ))>0 global_sequence_alignment`)).rows[0];
  assert.ok(
    Object.values(functions).every(value => value === true),
    `Funciones incompletas: ${JSON.stringify(functions)}`
  );

  const sequenceCoverage = (await db.query(`with target_type as(
      select transaction_type_id
      from public.transaction_types
      where abbreviation='SOL_PAG'
    ),global_maximum as(
      select coalesce(max(
        (regexp_match(numero,'^SOL_PAG-([0-9]+)$'))[1]::bigint
      ),0) maximum
      from public.solicitudes_pago
      where numero~'^SOL_PAG-[0-9]+$'
        and numero!~'^SOL_PAG-[0-9]{17}$'
    ),configured as(
      select subsidiary.subsidiary_id,sequence.sequence_id,
        sequence.prefix,sequence.suffix,sequence.current_number,
        sequence.padding_length,sequence.allow_manual_update,
        global_maximum.maximum
      from public.subsidiaries subsidiary
      cross join target_type
      cross join global_maximum
      left join public.number_sequences sequence
        on sequence.scope_type='Transacci\u00f3n'
       and sequence.transaction_type_id=target_type.transaction_type_id
       and sequence.subsidiary_id=subsidiary.subsidiary_id
    )select
      count(*)::integer subsidiaries,
      count(sequence_id)::integer sequences,
      coalesce(max(maximum),0)::text global_maximum,
      min(current_number)::text min_current,
      max(current_number)::text max_current,
      count(*)filter(where
        sequence_id is null
        or prefix is distinct from'SOL_PAG-'
        or suffix is not null
        or padding_length is distinct from 8
        or allow_manual_update is distinct from false
      )::integer invalid_configurations,
      count(*)filter(where
        sequence_id is not null and current_number<maximum
      )::integer lagging_sequences
    from configured`)).rows[0];
  assert.equal(
    sequenceCoverage.sequences,sequenceCoverage.subsidiaries,
    'No existe una secuencia SOL_PAG para cada subsidiaria.'
  );
  assert.equal(
    sequenceCoverage.invalid_configurations,0,
    `Configuraci\u00f3n SOL_PAG inv\u00e1lida: ${JSON.stringify(sequenceCoverage)}`
  );
  assert.ok(
    BigInt(sequenceCoverage.max_current)>=BigInt(sequenceCoverage.global_maximum),
    'Ninguna secuencia SOL_PAG refleja el m\u00e1ximo global.'
  );
  const immutableAfter = await immutableRequestNumbers();
  assert.deepEqual(
    immutableAfter,immutableBefore,
    'Se modific\u00f3 la numeraci\u00f3n de una solicitud que ya no era borrador.'
  );
  const remainingFallbackDrafts = (await db.query(`select id,numero
    from public.solicitudes_pago
    where estado='BORRADOR' and numero~'^SOL_PAG-[0-9]{17}$'
    order by id`)).rows;
  assert.deepEqual(
    remainingFallbackDrafts,[],
    'Quedaron borradores con numeraci\u00f3n de contingencia.'
  );
  const requestAfterNumbering = await request99();
  assert.equal(
    requestAfterNumbering.estado,requestBefore.estado,
    'La correcci\u00f3n de numeraci\u00f3n cambi\u00f3 el estado de la solicitud #99.'
  );
  if (shouldRenumber99) {
    assert.ok(canonicalNumber(requestAfterNumbering.numero),
      'La solicitud #99 no recibi\u00f3 un consecutivo can\u00f3nico.');
    assert.notEqual(requestAfterNumbering.numero,requestBefore.numero,
      'La solicitud #99 conserv\u00f3 la numeraci\u00f3n de contingencia.');
    const auditEvent = (await db.query(`select accion,nota
      from public.solicitudes_pago_eventos
      where id_solicitud=99 and accion='NUMERACION_CORREGIDA'
      order by id desc limit 1`)).rows[0];
    assert.ok(auditEvent, 'La renumeraci\u00f3n de #99 no dej\u00f3 evento de auditor\u00eda.');
    assert.match(auditEvent.nota,new RegExp(requestBefore.numero),
      'El evento no conserva el n\u00famero anterior de #99.');
    assert.match(auditEvent.nota,new RegExp(requestAfterNumbering.numero),
      'El evento no conserva el n\u00famero nuevo de #99.');
  } else {
    assert.equal(
      requestAfterNumbering.numero,requestBefore.numero,
      'La solicitud #99 fue renumerada sin ser un borrador con formato de contingencia.'
    );
  }

  for (const draft of fallbackDraftsBefore) {
    const corrected = (await db.query(`select numero,estado
      from public.solicitudes_pago where id=$1`,[draft.id])).rows[0];
    assert.equal(corrected.estado,'BORRADOR');
    assert.ok(canonicalNumber(corrected.numero),
      `El borrador #${draft.id} no recibi\u00f3 numeraci\u00f3n can\u00f3nica.`);
  }

  let request29Validated = false;
  if (shouldValidate29) {
    const context29 = await authorizedContext(request29Before.id_subsidiaria);
    assert.ok(context29, 'No existe una sesi\u00f3n autorizada para validar #29.');
    await db.query("select set_config('request.jwt.claims',$1,true)",[
      JSON.stringify(context29)
    ]);
    const stateBeforeValidation = (await db.query(`select estado,version
      from public.solicitudes_pago where id=29`)).rows[0];
    assert.equal(
      stateBeforeValidation.estado,'APROBADO',
      'La solicitud #29 dej\u00f3 de estar aprobada antes de validarla.'
    );
    await db.query('select public.pr_validate(29)');
    const stateAfterValidation = (await db.query(`select estado,version
      from public.solicitudes_pago where id=29`)).rows[0];
    assert.deepEqual(
      stateAfterValidation,stateBeforeValidation,
      'pr_validate(29) modific\u00f3 el estado o la versi\u00f3n de la solicitud.'
    );
    request29Validated = true;
  }

  const context = await authorizedContext(requestBefore.id_subsidiaria);
  assert.ok(context, 'No existe una sesi\u00f3n autorizada para validar la ruta de #99.');
  await db.query("select set_config('request.jwt.claims',$1,true)",[
    JSON.stringify(context)
  ]);

  const stateBeforeRouting = (await db.query(`select estado,version
    from public.solicitudes_pago where id=99`)).rows[0];
  const route = (await db.query(
    'select public.pr_resolve_payment_request_approver(99) value'
  )).rows[0].value;
  const stateAfterRouting = (await db.query(`select estado,version
    from public.solicitudes_pago where id=99`)).rows[0];
  assert.deepEqual(
    stateAfterRouting,stateBeforeRouting,
    'La consulta de la ruta modific\u00f3 la solicitud #99.'
  );
  assert.equal(route.source,'TAX_SUPERVISOR',
    'La solicitud tributaria #99 no se resolvi\u00f3 al Supervisor tributario.');
  assert.equal(
    String(route.approverId),String(requestBefore.tax_supervisor_user_id),
    'La ruta de #99 no coincide con el Supervisor tributario configurado.'
  );
  assert.ok(Array.isArray(route.steps), 'La ruta de #99 no devolvi\u00f3 steps.');
  assert.equal(
    route.steps.length,1,
    'La Agencia Tributaria debe reemplazar las dem\u00e1s rutas con un solo nivel.'
  );
  assert.equal(
    route.steps[0].source,'TAX_SUPERVISOR',
    'El nivel resuelto de #99 no conserva el override tributario.'
  );
  assert.equal(
    String(route.steps[0].approverId),String(requestBefore.tax_supervisor_user_id),
    'El nivel tributario de #99 no apunta al Supervisor configurado.'
  );
  assert.equal(route.steps[0].roleId,null, 'El nivel tributario no debe usar un rol.');

  const totalsAfter = await businessTotals();
  assert.deepEqual(
    totalsAfter,totalsBefore,
    `El despliegue modific\u00f3 conteos o importes: ${JSON.stringify({
      totalsBefore,totalsAfter
    })}`
  );

  await db.query("notify pgrst,'reload schema'");
  await db.query('commit');
  console.log(JSON.stringify({
    applied:true,
    migrations:migrations.map(path => path.split('/').at(-1)),
    manifest:releaseManifest.map(entry => ({
      migration:entry.path.split('/').at(-1),
      verifies:entry.verifies
    })),
    schema,
    functions,
    sequenceCoverage,
    correctedDrafts:fallbackDraftsBefore.length,
    costCenterBackfill:{
      expected:derivableCostCentersBefore.length,
      verified:verifiedCostCenterBackfills,
      untouched:costCentersBefore.length-derivableCostCentersBefore.length,
      unresolved:unresolvedCostCenters.length,
      auditMetadataVerified:true
    },
    costCenterTriggerProbe,
    departmentBackfill:{
      expected:derivableBefore.length,
      verified:backfilledLines.length,
      unresolvedDerivable:unresolvedDerivableAfter.length,
      auditMetadataVerified:true,
      request29Validated
    },
    protectedHistoricalRecords:{
      requests:protectedHistoricalAfter.headers.length,
      lines:protectedHistoricalAfter.lines.length,
      preserved:true
    },
    pendingApprovalRecords:{
      requests:pendingApprovalAfter.headers.length,
      lines:pendingApprovalAfter.lines.length,
      preserved:true
    },
    request99:{
      previousNumber:requestBefore.numero,
      number:requestAfterNumbering.numero,
      status:requestAfterNumbering.estado,
      renumbered:shouldRenumber99,
      approvalRoute:route.source,
      approverId:route.approverId,
      approvalSteps:route.steps,
      stepCount:route.steps.length
    },
    immutableNumbersPreserved:immutableAfter.length,
    businessDataPreserved:true
  }));
} catch (error) {
  await db.query('rollback').catch(() => {});
  throw error;
} finally {
  await db.end();
}
