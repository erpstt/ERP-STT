import assert from 'node:assert/strict';
import pg from 'pg';

process.loadEnvFile?.('.env');

const required = ['SUPABASE_URL', 'SUPABASE_DB_PASSWORD'];
const missing = required.filter(name => !process.env[name]);
if (missing.length) throw new Error(`Faltan variables de entorno: ${missing.join(', ')}`);

const projectRef = new URL(process.env.SUPABASE_URL).hostname.split('.')[0];
const db = new pg.Client({
  host: process.env.SUPABASE_DB_HOST || 'aws-0-us-east-1.pooler.supabase.com',
  port: Number(process.env.SUPABASE_DB_PORT || 6543),
  database: process.env.SUPABASE_DB_NAME || 'postgres',
  user: process.env.SUPABASE_DB_USER || `postgres.${projectRef}`,
  password: process.env.SUPABASE_DB_PASSWORD || process.env.PGPASSWORD,
  ssl: { rejectUnauthorized: false },
  connectionTimeoutMillis: 15_000,
});

const reportFor = async (context, filters = {}) => {
  await db.query("select set_config('request.jwt.claims',$1,true)", [JSON.stringify({
    sub: context.auth_id,
    email: context.email,
    session_id: context.session_id,
    role: 'authenticated',
  })]);
  await db.query('set local role authenticated');
  try {
    const active = (await db.query('select public.active_subsidiary_id() id')).rows[0]?.id;
    const report = (await db.query(
      'select public.asset_category_report($1::jsonb) value',
      [JSON.stringify(filters)],
    )).rows[0]?.value;
    return { active, report };
  } finally {
    await db.query('reset role');
  }
};

