import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import pg from 'pg';

process.loadEnvFile?.('.env');

const projectRef=new URL(process.env.SUPABASE_URL).hostname.split('.')[0];
const db=new pg.Client({
  host:process.env.SUPABASE_DB_HOST||'aws-0-us-east-1.pooler.supabase.com',
  port:Number(process.env.SUPABASE_DB_PORT||6543),
  database:process.env.SUPABASE_DB_NAME||'postgres',
  user:process.env.SUPABASE_DB_USER||`postgres.${projectRef}`,
  password:process.env.SUPABASE_DB_PASSWORD||process.env.PGPASSWORD,
  ssl:{rejectUnauthorized:false},
  connectionTimeoutMillis:15_000
});

const migration=await readFile(
  new URL(
    '../supabase/migrations/20261026120000_sales_invoice_number_sequence_integrity.sql',
    import.meta.url
  ),
  'utf8'
);

const one=async(statement,parameters=[])=>
  (await db.query(statement,parameters)).rows[0];
const scalar=async(statement,parameters=[])=>
  (await one(statement,parameters))?.value;
const numericSuffix=value=>{
  const match=/^FAC-(\d{8,})$/.exec(String(value??''));
  assert.ok(match,`Número de factura no canónico: ${value}`);
  return BigInt(match[1]);
};

