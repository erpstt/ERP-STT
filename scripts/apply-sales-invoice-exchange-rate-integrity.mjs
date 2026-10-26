import assert from 'node:assert/strict';
import pg from 'pg';
import {readFile} from 'node:fs/promises';

process.loadEnvFile?.('.env');
const projectRef=new URL(process.env.SUPABASE_URL).hostname.split('.')[0];
const db=new pg.Client({
  host:process.env.SUPABASE_DB_HOST||'aws-0-us-east-1.pooler.supabase.com',
  port:Number(process.env.SUPABASE_DB_PORT||6543),
  database:process.env.SUPABASE_DB_NAME||'postgres',
  user:process.env.SUPABASE_DB_USER||`postgres.${projectRef}`,
  password:process.env.SUPABASE_DB_PASSWORD||process.env.PGPASSWORD,
  ssl:{rejectUnauthorized:false},connectionTimeoutMillis:15000
});

const numbers=['FAC-00000669','FAC-00000670','FAC-00000671','FAC-00000672','FAC-00000673'];
const close=(actual,expected,tolerance=.005)=>Math.abs(Number(actual)-Number(expected))<=tolerance;

await db.connect();
try{
  await db.query('begin');
  const before=(await db.query(`select
      (select count(*)::int from customer_payment_application application
        join invoice using(invoice_id) where invoice_number=any($1)) application_count,
      (select coalesce(sum(application.amount),0) from customer_payment_application application
        join invoice using(invoice_id) where invoice_number=any($1)) application_total,
      (select coalesce(sum(amount),0) from bank_transaction bank_movement
        join customer_payment payment using(transaction_id) where payment_id=any($2)) bank_total,
      (select coalesce(sum(amount),0) from customer_payment_bank_fee where payment_id=any($2)) fee_total`,
    [numbers,[69,70]])).rows[0];

  const sql=await readFile(new URL(
    '../supabase/migrations/20261026150000_sales_invoice_exchange_rate_integrity.sql',
    import.meta.url
  ),'utf8');
  await db.query(sql);

  const installation=(await db.query(`select
    to_regprocedure('public.sales_invoice_official_exchange_rate(bigint,date,bigint)')is not null resolver,
    to_regprocedure('public.save_sales_invoice_before_fx_guard(jsonb,bigint)')is not null inner_save,
    to_regprocedure('public.rebuild_customer_payment_receivable_fx(bigint,numeric,bigint)')is not null payment_fx,
    position('sales_invoice_official_exchange_rate' in
      pg_get_functiondef('public.save_sales_invoice(jsonb,bigint)'::regprocedure))>0 guarded_save`)).rows[0];
  assert.ok(Object.values(installation).every(value=>value===true),
    `Instalación incompleta: ${JSON.stringify(installation)}`);

  const invoices=(await db.query(`select count(*)::int count,
      min(invoice.exchange_rate) min_invoice,max(invoice.exchange_rate) max_invoice,
      min(tran.exchange_rate) min_transaction,max(tran.exchange_rate) max_transaction,
      min(journal.exchange_rate) min_journal,max(journal.exchange_rate) max_journal
    from invoice join "transaction" tran using(transaction_id)
    join journal using(journal_id)
    where invoice.subsidiary_id=24 and invoice.invoice_number=any($1)`,[numbers])).rows[0];
  assert.equal(invoices.count,5);
  for(const key of ['min_invoice','max_invoice','min_transaction','max_transaction','min_journal','max_journal']){
    assert.ok(close(invoices[key],158.9838,.000000001),`${key}=${invoices[key]}`);
  }

  const after=(await db.query(`select
      (select count(*)::int from customer_payment_application application
        join invoice using(invoice_id) where invoice_number=any($1)) application_count,
      (select coalesce(sum(application.amount),0) from customer_payment_application application
        join invoice using(invoice_id) where invoice_number=any($1)) application_total,
      (select coalesce(sum(amount),0) from bank_transaction bank_movement
        join customer_payment payment using(transaction_id) where payment_id=any($2)) bank_total,
      (select coalesce(sum(amount),0) from customer_payment_bank_fee where payment_id=any($2)) fee_total,
      (select count(*)::int from sales_invoice_fx_correction_audit audit
        join invoice using(invoice_id) where invoice.invoice_number=any($1)) audit_count,
      (select coalesce(sum(impact.credit_amount-impact.debit_amount),0)
        from customer_payment payment join gl_impact impact using(transaction_id)
        join chart_accounts account using(account_id)
        join accounting_books book using(accounting_book_id)
        where payment.payment_id=any($2) and account.account_number='422001'
          and book.is_primary) realized_gain`,[numbers,[69,70]])).rows[0];

  assert.equal(after.application_count,before.application_count,'Cambió la cantidad de aplicaciones.');
  assert.ok(close(after.application_total,before.application_total),'Cambió el total aplicado.');
  assert.ok(close(after.bank_total,before.bank_total),'Cambió el movimiento bancario.');
  assert.ok(close(after.fee_total,before.fee_total),'Cambió la comisión bancaria.');
  assert.equal(after.audit_count,5,'No se registraron las cinco correcciones.');
  assert.ok(close(after.realized_gain,42180.035163),`Ganancia realizada=${after.realized_gain}`);

  await db.query('commit');
  console.log(JSON.stringify({
    applied:true,invoicesCorrected:5,exchangeRate:158.9838,
    applicationsPreserved:true,bankPreserved:true,feesPreserved:true,
    realizedFxGain:Number(after.realized_gain),auditRows:after.audit_count,
    ...installation
  }));
}catch(error){
  await db.query('rollback').catch(()=>{});
  throw error;
}finally{
  await db.end();
}