await db.connect();
try {
  await db.query('begin transaction read only');
  await db.query("set local lock_timeout='5s'; set local statement_timeout='60s'");

  const functionSecurity = (await db.query(`
    with target as (
      select p.oid,p.prosecdef,p.provolatile,p.proacl,p.proowner,pg_get_functiondef(p.oid) definition
      from pg_proc p
      where p.oid=to_regprocedure('public.asset_category_report(jsonb)')
    )
    select
      exists(select 1 from target) exists,
      coalesce((select prosecdef from target),false) security_definer,
      coalesce((select provolatile='s' from target),false) stable,
      coalesce((select position('active_subsidiary_id' in definition)>0 from target),false) scoped,
      coalesce((select position('''subsidiary''' in definition)>0 from target),false) subsidiary_header,
      has_function_privilege('authenticated','public.asset_category_report(jsonb)','execute') authenticated_execute,
      not has_function_privilege('anon','public.asset_category_report(jsonb)','execute') anon_denied,
      not exists(
        select 1 from target
        cross join lateral aclexplode(coalesce(target.proacl,acldefault('f',target.proowner))) privilege
        where privilege.grantee=0 and privilege.privilege_type='EXECUTE'
      ) public_denied
  `)).rows[0];
  for (const [check, passed] of Object.entries(functionSecurity)) {
    assert.equal(passed, true, `Falló la validación de seguridad: ${check}.`);
  }

  const contexts = (await db.query(`
    select distinct on (session.subsidiary_id)
      app_user.email,
      session.session_id,
      session.subsidiary_id,
      auth_user.id auth_id,
      subsidiary.name subsidiary_name,
      (select count(*)::int from public.asset_category category
       where category.subsidiary_id=session.subsidiary_id) category_count
    from public.user_company_sessions session
    join public.users app_user using(user_id)
    join auth.users auth_user on lower(auth_user.email)=lower(app_user.email)
    join public.user_subsidiaries access
      on access.user_id=session.user_id and access.subsidiary_id=session.subsidiary_id
    join public.subsidiaries subsidiary on subsidiary.subsidiary_id=session.subsidiary_id
    where app_user.is_active
    order by session.subsidiary_id,category_count desc,session.selected_at desc
  `)).rows;
  assert.ok(contexts.length, 'No existe una sesión autorizada para probar el reporte.');

  const selected = contexts
    .sort((left, right) => Number(right.category_count) - Number(left.category_count))
    .slice(0, Math.min(2, contexts.length));

  const verified = [];
  for (const context of selected) {
    const expectedRows = (await db.query(`
      select category_id,category_code,category_name,description,is_active
      from public.asset_category
      where subsidiary_id=$1
      order by category_name,category_id
    `, [context.subsidiary_id])).rows;

    const allResult = await reportFor(context, { status: 'ALL', search: '' });
    assert.equal(Number(allResult.active), Number(context.subsidiary_id));
    assert.ok(allResult.report?.subsidiary, 'El reporte debe incluir el encabezado de subsidiaria.');
    assert.equal(Number(allResult.report.subsidiary.id), Number(context.subsidiary_id));
    assert.equal(allResult.report.subsidiary.name, context.subsidiary_name);
    assert.ok(Array.isArray(allResult.report.rows));
    assert.equal(allResult.report.rows.length, expectedRows.length);

    const expectedIds = new Set(expectedRows.map(row => String(row.category_id)));
    assert.ok(allResult.report.rows.every(row => expectedIds.has(String(row.id))),
      'El reporte devolvió una categoría ajena a la subsidiaria activa.');

    if (allResult.report.rows.length) {
      const returnedIds = allResult.report.rows.map(row => String(row.id));
      const foreign = Number((await db.query(`
        select count(*) total
        from public.asset_category
        where category_id=any($1::bigint[]) and subsidiary_id<>$2
      `, [returnedIds, context.subsidiary_id])).rows[0].total);
      assert.equal(foreign, 0, 'Hay filas pertenecientes a otra subsidiaria.');
    }

    const activeResult = await reportFor(context, { status: 'ACTIVE', search: '' });
    const inactiveResult = await reportFor(context, { status: 'INACTIVE', search: '' });
    assert.ok(activeResult.report.rows.every(row => row.active === true));
    assert.ok(inactiveResult.report.rows.every(row => row.active === false));
    assert.equal(activeResult.report.rows.length, expectedRows.filter(row => row.is_active).length);
    assert.equal(inactiveResult.report.rows.length, expectedRows.filter(row => !row.is_active).length);

    let searchVerified = false;
    if (expectedRows.length) {
      const needle = String(expectedRows[0].category_code || expectedRows[0].category_name).toLowerCase();
      const searchResult = await reportFor(context, { status: 'ALL', search: needle });
      const directMatches = expectedRows.filter(row => [row.category_code, row.category_name, row.description]
        .filter(Boolean).join(' ').toLowerCase().includes(needle));
      assert.deepEqual(
        new Set(searchResult.report.rows.map(row => String(row.id))),
        new Set(directMatches.map(row => String(row.category_id))),
      );
      searchVerified = true;
    }

    const missingSearch = await reportFor(context, {
      status: 'ALL',
      search: '__categoria_que_no_debe_existir_9d1b50b8__',
    });
    assert.equal(missingSearch.report.rows.length, 0);

    verified.push({
      subsidiaryId: Number(context.subsidiary_id),
      subsidiary: context.subsidiary_name,
      rows: expectedRows.length,
      active: activeResult.report.rows.length,
      inactive: inactiveResult.report.rows.length,
      searchVerified,
    });
  }

  await db.query('rollback');
  console.log(JSON.stringify({
    passed: true,
    readOnly: true,
    availableAuthorizedContexts: contexts.length,
    testedContexts: verified.length,
    isolationAcrossDistinctSubsidiaries: verified.length > 1,
    filters: ['ALL', 'ACTIVE', 'INACTIVE', 'search'],
    privileges: {
      authenticatedExecute: true,
      anonDenied: true,
      publicDenied: true,
    },
    contexts: verified,
  }));
} catch (error) {
  await db.query('rollback').catch(() => {});
  throw error;
} finally {
  await db.end();
}
