import pg from 'pg';

process.loadEnvFile('.env');
const projectRef = new URL(process.env.SUPABASE_URL).hostname.split('.')[0];
const client = new pg.Client({
  host: process.env.SUPABASE_DB_HOST || 'aws-0-us-east-1.pooler.supabase.com',
  port: 6543,
  database: 'postgres',
  user: `postgres.${projectRef}`,
  password: process.env.SUPABASE_DB_PASSWORD,
  ssl: { rejectUnauthorized: false }
});

const entrypointSignatures = [
  'public.save_supplier_invoice(jsonb,bigint)',
  'public.save_supplier_note(text,jsonb,bigint)',
  'public.save_supplier_payment(jsonb,bigint)',
  'public.save_supplier_payment_with_advances(jsonb,bigint)'
];

const internalSignatures = [
  'public.budget_run(text,jsonb,bigint)',
  'public.save_supplier_invoice_without_budget(jsonb,bigint)',
  'public.save_supplier_invoice_without_budget_before_payable_routing(jsonb,bigint)',
  'public.save_supplier_invoice_without_withholding(jsonb,bigint)',
  'public.resolve_supplier_payable_account(bigint,bigint,text)',
  'public.ensure_supplier_invoice_payable_account(bigint)',
  'public.save_supplier_note_before_payable_routing(text,jsonb,bigint)',
  'public.save_supplier_payment_before_payable_routing(jsonb,bigint)',
  'public.save_supplier_payment_without_withholding(jsonb,bigint)',
  'public.save_supplier_payment_with_advances_before_payable_routing(jsonb,bigint)',
  'public.save_supplier_payment_with_advances_base(jsonb,bigint)',
  'public.apply_supplier_payment_payable_accounts(bigint,numeric)'
];

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function definitionIncludes(functions, signature, ...fragments) {
  const row = functions.get(signature);
  assert(row, `No existe la función requerida ${signature}.`);
  const definition = row.definition.toLowerCase();
  for (const fragment of fragments) {
    assert(
      definition.includes(fragment.toLowerCase()),
      `La función ${signature} no conserva el enlace esperado hacia ${fragment}.`
    );
  }
}

