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
  ssl: {rejectUnauthorized: false},
  connectionTimeoutMillis: 15_000
});
const migration = await readFile(
  new URL('../supabase/migrations/20261026103000_user_invitation_email_template.sql', import.meta.url),
  'utf8'
);
const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;

async function expectDatabaseError(statement, parameters, expectedCode) {
  await db.query('savepoint expected_error');
  try {
    await db.query(statement, parameters);
    assert.fail('La operación inválida fue aceptada.');
  } catch (error) {
    if (error.code === 'ERR_ASSERTION') throw error;
    assert.equal(error.code, expectedCode);
  } finally {
    await db.query('rollback to savepoint expected_error');
    await db.query('release savepoint expected_error');
  }
}

await db.connect();
try {
  await db.query('begin');
  await db.query("set local lock_timeout='5s'; set local statement_timeout='90s'");
  await db.query(migration);

  const fixture = (await db.query(`
    select company_session.session_id,account.user_id,account.email,
      auth_account.id::text auth_id,company_session.subsidiary_id
    from public.user_company_sessions company_session
    join public.user_role_sessions role_session
      on role_session.session_id=company_session.session_id
      and role_session.user_id=company_session.user_id
    join public.roles role on role.role_id=role_session.role_id
      and lower(role.role_name) in('administrador','administrator','admin')
    join public.users account on account.user_id=company_session.user_id and account.is_active
    join auth.users auth_account on lower(auth_account.email)=lower(account.email)
    join public.user_subsidiaries access
      on access.user_id=account.user_id
      and access.subsidiary_id=company_session.subsidiary_id
    join public.subsidiaries subsidiary
      on subsidiary.subsidiary_id=company_session.subsidiary_id
      and subsidiary.is_active
    order by company_session.selected_at desc
    limit 1
  `)).rows[0];
  assert.ok(fixture, 'Se requiere una sesión activa con rol Administrador para probar la plantilla.');

  const viewRoleId = (await db.query(`
    insert into public.roles(role_name,description,is_system_role)
    values($1,'Prueba temporal: solo consulta plantillas de notificación',false)
    returning role_id
  `, [`Plantillas consulta ${suffix}`])).rows[0].role_id;
  const editRoleId = (await db.query(`
    insert into public.roles(role_name,description,is_system_role)
    values($1,'Prueba temporal: consulta y edición de plantillas de notificación',false)
    returning role_id
  `, [`Plantillas edición ${suffix}`])).rows[0].role_id;
  const deliveryRoleId = (await db.query(`
    insert into public.roles(role_name,description,is_system_role)
    values($1,'Prueba temporal: alta de usuarios sin acceso a plantillas',false)
    returning role_id
  `, [`Alta usuarios ${suffix}`])).rows[0].role_id;
  const viewSession = `notification-view-${suffix}`;
  const editSession = `notification-edit-${suffix}`;
  const deliverySession = `notification-delivery-${suffix}`;
  await db.query(
    `insert into public.user_roles(user_id,role_id) values($1,$2),($1,$3),($1,$4)`,
    [fixture.user_id, viewRoleId, editRoleId, deliveryRoleId]
  );
  await db.query(`
    insert into public.role_access_matrix(
      role_id,resource_key,can_view,can_create,can_edit,can_delete
    ) values
      ($1,'configuration:notification-templates',true,false,false,false),
      ($2,'configuration:notification-templates',true,false,true,false),
      ($3,'security:users',true,true,false,false)
  `, [viewRoleId, editRoleId, deliveryRoleId]);
  await db.query(`
    insert into public.user_company_sessions(session_id,user_id,subsidiary_id)
    values($1,$4,$5),($2,$4,$5),($3,$4,$5)
  `, [viewSession, editSession, deliverySession, fixture.user_id, fixture.subsidiary_id]);
  await db.query(`
    insert into public.user_role_sessions(session_id,user_id,role_id)
    values($1,$4,$5),($2,$4,$6),($3,$4,$7)
  `, [viewSession, editSession, deliverySession, fixture.user_id, viewRoleId, editRoleId, deliveryRoleId]);

  const setSession = async sessionId => {
    await db.query(
      `select set_config('request.jwt.claims',$1,true),set_config('request.headers','{}',true)`,
      [JSON.stringify({
        email: fixture.email,
        sub: fixture.auth_id,
        session_id: sessionId,
        role: 'authenticated'
      })]
    );
  };

  await setSession(viewSession);
  await db.query('set local role authenticated');

  const readOnly = (await db.query(
    `select public.user_invitation_email_settings('get','{}'::jsonb) value`
  )).rows[0].value;
  assert.equal(readOnly.canEdit, false);
  await expectDatabaseError(
    `select public.user_invitation_email_settings('save',$1::jsonb)`,
    [JSON.stringify({subject: 'Sin permiso', body: '<p>Sin permiso</p>', active: true})],
    '42501'
  );

  await setSession(deliverySession);
  const delivery = (await db.query(
    `select public.user_invitation_email_settings('delivery','{}'::jsonb) value`
  )).rows[0].value;
  assert.equal(delivery.template.tipo_notificacion, 'USUARIO_INVITACION');
  assert.equal(delivery.canEdit, false);
  await expectDatabaseError(
    `select public.user_invitation_email_settings('get','{}'::jsonb)`,
    [],
    '42501'
  );

  await setSession(editSession);
  const editable = (await db.query(
    `select public.user_invitation_email_settings('get','{}'::jsonb) value`
  )).rows[0].value;
  assert.equal(editable.canEdit, true);
  const granularSave = (await db.query(
    `select public.user_invitation_email_settings('save',$1::jsonb) value`,
    [JSON.stringify({
      subject: 'Acceso a GENTIA ERP · {{usuario_nombre}}',
      body: '<p>Activa tu acceso con {{enlace_activacion}}.</p>',
      active: true
    })]
  )).rows[0].value;
  assert.equal(granularSave.template.asunto_template, 'Acceso a GENTIA ERP · {{usuario_nombre}}');

  await setSession(fixture.session_id);

  const data = (await db.query(
    `select public.user_invitation_email_settings('get','{}'::jsonb) value`
  )).rows[0].value;
  assert.equal(data.canEdit, true);
  assert.equal(data.template.tipo_notificacion, 'USUARIO_INVITACION');
  assert.deepEqual(data.variables, [
    'empresa_nombre','usuario_nombre','usuario_correo','enlace_activacion','fecha_expiracion'
  ]);
  assert.match(data.template.asunto_template, /GENTIA ERP/);
  assert.match(data.template.cuerpo_template, /enlace/i);
  assert.doesNotMatch(data.template.cuerpo_template, /contraseña\s*[:=]/i);

  await expectDatabaseError(
    `select public.user_invitation_email_settings('save',$1::jsonb)`,
    [JSON.stringify({subject: 'Acceso {{password}}', body: '<p>Prueba</p>', active: true})],
    '22023'
  );
  await expectDatabaseError(
    `select public.user_invitation_email_settings('save',$1::jsonb)`,
    [JSON.stringify({subject: 'Acceso {{enlace_activacion}}', body: '<p>Prueba</p>', active: true})],
    '22023'
  );

  const saved = (await db.query(
    `select public.user_invitation_email_settings('save',$1::jsonb) value`,
    [JSON.stringify({
      subject: 'Bienvenido {{usuario_nombre}} · {{empresa_nombre}}',
      body: '<p>Activa tu acceso con {{enlace_activacion}} antes de {{fecha_expiracion}}.</p>',
      active: true
    })]
  )).rows[0].value;
  assert.equal(saved.template.asunto_template, 'Bienvenido {{usuario_nombre}} · {{empresa_nombre}}');
  assert.equal(saved.template.activo, true);

  await db.query('reset role');
  const privileges = (await db.query(`
    select
      has_function_privilege('anon','public.user_invitation_email_settings(text,jsonb)','execute') anon_execute,
      has_function_privilege('authenticated','public.user_invitation_email_settings(text,jsonb)','execute') authenticated_execute,
      has_function_privilege('authenticated','public.user_invitation_email_ensure_template(bigint)','execute') ensure_execute
  `)).rows[0];
  assert.deepEqual(privileges, {
    anon_execute: false,
    authenticated_execute: true,
    ensure_execute: false
  });

  console.log(JSON.stringify({
    templateSeeded: true,
    viewOnlyRoleCannotEdit: true,
    granularEditRoleCanEdit: true,
    userCreatorCanDeliverWithoutTemplateAccess: true,
    administratorCompatible: true,
    allowedVariables: data.variables.length,
    activationLinkRejectedInSubject: true,
    anonymousDenied: true,
    passwordNotStoredOrRendered: true,
    rollback: true
  }));
} finally {
  await db.query('reset role').catch(() => {});
  await db.query('rollback').catch(() => {});
  await db.end();
}
