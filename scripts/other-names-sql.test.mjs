import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { setupOtherNames } from './fixtures/setup-other-names.mjs';

const db = new PGlite();
let originalAuditMetadata;
before(async () => { ({ originalAuditMetadata } = await setupOtherNames(db)); });
after(() => db.close());
const row = async (sql, params = []) => (await db.query(sql, params)).rows[0];
const value = async (sql, params = []) => (await row(sql, params))?.result;
const list = () => value('select public.other_name_list() as result');
const options = () => value('select public.other_name_options() as result');
const save = (input, id = null) => value('select public.save_other_name($1,$2) as result', [input, id]);
const remove = entry => value('select public.delete_other_name($1,$2) as result', [entry.other_name_id, entry._revision]);
const input = (extra = {}) => ({ name: 'Synthetic Third Party', identification: '1-234-567890', subsidiary_id: 1, ...extra });

async function assume(user = 1, role = 2, subsidiary = 1) {
  await db.exec('reset role');
  await db.query(`select set_config('request.jwt.claims',$1,true)`, [JSON.stringify({
    sub: `00000000-0000-4000-8000-${String(user).padStart(12, '0')}`, session_id: 'fixture',
  })]);
  await db.query(`insert into user_role_sessions values('fixture',$1,$2)
    on conflict(session_id)do update set user_id=$1,role_id=$2`, [user, role]);
  await db.query(`insert into user_company_sessions values('fixture',$1,$2)
    on conflict(session_id)do update set user_id=$1,subsidiary_id=$2`, [user, subsidiary]);
  await db.exec('set local role authenticated');
}
async function transaction(t) {
  await db.exec('reset role; begin');
  t.after(() => db.exec('reset role; rollback'));
}
async function denied(operation, expectedCode = '42501') {
  await db.exec('savepoint expected_denial');
  try { await assert.rejects(operation, error => error.code === expectedCode); }
  finally { await db.exec('rollback to expected_denial; release expected_denial'); }
}

test('CRUD atomico genera numero por filial, conserva cuenta con ceros y registra autoria y cambios', async t => {
  await transaction(t); await assume();
  const created = await save(input({ payment_bank_id: 1, payment_beneficiary_name: 'Beneficiary',
    payment_account_number: '0000123400', comments: 'Synthetic notes', email: 'contact@example.invalid' }));
  assert.equal(created.other_name_number, 'ON-000001');
  assert.equal(created.payment_account_number, '0000123400');
  assert.equal(created.created_by_email, 'manager@example.invalid');
  assert.equal(created.actor_type, 'HUMAN');
  assert.ok(created._actions.canEdit && created._actions.canDelete);
  const second = await save(input({ identification: 'second' }));
  assert.equal(second.other_name_number, 'ON-000002');
  const updated = await save({ comments: 'Updated notes', _revision: created._revision }, created.other_name_id);
  assert.equal(updated.other_name_number, created.other_name_number);
  assert.equal(updated.created_by_email, created.created_by_email);
  assert.equal(updated.updated_by_email, 'manager@example.invalid');
  assert.notEqual(updated._revision, created._revision);
  assert.equal(await remove(updated), true);
  await db.exec('reset role');
  assert.equal((await row("select count(*)::integer n from audit_log where entity_type='other_names'")).n, 4);
  assert.ok((await row("select count(*)::integer n from change_log where field_name='comments'")).n > 0);
  assert.equal((await row("select count(*)::integer n from deleted_records where original_table_name='other_names'")).n, 1);
});

test('identificacion normalizada es unica en una filial y se permite en otra con contador separado', async t => {
  await transaction(t); await assume();
  await save(input());
  for (const identification of ['1234567890', ' 1.234/567_890 ', '1 234 567890'])
    await denied(() => save(input({ identification })), '23505');
  await assume(1, 2, 2);
  const foreign = await save(input({ subsidiary_id: 2 }));
  assert.equal(foreign.other_name_number, 'ON-000001');
  assert.equal((await list()).length, 1);
  await assume();
  assert.equal((await list()).length, 1);
  const second = await save(input({ identification: 'different' }));
  assert.equal(second.other_name_number, 'ON-000002');
});

