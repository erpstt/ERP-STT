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
  connectionTimeoutMillis: 15_000
});

const migrationPath = '../supabase/migrations/20261027153000_user_edit_password_notification.sql';
const migrationSource = await readFile(new URL(migrationPath, import.meta.url), 'utf8');
const migration = migrationSource
  .replace(/^\uFEFF?\s*begin\s*;\s*/i, '')
  .replace(/\s*commit\s*;\s*(?=notify\s+pgrst|$)/i, '')
  .replace(/\s*notify\s+pgrst\s*,\s*'reload schema'\s*;\s*$/i, '');

assert.ok(migration.trim(), 'La migración de recuperación de acceso está vacía.');
assert.ok(!/^\s*begin\s*;/i.test(migration), 'La migración conserva un BEGIN interno.');
assert.ok(!/\bnotify\s+pgrst\b/i.test(migration), 'La migración conserva un NOTIFY interno.');

await db.connect();
try {
  await db.query('begin');
  await db.query("set local statement_timeout='120s'");
  await db.query("select set_config('lock_timeout','15s',true)");
  await db.query(migration);

  const functions = (await db.query(`select
    to_regprocedure('public.security_prepare_user_password_recovery(bigint)') is not null prepare_exists,
    to_regprocedure('public.user_password_recovery_email_settings(text,jsonb)') is not null settings_exists,
    to_regprocedure('public.security_audit_user_password_notification(bigint,bigint,bigint,text)') is not null audit_exists,
    to_regprocedure('public.consume_password_recovery_grant(text,text)') is not null consume_exists`)).rows[0];
  assert.ok(
    Object.values(functions).every(value => value === true),
    `Funciones de recuperación incompletas: ${JSON.stringify(functions)}`
  );

  const privileges = (await db.query(`select
    has_function_privilege('anon','public.security_prepare_user_password_recovery(bigint)','execute') anon_prepare,
    has_function_privilege('authenticated','public.security_prepare_user_password_recovery(bigint)','execute') authenticated_prepare,
    has_function_privilege('anon','public.user_password_recovery_email_settings(text,jsonb)','execute') anon_settings,
    has_function_privilege('authenticated','public.user_password_recovery_email_settings(text,jsonb)','execute') authenticated_settings,
    has_function_privilege('authenticated','public.security_audit_user_password_notification(bigint,bigint,bigint,text)','execute') authenticated_audit,
    has_function_privilege('service_role','public.security_audit_user_password_notification(bigint,bigint,bigint,text)','execute') service_audit,
    has_function_privilege('authenticated','public.consume_password_recovery_grant(text,text)','execute') authenticated_consume,
    has_function_privilege('service_role','public.consume_password_recovery_grant(text,text)','execute') service_consume`)).rows[0];
  assert.deepEqual(privileges, {
    anon_prepare: false,
    authenticated_prepare: true,
    anon_settings: false,
    authenticated_settings: true,
    authenticated_audit: false,
    service_audit: true,
    authenticated_consume: false,
    service_consume: true
  }, `Privilegios de recuperación incorrectos: ${JSON.stringify(privileges)}`);

  const templates = (await db.query(`select
    count(*) filter(where subsidiary.is_active)::int active_subsidiaries,
    count(configuration.id) filter(
      where subsidiary.is_active
        and configuration.tipo_notificacion='USUARIO_RECUPERACION'
    )::int configured_subsidiaries,
    count(configuration.id) filter(
      where subsidiary.is_active
        and configuration.tipo_notificacion='USUARIO_RECUPERACION'
        and configuration.activo
        and btrim(configuration.asunto_template)<>''
        and btrim(configuration.cuerpo_template)<>''
    )::int usable_templates
  from public.subsidiaries subsidiary
  left join public.configuraciones_correos configuration
    on configuration.id_subsidiaria=subsidiary.subsidiary_id
   and configuration.tipo_notificacion='USUARIO_RECUPERACION'`)).rows[0];
  assert.equal(
    templates.configured_subsidiaries,
    templates.active_subsidiaries,
    `Faltan plantillas de recuperación: ${JSON.stringify(templates)}`
  );
  assert.equal(
    templates.usable_templates,
    templates.active_subsidiaries,
    `Hay plantillas de recuperación inactivas o vacías: ${JSON.stringify(templates)}`
  );

  const constraint = (await db.query(`select exists(
    select 1
    from pg_constraint
    where conrelid='public.configuraciones_correos'::regclass
      and conname='configuraciones_correos_tipo_notificacion_check'
      and position('USUARIO_RECUPERACION' in pg_get_constraintdef(oid))>0
  ) includes_recovery`)).rows[0];
  assert.equal(constraint.includes_recovery, true, 'El catálogo de plantillas no admite USUARIO_RECUPERACION.');

  await db.query("notify pgrst,'reload schema'");
  await db.query('commit');
  console.log(JSON.stringify({
    applied: true,
    migration: migrationPath.split('/').at(-1),
    functions,
    privileges,
    templates,
    constraint
  }));
} catch (error) {
  await db.query('rollback').catch(() => {});
  throw error;
} finally {
  await db.end();
}
