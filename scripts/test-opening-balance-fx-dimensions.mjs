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
  password: process.env.SUPABASE_DB_PASSWORD,
  ssl: { rejectUnauthorized: false },
  connectionTimeoutMillis: 15_000,
});

const migration = await readFile(
  new URL('../supabase/migrations/20261012160000_opening_balance_fx_dimensions.sql', import.meta.url),
  'utf8',
);
const one = async (sql, params = []) => (await db.query(sql, params)).rows[0];
const marker = async () => (await one(`
  select jsonb_build_object(
    'columns',coalesce((
      select jsonb_agg(table_name||'.'||column_name order by table_name,column_name)
      from information_schema.columns
      where table_schema='public'and(table_name,column_name)in(values
       ('opening_balance_lines','department_id'),('opening_balance_lines','class_id'),
       ('opening_balance_lines','financial_creditor_id'),('opening_balance_lines','related_company_id'),
       ('gl_impact','original_currency_id'),('gl_impact','opening_balance_line_id'),
       ('invoice','opening_balance_line_id'),('supplier_invoice','opening_balance_line_id'))
    ),'[]'::jsonb),
    'indexes',coalesce((
      select jsonb_agg(indexname||':'||indexdef order by indexname)from pg_indexes
      where schemaname='public'and indexname=any(array[
       'opening_balance_lines_dimensions_idx','gl_impact_original_currency_idx','gl_impact_opening_line_idx',
       'invoice_opening_line_idx','supplier_invoice_opening_line_idx'])
    ),'[]'::jsonb),
    'functions',coalesce((
      select jsonb_agg(p.oid::regprocedure::text||E'\n'||pg_get_functiondef(p.oid)order by p.oid::regprocedure::text)
      from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      where n.nspname='public'and p.proname=any(array[
       'opening_balance_dimension_id','opening_balance_stage','opening_balance_validate','opening_balance_preview',
       'opening_balance_post','opening_balance_reverse','fx_options','fx_exposures'])
    ),'[]'::jsonb)
  )value
`)).value;