test('numero e identificadores generados no se aceptan y filial del tercero es inmutable', async t => {
  await transaction(t); await assume();
  for (const forged of [{ other_name_number: 'FORGED' }, { other_name_id: 10 }, { created_by_email: 'forged@example.invalid' }, { created_at: '2000-01-01' }])
    await denied(() => save(input(forged)), '22023');
  const created = await save(input());
  await denied(() => save({ other_name_number: 'FORGED', _revision: created._revision }, created.other_name_id), '22023');
  await denied(() => save({ subsidiary_id: 2, _revision: created._revision }, created.other_name_id));
  await denied(() => save(input({ subsidiary_id: 2, identification: 'FOREIGN' })));
  await assume(1, 2, 2);
  await denied(() => save({ subsidiary_id: 2, _revision: created._revision }, created.other_name_id));
  await denied(() => remove(created));
  assert.deepEqual(await list(), []);
  assert.equal((await db.query('select * from other_names')).rows.length, 0);
});

test('lector, admin sin concesion, contexto revocado e invitado no escriben ni escalan permisos', async t => {
  await transaction(t); await assume();
  const created = await save(input());
  await assume(1, 3);
  const access = await options();
  assert.equal(access.canView, true);
  assert.equal(access.canCreate, false);
  assert.equal((await list())[0]._actions.canEdit, false);
  await denied(() => save(input({ identification: 'reader' })));
  await denied(() => save({ name: 'Forged', _revision: created._revision }, created.other_name_id));
  await denied(() => remove(created));
  for (const role of [4, 5]) {
    await assume(1, role);
    await denied(list); await denied(options); await denied(() => save(input()));
    assert.equal((await db.query('select * from other_names')).rows.length, 0);
  }
  await assume();
  await db.exec('reset role; delete from user_subsidiaries where user_id=1 and subsidiary_id=1; set local role authenticated');
  await denied(list);
  await db.exec('reset role; set local role anon');
  await denied(list); await denied(options); await denied(() => save(input()));
  await denied(() => db.query('select * from other_names'));
});

test('RPC invoker y privados cierran DML directo, counters, DTO y truncate, incluso para service_role', async t => {
  await transaction(t); await assume();
  await save(input());
  for (const sql of ['insert into other_names(subsidiary_id,other_name_number,name,identification)values(1,\'x\',\'x\',\'x\')',
    'update other_names set name=\'Forged\'', 'delete from other_names', 'truncate other_names',
    'select * from other_name_private.number_counters', 'select other_name_private.allowed(\'create\')',
    'select other_name_private.dto(n) from other_names n']) await denied(() => db.query(sql));
  await db.exec('reset role');
  const routines = (await db.query(`select proname,prosecdef from pg_proc
    where oid in('public.other_name_list()'::regprocedure,'public.other_name_options()'::regprocedure,
      'public.save_other_name(jsonb,bigint)'::regprocedure,'public.delete_other_name(bigint,text)'::regprocedure)`)).rows;
  assert.equal(routines.length, 4); assert.ok(routines.every(r => !r.prosecdef));
  assert.deepEqual((await db.query("select role_id from role_access_matrix where resource_key='entities:other-names' order by role_id")).rows.map(r => r.role_id), [1, 2, 3]);
  for (const role of ['anon', 'service_role']) {
    await db.exec(`set local role ${role}`);
    await denied(() => db.query('select * from other_names'));
    await denied(list);
    await db.exec('reset role');
  }
});

test('IBAN valida checksum internacional y cuentas requieren banco sin perder ceros', async t => {
  await transaction(t); await assume();
  const created = await save(input({ payment_iban: ' gb82 west 1234 5698 7654 32 ', payment_bank_id: '1' }));
  assert.equal(created.payment_iban, 'GB82WEST12345698765432');
  const changed = await save({ payment_iban: null, payment_account_number: '001-0000023', _revision: created._revision }, created.other_name_id);
  assert.equal(changed.payment_account_number, '001-0000023');
  for (const invalid of [{ payment_iban: 'GB00WEST12345698765432', payment_bank_id: 1 },
    { payment_iban: 'CR00000000000000000000', payment_bank_id: 1 }, { payment_iban: 'BAD' },
    { payment_account_number: '0012' }, { payment_iban: 'GB82WEST12345698765432' },
    { payment_account_number: 123, payment_bank_id: 1 }]) await denied(() => save(input(invalid)), '22023');
  await denied(() => save(input({ payment_bank_id: 999 })), '42501');
  assert.equal((await list()).length, 1);
});

