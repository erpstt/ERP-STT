import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import pg from 'pg';

process.loadEnvFile?.('.env');
const projectRef = new URL(process.env.SUPABASE_URL).hostname.split('.')[0];
const db = new pg.Client({
  host: process.env.SUPABASE_DB_HOST || 'aws-0-us-east-1.pooler.supabase.com',
  port: Number(process.env.SUPABASE_DB_PORT || 6543),
  database: 'postgres',
  user: process.env.SUPABASE_DB_USER || `postgres.${projectRef}`,
  password: process.env.SUPABASE_DB_PASSWORD,
  ssl: { rejectUnauthorized: false },
  connectionTimeoutMillis: 15000
});
const value = async (sql, args = []) => (await db.query(sql, args)).rows[0]?.value;
const migrationUrl = new URL('../supabase/migrations/20260928090000_tax_obligation_catalog_and_templates.sql', import.meta.url);
const apply = process.argv.includes('--apply');

await db.connect();
try {
  await db.query("begin;set local lock_timeout='10s';set local statement_timeout='180s'");
  const installed = await value("select to_regprocedure('public.tax_obligation_catalog_manage(text,jsonb)') is not null value");
  if (!installed) await db.query(await readFile(migrationUrl, 'utf8'));

  const context = (await db.query(`
    select u.user_id,u.email,ucs.session_id,ucs.subsidiary_id,au.id::text sub,r.role_id,s.country_id
    from user_company_sessions ucs
    join users u using(user_id)
    join user_role_sessions urs using(session_id,user_id)
    join roles r using(role_id)
    join auth.users au on lower(au.email)=lower(u.email)
    join subsidiaries s on s.subsidiary_id=ucs.subsidiary_id
    where lower(r.role_name)in('administrador','administrator','admin')and u.is_active
    order by ucs.selected_at desc limit 1
  `)).rows[0];
  assert.ok(context, 'Se requiere una sesión activa con rol Administrador.');
  const claims = { sub: context.sub, email: context.email, session_id: context.session_id, role: 'authenticated' };
  await db.query('savepoint fixtures');
  await db.query("select set_config('request.jwt.claims',$1,true)", [JSON.stringify(claims)]);
  await db.query('set local role authenticated');

  const options = await value("select tax_obligation_catalog_manage('options','{}'::jsonb)value");
  assert.equal(options.permissions.view, true);
  assert.equal(options.permissions.manage, true);
  const country = options.countries.find(item => Number(item.id) === Number(context.country_id)) || options.countries[0];
  assert.ok(country, 'El usuario no tiene países autorizados para configurar.');
  const subsidiary = (await db.query(`
    select s.subsidiary_id from subsidiaries s join user_subsidiaries us using(subsidiary_id)
    where us.user_id=$1 and s.country_id=$2 and s.is_active order by s.subsidiary_id limit 1
  `, [context.user_id, country.id])).rows[0];
  assert.ok(subsidiary, 'No existe una subsidiaria autorizada para el país de prueba.');

  const suffix = randomUUID().slice(0, 8).toUpperCase();
  const code = `TEST-CAT-${suffix}`;
  const saved = await value("select tax_obligation_catalog_manage('save',$1::jsonb)value", [{
    countryId: Number(country.id), code, name: 'Obligación fiscal de prueba', frequency: 'quarterly',
    description: 'Registro reversible para validar el catálogo por país.', isActive: true
  }]);
  assert.ok(saved.id);
  const list = await value("select tax_obligation_catalog_manage('list',jsonb_build_object('countryId',$1::text))value", [country.id]);
  assert.ok(list.obligations.some(item => item.id === saved.id && item.code === code));
  const calendarOptions = await value("select tax_obligation_catalog_manage('calendar-options','{}'::jsonb)value");
  const selectable = calendarOptions.taxTypes.find(item => item.id === saved.id);
  assert.ok(selectable);
  assert.ok(selectable.subsidiaryIds.map(Number).includes(Number(subsidiary.subsidiary_id)));

  const templateSubject = `Aviso {{obligacion}} · {{empresa}} · ${suffix}`;
  const templateBody = 'La obligación {{obligacion}} del período {{periodo}} {{mensaje_vencimiento}}. Responsable: {{responsable}}.';
  await value("select tax_obligation_catalog_manage('save-template',$1::jsonb)value", [{
    countryId: Number(country.id), kind: 'reminder', subjectTemplate: templateSubject,
    bodyTemplate: templateBody, isActive: true
  }]);

  const eventId = randomUUID();
  await value("select tax_calendar_manage('save',$1::jsonb)value", [{
    id: eventId, subsidiaryId: Number(subsidiary.subsidiary_id), taxTypeCode: code, period: '2098-FY',
    dueDate: '2098-12-31', assignedUserId: Number(context.user_id), status: 'pending', documentType: 'none',
    notes: 'Prueba reversible de relación catálogo-calendario.', followers: [], reminders: [{ daysBeforeDue: 3 }]
  }]);
  await db.query('reset role');
  const relation = (await db.query('select obligation_type_id::text id from tax_calendar_events where id=$1', [eventId])).rows[0];
  assert.equal(relation.id, saved.id);
  await db.query('set local role authenticated');

  await value("select tax_obligation_catalog_manage('save',$1::jsonb)value", [{
    id: saved.id, countryId: Number(country.id), code, name: 'Obligación fiscal de prueba', frequency: 'quarterly',
    description: 'Registro reversible para validar el catálogo por país.', isActive: false
  }]);
  await value("select tax_calendar_manage('save',$1::jsonb)value", [{
    id: eventId, subsidiaryId: Number(subsidiary.subsidiary_id), taxTypeCode: code, period: '2098-FY',
    dueDate: '2098-12-31', assignedUserId: Number(context.user_id), status: 'filed', documentType: 'none',
    filingDate: '2098-12-30T15:00:00Z', followers: [], reminders: [{ daysBeforeDue: 3 }]
  }]);
  await db.query('savepoint inactive_type');
  let inactiveRejected = false;
  try {
    await value("select tax_calendar_manage('save',$1::jsonb)value", [{
      id: randomUUID(), subsidiaryId: Number(subsidiary.subsidiary_id), taxTypeCode: code,
      period: '2097-FY', dueDate: '2097-12-31', status: 'pending', documentType: 'none'
    }]);
  } catch (error) {
    inactiveRejected = /obligación tributaria activa/i.test(error.message);
    await db.query('rollback to savepoint inactive_type');
  }
  assert.equal(inactiveRejected, true, 'Una obligación inactiva no debe admitirse en registros nuevos.');
  await value("select tax_obligation_catalog_manage('save',$1::jsonb)value", [{
    id: saved.id, countryId: Number(country.id), code, name: 'Obligación fiscal de prueba', frequency: 'quarterly',
    description: 'Registro reversible para validar el catálogo por país.', isActive: true
  }]);

  await db.query('savepoint invalid_type');
  let invalidRejected = false;
  try {
    await value("select tax_calendar_manage('save',$1::jsonb)value", [{
      id: randomUUID(), subsidiaryId: Number(subsidiary.subsidiary_id), taxTypeCode: `NO-CATALOG-${suffix}`,
      period: '2097-FY', dueDate: '2097-12-31', status: 'pending', documentType: 'none'
    }]);
  } catch (error) {
    invalidRejected = /obligación tributaria activa/i.test(error.message);
    await db.query('rollback to savepoint invalid_type');
  }
  assert.equal(invalidRejected, true, 'Debe rechazarse un código ajeno al catálogo del país.');

  await db.query('reset role');
  await db.query("select tax_calendar_enqueue_recipient($1,$2,'email','reminder',null,3,'normal')", [eventId, context.user_id]);
  const queued = (await db.query('select payload from tax_calendar_email_outbox where event_id=$1 order by created_at desc limit 1', [eventId])).rows[0];
  assert.equal(queued.payload.templateSubject, templateSubject);
  assert.equal(queued.payload.templateBody, templateBody);
  assert.equal(queued.payload.taxTypeName, 'Obligación fiscal de prueba');

  await db.query("select set_config('request.jwt.claims',$1,true)", [JSON.stringify(claims)]);
  await db.query('set local role authenticated');
  await db.query('savepoint direct_access');
  let directDenied = false;
  try { await db.query('select count(*) from tax_obligation_types'); }
  catch (error) { directDenied = error.code === '42501'; await db.query('rollback to savepoint direct_access'); }
  assert.equal(directDenied, true, 'El catálogo debe permanecer detrás del RPC protegido.');

  await value("select tax_calendar_manage('delete',jsonb_build_object('id',$1::text))value", [eventId]);
  await value("select tax_obligation_catalog_manage('delete',jsonb_build_object('id',$1::text))value", [saved.id]);

  await db.query('rollback to savepoint fixtures');
  await db.query(apply && !installed ? 'commit' : 'rollback');
  console.log(JSON.stringify({
    applied: apply && !installed,
    countryCatalog: true,
    subsidiaryFiltering: true,
    invalidTypeRejected: true,
    inactiveTypePreservesHistory: true,
    eventRelation: true,
    editableTemplate: true,
    outboxTemplateSnapshot: true,
    directAccessDenied: true,
    fixturesRolledBack: true
  }));
} catch (error) {
  await db.query('rollback').catch(() => {});
  throw error;
} finally {
  await db.end();
}
