import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
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
  new URL('../supabase/migrations/20261026113000_redact_audit_secrets.sql', import.meta.url),
  'utf8'
);
const marker = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
const probeTable = `audit_secret_probe_${marker.replaceAll('-', '_')}`;
assert.match(probeTable, /^[a-z0-9_]+$/);

await db.connect();
try {
  await db.query('begin');
  await db.query("set local lock_timeout='5s'; set local statement_timeout='180s'");
  // En producción esta columna llega por la migración 110, inmediatamente
  // anterior. El entorno compartido de pruebas aún no la tiene aplicada.
  await db.query('alter table public.users add column if not exists auth_user_id uuid');

  // Simula entradas creadas antes de que existiera la redacción.
  const legacyAuditId = (await db.query(`
    insert into public.audit_log(action,entity_type,entity_id,description)
    values('MODIFICACION',$1,991,'Prueba histórica de redacción')
    returning log_id
  `, [`audit-redaction-${marker}`])).rows[0].log_id;
  const legacyChangeId = (await db.query(`
    insert into public.change_log(audit_log_id,field_name,old_value,new_value)
    values($1,'password_hash','hash-anterior','hash-nuevo')
    returning change_id
  `, [legacyAuditId])).rows[0].change_id;
  const legacyDeletedId = (await db.query(`
    insert into public.deleted_records(
      original_table_name,original_record_id,record_data_json,audit_log_id
    ) values($1,991,$2,$3)
    returning deleted_id
  `, [
    `audit-redaction-${marker}`,
    JSON.stringify({name: 'Visible', auth_user_id: 'uuid-secreto', nested: {api_token: 'token-secreto'}}),
    legacyAuditId
  ])).rows[0].deleted_id;
  const invalidLegacyDeletedId = (await db.query(`
    insert into public.deleted_records(
      original_table_name,original_record_id,record_data_json,audit_log_id
    ) values($1,992,'password=texto-secreto-no-json',$2)
    returning deleted_id
  `, [`audit-redaction-invalid-${marker}`, legacyAuditId])).rows[0].deleted_id;
  const legacyEventId = (await db.query(`
    insert into public.event_log(event_type,source_component,description,details)
    values('TEST_REDACTION','db-test','Prueba histórica',$1::jsonb)
    returning event_id
  `, [JSON.stringify({status: 'visible', credentials: {password: 'secreto'}})])).rows[0].event_id;

  await db.query(migration);

  const legacyChange = (await db.query(`
    select old_value,new_value from public.change_log where change_id=$1
  `, [legacyChangeId])).rows[0];
  assert.deepEqual(legacyChange, {old_value: '[REDACTADO]', new_value: '[REDACTADO]'});
  const legacyDeleted = JSON.parse((await db.query(`
    select record_data_json from public.deleted_records where deleted_id=$1
  `, [legacyDeletedId])).rows[0].record_data_json);
  assert.equal(legacyDeleted.name, 'Visible');
  assert.equal(legacyDeleted.auth_user_id, '[REDACTADO]');
  assert.equal(legacyDeleted.nested.api_token, '[REDACTADO]');
  const invalidLegacyDeleted = (await db.query(`
    select record_data_json from public.deleted_records where deleted_id=$1
  `, [invalidLegacyDeletedId])).rows[0].record_data_json;
  assert.doesNotMatch(invalidLegacyDeleted, /texto-secreto-no-json/);
  assert.deepEqual(JSON.parse(invalidLegacyDeleted), {
    _reason: 'FORMATO_HISTORICO_INVALIDO',
    _snapshot: '[REDACTADO]'
  });
  const legacyEvent = (await db.query(`
    select details from public.event_log where event_id=$1
  `, [legacyEventId])).rows[0].details;
  assert.equal(legacyEvent.status, 'visible');
  assert.equal(legacyEvent.credentials, '[REDACTADO]');

  await db.query(`
    create table public.${probeTable}(
      id bigint primary key,
      password_hash text,
      auth_user_id uuid,
      profile jsonb,
      note text
    )
  `);
  await db.query(`
    insert into public.${probeTable}(id,password_hash,auth_user_id,profile,note)
    values(1,'hash-inicial','00000000-0000-0000-0000-000000000001',
      '{"api_token":"token-inicial","visible":"inicial"}'::jsonb,'nota inicial')
  `);
  await db.query(`
    update public.${probeTable}
    set password_hash='hash-final',
        auth_user_id='00000000-0000-0000-0000-000000000002',
        profile='{"api_token":"token-final","visible":"final"}'::jsonb,
        note='nota final'
    where id=1
  `);

  const changes = (await db.query(`
    select change.field_name,change.old_value,change.new_value
    from public.audit_log audit
    join public.change_log change on change.audit_log_id=audit.log_id
    where audit.entity_type=$1 and audit.action='MODIFICACION'
    order by change.change_id
  `, [probeTable])).rows;
  const byField = Object.fromEntries(changes.map(change => [change.field_name, change]));
  assert.equal(byField.password_hash.old_value, '[REDACTADO]');
  assert.equal(byField.password_hash.new_value, '[REDACTADO]');
  assert.equal(byField.auth_user_id.old_value, '[REDACTADO]');
  assert.equal(byField.auth_user_id.new_value, '[REDACTADO]');
  assert.equal(byField.note.old_value, 'nota inicial');
  assert.equal(byField.note.new_value, 'nota final');
  assert.equal(JSON.parse(byField.profile.old_value).api_token, '[REDACTADO]');
  assert.equal(JSON.parse(byField.profile.new_value).api_token, '[REDACTADO]');
  assert.equal(JSON.parse(byField.profile.new_value).visible, 'final');

  await db.query(`delete from public.${probeTable} where id=1`);
  const deleted = JSON.parse((await db.query(`
    select record_data_json
    from public.deleted_records
    where original_table_name=$1
    order by deleted_id desc
    limit 1
  `, [probeTable])).rows[0].record_data_json);
  assert.equal(deleted.password_hash, '[REDACTADO]');
  assert.equal(deleted.auth_user_id, '[REDACTADO]');
  assert.equal(deleted.profile.api_token, '[REDACTADO]');
  assert.equal(deleted.profile.visible, 'final');
  assert.equal(deleted.note, 'nota final');

  const eventId = (await db.query(`
    select public.record_system_event(
      'TEST_REDACTION','db-test','Prueba futura','EXITOSA',$1::jsonb
    ) event_id
  `, [JSON.stringify({result: 'visible', resetToken: 'secreto', nested: {private_key: 'secreto'}})])).rows[0].event_id;
  const eventDetails = (await db.query(`
    select details from public.event_log where event_id=$1
  `, [eventId])).rows[0].details;
  assert.equal(eventDetails.result, 'visible');
  assert.equal(eventDetails.resetToken, '[REDACTADO]');
  assert.equal(eventDetails.nested.private_key, '[REDACTADO]');

  const privileges = (await db.query(`
    select
      has_function_privilege('authenticated','public.audit_field_is_sensitive(text)','execute') field_check,
      has_function_privilege('authenticated','public.audit_redact_jsonb(jsonb)','execute') json_redaction
  `)).rows[0];
  assert.deepEqual(privileges, {field_check: false, json_redaction: false});

  console.log(JSON.stringify({
    historicalValuesRedacted: true,
    futureChangesRedacted: true,
    deletedSnapshotsRedacted: true,
    eventDetailsRedacted: true,
    nonSensitiveValuesPreserved: true,
    rollback: true
  }));
} finally {
  await db.query('rollback').catch(() => {});
  await db.end();
}
