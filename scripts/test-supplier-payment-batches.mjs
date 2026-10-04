import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import pg from 'pg';

process.loadEnvFile?.('.env');
const ref = new URL(process.env.SUPABASE_URL).hostname.split('.')[0];
const db = new pg.Client({
  host: process.env.SUPABASE_DB_HOST || 'aws-0-us-east-1.pooler.supabase.com',
  port: Number(process.env.SUPABASE_DB_PORT || 6543), database: 'postgres',
  user: process.env.SUPABASE_DB_USER || `postgres.${ref}`,
  password: process.env.SUPABASE_DB_PASSWORD || process.env.PGPASSWORD,
  ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 15000,
});
const migration = await readFile(new URL('../supabase/migrations/20261003120000_supplier_payment_batches.sql', import.meta.url), 'utf8');
const value = async (sql, args = []) => (await db.query(sql, args)).rows[0]?.value;
const rpc = (name, payload) => value(`select ${name}($1::jsonb)value`, [JSON.stringify(payload)]);
function validCrIban(bban = '000000000000000001') {
  const rearranged = `${bban}122700`;
  let remainder = 0n;
  for (const character of rearranged) remainder = (remainder * 10n + BigInt(character)) % 97n;
  return `CR${String(98n - remainder).padStart(2, '0')}${bban}`;
}

