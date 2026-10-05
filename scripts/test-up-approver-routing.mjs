import assert from 'node:assert/strict';
import pg from 'pg';
import { readFile } from 'node:fs/promises';

if(process.loadEnvFile)process.loadEnvFile('.env');
const projectRef=new URL(process.env.SUPABASE_URL).hostname.split('.')[0];
const db=new pg.Client({
  host:process.env.SUPABASE_DB_HOST||'aws-0-us-east-1.pooler.supabase.com',
  port:Number(process.env.SUPABASE_DB_PORT||6543),database:process.env.SUPABASE_DB_NAME||'postgres',
  user:process.env.SUPABASE_DB_USER||`postgres.${projectRef}`,
  password:process.env.SUPABASE_DB_PASSWORD||process.env.PGPASSWORD,
  ssl:{rejectUnauthorized:false},connectionTimeoutMillis:15000
});

function migrationBody(sql){return sql.replace(/^\s*begin\s*;/i,'').replace(/commit\s*;\s*$/i,'');}
async function rejectsWithRollback(run,pattern){
  await db.query('savepoint expected_error');
  try{await assert.rejects(run(),pattern);}
  finally{await db.query('rollback to savepoint expected_error');}
}

await db.connect();
try{
  await db.query('begin');
  const sql=await readFile(new URL('../supabase/migrations/20261004100000_up_approver_routing.sql',import.meta.url),'utf8');
  await db.query(migrationBody(sql));

  const admin=(await db.query(`
    select u.user_id,u.email,r.role_id,us.subsidiary_id
      from users u join user_roles ur using(user_id)join roles r using(role_id)
      join user_subsidiaries us using(user_id)join subsidiaries s using(subsidiary_id)
     where u.is_active and s.is_active and lower(r.role_name)in('administrador','administrator','admin')
     order by u.user_id,us.subsidiary_id limit 1`)).rows[0];
  assert.ok(admin,'Se requiere un administrador con acceso a una subsidiaria.');
  const sessionId=`up-routing-test-${Date.now()}`;
  await db.query('insert into user_company_sessions(session_id,user_id,subsidiary_id)values($1,$2,$3)',[sessionId,admin.user_id,admin.subsidiary_id]);
  await db.query('insert into user_role_sessions(session_id,user_id,role_id)values($1,$2,$3)',[sessionId,admin.user_id,admin.role_id]);
  await db.query("select set_config('request.jwt.claims',$1,true)",[JSON.stringify({email:admin.email,session_id:sessionId,role:'service_role'})]);
  assert.equal(String((await db.query('select active_subsidiary_id() sid')).rows[0].sid),String(admin.subsidiary_id));

  const centers=(await db.query(`select cost_center_id,customer_id from cost_centers
    where subsidiary_id=$1 and cost_center_type='CLIENTE'and customer_id is not null
    order by cost_center_id limit 2`,[admin.subsidiary_id])).rows;
  if(centers.length<2){
    const customerId=centers[0]?.customer_id||(await db.query(`select customer_id from entity_subsidiaries
      where subsidiary_id=$1 and customer_id is not null order by customer_id limit 1`,[admin.subsidiary_id])).rows[0]?.customer_id;
    assert.ok(customerId,'Se requiere un cliente autorizado para crear el centro de prueba.');
    while(centers.length<2){
      centers.push((await db.query(`insert into cost_centers(code,name,subsidiary_id,customer_id,cost_center_type,is_inactive)
        values('TEMP',$2,$1,$3,'CLIENTE',false)returning cost_center_id,customer_id`,
        [admin.subsidiary_id,`Centro cliente de prueba ${centers.length+1}`,customerId])).rows[0]);
    }
  }
  const currencyId=(await db.query('select currency_id from subsidiaries where subsidiary_id=$1',[admin.subsidiary_id])).rows[0].currency_id;
  const account=(await db.query('select account_id from chart_accounts where pr_allowed_account(account_id) order by account_id limit 1')).rows[0];
  assert.ok(account,'Se requiere una cuenta habilitada para Otros Pagos.');

  const createUser=async suffix=>(await db.query(`insert into users(email,password_hash,first_name,last_name,is_active)
    values($1,'test-only','Aprobador', $2,true)returning user_id,email`,[`up-${suffix}-${Date.now()}@example.test`,suffix])).rows[0];
  const approverA=await createUser('A'),approverB=await createUser('B');
  await db.query('insert into user_subsidiaries(user_id,subsidiary_id)values($1,$3),($2,$3)',[approverA.user_id,approverB.user_id,admin.subsidiary_id]);

  const options=(await db.query('select up_approver_options() value')).rows[0].value;
  assert.equal(options.permissions.manage,true);
  assert.ok(options.users.some(user=>String(user.id)===String(approverA.user_id)));

  await db.query('update cost_centers set up_approver_id=$1 where cost_center_id=any($2::bigint[])',[approverA.user_id,centers.map(row=>row.cost_center_id)]);
  let listed=(await db.query('select up_cost_centers_by_approver($1) value',[approverA.user_id])).rows[0].value;
  assert.equal(listed.total,2);
  let changed=(await db.query('select up_reassign_cost_centers($1) value',[{
    subsidiary_id:admin.subsidiary_id,current_approver_id:approverA.user_id,new_approver_id:approverB.user_id,
    reassign_all:false,cost_center_ids:[centers[0].cost_center_id]
  }])).rows[0].value;
  assert.equal(changed.updatedCount,1);
  assert.equal(String((await db.query('select up_approver_id from cost_centers where cost_center_id=$1',[centers[1].cost_center_id])).rows[0].up_approver_id),String(approverA.user_id));
  changed=(await db.query('select up_reassign_cost_centers($1) value',[{
    subsidiary_id:admin.subsidiary_id,current_approver_id:approverA.user_id,new_approver_id:approverB.user_id,
    reassign_all:true,cost_center_ids:[]
  }])).rows[0].value;
  assert.equal(changed.updatedCount,1);
  assert.equal(Number((await db.query('select count(*) n from cost_center_up_approver_audit')).rows[0].n),2);

  async function createRequest(lines,total=lines.reduce((sum,line)=>sum+line.amount,0)){
    const number=`UP-TEST-${Date.now()}-${Math.random().toString(36).slice(2,8)}`;
    const request=(await db.query(`insert into solicitudes_pago(numero,id_subsidiaria,id_moneda,tipo_solicitud,fecha_pago_programada,id_solicitante,concepto,total)
      values($1,$2,$3,'OTROS',current_date,$4,'Prueba automatizada de ruteo UP',$5)returning id,version`,
      [number,admin.subsidiary_id,currencyId,admin.user_id,total])).rows[0];
    for(const line of lines)await db.query(`insert into solicitudes_pago_lineas(
      id_solicitud,id_cuenta_contable,tipo_tercero,id_cliente,id_centro_costo,concepto,monto)
      values($1,$2,'Cliente',$3,$4,'Prueba de aprobador UP',$5)`,
      [request.id,account.account_id,line.customerId,line.centerId,line.amount]);
    return request;
  }

  await db.query('update cost_centers set up_approver_id=$1 where cost_center_id=$2',[approverA.user_id,centers[0].cost_center_id]);
  let request=await createRequest([{centerId:centers[0].cost_center_id,customerId:centers[0].customer_id,amount:10}]);
  await rejectsWithRollback(
    ()=>db.query("select wf_start_entity('PAYMENT_REQUEST',$1,'{}'::jsonb)",[request.id]),
    /deben enviarse desde la acción Enviar a aprobación/i
  );
  await rejectsWithRollback(
    ()=>db.query("select wf_start_entity_without_budget('PAYMENT_REQUEST',$1,jsonb_build_object('requestVersion',$2::integer))",[request.id,request.version+1]),
    /cambió después de pedir la aprobación presupuestaria/i
  );
  let submitted=(await db.query("select pr_transition(jsonb_build_object('id',$1::bigint,'version',$2::integer,'transition','SUBMIT')) value",[request.id,request.version])).rows[0].value;
  assert.equal(String(submitted.assignedApproverId),String(approverA.user_id));
  let header=(await db.query('select estado,assigned_approver_id,approval_route_source,version from solicitudes_pago where id=$1',[request.id])).rows[0];
  assert.deepEqual([header.estado,String(header.assigned_approver_id),header.approval_route_source],['PENDIENTE_APROBACION',String(approverA.user_id),'COST_CENTER']);
  let step=(await db.query(`select s.usuario_aprobador_id,s.nombre_nivel from wf_instances i join wf_instance_steps s on s.instance_id=i.id
    where i.entity_type='PAYMENT_REQUEST'and i.entity_id=$1`,[request.id])).rows[0];
  assert.equal(String(step.usuario_aprobador_id),String(approverA.user_id));
  assert.match(step.nombre_nivel,/UP/);
  await db.query("select pr_transition(jsonb_build_object('id',$1::bigint,'version',$2::integer,'transition','APPROVE'))",[request.id,header.version]);
  const approvedState=(await db.query(`select h.estado,i.status from solicitudes_pago h join wf_instances i
    on i.entity_type='PAYMENT_REQUEST'and i.entity_id=h.id where h.id=$1`,[request.id])).rows[0];
  assert.deepEqual([approvedState.estado,approvedState.status],['APROBADO','APROBADO']);

  await db.query('update cost_centers set up_approver_id=null where cost_center_id=$1',[centers[0].cost_center_id]);
  await db.query('update subsidiaries set default_up_approver_id=$1 where subsidiary_id=$2',[approverB.user_id,admin.subsidiary_id]);
  request=await createRequest([{centerId:centers[0].cost_center_id,customerId:centers[0].customer_id,amount:11}]);
  submitted=(await db.query("select pr_transition(jsonb_build_object('id',$1::bigint,'version',$2::integer,'transition','SUBMIT')) value",[request.id,request.version])).rows[0].value;
  assert.equal(String(submitted.assignedApproverId),String(approverB.user_id));
  header=(await db.query('select assigned_approver_id,approval_route_source from solicitudes_pago where id=$1',[request.id])).rows[0];
  assert.deepEqual([String(header.assigned_approver_id),header.approval_route_source],[String(approverB.user_id),'SUBSIDIARY']);

  await db.query('update subsidiaries set default_up_approver_id=null where subsidiary_id=$1',[admin.subsidiary_id]);
  const missing=await createRequest([{centerId:centers[0].cost_center_id,customerId:centers[0].customer_id,amount:12}]);
  await rejectsWithRollback(
    ()=>db.query("select pr_transition(jsonb_build_object('id',$1::bigint,'version',$2::integer,'transition','SUBMIT'))",[missing.id,missing.version]),
    /no tiene un Aprobador UP asignado/i
  );
  header=(await db.query('select estado,assigned_approver_id from solicitudes_pago where id=$1',[missing.id])).rows[0];
  assert.equal(header.estado,'BORRADOR');assert.equal(header.assigned_approver_id,null);

  await db.query('update cost_centers set up_approver_id=$1 where cost_center_id=$2',[approverA.user_id,centers[0].cost_center_id]);
  await db.query('update cost_centers set up_approver_id=$1 where cost_center_id=$2',[approverB.user_id,centers[1].cost_center_id]);
  const conflicting=await createRequest([
    {centerId:centers[0].cost_center_id,customerId:centers[0].customer_id,amount:10},
    {centerId:centers[1].cost_center_id,customerId:centers[1].customer_id,amount:10}
  ]);
  await rejectsWithRollback(
    ()=>db.query("select pr_transition(jsonb_build_object('id',$1::bigint,'version',$2::integer,'transition','SUBMIT'))",[conflicting.id,conflicting.version]),
    /aprobadores UP diferentes/i
  );
  assert.equal((await db.query('select estado from solicitudes_pago where id=$1',[conflicting.id])).rows[0].estado,'BORRADOR');

  const internal=(await db.query(`insert into cost_centers(code,name,subsidiary_id,cost_center_type,is_inactive)
    values('TEMP','Centro interno de prueba',$1,'INTERNO',false)returning cost_center_id,code,customer_id,up_approver_id`,[admin.subsidiary_id])).rows[0];
  assert.match(internal.code,/^INT-/);assert.equal(internal.customer_id,null);assert.equal(internal.up_approver_id,null);
  request=await createRequest([{centerId:internal.cost_center_id,customerId:centers[0].customer_id,amount:13}]);
  const standard=(await db.query('select pr_resolve_up_approver($1) value',[request.id])).rows[0].value;
  assert.equal(standard.source,'STANDARD');assert.equal(standard.approverId,null);

  const limitedRole=(await db.query(`insert into roles(role_name,description,is_system_role)
    values($1,'Rol temporal sin permisos UP',false)returning role_id`,[`UP_LIMITED_${Date.now()}`])).rows[0];
  const limitedUser=await createUser('LIMITED');
  await db.query('insert into user_subsidiaries(user_id,subsidiary_id)values($1,$2)',[limitedUser.user_id,admin.subsidiary_id]);
  await db.query('insert into user_roles(user_id,role_id)values($1,$2)',[limitedUser.user_id,limitedRole.role_id]);
  const limitedSession=`up-limited-${Date.now()}`;
  await db.query('insert into user_company_sessions(session_id,user_id,subsidiary_id)values($1,$2,$3)',[limitedSession,limitedUser.user_id,admin.subsidiary_id]);
  await db.query('insert into user_role_sessions(session_id,user_id,role_id)values($1,$2,$3)',[limitedSession,limitedUser.user_id,limitedRole.role_id]);
  await db.query("select set_config('request.jwt.claims',$1,true)",[JSON.stringify({email:limitedUser.email,session_id:limitedSession,role:'authenticated'})]);
  await rejectsWithRollback(
    ()=>db.query("update cost_centers set cost_center_type='INTERNO' where cost_center_id=$1",[centers[0].cost_center_id]),
    /No tiene permiso para configurar aprobadores UP/i
  );

  await db.query("select set_config('request.jwt.claims',$1,true)",[JSON.stringify({email:admin.email,session_id:sessionId,role:'authenticated'})]);
  await db.query('set local role authenticated');
  assert.equal(Number((await db.query('select count(*) n from cost_center_up_approver_audit')).rows[0].n),2);
  assert.equal(Number((await db.query('select count(*) n from cost_centers where subsidiary_id<>active_subsidiary_id()')).rows[0].n),0);
  assert.ok(Array.isArray((await db.query('select up_approver_selector_options() value')).rows[0].value));
  await db.query('reset role');

  console.log(JSON.stringify({
    migration:true,costCenterTypes:true,directRouting:true,subsidiaryFallback:true,
    missingApproverRollback:true,multipleApproverGuard:true,internalCenters:true,
    partialReassignment:true,totalReassignment:true,audit:true,directRpcGuards:true,
    workflowConsistency:true,permissionGuard:true,tenantRls:true,rollback:true
  }));
}finally{
  await db.query('rollback').catch(()=>undefined);
  await db.end();
}