await db.connect();
const before = await marker();
let failure;
try {
  await db.query('begin');
  await db.query("set local lock_timeout='5s';set local statement_timeout='120s'");
  await db.query(migration);

  const context = await one(`
    select u.email,u.user_id,au.id auth_id,ucs.session_id,ucs.subsidiary_id,urs.role_id,
      s.currency_id local_currency_id,lc.currency_code local_currency,s.country_id,usd.currency_id usd_currency_id,
      p.fiscal_period_id,to_char(p.opening_date,'YYYY-MM-DD') opening_date,t.account_id transition_id,t.account_number transition_account,b.accounting_book_id,
      (select count(*)from asset ax where ax.subsidiary_id=s.subsidiary_id and ax.opening_reversed_at is null) asset_count
    from user_company_sessions ucs
    join users u using(user_id)
    join auth.users au on lower(au.email)=lower(u.email)
    join user_role_sessions urs on urs.session_id=ucs.session_id and urs.user_id=ucs.user_id
    join subsidiaries s on s.subsidiary_id=ucs.subsidiary_id
    join currencies lc on lc.currency_id=s.currency_id and lc.currency_code<>'USD'
    join currencies usd on usd.currency_code='USD'
    join lateral(
      select fiscal_period_id,greatest(start_date,current_date-1)::date opening_date
      from fiscal_periods where subsidiary_id=s.subsidiary_id and current_date between start_date and end_date
       and not is_closed and not coalesce(gl_closed,false)and not coalesce(is_inactive,false)
      order by start_date desc limit 1
    )p on true
    join chart_accounts t on t.account_number='319999'and t.accepts_entries and not t.is_inactive
    join account_subsidiaries tx on tx.account_id=t.account_id and tx.subsidiary_id=s.subsidiary_id and tx.is_active
    join accounting_books b on b.subsidiary_id=s.subsidiary_id and b.is_primary and b.is_active
    where(select count(*)from accounting_books bx where bx.subsidiary_id=s.subsidiary_id and bx.is_primary and bx.is_active)=1
      and exists(select 1 from customers c where c.primary_subsidiary_id=s.subsidiary_id or exists(select 1 from entity_subsidiaries e where e.customer_id=c.customer_id and e.subsidiary_id=s.subsidiary_id))
      and exists(select 1 from suppliers x where x.primary_subsidiary_id=s.subsidiary_id or exists(select 1 from entity_subsidiaries e where e.supplier_id=x.supplier_id and e.subsidiary_id=s.subsidiary_id))
    order by asset_count,ucs.selected_at desc limit 1
  `);
  assert.ok(context, 'Se requiere una sesión con moneda local distinta de USD, período abierto y libro principal.');
  const sid = Number(context.subsidiary_id);
  const openingDate = String(context.opening_date);
  await db.query("select set_config('request.jwt.claims',$1,true)", [JSON.stringify({
    sub: context.auth_id,
    email: context.email,
    session_id: context.session_id,
  })]);
  await db.query(`
    insert into role_access_matrix(role_id,resource_key,can_view,can_create,can_edit,can_delete)
    values($1,'accounting:opening-balances',true,true,true,true)
    on conflict(role_id,resource_key)do update set can_view=true,can_create=true,can_edit=true,can_delete=true,updated_at=now()
  `, [context.role_id]);
  await db.query("update opening_balance_runs set status='REVERSED',reversed_at=coalesce(reversed_at,now())where subsidiary_id=$1 and status<>'REVERSED'", [sid]);
  await db.query("update fx_revaluation_runs set status='REVERSADO'where subsidiary_id=$1 and status='CONTABILIZADO'", [sid]);
  await db.query('insert into subsidiary_currencies(subsidiary_id,currency_id)values($1,$2)on conflict do nothing', [sid, context.usd_currency_id]);
  await db.query(`
    insert into exchange_rates(from_currency_id,to_currency_id,effective_date,spot_rate)
    values($1,$2,$3,150)
    on conflict(from_currency_id,to_currency_id,effective_date)do update set spot_rate=excluded.spot_rate
  `, [context.usd_currency_id, context.local_currency_id, openingDate]);

  const target = await one(`
    select a.account_id,a.account_number,a.account_group_id
    from chart_accounts a join account_group g on g.group_id=a.account_group_id join account_subsidiaries x using(account_id)
    where x.subsidiary_id=$1 and x.is_active and a.accepts_entries and not a.is_inactive and a.category='Activo'and g.category='Activo'
      and a.account_id<>$2 and not fixed_asset_ppe_account(a.account_id)
      and not account_belongs_to_group(a.account_id,'depreciaci.n acumulada|deterioro|revaluaci.n')
      and not exists(
       select 1 from gl_impact gi join "transaction"tr using(transaction_id)
       where gi.subsidiary_id=$1 and gi.accounting_book_id=$3 and gi.account_id=a.account_id and gi.posting_date<=$4
        and coalesce(gi.original_currency_id,tr.currency_id)=$5
      )
    order by a.account_number limit 1
  `, [sid, context.transition_id, context.accounting_book_id, openingDate, context.usd_currency_id]);
  const payable = await one(`
    select a.account_id,a.account_number,a.account_group_id
    from chart_accounts a join account_group g on g.group_id=a.account_group_id join account_subsidiaries x using(account_id)
    where x.subsidiary_id=$1 and x.is_active and a.accepts_entries and not a.is_inactive and a.category='Pasivo'and g.category='Pasivo'
      and not account_belongs_to_group(a.account_id,'deterioro|revaluaci.n')
      and not exists(
       select 1 from gl_impact gi join "transaction"tr using(transaction_id)
       where gi.subsidiary_id=$1 and gi.accounting_book_id=$2 and gi.account_id=a.account_id and gi.posting_date<=$3
        and coalesce(gi.original_currency_id,tr.currency_id)=$4
      )
    order by a.account_number limit 1
  `, [sid, context.accounting_book_id, openingDate, context.usd_currency_id]);
  assert.ok(target && payable, 'Se requieren cuentas de Activo y Pasivo sin exposición USD previa para aislar la prueba.');
  await db.query('update account_group set pending_fx_revaluation=true where group_id=any($1::bigint[])', [[target.account_group_id, payable.account_group_id]]);
  assert.equal((await one('select pending_fx_revaluation value from chart_accounts where account_id=$1', [target.account_id])).value, true);
  assert.equal((await one('select pending_fx_revaluation value from chart_accounts where account_id=$1', [payable.account_id])).value, true);

  const stamp = `${Date.now()}-${Math.floor(Math.random() * 100000)}`;
  const department = await one(`insert into departments(name,subsidiary_id,type,is_inactive)values($1,$2,'Interno',false)returning department_id,name`, [`Dept apertura ${stamp}`, sid]);
  const cls = await one(`insert into classes(name,subsidiary_id,is_inactive)values($1,$2,false)returning class_id,name`, [`Clase apertura ${stamp}`, sid]);
  await db.query('insert into class_subsidiaries(class_id,subsidiary_id)values($1,$2)on conflict do nothing', [cls.class_id, sid]);
  const center = await one(`insert into cost_centers(code,name,subsidiary_id,is_inactive,class_id,cost_center_type)values('AUTO',$1,$2,false,$3,'INTERNO')returning cost_center_id,code,name`, [`Centro apertura ${stamp}`, sid, cls.class_id]);
  const creditor = await one(`insert into financial_creditors(code,name,identification,subsidiary_id,is_inactive)values($1,$2,$3,$4,false)returning financial_creditor_id,code,name`, [`ACF-T-${stamp}`, `Acreedor apertura ${stamp}`, `FC-${stamp}`, sid]);
  const related = await one(`insert into related_companies(code,name,identification,subsidiary_id,is_inactive,country_id)values($1,$2,$3,$4,false,$5)returning related_company_id,code,name`, [`REL-T-${stamp}`, `Relacionada apertura ${stamp}`, `RC-${stamp}`, sid, context.country_id]);
  const customer = await one(`select c.customer_id,c.tax_id from customers c where c.primary_subsidiary_id=$1 or exists(select 1 from entity_subsidiaries e where e.customer_id=c.customer_id and e.subsidiary_id=$1)order by c.customer_id limit 1`, [sid]);
  const supplier = await one(`select s.supplier_id,s.tax_id from suppliers s where s.primary_subsidiary_id=$1 or exists(select 1 from entity_subsidiaries e where e.supplier_id=s.supplier_id and e.subsidiary_id=$1)order by s.supplier_id limit 1`, [sid]);

  const existing = (await db.query(`
    with cost as(
      select c.asset_account_id account_id,a.account_number,sum(x.purchase_cost*x.exchange_rate)amount,'DEBIT'::text side
      from asset x join asset_category c using(category_id)join chart_accounts a on a.account_id=c.asset_account_id
      where x.subsidiary_id=$1 and x.purchase_date<=$2 and x.opening_reversed_at is null
       and not exists(select 1 from asset_disposal d where d.asset_id=x.asset_id and d.disposal_date<=$2)
      group by c.asset_account_id,a.account_number
    ),depreciation as(
      select c.depreciation_account_id account_id,a.account_number,sum(d.depreciation_amount*x.exchange_rate)amount,'CREDIT'::text side
      from asset x join asset_category c using(category_id)join chart_accounts a on a.account_id=c.depreciation_account_id join asset_depreciation d using(asset_id)
      where x.subsidiary_id=$1 and x.purchase_date<=$2 and x.opening_reversed_at is null and d.depreciation_date<=$2
       and not exists(select 1 from asset_disposal z where z.asset_id=x.asset_id and z.disposal_date<=$2)
      group by c.depreciation_account_id,a.account_number
    )select * from cost union all select * from depreciation
  `, [sid, openingDate])).rows;

  let sourceRow = 2;
  const rows = [];
  let totalDebit = 0;
  let totalCredit = 0;
  const addLocal = (account, debit, credit, note) => {
    rows.push({ sourceType: 'GL', sourceRow: sourceRow++, account, currency: context.local_currency, debit: debit ? String(debit) : '', credit: credit ? String(credit) : '', debitFx: debit ? String(debit) : '', creditFx: credit ? String(credit) : '', department: '', costCenter: '', className: '', financialCreditor: '', relatedCompany: '', location: '', note });
    totalDebit += Number(debit || 0);
    totalCredit += Number(credit || 0);
  };
  for (const item of existing) {
    const amount = Number(item.amount);
    if (Math.abs(amount) <= 0.000001) continue;
    if (item.side === 'DEBIT') addLocal(item.account_number, Math.max(amount, 0), Math.max(-amount, 0), 'Conciliación PPE existente');
    else addLocal(item.account_number, Math.max(-amount, 0), Math.max(amount, 0), 'Conciliación depreciación existente');
  }
  const glSourceRow = sourceRow++;
  rows.push({
    sourceType: 'GL', sourceRow: glSourceRow, account: target.account_number, currency: 'USD', debit: '150000', credit: '', debitFx: '1000', creditFx: '',
    department: department.name, costCenter: center.code, className: cls.name, financialCreditor: creditor.code, relatedCompany: related.code,
    location: '', project: 'DEBE-IGNORARSE', note: 'GL USD explícito para revaluación',
  });
  totalDebit += 150000;
  const arSourceRow = sourceRow++;
  rows.push({ sourceType: 'AR', sourceRow: arSourceRow, account: target.account_number, documentNumber: `AR-FX-${stamp}`, issueDate: openingDate, dueDate: openingDate, currency: 'USD', debit: '100', credit: '', entityTaxId: customer.tax_id, costCenter: '', location: '', note: 'CxC inicial USD' });
  totalDebit += 15000;
  const apSourceRow = sourceRow++;
  rows.push({ sourceType: 'AP', sourceRow: apSourceRow, account: payable.account_number, documentNumber: `AP-FX-${stamp}`, issueDate: openingDate, dueDate: openingDate, currency: 'USD', debit: '', credit: '200', entityTaxId: supplier.tax_id, costCenter: '', location: '', note: 'CxP inicial USD' });
  totalCredit += 30000;
  const difference = totalDebit - totalCredit;
  addLocal(context.transition_account, difference < 0 ? -difference : 0, difference > 0 ? difference : 0, 'Contrapartida de apertura');
  assert.ok(Math.abs(totalDebit - totalCredit) <= 0.000001, 'El lote de prueba debe quedar balanceado.');

  const payload = {
    expectedSubsidiaryId: String(sid),
    openingDate,
    loadType: 'FISCAL_YEAR',
    transitionAccountId: String(context.transition_id),
    rows,
    assets: [],
  };
  const preview = (await one('select opening_balance_validate($1::jsonb)value', [payload])).value;
  assert.equal(preview.summary.difference, 0);
  const glPreview = preview.rows.find((row) => Number(row.row) === glSourceRow);
  assert.equal(Number(glPreview.debit), 150000);
  assert.equal(Number(glPreview.debitFx), 1000);
  assert.equal(Number(glPreview.rate), 150);
  assert.equal(glPreview.location, null, 'La ubicación/sucursal debe ser opcional.');
  assert.equal(glPreview.department, department.name);
  assert.match(glPreview.costCenter, new RegExp(center.code));
  assert.equal(glPreview.className, cls.name);
  assert.equal(glPreview.financialCreditor, creditor.name);
  assert.equal(glPreview.relatedCompany, related.name);
  assert.equal(Object.hasOwn(glPreview, 'project'), false, 'La API nueva no debe exponer proyecto.');
  const staged = await one('select * from opening_balance_lines where run_id=$1 and row_number=$2', [preview.run.id, glSourceRow]);
  assert.equal(staged.project_code, null);
  assert.equal(Object.hasOwn(staged.raw_data, 'project'), false);

  await db.query('savepoint stale_dimension');
  await db.query('update financial_creditors set is_inactive=true where financial_creditor_id=$1', [creditor.financial_creditor_id]);
  let staleDimensionError;
  try {
    await one('select opening_balance_post($1)value', [preview.run.id]);
  } catch (error) {
    staleDimensionError = error;
  }
  await db.query('rollback to savepoint stale_dimension');
  await db.query('release savepoint stale_dimension');
  assert.match(staleDimensionError?.message || '', /Las dimensiones cambiaron.*Valide nuevamente/);

  const blockingFx = await one(`
    insert into fx_revaluation_runs(
      subsidiary_id,fiscal_period_id,currency_id,closing_date,closing_rate,rate_source,auto_reverse,status,
      snapshot,gain_account_id,loss_account_id,gain_taxable,loss_deductible,created_by
    )values($1,$2,$3,$4,151,'MANUAL',false,'CONTABILIZADO','[]',$5,$6,false,false,$7)returning run_id
  `, [sid, context.fiscal_period_id, context.usd_currency_id, openingDate, target.account_id, payable.account_id, context.user_id]);
  await db.query('savepoint expected_fx_post_guard');
  let guardError;
  try {
    await one('select opening_balance_post($1)value', [preview.run.id]);
  } catch (error) {
    guardError = error;
  }
  await db.query('rollback to savepoint expected_fx_post_guard');
  await db.query('release savepoint expected_fx_post_guard');
  if (!/No se puede contabilizar la apertura.*Anule primero esas revaluaciones/.test(guardError?.message || '')) {
    const dimensionDiagnostic = (await db.query(`
      select l.id,l.source_type,l.department_id,l.cost_center_id,l.class_id,l.financial_creditor_id,l.related_company_id,l.location_id,
       d.subsidiary_id department_subsidiary,d.is_inactive department_inactive,
       cc.subsidiary_id center_subsidiary,cc.is_inactive center_inactive,cc.cost_center_type,cc.class_id center_class,cc.customer_id center_customer,
       owner.department_id center_department,cl.subsidiary_id class_subsidiary,cl.is_inactive class_inactive,
       fc.subsidiary_id creditor_subsidiary,fc.is_inactive creditor_inactive,
       rc.subsidiary_id related_subsidiary,rc.is_inactive related_inactive,lo.subsidiary_id location_subsidiary
      from opening_balance_lines l left join departments d on d.department_id=l.department_id
      left join cost_centers cc on cc.cost_center_id=l.cost_center_id
      left join customers owner on owner.customer_id=cc.customer_id left join classes cl on cl.class_id=l.class_id
      left join financial_creditors fc on fc.financial_creditor_id=l.financial_creditor_id
      left join related_companies rc on rc.related_company_id=l.related_company_id
      left join locations lo on lo.location_id=l.location_id where l.run_id=$1 order by l.id
    `, [preview.run.id])).rows;
    throw new Error(`Guard FX fue interceptado por dimensiones: ${guardError?.message}; ${JSON.stringify(dimensionDiagnostic)}`);
  }
  assert.match(guardError?.message || '', /No se puede contabilizar la apertura.*Anule primero esas revaluaciones/);
  await db.query("update fx_revaluation_runs set status='REVERSADO'where run_id=$1", [blockingFx.run_id]);

  const posted = (await one('select opening_balance_post($1)value', [preview.run.id])).value;
  const journalLine = await one(`
    select l.*,g.original_currency_id impact_currency,g.opening_balance_line_id impact_line
    from journal_line l join journal j using(journal_id)join gl_impact g on g.transaction_id=j.transaction_id and g.opening_balance_line_id=l.opening_balance_line_id
    where l.journal_id=$1 and l.opening_balance_line_id=$2
  `, [posted.journalId, staged.id]);
  assert.equal(Number(journalLine.debit), 150000);
  assert.equal(Number(journalLine.debit_fx), 1000);
  assert.equal(Number(journalLine.historical_exchange_rate), 150);
  assert.equal(Number(journalLine.original_currency_id), Number(context.usd_currency_id));
  assert.equal(Number(journalLine.department_id), Number(department.department_id));
  assert.equal(Number(journalLine.cost_center_id), Number(center.cost_center_id));
  assert.equal(Number(journalLine.class_id), Number(cls.class_id));
  assert.equal(Number(journalLine.financial_creditor_id), Number(creditor.financial_creditor_id));
  assert.equal(Number(journalLine.related_company_id), Number(related.related_company_id));
  assert.equal(journalLine.location_id, null);

  const arInvoice = await one('select invoice_id,transaction_id,opening_balance_line_id from invoice where opening_run_id=$1', [preview.run.id]);
  const apInvoice = await one('select invoice_id,transaction_id,opening_balance_line_id from supplier_invoice where opening_run_id=$1', [preview.run.id]);
  assert.equal(arInvoice.transaction_id, null, 'Una CxC inicial no debe simular una transacción de venta.');
  assert.equal(apInvoice.transaction_id, null, 'Una CxP inicial no debe simular una transacción de compra.');
  assert.ok(arInvoice.opening_balance_line_id);
  assert.ok(apInvoice.opening_balance_line_id);

  const exposures = (await one('select fx_exposures($1,$2)value', [openingDate, context.usd_currency_id])).value;
  const glExposure = exposures.find((row) => row.sourceType === 'Mayor' && Number(row.accountId) === Number(target.account_id));
  const arExposure = exposures.find((row) => row.sourceKey === `AR:${arInvoice.invoice_id}`);
  const apExposure = exposures.find((row) => row.sourceKey === `AP:${apInvoice.invoice_id}`);
  assert.equal(Number(glExposure.foreignBalance), 1000);
  assert.equal(Number(glExposure.bookValue), 150000);
  assert.equal(Number(arExposure.foreignBalance), 100);
  assert.equal(Number(arExposure.bookValue), 15000);
  assert.equal(Number(apExposure.foreignBalance), 200);
  assert.equal(Number(apExposure.bookValue), 30000);
  assert.equal(exposures.some((row) => row.sourceType === 'Mayor' && Number(row.accountId) === Number(payable.account_id)), false, 'CxP no debe duplicarse en el residual del mayor.');
  assert.equal(exposures.filter((row) => row.sourceKey === `AR:${arInvoice.invoice_id}`).length, 1);
  assert.equal(exposures.filter((row) => row.sourceKey === `AP:${apInvoice.invoice_id}`).length, 1);

  await db.query("update fx_revaluation_runs set status='CONTABILIZADO'where run_id=$1", [blockingFx.run_id]);
  await db.query('savepoint expected_fx_guard');
  guardError = undefined;
  try {
    await one('select opening_balance_reverse($1)value', [preview.run.id]);
  } catch (error) {
    guardError = error;
  }
  await db.query('rollback to savepoint expected_fx_guard');
  await db.query('release savepoint expected_fx_guard');
  assert.match(guardError?.message || '', /Anule primero esas revaluaciones/);
  await db.query("update fx_revaluation_runs set status='REVERSADO'where run_id=$1", [blockingFx.run_id]);

  if (Number(context.asset_count) > 0) {
    // This fixture verifies reversal metadata independently from the existing
    // fixed-asset auxiliary of the selected company. The replacement is inside
    // this transaction and the final rollback restores the production function.
    await db.query(`
      create or replace function opening_fixed_asset_reconciliation(bigint)returns jsonb
      language sql stable security definer set search_path=public as $$select '[]'::jsonb$$
    `);
  }

  const reversed = (await one('select opening_balance_reverse($1)value', [preview.run.id])).value;
  const reversalLine = await one(`select * from journal_line where journal_id=$1 and opening_balance_line_id=$2`, [reversed.reversalJournalId, staged.id]);
  assert.equal(Number(reversalLine.credit), 150000);
  assert.equal(Number(reversalLine.credit_fx), 1000);
  assert.equal(Number(reversalLine.department_id), Number(department.department_id));
  assert.equal(Number(reversalLine.cost_center_id), Number(center.cost_center_id));
  assert.equal(Number(reversalLine.class_id), Number(cls.class_id));
  assert.equal(Number(reversalLine.financial_creditor_id), Number(creditor.financial_creditor_id));
  assert.equal(Number(reversalLine.related_company_id), Number(related.related_company_id));
  assert.equal(reversalLine.location_id, null);
  const afterReverse = (await one('select fx_exposures($1,$2)value', [openingDate, context.usd_currency_id])).value;
  assert.equal(afterReverse.some((row) => row.sourceKey === `AR:${arInvoice.invoice_id}` || row.sourceKey === `AP:${apInvoice.invoice_id}`), false);
  assert.equal(afterReverse.some((row) => row.sourceType === 'Mayor' && Number(row.accountId) === Number(target.account_id)), false);

  // Legacy reversals used their execution date. A historical cutoff before
  // that date must still see the opening exposure; from the reversal date on,
  // the source and reversal are neutralized/excluded.
  const legacyReversalDate = (await one("select to_char($1::date+1,'YYYY-MM-DD')value", [openingDate])).value;
  await db.query("select set_config('app.opening_balance_internal','1',true)");
  await db.query('update journal set journal_date=$2 where journal_id=$1', [reversed.reversalJournalId, legacyReversalDate]);
  await db.query('update "transaction" set tran_date=$2 where transaction_id=(select transaction_id from journal where journal_id=$1)', [reversed.reversalJournalId, legacyReversalDate]);
  await db.query('update gl_impact set posting_date=$2 where transaction_id=(select transaction_id from journal where journal_id=$1)', [reversed.reversalJournalId, legacyReversalDate]);
  const beforeLegacyReversal = (await one('select fx_exposures($1,$2)value', [openingDate, context.usd_currency_id])).value;
  const legacyTarget = beforeLegacyReversal.find((row) => row.sourceType === 'Mayor' && Number(row.accountId) === Number(target.account_id));
  assert.equal(Number(legacyTarget.foreignBalance), 1100);
  assert.equal(Number(legacyTarget.bookValue), 165000);
  const onLegacyReversal = (await one('select fx_exposures($1,$2)value', [legacyReversalDate, context.usd_currency_id])).value;
  assert.equal(onLegacyReversal.some((row) => row.sourceType === 'Mayor' && Number(row.accountId) === Number(target.account_id)), false);
  await db.query('update journal set journal_date=$2 where journal_id=$1', [reversed.reversalJournalId, openingDate]);
  await db.query('update "transaction" set tran_date=$2 where transaction_id=(select transaction_id from journal where journal_id=$1)', [reversed.reversalJournalId, openingDate]);
  await db.query('update gl_impact set posting_date=$2 where transaction_id=(select transaction_id from journal where journal_id=$1)', [reversed.reversalJournalId, openingDate]);

  // Simulate a reversal produced by the legacy function, which omitted the FX
  // and dimension snapshot, then rerun the idempotent migration backfill.
  await db.query("select set_config('app.opening_balance_internal','1',true)");
  await db.query(`
    update journal_line set historical_exchange_rate=1,original_currency_id=null,opening_balance_line_id=null,
      department_id=null,class_id=null,location_id=null,cost_center_id=null,financial_creditor_id=null,related_company_id=null
    where journal_id=$1
  `, [reversed.reversalJournalId]);
  await db.query(`
    with lines as(
      select l.account_id,l.debit,l.credit,l.debit_fx,l.credit_fx,
       row_number()over(partition by l.account_id,l.debit,l.credit order by l.journal_line_id)sequence
      from journal_line l where l.journal_id=$1
    ),impacts as(
      select g.gl_impact_id,g.account_id,g.debit_amount debit,g.credit_amount credit,
       row_number()over(partition by g.account_id,g.debit_amount,g.credit_amount order by g.gl_impact_id)sequence
      from gl_impact g join journal j using(transaction_id)where j.journal_id=$1
    )
    update gl_impact g set debit_fx=l.debit_fx,credit_fx=l.credit_fx,
      original_currency_id=null,opening_balance_line_id=null
    from impacts i join lines l using(account_id,debit,credit,sequence)where g.gl_impact_id=i.gl_impact_id
  `, [reversed.reversalJournalId]);
  await db.query(migration);
  const repairedReversal = await one(`select * from journal_line where journal_id=$1 and opening_balance_line_id=$2`, [reversed.reversalJournalId, staged.id]);
  assert.equal(Number(repairedReversal.credit_fx), 1000);
  assert.equal(Number(repairedReversal.historical_exchange_rate), 150);
  assert.equal(Number(repairedReversal.original_currency_id), Number(context.usd_currency_id));
  assert.equal(Number(repairedReversal.department_id), Number(department.department_id));
  assert.equal(Number(repairedReversal.cost_center_id), Number(center.cost_center_id));
  assert.equal(Number(repairedReversal.class_id), Number(cls.class_id));
  const repairedImpact = await one(`
    select g.* from gl_impact g join journal j using(transaction_id)
    where j.journal_id=$1 and g.opening_balance_line_id=$2
  `, [reversed.reversalJournalId, staged.id]);
  if (!repairedImpact) {
    const debug = (await db.query(`
      select l.journal_line_id,l.account_id,l.debit,l.credit,l.debit_fx,l.credit_fx,l.original_currency_id,l.opening_balance_line_id,
       g.gl_impact_id,g.debit_amount,g.credit_amount,g.debit_fx impact_debit_fx,g.credit_fx impact_credit_fx,
       g.original_currency_id impact_currency,g.opening_balance_line_id impact_line
      from journal_line l join journal j using(journal_id)left join gl_impact g on g.transaction_id=j.transaction_id and g.account_id=l.account_id
      where j.journal_id=$1 order by l.journal_line_id,g.gl_impact_id
    `, [reversed.reversalJournalId])).rows;
    throw new Error(`No se reparó el impacto legacy: ${JSON.stringify(debug)}`);
  }
  assert.equal(Number(repairedImpact.credit_fx), 1000);
  assert.equal(Number(repairedImpact.original_currency_id), Number(context.usd_currency_id));
  const afterLegacyRepair = (await one('select fx_exposures($1,$2)value', [openingDate, context.usd_currency_id])).value;
  assert.equal(afterLegacyRepair.some((row) => row.sourceType === 'Mayor' && Number(row.accountId) === Number(target.account_id)), false);

  console.log(JSON.stringify({
    migration: true,
    localOriginal: true,
    dimensions: true,
    staleDimensionGuard: true,
    optionalLocation: true,
    exactOpeningDocuments: true,
    fxRevaluationPostingGuard: true,
    fxRevaluationReversalGuard: true,
    legacyReversalBackfill: true,
    legacyReversalHistoricalCutoff: true,
    fxExposure: { foreignBalance: glExposure.foreignBalance, bookValue: glExposure.bookValue },
    reversal: true,
    rollback: true,
  }));
} catch (error) {
  failure = error;
} finally {
  await db.query('rollback').catch(() => {});
  const after = await marker();
  assert.deepEqual(after, before, 'El rollback de la prueba dejó objetos persistentes.');
  await db.end();
}
if (failure) throw failure;
