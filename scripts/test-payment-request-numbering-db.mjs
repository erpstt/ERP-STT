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

const migrationBody = source => source
  .replace(/^\uFEFF?\s*begin\s*;\s*/i, '')
  .replace(
    /\s*commit\s*;\s*notify\s+pgrst\s*,\s*'reload schema'\s*;\s*$/i,
    ''
  );
const one = async (statement, parameters = []) =>
  (await db.query(statement, parameters)).rows[0];
const nextNumber = async (typeId, subsidiaryId) =>
  (await one(
    'select public.next_transaction_number($1,$2) value',
    [typeId, subsidiaryId]
  )).value;
const suffix = value => BigInt(/^SOL_PAG-(\d{8,})$/.exec(value)?.[1] || '-1');

let transactionOpen = false;
await db.connect();
try {
  await db.query('begin');
  transactionOpen = true;
  await db.query("set local lock_timeout='15s';set local statement_timeout='120s'");

  const immutableBefore = (await db.query(`
    select id,numero from public.solicitudes_pago
    where estado<>'BORRADOR'
    order by id
  `)).rows;
  const fallbackDrafts = (await db.query(`
    select id,numero from public.solicitudes_pago
    where estado='BORRADOR' and numero~'^SOL_PAG-[0-9]{17}$'
    order by id
  `)).rows;
  const migration = await readFile(new URL(
    '../supabase/migrations/20261027140000_payment_request_number_sequence.sql',
    import.meta.url
  ), 'utf8');
  await db.query(migrationBody(migration));

  const coverage = await one(`
    select
      (select count(*)::int from public.subsidiaries) subsidiaries,
      count(sequence.sequence_id)::int sequences
    from public.subsidiaries subsidiary
    cross join public.transaction_types transaction_type
    left join public.number_sequences sequence
      on sequence.scope_type='Transacción'
     and sequence.transaction_type_id=transaction_type.transaction_type_id
     and sequence.subsidiary_id=subsidiary.subsidiary_id
    where transaction_type.abbreviation='SOL_PAG'
  `);
  assert.equal(coverage.sequences, coverage.subsidiaries,
    'No se creó SOL_PAG para todas las subsidiarias.');

  const remainingFallbackDrafts = await one(`
    select count(*)::int value
    from public.solicitudes_pago
    where estado='BORRADOR' and numero~'^SOL_PAG-[0-9]{17}$'
  `);
  assert.equal(remainingFallbackDrafts.value, 0,
    'Quedaron borradores con numeración por timestamp.');
  for (const draft of fallbackDrafts) {
    const corrected = await one(`
      select request.numero,event.accion,event.nota
      from public.solicitudes_pago request
      join lateral(
        select accion,nota
        from public.solicitudes_pago_eventos
        where id_solicitud=request.id and accion='NUMERACION_CORREGIDA'
        order by id desc limit 1
      )event on true
      where request.id=$1
    `,[draft.id]);
    assert.match(corrected.numero, /^SOL_PAG-\d{8,}$/);
    assert.match(corrected.nota, new RegExp(draft.numero));
  }

  const immutableAfter = (await db.query(`
    select id,numero from public.solicitudes_pago
    where estado<>'BORRADOR'
    order by id
  `)).rows;
  assert.deepEqual(immutableAfter, immutableBefore,
    'Se renumeró una solicitud aprobada, aplicada, rechazada o anulada.');

  const transactionType = await one(`
    select transaction_type_id
    from public.transaction_types
    where abbreviation='SOL_PAG'
  `);
  const subsidiaries = (await db.query(`
    select subsidiary_id,currency_id
    from public.subsidiaries
    where currency_id is not null
    order by subsidiary_id
    limit 2
  `)).rows;
  assert.equal(subsidiaries.length, 2,
    'Se necesitan dos subsidiarias para validar unicidad global.');

  const actor = await one(`
    select user_id,email,auth_user_id::text auth_user_id
    from public.users
    where is_active
    order by user_id
    limit 1
  `);
  assert.ok(actor?.user_id, 'No existe un usuario activo para la prueba.');
  await db.query(
    "select set_config('request.jwt.claims',$1,true)",
    [JSON.stringify({ sub: actor.auth_user_id, email: actor.email })]
  );

  const first = await nextNumber(
    transactionType.transaction_type_id,
    subsidiaries[0].subsidiary_id
  );
  assert.match(first, /^SOL_PAG-\d{8,}$/,
    'El primer número no tiene el formato canónico.');

  await db.query(`
    insert into public.solicitudes_pago(
      numero,id_subsidiaria,id_moneda,tipo_solicitud,
      fecha_pago_programada,id_solicitante,concepto,total
    )values($1,$2,$3,'OTROS',current_date,$4,'Prueba transaccional',1)
  `,[
    first,subsidiaries[0].subsidiary_id,subsidiaries[0].currency_id,
    actor.user_id
  ]);

  const second = await nextNumber(
    transactionType.transaction_type_id,
    subsidiaries[1].subsidiary_id
  );
  assert.match(second, /^SOL_PAG-\d{8,}$/,
    'El segundo número no tiene el formato canónico.');
  assert.equal(suffix(second), suffix(first) + 1n,
    'El consecutivo no evitó una colisión entre subsidiarias.');

  await db.query(`
    insert into public.solicitudes_pago(
      numero,id_subsidiaria,id_moneda,tipo_solicitud,
      fecha_pago_programada,id_solicitante,concepto,total
    )values($1,$2,$3,'OTROS',current_date,$4,'Prueba transaccional',1)
  `,[
    second,subsidiaries[1].subsidiary_id,subsidiaries[1].currency_id,
    actor.user_id
  ]);

  // Simule una filial muy rezagada frente a un consecutivo global de nueve
  // digitos. La siguiente emision debe alinearse en una sola operacion, no
  // recorrer una colision por cada numero ya utilizado.
  const maximum = await one(`
    select coalesce(max(
      (regexp_match(numero,'^SOL_PAG-([0-9]+)$'))[1]::bigint
    ),0) value
    from public.solicitudes_pago
    where numero~'^SOL_PAG-[0-9]+$'
      and numero!~'^SOL_PAG-[0-9]{17}$'
  `);
  const highSuffix = BigInt(maximum.value) > 100000000n
    ? BigInt(maximum.value) + 5000n
    : 100000000n;
  const highNumber = `SOL_PAG-${highSuffix}`;
  await db.query(`
    insert into public.solicitudes_pago(
      numero,id_subsidiaria,id_moneda,tipo_solicitud,
      fecha_pago_programada,id_solicitante,concepto,total
    )values($1,$2,$3,'OTROS',current_date,$4,'Prueba de consecutivo amplio',1)
  `,[
    highNumber,subsidiaries[0].subsidiary_id,subsidiaries[0].currency_id,
    actor.user_id
  ]);
  await db.query(`
    update public.number_sequences set current_number=0
    where scope_type='Transacción'
      and transaction_type_id=$1
      and subsidiary_id=$2
  `,[transactionType.transaction_type_id,subsidiaries[1].subsidiary_id]);
  const realigned = await nextNumber(
    transactionType.transaction_type_id,
    subsidiaries[1].subsidiary_id
  );
  assert.equal(suffix(realigned), highSuffix + 1n,
    'La secuencia rezagada no se alineo con el maximo global.');
  await db.query(`
    insert into public.solicitudes_pago(
      numero,id_subsidiaria,id_moneda,tipo_solicitud,
      fecha_pago_programada,id_solicitante,concepto,total
    )values($1,$2,$3,'OTROS',current_date,$4,'Prueba de realineacion',1)
  `,[
    realigned,subsidiaries[1].subsidiary_id,subsidiaries[1].currency_id,
    actor.user_id
  ]);

  await db.query(`
    delete from public.number_sequences
    where scope_type='Transacción'
      and transaction_type_id=$1
      and subsidiary_id=$2
  `,[transactionType.transaction_type_id,subsidiaries[1].subsidiary_id]);
  const recreated = await nextNumber(
    transactionType.transaction_type_id,
    subsidiaries[1].subsidiary_id
  );
  assert.equal(suffix(recreated), suffix(realigned) + 1n,
    'No se auto-configuró la secuencia faltante de SOL_PAG.');

  console.log(JSON.stringify({
    passed: true,
    rollback: true,
    sequencesCreated: coverage.sequences,
    format: 'SOL_PAG-00000001',
    globalCollisionAvoided: true,
    laggingSequenceRealigned: true,
    supportsMoreThanEightDigits: true,
    missingSequenceRecreated: true,
    correctedDrafts: fallbackDrafts.length,
    immutableNumbersPreserved: immutableBefore.length
  }));
} finally {
  if (transactionOpen) await db.query('rollback');
  await db.end();
}
