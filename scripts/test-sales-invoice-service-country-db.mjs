import assert from 'node:assert/strict';
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

const one = async (sql, values = []) => (await db.query(sql, values)).rows[0];

await db.connect();
try {
  await db.query('begin');
  await db.query("set local lock_timeout='5s'; set local statement_timeout='90s'");

  const columnInstalled = await one(`
    select exists(
      select 1 from information_schema.columns
      where table_schema='public' and table_name='sales_invoice_line'
        and column_name='service_country_id'
    ) value
  `);
  if (!columnInstalled.value) {
    const migration = await readFile(
      new URL('../supabase/migrations/20260928110000_add_sales_invoice_service_country.sql', import.meta.url),
      'utf8'
    );
    await db.query(migration);
  }
  const installed = await one(`select
    to_regprocedure('public.save_sales_invoice_before_service_country_integrity(jsonb,bigint)') is not null value`);
  if(!installed.value){
    const migration=await readFile(
      new URL('../supabase/migrations/20261001121000_enforce_sales_invoice_service_country.sql',import.meta.url),
      'utf8'
    );
    await db.query(migration);
  }
  assert.equal((await one(
    'select count(*)::int value from public.sales_invoice_line where service_country_id is null'
  )).value,0);

  const context = await one(`
    select distinct u.email, ucs.session_id, au.id sub, ucs.subsidiary_id
    from public.user_company_sessions ucs
    join public.users u using(user_id)
    join auth.users au on lower(au.email)=lower(u.email)
    where exists(
      select 1 from public.user_roles ur
      join public.role_permissions rp using(role_id)
      join public.permissions p using(permission_id)
      where ur.user_id=u.user_id and p.code='sales:invoice:create'
    )
      and exists(
        select 1 from public.user_roles ur
        join public.role_permissions rp using(role_id)
        join public.permissions p using(permission_id)
        where ur.user_id=u.user_id and p.code='sales:invoice:update'
      )
      and exists(
        select 1 from public.fiscal_periods fp
        where fp.subsidiary_id=ucs.subsidiary_id
          and not fp.is_closed and not coalesce(fp.ar_closed,false)
      )
      and exists(
        select 1 from public.entity_subsidiaries es
        where es.subsidiary_id=ucs.subsidiary_id
      )
      and exists(
        select 1 from public.products p
        join public.product_subsidiaries ps using(product_id)
        where ps.subsidiary_id=ucs.subsidiary_id and p.is_active
          and p.product_usage in('Venta','Ambas') and p.sales_account_id is not null
      )
    order by ucs.session_id desc
    limit 1
  `);
  assert.ok(context, 'Se requiere una sesión autorizada con datos de venta configurados.');

  await db.query("select set_config('request.jwt.claims',$1,true)", [JSON.stringify(context)]);
  const active = await one('select public.active_subsidiary_id() value');
  assert.equal(String(active.value), String(context.subsidiary_id));

  const setup = await one(`
    select
      (select es.customer_id from public.entity_subsidiaries es
       where es.subsidiary_id=$1 order by es.customer_id limit 1) customer_id,
      (select p.product_id from public.products p
       join public.product_subsidiaries ps using(product_id)
       where ps.subsidiary_id=$1 and p.is_active
         and p.product_usage in('Venta','Ambas') and p.sales_account_id is not null
       order by p.product_id limit 1) product_id,
      (select fp.fiscal_period_id from public.fiscal_periods fp
       where fp.subsidiary_id=$1 and not fp.is_closed and not coalesce(fp.ar_closed,false)
       order by fp.start_date limit 1) fiscal_period_id,
      (select to_char(fp.start_date,'YYYY-MM-DD') from public.fiscal_periods fp
       where fp.subsidiary_id=$1 and not fp.is_closed and not coalesce(fp.ar_closed,false)
       order by fp.start_date limit 1) invoice_date,
      (select s.currency_id from public.subsidiaries s where s.subsidiary_id=$1) currency_id,
      (select pt.term_id from public.payment_terms pt order by pt.term_id limit 1) payment_term_id,
      (select s.country_id from public.subsidiaries s where s.subsidiary_id=$1) subsidiary_country_id,
      (select c.country_id from public.countries c order by c.country_id limit 1) first_country_id,
      (select c.country_id from public.countries c order by c.country_id offset 1 limit 1) second_country_id
  `, [context.subsidiary_id]);
  assert.ok(setup.customer_id && setup.product_id && setup.fiscal_period_id && setup.currency_id && setup.payment_term_id);
  assert.ok(setup.first_country_id, 'El catálogo CORE debe contener al menos un país.');

  const payload = {
    invoice_number: 'AUTO',
    customer_id: setup.customer_id,
    payment_term_id: setup.payment_term_id,
    invoice_date: setup.invoice_date,
    fiscal_period_id: setup.fiscal_period_id,
    currency_id: setup.currency_id,
    exchange_rate: 1,
    memo: 'Prueba reversible de país de servicio',
    lines: [{
      product_id: setup.product_id,
      quantity: 1,
      unit_price: 1,
      tax_code_id: '',
      tax_rate: 0,
      service_country_id: setup.first_country_id,
      service_month: String(setup.invoice_date).slice(0, 7),
      note: 'País de servicio inicial',
      department_id: '',
      cost_center_id: '',
      class_id: '',
      related_company_id: ''
    }]
  };

  const created = await one(
    'select public.save_sales_invoice($1::jsonb,null) value',
    [JSON.stringify(payload)]
  );
  const createdCountry = await one(
    'select service_country_id value from public.sales_invoice_line where invoice_id=$1',
    [created.value.invoiceId]
  );
  assert.equal(String(createdCountry.value), String(setup.first_country_id));

  const updatedCountry = setup.second_country_id || setup.first_country_id;
  payload.invoice_number = created.value.transactionNumber;
  payload.lines[0].service_country_id = updatedCountry;
  payload.lines[0].note = 'País de servicio actualizado';
  await db.query(
    'select public.save_sales_invoice($1::jsonb,$2)',
    [JSON.stringify(payload), created.value.invoiceId]
  );
  const editedCountry = await one(
    'select service_country_id value from public.sales_invoice_line where invoice_id=$1',
    [created.value.invoiceId]
  );
  assert.equal(String(editedCountry.value), String(updatedCountry));

  delete payload.lines[0].service_country_id;
  await db.query(
    'select public.save_sales_invoice($1::jsonb,$2)',
    [JSON.stringify(payload), created.value.invoiceId]
  );
  const preservedCountry = await one(
    'select service_country_id value from public.sales_invoice_line where invoice_id=$1',
    [created.value.invoiceId]
  );
  assert.equal(String(preservedCountry.value),String(updatedCountry));
  const accountingCountry=await one(`select line.service_country_id value
    from public.journal_line line join public.chart_accounts account using(account_id)
    where line.journal_id=$1 and account.category='Ingreso'
    order by line.journal_line_id limit 1`,[created.value.journalId]);
  assert.equal(String(accountingCountry.value),String(updatedCountry));

  await db.query('rollback');
  console.log(JSON.stringify({
    migration: installed.value ? 'already-installed' : 'validated-with-rollback',
    created: true,
    edited: true,
    legacyEditPreservesCountry: true,
    accountingCountry: true,
    historicalBackfill: true,
    countryForeignKey: true,
    rollback: true
  }));
} catch (error) {
  await db.query('rollback').catch(() => {});
  throw error;
} finally {
  await db.end();
}