await db.connect();
try {
  await db.query('begin');
  await db.query("set local lock_timeout='10s';set local statement_timeout='180s'");
  await db.query(migration);
  const installed = (await db.query(`select
    to_regclass('public.bank_payment_formats')is not null formats,
    to_regclass('public.payment_batches')is not null batches,
    to_regclass('public.payment_batch_items')is not null items,
    to_regclass('public.payment_batch_response_files')is not null response_files,
    to_regprocedure('public.payment_batch_prepare(jsonb)')is not null prepare,
    to_regprocedure('public.payment_batch_apply_response(jsonb)')is not null apply_response`)).rows[0];
  assert.ok(Object.values(installed).every(Boolean), 'La migración no instaló todos los objetos.');

  const context = (await db.query(`
    select u.email,au.id::text sub,ucs.session_id,ucs.subsidiary_id
    from user_company_sessions ucs join user_role_sessions urs using(session_id,user_id)
    join roles r on r.role_id=urs.role_id and lower(r.role_name)in('administrador','administrator','admin')
    join users u using(user_id)join auth.users au on lower(au.email)=lower(u.email)
    join subsidiaries s using(subsidiary_id)join countries c using(country_id)
    where upper(coalesce(c.country_code_iso2,''))='CR'
    order by ucs.selected_at desc limit 1`)).rows[0];
  assert.ok(context, 'Se requiere una sesión administrativa activa para una subsidiaria de Costa Rica.');
  await db.query("select set_config('request.jwt.claims',$1,true)", [JSON.stringify({ ...context, role: 'authenticated' })]);

  const iban = validCrIban();
  assert.equal(await value('select cr_iban_valid($1)value', [iban]), true);
  assert.equal(await value("select cr_iban_valid('CR00000000000000000000')value"), false);
  assert.equal(await value("select cr_tax_id_valid('3-101-123456','J')value"), true);

  let fixture = (await db.query(`
    select i.invoice_id,i.supplier_id,i.currency_id,ba.bank_account_id,ba.balance,
      fp.fiscal_period_id,fp.start_date::text payment_date,s.currency_id base_currency_id
    from supplier_invoice i join subsidiaries s on s.subsidiary_id=i.subsidiary_id
    join bank_account ba on ba.subsidiary_id=i.subsidiary_id and ba.currency_id=i.currency_id
      and not coalesce(ba.is_credit_card,false) and ba.balance>1
    join fiscal_periods fp on fp.subsidiary_id=i.subsidiary_id and not fp.is_closed and not fp.gl_closed
      and not fp.ap_closed and not fp.is_inactive
    where i.subsidiary_id=$1 and pr_invoice_balance(i.invoice_id)>0.10
      and not exists(select 1 from solicitudes_pago_lineas l join solicitudes_pago r on r.id=l.id_solicitud
        where l.id_factura_proveedor=i.invoice_id and r.estado in('BORRADOR','PENDIENTE_APROBACION','APROBADO'))
    order by ba.balance desc,i.invoice_id limit 1`, [context.subsidiary_id])).rows[0];
  if (!fixture) {
    const base = (await db.query(`select s.currency_id,s.country_id,fp.fiscal_period_id,fp.start_date::text payment_date,
      (select supplier_id from entity_subsidiaries where subsidiary_id=s.subsidiary_id and supplier_id is not null order by id limit 1)supplier_id,
      (select ca.account_id from chart_accounts ca join account_subsidiaries ac using(account_id)
       where ac.subsidiary_id=s.subsidiary_id and ac.is_active and ca.category='Activo'and ca.accepts_entries and not ca.is_inactive order by ca.account_id limit 1)bank_ledger_id
      from subsidiaries s join fiscal_periods fp on fp.subsidiary_id=s.subsidiary_id and not fp.is_closed and not fp.gl_closed and not fp.ap_closed and not fp.is_inactive
      where s.subsidiary_id=$1 order by fp.start_date desc limit 1`, [context.subsidiary_id])).rows[0];
    assert.ok(base?.supplier_id && base?.bank_ledger_id, 'La subsidiaria de Costa Rica requiere proveedor, período abierto y cuenta de activo para la prueba.');
    const stamp = Date.now().toString().slice(-10);
    const bank = (await db.query(`insert into banks(bank_code,bank_name,country_id)values($1,'Banco prueba rollback',$2)returning bank_id`, [`T${stamp}`, base.country_id])).rows[0];
    const account = (await db.query(`insert into bank_account(account_number,iban,bank_id,subsidiary_id,currency_id,account_id,balance,country_id,is_credit_card)
      values($1,$2,$3,$4,$5,$6,1000,$7,false)returning bank_account_id,balance`, [`${stamp}`.padStart(10, '0').slice(-10), iban, bank.bank_id, context.subsidiary_id, base.currency_id, base.bank_ledger_id, base.country_id])).rows[0];
    const invoice = (await db.query(`insert into supplier_invoice(invoice_number,supplier_id,subsidiary_id,due_date,total_amount,invoice_date,fiscal_period_id,currency_id,exchange_rate,subtotal_amount,tax_total,withholding_total,payable_amount,memo)
      values($1,$2,$3,$4,100,$4,$5,$6,1,100,0,0,100,'Prueba lote con rollback')returning invoice_id`, [`PB-${stamp}`, base.supplier_id, context.subsidiary_id, base.payment_date, base.fiscal_period_id, base.currency_id])).rows[0];
    fixture = { invoice_id: invoice.invoice_id, supplier_id: base.supplier_id, currency_id: base.currency_id, bank_account_id: account.bank_account_id, balance: account.balance, fiscal_period_id: base.fiscal_period_id, payment_date: base.payment_date, base_currency_id: base.currency_id };
  }
  await db.query('update bank_account set iban=$1 where bank_account_id=$2', [iban, fixture.bank_account_id]);
  await db.query("update suppliers set payment_iban=$1,payment_id_type='J',payment_beneficiary_name=company_name,tax_id='3101123456'where supplier_id=$2", [iban, fixture.supplier_id]);

  const rate = String(fixture.currency_id) === String(fixture.base_currency_id) ? 1 : Number((await db.query(`select spot_rate from exchange_rates where from_currency_id=$1 and to_currency_id=$2 and effective_date<=$3 order by effective_date desc limit 1`, [fixture.currency_id, fixture.base_currency_id, fixture.payment_date])).rows[0]?.spot_rate || 1);
  const request = await rpc('pr_save', { type: 'CXP', currencyId: fixture.currency_id, supplierId: fixture.supplier_id, plannedDate: fixture.payment_date, concept: 'Prueba lote bancario con rollback', lines: [{ invoiceId: fixture.invoice_id, amount: 0.10 }] });
  let requestDetail = await rpc('pr_detail', { id: request.id });
  await rpc('pr_transition', { id: request.id, version: requestDetail.header.version, transition: 'SUBMIT' });
  requestDetail = await rpc('pr_detail', { id: request.id });
  await rpc('pr_transition', { id: request.id, version: requestDetail.header.version, transition: 'APPROVE' });
  requestDetail = await rpc('pr_detail', { id: request.id });

  const options = await value('select payment_batch_options()value');
  assert.equal(options.permissions.manage, true); assert.equal(options.permissions.execute, true);
  const format = options.formats.find(item => item.code === 'SINPE_GENERIC_XML' && String(item.currencyId) === String(fixture.currency_id));
  assert.ok(format, 'No se creó el formato SINPE para la moneda de la cuenta.');
  await db.query('savepoint conflicting_request');
  const conflictRequest = await rpc('pr_save', { type: 'CXP', currencyId: fixture.currency_id, supplierId: fixture.supplier_id, plannedDate: fixture.payment_date, concept: 'Reserva concurrente de prueba', lines: [{ invoiceId: fixture.invoice_id, amount: 0.10 }] });
  let conflictDetail = await rpc('pr_detail', { id: conflictRequest.id });
  await rpc('pr_transition', { id: conflictRequest.id, version: conflictDetail.header.version, transition: 'SUBMIT' });
  conflictDetail = await rpc('pr_detail', { id: conflictRequest.id });
  await rpc('pr_transition', { id: conflictRequest.id, version: conflictDetail.header.version, transition: 'APPROVE' });
  const conflictedCandidates = await rpc('payment_batch_candidates', { bankAccountId: fixture.bank_account_id, dueTo: '2999-12-31' });
  const conflictedCandidate = conflictedCandidates.find(item => String(item.id) === String(request.id));
  assert.equal(conflictedCandidate.valid, false); assert.match(conflictedCandidate.errors.join(' '), /otra solicitud/i);
  await db.query('savepoint conflicting_prepare');
  await assert.rejects(rpc('payment_batch_prepare', { bankAccountId: fixture.bank_account_id, formatId: format.id, executionDate: fixture.payment_date, rate, requestIds: [request.id] }), /comparte una factura/i);
  await db.query('rollback to savepoint conflicting_prepare');
  await db.query('rollback to savepoint conflicting_request');
  const candidates = await rpc('payment_batch_candidates', { bankAccountId: fixture.bank_account_id, dueTo: '2999-12-31' });
  const candidate = candidates.find(item => String(item.id) === String(request.id));
  assert.ok(candidate?.valid, `La solicitud no quedó elegible: ${JSON.stringify(candidate?.errors)}`);
  assert.ok(Array.isArray(candidate.invoices) && candidate.invoices.length > 0 && candidate.invoices.every(item => item.number && Number(item.amount) > 0), 'El candidato no incluyó el detalle estructurado de sus facturas.');

  const prepared = await rpc('payment_batch_prepare', { bankAccountId: fixture.bank_account_id, formatId: format.id, executionDate: fixture.payment_date, rate, requestIds: [request.id] });
  const batchId = prepared.header.id;
  assert.equal(prepared.header.status, 'DRAFT'); assert.equal(prepared.items.length, 1);
  assert.equal(prepared.header.extension, '.xml'); assert.equal(prepared.header.formatCode, 'SINPE_GENERIC_XML');
  assert.equal((await db.query('select batch_processing_status from solicitudes_pago where id=$1', [request.id])).rows[0].batch_processing_status, 'LOCKED_IN_BATCH');
  await db.query('savepoint protected_invoice');
  await assert.rejects(db.query('update supplier_invoice set due_date=due_date where invoice_id=$1', [fixture.invoice_id]), /lote de pago/i);
  await db.query('rollback to savepoint protected_invoice');
  await db.query('savepoint protected_manual_payment');
  await assert.rejects(rpc('pr_execute', { id: request.id, version: Number(requestDetail.header.version) + 1, bankId: fixture.bank_account_id, date: fixture.payment_date, rate, method: 'SINPE', reference: 'MANUAL-BLOCKED' }), /bloqueada en el lote/i);
  await db.query('rollback to savepoint protected_manual_payment');

  const generated = Buffer.from('<LotePagos><Prueba>rollback</Prueba></LotePagos>', 'utf8');
  await db.query('savepoint invalid_generated_checksum');
  await assert.rejects(rpc('payment_batch_finalize', { batchId, fileName: `${prepared.header.number}.xml`, mimeType: 'application/xml', checksum: '0'.repeat(64), contentBase64: generated.toString('base64') }), /huella SHA-256/i);
  await db.query('rollback to savepoint invalid_generated_checksum');
  const finalized = await rpc('payment_batch_finalize', { batchId, fileName: `${prepared.header.number}.xml`, mimeType: 'application/xml', checksum: createHash('sha256').update(generated).digest('hex'), contentBase64: generated.toString('base64') });
  assert.equal(finalized.batch.status, 'FILE_GENERATED');
  const downloaded = await value('select payment_batch_file($1)value', [batchId]);
  assert.deepEqual(Buffer.from(downloaded.contentBase64, 'base64'), generated);
  await rpc('payment_batch_mark_sent', { batchId });
  await db.query('savepoint duplicate_bank_response');
  await assert.rejects(rpc('payment_batch_apply_response', { batchId, results: [
    { itemId: prepared.items[0].id, status: 'APROBADO', bankReference: 'DUP-1' },
    { itemId: prepared.items[0].id, status: 'APROBADO', bankReference: 'DUP-2' }
  ] }), /duplicada/i);
  await db.query('rollback to savepoint duplicate_bank_response');
  const bankResponse = Buffer.from(`REFERENCIA_ERP,ESTADO,REFERENCIA_BANCO\n${prepared.items[0].lineReference},APROBADO,BANK-ROLLBACK-001\n`, 'utf8');
  const bankResponseChecksum = createHash('sha256').update(bankResponse).digest('hex');
  const applied = await rpc('payment_batch_apply_response', { batchId, responseFileName: 'respuesta.csv', responseChecksum: bankResponseChecksum,
    responseContentBase64: bankResponse.toString('base64'), results: [{ lineReference: prepared.items[0].lineReference, status: 'APROBADO', bankReference: 'BANK-ROLLBACK-001' }] });
  assert.equal(applied.status, 'FULLY_APPLIED'); assert.equal(Number(applied.paid), 1);
  requestDetail = await rpc('pr_detail', { id: request.id });
  assert.equal(requestDetail.header.estado, 'APLICADO'); assert.ok(requestDetail.header.payment_id && requestDetail.header.journal_id);
  assert.equal((await db.query('select processing_status from payment_batch_items where batch_id=$1', [batchId])).rows[0].processing_status, 'PAID_CONFIRMED');
  assert.equal(Number((await db.query('select amount_paid from supplier_payment where payment_id=$1', [requestDetail.header.payment_id])).rows[0].amount_paid), Number(prepared.items[0].amount));
  const archivedResponse = (await db.query('select checksum,content from payment_batch_response_files where batch_id=$1', [batchId])).rows[0];
  assert.equal(archivedResponse.checksum, bankResponseChecksum); assert.deepEqual(Buffer.from(archivedResponse.content), bankResponse);

  await db.query('rollback');
  console.log(JSON.stringify({ migration: true, costaRicaValidation: true, candidateValidation: true, duplicateInvoiceGuard: true, requestLock: true, invoiceLock: true, immutableFile: true, checksumValidation: true, duplicateResponseGuard: true, archivedBankResponse: true, transactionalApplication: true, rollback: true }));
} catch (error) {
  await db.query('rollback').catch(() => undefined);
  throw error;
} finally {
  await db.end();
}