test('revision obsoleta y borrado preservan numero; contador no se reutiliza', async t => {
  await transaction(t); await assume();
  const created = await save(input());
  const changed = await save({ name: 'Changed', _revision: created._revision }, created.other_name_id);
  await denied(() => save({ name: 'Stale', _revision: created._revision }, created.other_name_id), '55000');
  await denied(() => remove(created), '55000');
  await denied(() => save({ name: 'No revision' }, created.other_name_id), '55000');
  assert.equal(await remove(changed), true);
  const next = await save(input());
  assert.equal(next.other_name_number, 'ON-000002');
});

test('contador supera seis digitos sin truncar y subsidiaria omitida se deriva del contexto', async t => {
  await transaction(t); await assume();
  await db.exec(`reset role; insert into other_name_private.number_counters values(1,999999); set local role authenticated`);
  const created = await save({ name: 'Synthetic rollover', identification: 'ROLLOVER' });
  assert.equal(created.other_name_number, 'ON-1000000');
  assert.equal(created.subsidiary_id, 1);
  const changed = await save({ comments: 'Keep current subsidiary', _revision: created._revision }, created.other_name_id);
  assert.equal(changed.subsidiary_id, 1);
  await db.exec('reset role');
  const triggers = (await db.query(`select tgname from pg_trigger where tgrelid='public.other_names'::regclass and not tgisinternal order by tgname`)).rows.map(r => r.tgname);
  assert.deepEqual(triggers, ['actor_no_truncate', 'central_row_audit', 'zzzz_actor_stamp']);
});

test('opciones muestran solo filial activa y metadata bancaria minima; usuarios y filiales inactivos se deniegan', async t => {
  await transaction(t); await assume();
  const references = (await options()).references;
  assert.deepEqual(references['organization/subsidiaries'], [{ subsidiary_id: 1, name: 'Synthetic A' }]);
  assert.deepEqual(Object.keys(references['banking/banks'][0]).sort(), ['bank_code', 'bank_id', 'bank_name', 'country_id']);
  await assume(1, 2, 3); await denied(list); await denied(() => save(input({ subsidiary_id: 3 })));
  await assume(); await db.exec('reset role; update users set is_active=false where user_id=1; set local role authenticated');
  await denied(list);
});

test('campos obligatorios, tipos, email, limites y fallos posteriores revierten toda la operacion', async t => {
  await transaction(t); await assume();
  for (const invalid of [{ name: ' ' }, { name: 'x'.repeat(251) }, { identification: ' /-_.' }, { identification: 'x'.repeat(81) },
    { email: 'bad@' }, { email: 'x'.repeat(255) }, { phone: 'x'.repeat(81) }, { comments: 'x'.repeat(8001) },
    { payment_account_number: 'x'.repeat(81), payment_bank_id: 1 }, { payment_beneficiary_name: 'x'.repeat(251) },
    { is_active: 'false' }, { name: [] }, { subsidiary_id: '1.0' }, { payment_bank_id: -1 }])
    await denied(() => save(input(invalid)), '22023');
  await db.exec(`reset role; create function fixture_other_names_fail()returns trigger language plpgsql as $$begin
    raise exception using errcode='55000',message='Synthetic audit/write failure';end$$;
    create trigger zz_fixture_failure after insert on other_names for each row execute function fixture_other_names_fail();
    set local role authenticated`);
  await denied(() => save(input()), '55000');
  await db.exec('reset role; drop trigger zz_fixture_failure on other_names; set local role authenticated');
  assert.deepEqual(await list(), []);
  const created = await save(input());
  assert.equal(created.other_name_number, 'ON-000001');
  await db.exec('reset role');
  assert.equal((await row("select count(*)::integer n from audit_log where entity_type='other_names'")).n, 1);
});

test('auditoria clasifica Otros Nombres en Entidades y conserva todos los casos existentes', async t => {
  await transaction(t);
  assert.deepEqual(await value("select public.audit_change_entity_meta('other_names','public') as result"), {
    moduleCode: 'entities', moduleLabel: 'Entidades', entityLabel: 'Otros Nombres',
  });
  for (const { sample, metadata } of originalAuditMetadata)
    assert.deepEqual(await value("select public.audit_change_entity_meta($1,'public') as result", [sample]), metadata, sample);
  const attributes = await row(`select provolatile,proparallel,prosecdef,proconfig from pg_proc
    where oid='public.audit_change_entity_meta(text,text)'::regprocedure`);
  assert.equal(attributes.provolatile, 'i');
  assert.equal(attributes.proparallel, 's');
  assert.equal(attributes.prosecdef, false);
  assert.deepEqual(attributes.proconfig, ['search_path=pg_catalog']);
});
