import assert from 'node:assert/strict';
import pg from 'pg';
import { readFile } from 'node:fs/promises';

if(process.loadEnvFile)process.loadEnvFile('.env');
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

function migrationBody(sql){
  return sql.replace(/^\s*begin\s*;/i,'').replace(/\bcommit\s*;/gi,'');
}

await db.connect();
try{
  const liveRequest=(await db.query(`
    select request.id,request.numero,request.estado,request.id_subsidiaria,
      coalesce(jsonb_agg(jsonb_build_object(
        'partyType',line.tipo_tercero,
        'taxAgencyId',line.id_agencia_tributaria,
        'costCenterId',line.id_centro_costo
      )order by line.id)filter(where line.id is not null),'[]'::jsonb) lines
    from public.solicitudes_pago request
    left join public.solicitudes_pago_lineas line on line.id_solicitud=request.id
    where request.id=99
    group by request.id`)).rows[0]||null;

  await db.query('begin');
  const dimensionSql=await readFile(new URL(
    '../supabase/migrations/20261027120000_payment_request_line_dimensions.sql',
    import.meta.url
  ),'utf8');
  const approvalSql=await readFile(new URL(
    '../supabase/migrations/20261027130000_payment_request_approval_routing.sql',
    import.meta.url
  ),'utf8');
  await db.query(migrationBody(dimensionSql));
  await db.query(migrationBody(approvalSql));

  const admin=(await db.query(`
    select account.user_id,account.auth_user_id,account.email,
      role.role_id,scope.subsidiary_id
    from public.users account
    join public.user_roles membership using(user_id)
    join public.roles role using(role_id)
    join public.user_subsidiaries scope using(user_id)
    join public.subsidiaries subsidiary using(subsidiary_id)
    where account.is_active and account.auth_user_id is not null
      and subsidiary.is_active
      and lower(role.role_name)in('administrador','administrator','admin')
      and exists(
        select 1 from public.tax_agency_subsidiaries agency_scope
        where agency_scope.subsidiary_id=scope.subsidiary_id
      )
    order by case when upper(subsidiary.name)='S.T.T. HOLDINGS LIMITED'then 0 else 1 end,
      account.user_id,scope.subsidiary_id
    limit 1`)).rows[0];
  assert.ok(admin,'Se requiere un administrador en una subsidiaria con Agencia Tributaria.');
  const fallbackAdmin=(await db.query(`
    select account.user_id
    from public.users account
    join public.user_roles membership on membership.user_id=account.user_id
    join public.roles role on role.role_id=membership.role_id
    join public.user_subsidiaries scope
      on scope.user_id=account.user_id and scope.subsidiary_id=$1
    where account.is_active
      and lower(role.role_name)in('administrador','administrator','admin')
    order by account.user_id,role.role_id
    limit 1`,[admin.subsidiary_id])).rows[0];
  assert.ok(fallbackAdmin,'Se requiere un administrador autorizado en la subsidiaria.');

  const sessionId=`payment-routing-${Date.now()}`;
  await db.query(
    'insert into public.user_company_sessions(session_id,user_id,subsidiary_id)values($1,$2,$3)',
    [sessionId,admin.user_id,admin.subsidiary_id]
  );
  await db.query(
    'insert into public.user_role_sessions(session_id,user_id,role_id)values($1,$2,$3)',
    [sessionId,admin.user_id,admin.role_id]
  );
  await db.query("select set_config('request.jwt.claims',$1,true)",[
    JSON.stringify({
      sub:admin.auth_user_id,email:admin.email,
      session_id:sessionId,role:'service_role'
    })
  ]);

  const currencyId=(await db.query(
    'select currency_id from public.subsidiaries where subsidiary_id=$1',
    [admin.subsidiary_id]
  )).rows[0].currency_id;
  const account=(await db.query(`
    select account_id from public.chart_accounts
    where public.pr_allowed_account(account_id)
    order by case when category in('Activo','Pasivo')then 0 else 1 end,account_id
    limit 1`)).rows[0];
  assert.ok(account,'Se requiere una cuenta habilitada para imputación directa.');

  const customer=(await db.query(`
    select customer.customer_id
    from public.customers customer
    where customer.primary_subsidiary_id=$1
       or exists(
         select 1 from public.entity_subsidiaries scope
         where scope.customer_id=customer.customer_id and scope.subsidiary_id=$1
       )
    order by customer.customer_id limit 1`,[admin.subsidiary_id])).rows[0];
  const supplier=(await db.query(`
    select supplier.supplier_id
    from public.suppliers supplier
    where supplier.primary_subsidiary_id=$1
       or exists(
         select 1 from public.entity_subsidiaries scope
         where scope.supplier_id=supplier.supplier_id and scope.subsidiary_id=$1
       )
    order by supplier.supplier_id limit 1`,[admin.subsidiary_id])).rows[0];
  const agency=(await db.query(`
    select agency.tax_agency_id
    from public.tax_agencies agency
    join public.tax_agency_subsidiaries scope using(tax_agency_id)
    where scope.subsidiary_id=$1
    order by agency.tax_agency_id limit 1`,[admin.subsidiary_id])).rows[0];
  assert.ok(customer&&supplier&&agency,'Se requieren cliente, proveedor y Agencia Tributaria de prueba.');

  const makeUser=async label=>(await db.query(`
    insert into public.users(
      email,password_hash,auth_user_id,first_name,last_name,is_active
    )values($1,'test-only',gen_random_uuid(),'Aprobador',$2,true)
    returning user_id,email,auth_user_id`,[
      `payment-${label.toLowerCase()}-${Date.now()}@example.test`,label
    ])).rows[0];
  const taxApprover=await makeUser('TRIBUTARIO');
  const upApprover=await makeUser('UP');
  const upApprover2=await makeUser('UP-2');
  const defaultUpApprover=await makeUser('UP-DEFAULT');
  const administrativeApprover=await makeUser('ADMINISTRATIVO');
  await db.query(`
    insert into public.user_subsidiaries(user_id,subsidiary_id)
    values($1,$6),($2,$6),($3,$6),($4,$6),($5,$6)`,[
      taxApprover.user_id,upApprover.user_id,upApprover2.user_id,
      defaultUpApprover.user_id,administrativeApprover.user_id,
      admin.subsidiary_id
    ]);

  const suffix=Date.now().toString();
  const clientDepartment=(await db.query(`
    insert into public.departments(name,subsidiary_id,type,is_inactive)
    values($1,$2,'Cliente',false)returning department_id`,[
      `CLIENTE ROUTING ${suffix}`,admin.subsidiary_id
    ])).rows[0];
  const internalDepartment=(await db.query(`
    insert into public.departments(name,subsidiary_id,type,is_inactive)
    values($1,$2,'Interno',false)returning department_id`,[
      `INTERNO ROUTING ${suffix}`,admin.subsidiary_id
    ])).rows[0];
  await db.query(`
    insert into public.department_subsidiaries(department_id,subsidiary_id)
    values($1,$3),($2,$3)on conflict do nothing`,[
      clientDepartment.department_id,internalDepartment.department_id,
      admin.subsidiary_id
    ]);
  await db.query(
    'update public.customers set department_id=$1 where customer_id=$2',
    [clientDepartment.department_id,customer.customer_id]
  );
  const center=(await db.query(`
    insert into public.cost_centers(
      code,name,subsidiary_id,customer_id,cost_center_type,
      up_approver_id,is_inactive
    )values('TEMP',$1,$2,$3,'CLIENTE',$4,false)
    returning cost_center_id`,[
      `Centro routing ${suffix}`,admin.subsidiary_id,customer.customer_id,
      upApprover.user_id
    ])).rows[0];
  const center2=(await db.query(`
    insert into public.cost_centers(
      code,name,subsidiary_id,customer_id,cost_center_type,
      up_approver_id,is_inactive
    )values('TEMP2',$1,$2,$3,'CLIENTE',$4,false)
    returning cost_center_id`,[
      `Centro routing 2 ${suffix}`,admin.subsidiary_id,customer.customer_id,
      upApprover2.user_id
    ])).rows[0];

  await db.query(`
    update public.subsidiaries set
      tax_supervisor_user_id=$1,
      default_up_approver_id=$2,
      administrative_approver='user:'||$3::text
    where subsidiary_id=$4`,[
      taxApprover.user_id,defaultUpApprover.user_id,
      administrativeApprover.user_id,admin.subsidiary_id
    ]);
  await db.query(`
    update public.wf_workflows set estado_activo=false
    where subsidiaria_id=$1 and entity_type='PAYMENT_REQUEST'`,[
      admin.subsidiary_id
    ]);

  async function createRequest(input){
    const requestLines=Array.isArray(input)?input:[input];
    const total=requestLines.reduce((sum,line)=>sum+Number(line.amount||10),0);
    const header=(await db.query(`
      insert into public.solicitudes_pago(
        numero,id_subsidiaria,id_moneda,tipo_solicitud,
        fecha_pago_programada,id_solicitante,concepto,total
      )values($1,$2,$3,'OTROS',current_date,$4,$5,$6)
      returning id,version`,[
        `ROUTE-${Date.now()}-${Math.random().toString(36).slice(2,8)}`,
        admin.subsidiary_id,currencyId,admin.user_id,
        'Prueba automatizada de ruta de aprobación',total
      ])).rows[0];
    for(const line of requestLines){
      await db.query(`
        insert into public.solicitudes_pago_lineas(
          id_solicitud,id_cuenta_contable,tipo_tercero,
          id_cliente,id_proveedor,id_agencia_tributaria,
          id_departamento,id_centro_costo,concepto,monto
        )values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,[
          header.id,account.account_id,line.partyType,line.customerId||null,
          line.supplierId||null,line.agencyId||null,line.departmentId||null,
          line.centerId||null,'Línea de prueba',Number(line.amount||10)
        ]);
    }
    return header;
  }
  const submit=async request=>(await db.query(`
    select public.pr_transition(jsonb_build_object(
      'id',$1::bigint,'version',$2::integer,'transition','SUBMIT'
    )) value`,[request.id,request.version])).rows[0].value;
  const routeState=async requestId=>(await db.query(`
    select request.approval_route_source,request.assigned_approver_id,
      instance.id instance_id,instance.status,instance.current_level,
      step.usuario_aprobador_id,step.rol_aprobador_id,step.nombre_nivel
    from public.solicitudes_pago request
    join public.wf_instances instance
      on instance.entity_type='PAYMENT_REQUEST'and instance.entity_id=request.id
    join public.wf_instance_steps step
      on step.instance_id=instance.id and step.nivel=instance.current_level
    where request.id=$1`,[requestId])).rows[0];
  const routeSteps=async requestId=>(await db.query(`
    select step.nivel,step.usuario_aprobador_id,step.rol_aprobador_id,
      step.nombre_nivel,step.status
    from public.wf_instances instance
    join public.wf_instance_steps step on step.instance_id=instance.id
    where instance.entity_type='PAYMENT_REQUEST'and instance.entity_id=$1
    order by step.nivel`,[requestId])).rows;
  const assertAdministratorFallback=async state=>{
    assert.equal(state.approval_route_source,'ADMIN_FALLBACK');
    assert.equal(String(state.assigned_approver_id),String(fallbackAdmin.user_id));
    assert.equal(String(state.usuario_aprobador_id),String(fallbackAdmin.user_id));
    assert.equal(state.rol_aprobador_id,null);
    const authorized=(await db.query(`
      select exists(
        select 1
        from public.users account
        join public.user_roles membership on membership.user_id=account.user_id
        join public.roles role on role.role_id=membership.role_id
        join public.user_subsidiaries scope on scope.user_id=account.user_id
        where account.user_id=$1 and account.is_active
          and scope.subsidiary_id=$2
          and lower(role.role_name)in('administrador','administrator','admin')
      ) value`,[state.assigned_approver_id,admin.subsidiary_id])).rows[0].value;
    assert.equal(authorized,true);
  };

  let request=await createRequest([{
    partyType:'Agencia Tributaria',agencyId:agency.tax_agency_id,
    departmentId:clientDepartment.department_id,centerId:center.cost_center_id
  },{
    partyType:'Proveedor',supplierId:supplier.supplier_id,
    departmentId:internalDepartment.department_id
  }]);
  await submit(request);
  let state=await routeState(request.id);
  assert.deepEqual([
    state.approval_route_source,String(state.assigned_approver_id),
    String(state.usuario_aprobador_id),state.nombre_nivel
  ],[
    'TAX_SUPERVISOR',String(taxApprover.user_id),
    String(taxApprover.user_id),'Supervisión tributaria'
  ]);
  assert.equal((await routeSteps(request.id)).length,1,
    'La Agencia Tributaria debe reemplazar cualquier ruta analítica adicional.');

  request=await createRequest({
    partyType:'Cliente',customerId:customer.customer_id,
    departmentId:clientDepartment.department_id,centerId:center.cost_center_id
  });
  await submit(request);
  state=await routeState(request.id);
  assert.deepEqual([
    state.approval_route_source,String(state.assigned_approver_id),
    state.nombre_nivel
  ],['COST_CENTER',String(upApprover.user_id),'Aprobación Proyectos (UP)']);

  await db.query(
    'update public.users set is_active=false where user_id=$1',
    [upApprover.user_id]
  );
  request=await createRequest({
    partyType:'Cliente',customerId:customer.customer_id,
    departmentId:clientDepartment.department_id,centerId:center.cost_center_id
  });
  await submit(request);
  state=await routeState(request.id);
  assert.deepEqual([
    state.approval_route_source,String(state.assigned_approver_id),
    String(state.usuario_aprobador_id),state.rol_aprobador_id
  ],[
    'SUBSIDIARY',String(defaultUpApprover.user_id),
    String(defaultUpApprover.user_id),null
  ]);
  await db.query(
    'update public.users set is_active=true where user_id=$1',
    [upApprover.user_id]
  );

  request=await createRequest([{
    partyType:'Cliente',customerId:customer.customer_id,
    departmentId:clientDepartment.department_id,centerId:center.cost_center_id
  },{
    partyType:'Proveedor',supplierId:supplier.supplier_id,
    departmentId:internalDepartment.department_id
  }]);
  await submit(request);
  state=await routeState(request.id);
  let steps=await routeSteps(request.id);
  assert.equal(state.approval_route_source,'MIXED');
  assert.deepEqual(
    steps.map(step=>String(step.usuario_aprobador_id)),
    [String(upApprover.user_id),String(administrativeApprover.user_id)],
    'Cliente e Interno deben crear niveles UP y Administrativo secuenciales.'
  );
  assert.equal(String(state.assigned_approver_id),String(upApprover.user_id));

  // El administrador puede intervenir como respaldo; esto permite probar el
  // avance real sin crear una identidad temporal en Supabase Auth.
  await db.query(
    "select public.wf_act($1,'APROBAR',null,null::inet)",
    [state.instance_id]
  );
  state=await routeState(request.id);
  assert.equal(state.current_level,2);
  assert.equal(String(state.assigned_approver_id),String(administrativeApprover.user_id),
    'El encabezado no se sincronizó con el aprobador del nivel vigente.');
  await db.query(
    "select public.wf_act($1,'APROBAR',null,null::inet)",
    [state.instance_id]
  );
  const completedRoute=(await db.query(`
    select request.estado,request.assigned_approver_id,
      instance.status,instance.current_level
    from public.solicitudes_pago request
    join public.wf_instances instance
      on instance.entity_type='PAYMENT_REQUEST'and instance.entity_id=request.id
    where request.id=$1`,[request.id])).rows[0];
  assert.deepEqual([
    completedRoute.estado,completedRoute.status,
    completedRoute.current_level,completedRoute.assigned_approver_id
  ],['APROBADO','APROBADO',null,null],
  'Al finalizar debe limpiarse el aprobador actual sin perder el historial.');

  request=await createRequest([{
    partyType:'Cliente',customerId:customer.customer_id,
    departmentId:clientDepartment.department_id,centerId:center.cost_center_id
  },{
    partyType:'Cliente',customerId:customer.customer_id,
    departmentId:clientDepartment.department_id,centerId:center2.cost_center_id
  }]);
  await submit(request);
  state=await routeState(request.id);
  steps=await routeSteps(request.id);
  assert.equal(state.approval_route_source,'MIXED');
  assert.deepEqual(
    steps.map(step=>String(step.usuario_aprobador_id)),
    [String(upApprover.user_id),String(upApprover2.user_id)],
    'Los centros con UP distintos deben generar niveles secuenciales.'
  );

  await db.query(
    'update public.cost_centers set up_approver_id=$1 where cost_center_id=$2',
    [upApprover.user_id,center2.cost_center_id]
  );
  request=await createRequest([{
    partyType:'Cliente',customerId:customer.customer_id,
    departmentId:clientDepartment.department_id,centerId:center.cost_center_id
  },{
    partyType:'Cliente',customerId:customer.customer_id,
    departmentId:clientDepartment.department_id,centerId:center2.cost_center_id
  }]);
  await submit(request);
  steps=await routeSteps(request.id);
  assert.equal(steps.length,1,'Un mismo UP no debe aprobar dos veces.');
  await db.query(
    'update public.cost_centers set up_approver_id=$1 where cost_center_id=$2',
    [upApprover2.user_id,center2.cost_center_id]
  );

  await db.query(`
    update public.subsidiaries
    set administrative_approver='user:'||$1::text
    where subsidiary_id=$2`,[upApprover.user_id,admin.subsidiary_id]);
  request=await createRequest([{
    partyType:'Cliente',customerId:customer.customer_id,
    departmentId:clientDepartment.department_id,centerId:center.cost_center_id
  },{
    partyType:'Proveedor',supplierId:supplier.supplier_id,
    departmentId:internalDepartment.department_id
  }]);
  await submit(request);
  state=await routeState(request.id);
  steps=await routeSteps(request.id);
  assert.equal(state.approval_route_source,'MIXED');
  assert.equal(steps.length,1,
    'El mismo usuario UP/Administrativo debe aparecer una sola vez.');
  await db.query(`
    update public.subsidiaries
    set administrative_approver='user:'||$1::text
    where subsidiary_id=$2`,[
      administrativeApprover.user_id,admin.subsidiary_id
    ]);

  await db.query(
    'update public.cost_centers set up_approver_id=null where cost_center_id=$1',
    [center.cost_center_id]
  );
  request=await createRequest({
    partyType:'Cliente',customerId:customer.customer_id,
    departmentId:clientDepartment.department_id,centerId:center.cost_center_id
  });
  await submit(request);
  state=await routeState(request.id);
  assert.deepEqual([
    state.approval_route_source,String(state.assigned_approver_id)
  ],['SUBSIDIARY',String(defaultUpApprover.user_id)]);

  request=await createRequest({
    partyType:'Proveedor',supplierId:supplier.supplier_id,
    departmentId:internalDepartment.department_id
  });
  await submit(request);
  state=await routeState(request.id);
  assert.deepEqual([
    state.approval_route_source,String(state.assigned_approver_id),
    state.nombre_nivel
  ],[
    'ADMINISTRATIVE',String(administrativeApprover.user_id),
    'Aprobación administrativa'
  ]);

  await db.query(`
    update public.subsidiaries set administrative_approver=null
    where subsidiary_id=$1`,[admin.subsidiary_id]);
  request=await createRequest({
    partyType:'Proveedor',supplierId:supplier.supplier_id,
    departmentId:internalDepartment.department_id
  });
  await submit(request);
  state=await routeState(request.id);
  await assertAdministratorFallback(state);

  await db.query(`
    update public.subsidiaries set tax_supervisor_user_id=null
    where subsidiary_id=$1`,[admin.subsidiary_id]);
  request=await createRequest({
    partyType:'Agencia Tributaria',agencyId:agency.tax_agency_id,
    departmentId:internalDepartment.department_id
  });
  await submit(request);
  state=await routeState(request.id);
  await assertAdministratorFallback(state);

  console.log(JSON.stringify({
    passed:true,
    liveRequest,
    noGenericWorkflowRequired:true,
    taxSupervisorPriority:true,
    projectCostCenterApprover:true,
    invalidProjectApproverUsesSubsidiaryFallback:true,
    projectSubsidiaryFallback:true,
    mixedDepartmentSequentialApproval:true,
    multipleProjectApproversSequential:true,
    duplicateApproversDeduplicated:true,
    currentApproverSynchronized:true,
    completedApproverCleared:true,
    administrativeApprover:true,
    administratorFallback:true,
    administratorFallbackScoped:true,
    rollback:true
  }));
}finally{
  await db.query('rollback').catch(()=>undefined);
  await db.end();
}