let transactionOpen=false;
await db.connect();
try{
  await db.query('begin');
  transactionOpen=true;
  await db.query("set local lock_timeout='15s'; set local statement_timeout='120s'");

  const correctionBefore=await one(`
    select invoice.invoice_id,invoice.invoice_number,
      transaction_row.tran_number,journal.journal_number
    from public.invoice invoice
    left join public."transaction" transaction_row
      on transaction_row.transaction_id=invoice.transaction_id
    left join public.journal journal on journal.journal_id=invoice.journal_id
    where invoice.invoice_id=674
  `);
  const sequenceSnapshot=(await db.query(`
    select sequence.sequence_id,sequence.transaction_type_id,
      sequence.subsidiary_id,sequence.prefix,sequence.suffix,
      sequence.current_number,sequence.padding_length
    from public.number_sequences sequence
    join public.transaction_types transaction_type
      on transaction_type.transaction_type_id=sequence.transaction_type_id
    where sequence.scope_type='Transacción'
      and transaction_type.abbreviation='FAC_VEN'
    order by sequence.subsidiary_id
  `)).rows;

  // Reaplicar dentro de la misma transacción valida idempotencia. El finally
  // revierte tanto la migración como todos los consecutivos consumidos aquí.
  await db.query(migration);
  await db.query(migration);

  const contract=await one(`
    select
      to_regprocedure(
        'public.ensure_sales_invoice_number_sequence(bigint)'
      ) is not null helper_exists,
      to_regprocedure(
        'public.save_sales_invoice_before_number_integrity(jsonb,bigint)'
      ) is not null predecessor_exists,
      pg_get_functiondef(
        'public.save_sales_invoice(jsonb,bigint)'::regprocedure
      ) wrapper_definition,
      not has_function_privilege(
        'public','public.ensure_sales_invoice_number_sequence(bigint)','execute'
      ) helper_public_denied,
      not has_function_privilege(
        'anon','public.ensure_sales_invoice_number_sequence(bigint)','execute'
      ) helper_anon_denied,
      not has_function_privilege(
        'authenticated',
        'public.ensure_sales_invoice_number_sequence(bigint)','execute'
      ) helper_authenticated_denied,
      not has_function_privilege(
        'authenticated',
        'public.save_sales_invoice_before_number_integrity(jsonb,bigint)',
        'execute'
      ) predecessor_authenticated_denied,
      has_function_privilege(
        'authenticated','public.save_sales_invoice(jsonb,bigint)','execute'
      ) wrapper_authenticated_allowed,
      not has_function_privilege(
        'anon','public.save_sales_invoice(jsonb,bigint)','execute'
      ) wrapper_anon_denied
  `);
  assert.equal(contract.helper_exists,true,'Falta el helper de secuencia FAC-.');
  assert.equal(contract.predecessor_exists,true,'Falta preservar la cadena anterior de guardado.');
  for(const key of [
    'helper_public_denied','helper_anon_denied','helper_authenticated_denied',
    'predecessor_authenticated_denied','wrapper_authenticated_allowed',
    'wrapper_anon_denied'
  ])assert.equal(contract[key],true,`Contrato de privilegios inválido: ${key}`);

  const wrapper=String(contract.wrapper_definition||'');
  const normalizedWrapper=wrapper.toLowerCase();
  const editBranch=normalizedWrapper.indexOf('if target_invoice_id is not null then');
  const ensureCall=normalizedWrapper.indexOf(
    'perform public.ensure_sales_invoice_number_sequence(sid)'
  );
  assert.ok(editBranch>=0,'El wrapper no distingue edición de creación.');
  assert.ok(ensureCall>editBranch,'La edición debe retornar antes de asegurar o consumir la secuencia.');
  assert.match(
    normalizedWrapper.slice(editBranch,ensureCall),
    /return public\.save_sales_invoice_before_number_integrity\s*\(/
  );
  assert.match(wrapper,/automatic_number\s+boolean/i);
  assert.match(wrapper,/generated_number\s+text/i);
  assert.match(
    wrapper,
    /automatic_number\s*:=\s*coalesce\s*\(\s*btrim\s*\(\s*effective_payload\s*->>\s*'invoice_number'\s*\)\s*,\s*''\s*\)\s*=\s*''[\s\S]*upper\s*\(\s*btrim\s*\(\s*effective_payload\s*->>\s*'invoice_number'\s*\)\s*\)\s*=\s*'AUTO'/i
  );
  assert.match(
    wrapper,
    /if\s+automatic_number\s+then[\s\S]*jsonb_build_object\s*\(\s*'invoice_number'\s*,\s*'AUTO'\s*\)[\s\S]*end if;/i
  );
  assert.match(wrapper,/generated_number\s*:=\s*coalesce\s*\(\s*result\s*->>\s*'transactionNumber'/i);
  assert.match(wrapper,/transaction_number_value\s*<>\s*generated_number/i);
  assert.match(wrapper,/journal_number_value\s*<>\s*generated_number/i);
  assert.match(
    wrapper,
    /if\s+automatic_number[\s\S]*invoice_number_value\s*<>\s*generated_number\s+then/i
  );
  assert.doesNotMatch(
    wrapper,
    /transaction_number_value\s*<>\s*invoice_number_value/i,
    'Una factura con número comercial manual no debe reemplazar el consecutivo contable.'
  );
  assert.match(wrapper,/\^FAC_VEN-\[0-9\]\{17\}\$/);
  assert.doesNotMatch(wrapper,/clock_timestamp\s*\(/i,'El wrapper no debe fabricar números por fecha.');

  const backfill=(await db.query(`
    with sales_type as(
      select transaction_type_id
      from public.transaction_types
      where abbreviation='FAC_VEN'
      order by transaction_type_id
      limit 1
    )
    select subsidiary.subsidiary_id,sequence.sequence_id,
      sequence.prefix,sequence.suffix,sequence.current_number,
      sequence.padding_length
    from public.subsidiaries subsidiary
    cross join sales_type
    left join public.number_sequences sequence
      on sequence.scope_type='Transacción'
     and sequence.transaction_type_id=sales_type.transaction_type_id
     and sequence.subsidiary_id=subsidiary.subsidiary_id
    order by subsidiary.subsidiary_id
  `)).rows;
  assert.ok(backfill.length>0,'Se requiere al menos una subsidiaria.');
  assert.ok(backfill.every(row=>row.sequence_id),'No se cubrieron todas las subsidiarias.');

  const beforeBySubsidiary=new Map(
    sequenceSnapshot.map(row=>[String(row.subsidiary_id),row])
  );
  for(const after of backfill){
    const before=beforeBySubsidiary.get(String(after.subsidiary_id));
    if(before){
      assert.equal(after.prefix,before.prefix,'La migración cambió un prefijo configurado.');
      assert.equal(after.suffix,before.suffix,'La migración cambió un sufijo configurado.');
      assert.equal(
        after.padding_length,before.padding_length,
        'La migración cambió la longitud de una serie existente.'
      );
      assert.ok(
        BigInt(after.current_number)>=BigInt(before.current_number),
        'La migración redujo un consecutivo existente.'
      );
    }else{
      assert.equal(after.prefix,'FAC-','Una serie FAC_VEN faltante debe nacer con prefijo FAC-.');
      assert.equal(after.suffix,null);
      assert.equal(after.padding_length,8);
    }
  }

  const lagging=await db.query(`
    with sales_type as(
      select transaction_type_id
      from public.transaction_types
      where abbreviation='FAC_VEN'
      order by transaction_type_id
      limit 1
    ),canonical as(
      select source.subsidiary_id,max(source.number_value) canonical_max
      from(
        select invoice.subsidiary_id,
          substring(invoice.invoice_number from '^FAC-([0-9]+)$')::bigint number_value
        from public.invoice invoice where invoice.invoice_number~'^FAC-[0-9]+$'
        union all
        select transaction_row.subsidiary_id,
          substring(transaction_row.tran_number from '^FAC-([0-9]+)$')::bigint
        from public."transaction" transaction_row
        where transaction_row.tran_number~'^FAC-[0-9]+$'
        union all
        select journal.subsidiary_id,
          substring(journal.journal_number from '^FAC-([0-9]+)$')::bigint
        from public.journal journal where journal.journal_number~'^FAC-[0-9]+$'
      )source
      group by source.subsidiary_id
    )
    select sequence.subsidiary_id,sequence.current_number,canonical.canonical_max
    from public.number_sequences sequence
    cross join sales_type
    join canonical using(subsidiary_id)
    where sequence.scope_type='Transacción'
      and sequence.transaction_type_id=sales_type.transaction_type_id
      and sequence.prefix='FAC-' and sequence.suffix is null
      and sequence.current_number<canonical.canonical_max
  `);
  assert.deepEqual(lagging.rows,[],'Una secuencia quedó por debajo de sus documentos históricos.');

  // Simula una subsidiaria creada después del seed inicial: se elimina solo
  // su fila de secuencia, se llama al helper y se comprueba su reconstrucción.
  const candidate=await one(`
    with sales_type as(
      select transaction_type_id
      from public.transaction_types
      where abbreviation='FAC_VEN'
      order by transaction_type_id
      limit 1
    ),canonical as(
      select subsidiary.subsidiary_id,greatest(
        coalesce((select max(substring(invoice.invoice_number from '^FAC-([0-9]+)$')::bigint)
          from public.invoice invoice
          where invoice.subsidiary_id=subsidiary.subsidiary_id
            and invoice.invoice_number~'^FAC-[0-9]+$'),0),
        coalesce((select max(substring(transaction_row.tran_number from '^FAC-([0-9]+)$')::bigint)
          from public."transaction" transaction_row
          where transaction_row.subsidiary_id=subsidiary.subsidiary_id
            and transaction_row.tran_number~'^FAC-[0-9]+$'),0),
        coalesce((select max(substring(journal.journal_number from '^FAC-([0-9]+)$')::bigint)
          from public.journal journal
          where journal.subsidiary_id=subsidiary.subsidiary_id
            and journal.journal_number~'^FAC-[0-9]+$'),0)
      ) canonical_max
      from public.subsidiaries subsidiary
    )
    select canonical.subsidiary_id,canonical.canonical_max,
      sales_type.transaction_type_id
    from canonical cross join sales_type
    order by canonical.canonical_max desc,canonical.subsidiary_id
    limit 1
  `);
  assert.ok(candidate,'Se requiere al menos una subsidiaria para probar la secuencia.');
  await db.query(`
    delete from public.number_sequences
    where scope_type='Transacción' and transaction_type_id=$1 and subsidiary_id=$2
  `,[candidate.transaction_type_id,candidate.subsidiary_id]);
  assert.equal(await scalar(`
    select count(*)::int value from public.number_sequences
    where scope_type='Transacción' and transaction_type_id=$1 and subsidiary_id=$2
  `,[candidate.transaction_type_id,candidate.subsidiary_id]),0);

  await db.query(
    'select public.ensure_sales_invoice_number_sequence($1)',
    [candidate.subsidiary_id]
  );
  const rebuilt=await one(`
    select prefix,suffix,current_number,padding_length
    from public.number_sequences
    where scope_type='Transacción' and transaction_type_id=$1 and subsidiary_id=$2
  `,[candidate.transaction_type_id,candidate.subsidiary_id]);
  assert.deepEqual(
    {prefix:rebuilt.prefix,suffix:rebuilt.suffix,padding:rebuilt.padding_length},
    {prefix:'FAC-',suffix:null,padding:8}
  );
  assert.equal(BigInt(rebuilt.current_number),BigInt(candidate.canonical_max));

  const globalMaximum=BigInt(await scalar(`
    select greatest(
      coalesce((select max(substring(invoice_number from '^FAC-([0-9]+)$')::bigint)
        from public.invoice where invoice_number~'^FAC-[0-9]+$'),0),
      coalesce((select max(substring(tran_number from '^FAC-([0-9]+)$')::bigint)
        from public."transaction" where tran_number~'^FAC-[0-9]+$'),0),
      coalesce((select max(substring(journal_number from '^FAC-([0-9]+)$')::bigint)
        from public.journal where journal_number~'^FAC-[0-9]+$'),0)
    ) value
  `));
  const highWater=globalMaximum+1000n;
  await db.query(`
    update public.number_sequences set current_number=$3
    where scope_type='Transacción' and transaction_type_id=$1 and subsidiary_id=$2
  `,[candidate.transaction_type_id,candidate.subsidiary_id,highWater.toString()]);
  const first=await scalar(
    'select public.next_transaction_number($1,$2) value',
    [candidate.transaction_type_id,candidate.subsidiary_id]
  );
  const second=await scalar(
    'select public.next_transaction_number($1,$2) value',
    [candidate.transaction_type_id,candidate.subsidiary_id]
  );
  assert.equal(numericSuffix(first),highWater+1n);
  assert.equal(numericSuffix(second),highWater+2n);

  const correctionAfter=await one(`
    select invoice.invoice_id,invoice.invoice_number,
      transaction_row.tran_number,journal.journal_number,
      count(*)filter(where line.note='Cuenta por cobrar · AUTO')::int auto_notes
    from public.invoice invoice
    left join public."transaction" transaction_row
      on transaction_row.transaction_id=invoice.transaction_id
    left join public.journal journal on journal.journal_id=invoice.journal_id
    left join public.journal_line line on line.journal_id=invoice.journal_id
    where invoice.invoice_id=674
    group by invoice.invoice_id,invoice.invoice_number,
      transaction_row.tran_number,journal.journal_number
  `);
  if(correctionBefore&&[
    'FAC_VEN-20261026181826700','FAC-00000669'
  ].includes(correctionBefore.invoice_number)){
    assert.ok(correctionAfter,'La factura corregida debe continuar existiendo.');
    assert.equal(correctionAfter.invoice_number,'FAC-00000669');
    assert.equal(correctionAfter.tran_number,correctionAfter.invoice_number);
    assert.equal(correctionAfter.journal_number,correctionAfter.invoice_number);
    assert.equal(correctionAfter.auto_notes,0);
  }

  console.log(JSON.stringify({
    migrationIdempotent:true,
    missingSequenceRecovered:true,
    canonicalNumbers:[first,second],
    editPathDoesNotEnsureSequence:true,
    linkedNumberIntegrity:correctionAfter?true:'not-applicable',
    correctedInvoiceNumber:correctionAfter?.invoice_number??null,
    correctedTransactionNumber:correctionAfter?.tran_number??null,
    correctedJournalNumber:correctionAfter?.journal_number??null,
    sttSequence:backfill.find(row=>String(row.subsidiary_id)==='24')??null,
    rolledBack:true
  }));
}finally{
  if(transactionOpen)await db.query('rollback').catch(()=>{});
  await db.end();
}