await client.connect();
try {
  const requiredColumns = {
    supplier_invoice: [
      'subtotal_amount',
      'tax_total',
      'withholding_total',
      'payable_amount'
    ],
    supplier_invoice_withholding: [
      'invoice_id',
      'entity_rule_id',
      'tax_code_id',
      'liability_account_id',
      'base_amount',
      'rate_percentage',
      'withholding_amount',
      'application_moment',
      'recognized_at_invoice'
    ],
    supplier_payment_withholding: [
      'payment_id',
      'invoice_id',
      'invoice_withholding_id',
      'tax_code_id',
      'liability_account_id',
      'base_applied',
      'withholding_amount'
    ]
  };

  const schema = await client.query(`
    select c.table_name, array_agg(c.column_name order by c.column_name) columns,
      coalesce(pc.relrowsecurity, false) rls_enabled
    from information_schema.columns c
    left join pg_class pc
      on pc.oid = to_regclass(format('%I.%I', c.table_schema, c.table_name))
    where c.table_schema = 'public'
      and c.table_name = any($1::text[])
    group by c.table_name, pc.relrowsecurity
  `, [Object.keys(requiredColumns)]);
  const schemaByTable = new Map(schema.rows.map(row => [row.table_name, row]));

  for (const [table, columns] of Object.entries(requiredColumns)) {
    const row = schemaByTable.get(table);
    assert(row, `No existe la tabla public.${table}.`);
    for (const column of columns) {
      assert(row.columns.includes(column), `Falta public.${table}.${column}.`);
    }
  }
  assert(
    schemaByTable.get('supplier_invoice_withholding').rls_enabled
      && schemaByTable.get('supplier_payment_withholding').rls_enabled,
    'Las tablas de retenciones de proveedor deben conservar RLS habilitado.'
  );

  const integrity = await client.query(`
    select
      (
        select count(*)::int
        from public.supplier_invoice_withholding w
        left join public.supplier_invoice invoice using(invoice_id)
        left join public.tax_codes code using(tax_code_id)
        left join public.tax_types tax_type using(tax_type_id)
        where invoice.invoice_id is null
          or code.tax_code_id is null
          or not coalesce(code.is_withholding, false)
          or tax_type.applies_to not in ('Compras', 'Ambos')
          or w.application_moment not in ('Al registrar la factura', 'Al aplicar el pago')
          or w.liability_account_id is distinct from tax_type.liability_account_id
          or w.withholding_amount < 0
          or w.recognized_at_invoice is distinct from
            (w.application_moment = 'Al registrar la factura')
      ) invalid_invoice_rows,
      (
        select count(*)::int
        from public.supplier_payment_withholding w
        left join public.supplier_payment payment using(payment_id)
        left join public.supplier_invoice invoice using(invoice_id)
        left join public.supplier_invoice_withholding source
          using(invoice_withholding_id)
        where payment.payment_id is null
          or invoice.invoice_id is null
          or source.invoice_withholding_id is null
          or source.invoice_id is distinct from w.invoice_id
          or source.tax_code_id is distinct from w.tax_code_id
          or source.liability_account_id is distinct from w.liability_account_id
          or source.application_moment <> 'Al aplicar el pago'
          or w.base_applied < 0
          or w.withholding_amount < 0
      ) invalid_payment_rows,
      (
        select count(*)::int
        from public.entity_withholding_rules rule
        join public.tax_codes code using(tax_code_id)
        join public.tax_types tax_type using(tax_type_id)
        where rule.supplier_id is not null
          and (
            not coalesce(code.is_withholding, false)
            or tax_type.applies_to not in ('Compras', 'Ambos')
            or tax_type.liability_account_id is null
            or not exists (
              select 1
              from public.tax_code_subsidiaries assignment
              where assignment.tax_code_id = rule.tax_code_id
                and assignment.subsidiary_id = rule.subsidiary_id
            )
          )
      ) invalid_supplier_rules
  `);
  const counts = integrity.rows[0];
  assert(counts.invalid_invoice_rows === 0, 'Hay retenciones de factura con configuración inconsistente.');
  assert(counts.invalid_payment_rows === 0, 'Hay retenciones de pago sin trazabilidad válida.');
  assert(counts.invalid_supplier_rules === 0, 'Hay reglas de retención de proveedor incompletas.');

  const signatures = [...entrypointSignatures, ...internalSignatures];
  const functionResult = await client.query(`
    select expected.signature,
      p.oid,
      pg_get_functiondef(p.oid) definition,
      p.prosecdef security_definer,
      has_function_privilege('authenticated', p.oid, 'EXECUTE') authenticated_execute,
      has_function_privilege('anon', p.oid, 'EXECUTE') anon_execute,
      exists (
        select 1
        from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) privilege
        where privilege.grantee = 0
          and privilege.privilege_type = 'EXECUTE'
      ) public_execute
    from unnest($1::text[]) expected(signature)
    left join pg_proc p on p.oid = to_regprocedure(expected.signature)
  `, [signatures]);
  const functions = new Map(
    functionResult.rows
      .filter(row => row.oid)
      .map(row => [row.signature, row])
  );

  for (const signature of entrypointSignatures) {
    const row = functions.get(signature);
    assert(row, `No existe el entrypoint ${signature}.`);
    assert(row.security_definer, `${signature} debe ejecutarse como SECURITY DEFINER.`);
    assert(row.authenticated_execute, `authenticated no puede ejecutar ${signature}.`);
    assert(!row.anon_execute && !row.public_execute, `${signature} quedó expuesta a anon o PUBLIC.`);
  }

  for (const signature of internalSignatures) {
    const row = functions.get(signature);
    assert(row, `No existe el helper interno ${signature}.`);
    assert(row.security_definer, `${signature} debe ejecutarse como SECURITY DEFINER.`);
    assert(
      !row.authenticated_execute && !row.anon_execute && !row.public_execute,
      `El helper interno ${signature} todavía puede ejecutarse por authenticated, anon o PUBLIC.`
    );
  }

  // Facturas: RPC pública -> presupuesto -> enrutamiento CxP -> retenciones -> guardado base.
  definitionIncludes(functions, 'public.save_supplier_invoice(jsonb,bigint)', 'budget_run(');
  definitionIncludes(
    functions,
    'public.budget_run(text,jsonb,bigint)',
    'save_supplier_invoice_without_budget('
  );
  definitionIncludes(
    functions,
    'public.save_supplier_invoice_without_budget(jsonb,bigint)',
    'save_supplier_invoice_without_budget_before_payable_routing('
  );
  definitionIncludes(
    functions,
    'public.save_supplier_invoice_without_budget_before_payable_routing(jsonb,bigint)',
    'save_supplier_invoice_without_withholding(',
    'supplier_invoice_withholding'
  );

  // Pagos directos y con anticipos deben atravesar la capa que calcula y registra retenciones.
  definitionIncludes(
    functions,
    'public.save_supplier_payment(jsonb,bigint)',
    'save_supplier_payment_before_payable_routing('
  );
  definitionIncludes(
    functions,
    'public.save_supplier_payment_before_payable_routing(jsonb,bigint)',
    'save_supplier_payment_without_withholding(',
    'supplier_payment_withholding'
  );
  definitionIncludes(
    functions,
    'public.save_supplier_payment_with_advances(jsonb,bigint)',
    'save_supplier_payment_with_advances_before_payable_routing('
  );
  definitionIncludes(
    functions,
    'public.save_supplier_payment_with_advances_before_payable_routing(jsonb,bigint)',
    'save_supplier_payment_with_advances_base('
  );
  definitionIncludes(
    functions,
    'public.save_supplier_payment_with_advances_base(jsonb,bigint)',
    'save_supplier_payment('
  );

  const syncResult = await client.query(`
    select pg_get_functiondef('public.sync_journal_gl_impacts(bigint)'::regprocedure) definition
  `);
  const syncDefinition = syncResult.rows[0].definition.toLowerCase();
  assert(
    syncDefinition.includes("not like 'retenci") && syncDefinition.includes('note'),
    'La sincronización al Mayor no excluye las líneas explícitas de retención y puede duplicarlas.'
  );

  console.log(
    'PASS: esquema, configuración, cadena de wrappers y permisos de retenciones de proveedores validados.'
  );
} finally {
  await client.end();
}
