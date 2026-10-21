import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import pg from 'pg';

process.loadEnvFile?.('.env');

const required = ['SUPABASE_URL', 'SUPABASE_DB_PASSWORD'];
const missing = required.filter(name => !process.env[name]);

test('RPC de exportación aísla la subsidiaria y reconoce asignaciones secundarias', { skip: missing.length ? `Faltan ${missing.join(', ')}` : false }, async () => {
  const projectRef = new URL(process.env.SUPABASE_URL).hostname.split('.')[0];
  const db = new pg.Client({
    host: process.env.SUPABASE_DB_HOST || 'aws-0-us-east-1.pooler.supabase.com',
    port: Number(process.env.SUPABASE_DB_PORT || 6543),
    database: process.env.SUPABASE_DB_NAME || 'postgres',
    user: process.env.SUPABASE_DB_USER || `postgres.${projectRef}`,
    password: process.env.SUPABASE_DB_PASSWORD || process.env.PGPASSWORD,
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 15000,
  });
  const migration = await readFile(new URL('../supabase/migrations/20261020090000_entity_catalog_exports.sql', import.meta.url), 'utf8');
  const suffix = randomUUID().replaceAll('-', '').slice(0, 12).toUpperCase();
  const marker = `ENTEXP-${suffix}`;

  await db.connect();
  try {
    await db.query('begin');
    await db.query("set local lock_timeout='5s'; set local statement_timeout='60s'");
    await db.query(migration);

    const subsidiaries = (await db.query(`select subsidiary_id,name,currency_id
      from public.subsidiaries where is_active and currency_id is not null
      order by subsidiary_id limit 2`)).rows;
    assert.equal(subsidiaries.length, 2, 'La prueba requiere dos subsidiarias activas.');
    const [allowed, forbidden] = subsidiaries;

    const email = `entity-export-${suffix.toLowerCase()}@example.test`;
    const auditAuth = (await db.query('select id from auth.users order by created_at limit 1')).rows[0];
    assert.ok(auditAuth, 'La prueba requiere un usuario autenticado para atribuir las escrituras de auditoría.');
    const userId = (await db.query(`insert into public.users(email,password_hash,first_name,last_name,is_active)
      values($1,'test-only','Prueba','Exportación',true)returning user_id`, [email])).rows[0].user_id;
    const sessionId = `entity-export-${suffix}`;
    await db.query('insert into public.user_subsidiaries(user_id,subsidiary_id)values($1,$2)', [userId, allowed.subsidiary_id]);
    await db.query(`insert into public.user_company_sessions(session_id,user_id,subsidiary_id)
      values($1,$2,$3)`, [sessionId, userId, allowed.subsidiary_id]);
    const roleId = (await db.query(`insert into public.roles(role_name,description,is_system_role)
      values($1,'Rol temporal para validar exportaciones de Entidades',false)returning role_id`,
    [`Exportador entidades ${suffix}`])).rows[0].role_id;
    await db.query('insert into public.user_roles(user_id,role_id)values($1,$2)', [userId, roleId]);
    await db.query(`insert into public.user_role_sessions(session_id,user_id,role_id)
      values($1,$2,$3)`, [sessionId, userId, roleId]);
    await db.query(`insert into public.role_access_matrix(
        role_id,resource_key,can_view,can_create,can_edit,can_delete
      )select $1,resource_key,true,false,false,false from unnest($2::text[])resource_key`, [
      roleId,
      ['entities:customers', 'entities:suppliers', 'entities:employees', 'entities:entity-subsidiaries'],
    ]);
    await db.query("select set_config('request.jwt.claims',$1,true)", [JSON.stringify({
      sub: auditAuth.id, email, session_id: sessionId, role: 'authenticated',
    })]);

    const secondaryCustomer = (await db.query(`insert into public.customers(
        customer_number,company_name,tax_id,primary_subsidiary_id,currency_id,credit_limit,email
      )values($1,$2,$3,$4,$5,777.25,$6)returning customer_id`, [
      `CLI-${marker}`, `${marker} Cliente asignación secundaria`, `${marker}-C`,
      forbidden.subsidiary_id, forbidden.currency_id, `${marker.toLowerCase()}-customer@example.test`,
    ])).rows[0].customer_id;
    await db.query(`insert into public.entity_subsidiaries(customer_id,subsidiary_id,is_primary,credit_limit)
      values($1,$2,true,777.25),($1,$3,false,555.50)`, [secondaryCustomer, forbidden.subsidiary_id, allowed.subsidiary_id]);
    await db.query(`insert into public.customer_currencies(customer_id,currency_id,is_primary)
      values($1,$2,true)on conflict do nothing`, [secondaryCustomer, forbidden.currency_id]);

    const forbiddenCustomer = (await db.query(`insert into public.customers(
        customer_number,company_name,tax_id,primary_subsidiary_id,currency_id,credit_limit
      )values($1,$2,$3,$4,$5,1)returning customer_id`, [
      `CLI-${marker}-X`, `${marker} Cliente prohibido`, `${marker}-CX`, forbidden.subsidiary_id, forbidden.currency_id,
    ])).rows[0].customer_id;
    await db.query(`insert into public.entity_subsidiaries(customer_id,subsidiary_id,is_primary,credit_limit)
      values($1,$2,true,1)`, [forbiddenCustomer, forbidden.subsidiary_id]);

    const secondarySupplier = (await db.query(`insert into public.suppliers(
        supplier_number,company_name,tax_id,primary_subsidiary_id,currency_id,email
      )values($1,$2,$3,$4,$5,$6)returning supplier_id`, [
      `PROV-${marker}`, `${marker} Proveedor asignación secundaria`, `${marker}-P`,
      forbidden.subsidiary_id, forbidden.currency_id, `${marker.toLowerCase()}-supplier@example.test`,
    ])).rows[0].supplier_id;
    await db.query(`insert into public.entity_subsidiaries(supplier_id,subsidiary_id,is_primary,credit_limit)
      values($1,$2,true,0),($1,$3,false,0)`, [secondarySupplier, forbidden.subsidiary_id, allowed.subsidiary_id]);
    await db.query(`insert into public.supplier_currencies(supplier_id,currency_id,is_primary)
      values($1,$2,true)on conflict do nothing`, [secondarySupplier, forbidden.currency_id]);

    const allowedEmployee = (await db.query(`insert into public.employees(
        employee_number,identification,first_name,last_name,subsidiary_id,is_active
      )values($1,$2,$3,'Permitido',$4,true)returning employee_id`, [
      `EMP-${marker}`, `${marker}-E`, marker, allowed.subsidiary_id,
    ])).rows[0].employee_id;
    const forbiddenEmployee = (await db.query(`insert into public.employees(
        employee_number,identification,first_name,last_name,subsidiary_id,is_active
      )values($1,$2,$3,'Prohibido',$4,true)returning employee_id`, [
      `EMP-${marker}-X`, `${marker}-EX`, marker, forbidden.subsidiary_id,
    ])).rows[0].employee_id;

    const execute = async (catalog, search = marker) => (await db.query(
      'select public.entity_catalog_export_data($1,$2) value', [catalog, search]
    )).rows[0].value;
    let savepointNumber = 0;
    const expectDatabaseError = async (sql, parameters, expression) => {
      const savepoint = `entity_export_expected_${++savepointNumber}`;
      let failure = null;
      await db.query(`savepoint ${savepoint}`);
      try {
        await db.query(sql, parameters);
      } catch (error) {
        failure = error;
      } finally {
        await db.query(`rollback to savepoint ${savepoint}`);
        await db.query(`release savepoint ${savepoint}`);
      }
      assert.ok(failure, `La consulta debió fallar con ${expression}.`);
      assert.match(failure.message, expression);
    };

    const customers = await execute('customers');
    assert.equal(Number(customers.header.subsidiaryId), Number(allowed.subsidiary_id));
    assert.equal(customers.total, 1);
    assert.equal(Number(customers.rows[0].id), Number(secondaryCustomer));
    assert.equal(customers.rows[0].isPrimary, false);
    assert.equal(Number(customers.rows[0].creditLimit), 555.5, 'Debe usar el límite de la asignación activa.');
    assert.ok(!customers.rows.some(row => Number(row.id) === Number(forbiddenCustomer)));

    const suppliers = await execute('suppliers');
    assert.equal(suppliers.total, 1);
    assert.equal(Number(suppliers.rows[0].id), Number(secondarySupplier));
    assert.equal(suppliers.rows[0].isPrimary, false);

    const employees = await execute('employees');
    assert.equal(employees.total, 1);
    assert.equal(Number(employees.rows[0].id), Number(allowedEmployee));
    assert.ok(!employees.rows.some(row => Number(row.id) === Number(forbiddenEmployee)));

    const links = await execute('entity-subsidiaries');
    assert.equal(links.total, 2);
    assert.deepEqual(new Set(links.rows.map(row => row.entityKind)), new Set(['Cliente', 'Proveedor']));
    assert.ok(links.rows.every(row => row.isPrimary === false));
    assert.ok(!links.rows.some(row => row.name.includes('prohibido')));

    const caseInsensitive = await execute('customers', marker.toLowerCase());
    assert.equal(caseInsensitive.total, 1, 'La búsqueda debe ignorar mayúsculas y minúsculas.');
    const accentInsensitive = await execute('customers', 'asignacion secundaria');
    assert.equal(accentInsensitive.total, 1, 'La búsqueda debe encontrar texto aunque el usuario omita los acentos.');

    await db.query(`update public.role_access_matrix set can_view=false
      where role_id=$1 and resource_key='entities:customers'`, [roleId]);
    await expectDatabaseError(
      "select public.entity_catalog_export_data('customers','')", [], /rol activo no tiene permiso/i,
    );
    await db.query(`update public.role_access_matrix set can_view=true
      where role_id=$1 and resource_key='entities:customers'`, [roleId]);

    await expectDatabaseError("select public.entity_catalog_export_data('users','')", [], /no admite exportacion/i);
    await expectDatabaseError(
      "select public.entity_catalog_export_data('customers',$1)", ['x'.repeat(201)], /no puede superar 200/i,
    );

    await db.query('update public.user_company_sessions set subsidiary_id=$1 where session_id=$2', [forbidden.subsidiary_id, sessionId]);
    await expectDatabaseError(
      "select public.entity_catalog_export_data('customers','')", [], /subsidiaria autorizada activa/i,
    );

    const privileges = (await db.query(`select
      has_function_privilege('anon','public.entity_catalog_export_data(text,text)','execute') anon,
      has_function_privilege('authenticated','public.entity_catalog_export_data(text,text)','execute') authenticated`)).rows[0];
    assert.equal(privileges.anon, false);
    assert.equal(privileges.authenticated, true);
  } finally {
    await db.query('rollback').catch(() => {});
    await db.end();
  }
});
