import assert from 'node:assert/strict';
import pg from 'pg';
import { readFile } from 'node:fs/promises';

process.loadEnvFile?.('.env');
const ref = new URL(process.env.SUPABASE_URL).hostname.split('.')[0];
const db = new pg.Client({
  host: process.env.SUPABASE_DB_HOST || 'aws-0-us-east-1.pooler.supabase.com',
  port: Number(process.env.SUPABASE_DB_PORT || 6543),
  database: 'postgres',
  user: process.env.SUPABASE_DB_USER || `postgres.${ref}`,
  password: process.env.SUPABASE_DB_PASSWORD || process.env.PGPASSWORD,
  ssl: { rejectUnauthorized: false },
  connectionTimeoutMillis: 15000
});

const rpc = async (name, payload) => (await db.query(
  `select ${name}($1::jsonb) value`, [JSON.stringify(payload)]
)).rows[0].value;

await db.connect();
try {
  await db.query('begin');
  await db.query(await readFile(new URL('../supabase/migrations/20260909150000_payment_requests.sql', import.meta.url), 'utf8'));
  const ctx = (await db.query(`select u.email,ucs.session_id from user_company_sessions ucs join users u using(user_id)
    join user_role_sessions urs using(session_id,user_id) join roles r using(role_id)
    where lower(r.role_name) in('administrador','administrator','admin') order by ucs.selected_at desc limit 1`)).rows[0];
  assert.ok(ctx, 'Se requiere una sesión administrativa para la prueba');
  await db.query("select set_config('request.jwt.claims',$1,true)", [JSON.stringify(ctx)]);
  const sid = (await db.query('select active_subsidiary_id() sid')).rows[0].sid;
  const bank = (await db.query(`select b.bank_account_id,b.currency_id from bank_account b
    where b.subsidiary_id=$1 and not coalesce(b.is_credit_card,false) order by b.balance desc limit 1`, [sid])).rows[0];
  const account = (await db.query(`select a.account_id from chart_accounts a join account_subsidiaries s using(account_id)
    where s.subsidiary_id=$1 and pr_allowed_account(a.account_id) order by a.account_id limit 1`, [sid])).rows[0];
  const employee = (await db.query('select employee_id from employees where subsidiary_id=$1 and is_active limit 1', [sid])).rows[0];
  const period = (await db.query(`select fiscal_period_id,start_date::text,end_date::text from fiscal_periods
    where subsidiary_id=$1 and not is_closed and not gl_closed and not is_inactive order by start_date desc limit 1`, [sid])).rows[0];
  assert.ok(bank && account && employee && period, 'Faltan banco, cuenta permitida, empleado o período abierto');
  const local = (await db.query('select currency_id from subsidiaries where subsidiary_id=$1', [sid])).rows[0].currency_id;
  const date = period.start_date;
  const rate = String(bank.currency_id) === String(local) ? 1 : Number((await db.query(`select spot_rate from exchange_rates
    where from_currency_id=$1 and to_currency_id=$2 and effective_date<=$3 order by effective_date desc limit 1`, [bank.currency_id, local, date])).rows[0]?.spot_rate || 1);
  const before = Number((await db.query('select count(*) n from journal')).rows[0].n);
  await db.query('savepoint excluded_account');
  await assert.rejects(rpc('pr_save', { type:'OTROS', currencyId:bank.currency_id, plannedDate:date, concept:'INVALID', lines:[{ accountId:(await db.query('select account_id from bank_account where bank_account_id=$1',[bank.bank_account_id])).rows[0].account_id, entityType:'Empleado', entityId:employee.employee_id, concept:'INVALID', amount:0.01 }] }), /Cuenta no permitida/);
  await db.query('rollback to savepoint excluded_account');
  const saved = await rpc('pr_save', { type:'OTROS', currencyId:bank.currency_id, plannedDate:date, concept:'PR TEST', lines:[{ accountId:account.account_id, entityType:'Empleado', entityId:employee.employee_id, concept:'PR TEST LINE', amount:0.01 }] });
  let detail = await rpc('pr_detail', { id:saved.id });
  assert.equal(detail.header.estado, 'BORRADOR');
  assert.equal(Number((await db.query('select count(*) n from journal')).rows[0].n), before, 'El borrador creó un asiento');
  await rpc('pr_transition', { id:saved.id, version:detail.header.version, transition:'SUBMIT' });
  detail = await rpc('pr_detail', { id:saved.id });
  assert.equal(detail.header.estado, 'PENDIENTE_APROBACION');
  assert.equal(Number((await db.query('select count(*) n from journal')).rows[0].n), before, 'El envío creó un asiento');
  await rpc('pr_transition', { id:saved.id, version:detail.header.version, transition:'APPROVE' });
  detail = await rpc('pr_detail', { id:saved.id });
  assert.equal(detail.header.estado, 'APROBADO');
  assert.equal(Number((await db.query('select count(*) n from journal')).rows[0].n), before, 'La aprobación creó un asiento');
  const result = await rpc('pr_execute', { id:saved.id, version:detail.header.version, bankId:bank.bank_account_id, date, rate, method:'TRANSFERENCIA', reference:'PR-TEST' });
  detail = await rpc('pr_detail', { id:saved.id });
  assert.equal(detail.header.estado, 'APLICADO');
  assert.equal(String(result.journalId), String(detail.header.journal_id));
  assert.equal(Number((await db.query('select count(*) n from journal')).rows[0].n), before + 1);
  await db.query('savepoint protected_edit');
  await assert.rejects(db.query("update journal set memo='EDIT' where journal_id=$1", [result.journalId]), /solicitud aplicada/);
  await db.query('rollback to savepoint protected_edit');
  assert.ok(detail.events.some(event => event.accion === 'APROBADO'));
  assert.ok(detail.events.some(event => event.accion === 'APLICADO'));
  const payable = (await db.query(`select i.invoice_id,i.supplier_id,i.currency_id,b.bank_account_id
    from supplier_invoice i join bank_account b on b.subsidiary_id=i.subsidiary_id and b.currency_id=i.currency_id and not coalesce(b.is_credit_card,false)
    where i.subsidiary_id=$1 and pr_invoice_balance(i.invoice_id)>0.02 order by i.invoice_id limit 1`, [sid])).rows[0];
  assert.ok(payable, 'Se requiere una factura pendiente con banco en su moneda');
  const cxp = await rpc('pr_save', { type:'CXP', currencyId:payable.currency_id, supplierId:payable.supplier_id, plannedDate:date, concept:'PR CXP TEST', lines:[{ invoiceId:payable.invoice_id, amount:0.01 }] });
  const availability = (await rpc('pr_invoices', { supplierId:payable.supplier_id, currencyId:payable.currency_id })).find(item => String(item.id) === String(payable.invoice_id));
  assert.ok(availability);
  assert.equal(Number(availability.reserved), 0.01);
  assert.equal(Number(availability.available), Number(availability.balance) - 0.01);
  await db.query('savepoint excess_request');
  await assert.rejects(rpc('pr_save', { type:'CXP', currencyId:payable.currency_id, supplierId:payable.supplier_id, plannedDate:date, concept:'EXCESS', lines:[{ invoiceId:payable.invoice_id, amount:Number(availability.available) + 0.01 }] }), /saldo reservado/);
  await db.query('rollback to savepoint excess_request');
  const partial = await rpc('pr_save', { type:'CXP', currencyId:payable.currency_id, supplierId:payable.supplier_id, plannedDate:date, concept:'AVAILABLE PART', lines:[{ invoiceId:payable.invoice_id, amount:0.001 }] });
  const partialDetail = await rpc('pr_detail', { id:partial.id });
  await rpc('pr_transition', { id:partial.id, version:partialDetail.header.version, transition:'CANCEL', reason:'Reserva parcial de prueba' });
  let cxpDetail = await rpc('pr_detail', { id:cxp.id });
  await rpc('pr_transition', { id:cxp.id, version:cxpDetail.header.version, transition:'SUBMIT' });
  cxpDetail = await rpc('pr_detail', { id:cxp.id });
  await rpc('pr_transition', { id:cxp.id, version:cxpDetail.header.version, transition:'APPROVE' });
  cxpDetail = await rpc('pr_detail', { id:cxp.id });
  const cxpRate = String(payable.currency_id) === String(local) ? 1 : Number((await db.query(`select spot_rate from exchange_rates where from_currency_id=$1 and to_currency_id=$2 and effective_date<=$3 order by effective_date desc limit 1`, [payable.currency_id, local, date])).rows[0]?.spot_rate || 1);
  const locks = (await db.query('select supplier_payment_request_locks() value')).rows[0].value;
  assert.ok(locks.some(lock => String(lock.invoiceId) === String(payable.invoice_id) && lock.status === 'APROBADO'));
  await db.query('savepoint direct_payment_blocked');
  await assert.rejects(rpc('save_supplier_payment', { date, rate:cxpRate, period_id:period.fiscal_period_id, supplier_id:payable.supplier_id, account_id:payable.bank_account_id, reference:'DIRECT-BLOCKED', memo:'Must rollback', applications:[{ invoice_id:payable.invoice_id, amount:0.01 }] }), /Solicitud de Pago/);
  await db.query('rollback to savepoint direct_payment_blocked');
  await rpc('pr_execute', { id:cxp.id, version:cxpDetail.header.version, bankId:payable.bank_account_id, date, rate:cxpRate, method:'SINPE', reference:'PR-CXP-TEST' });
  cxpDetail = await rpc('pr_detail', { id:cxp.id });
  assert.equal(cxpDetail.header.estado, 'APLICADO');
  assert.ok(cxpDetail.header.payment_id);
  assert.equal(Number((await db.query('select amount from supplier_payment_application where payment_id=$1 and invoice_id=$2', [cxpDetail.header.payment_id, payable.invoice_id])).rows[0].amount), 0.01);
  console.log('PASS: flujo Otros Pagos y CxP; cero impacto previo; ejecución contable; exclusiones, auditoría y protección posterior.');
  await db.query('rollback');
  console.log('Datos de prueba revertidos.');
} catch (error) {
  await db.query('rollback');
  throw error;
} finally {
  await db.end();
}
