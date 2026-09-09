import assert from 'node:assert/strict';
import pg from 'pg';
import { readFile } from 'node:fs/promises';

process.loadEnvFile?.('.env');
const ref=new URL(process.env.SUPABASE_URL).hostname.split('.')[0];
const db=new pg.Client({host:process.env.SUPABASE_DB_HOST||'aws-0-us-east-1.pooler.supabase.com',port:6543,database:'postgres',user:`postgres.${ref}`,password:process.env.SUPABASE_DB_PASSWORD,ssl:{rejectUnauthorized:false}});
await db.connect();
try{
  await db.query('begin');
  await db.query(await readFile(new URL('../supabase/migrations/20260909180000_supplier_advances.sql',import.meta.url),'utf8'));
  const ctx=(await db.query(`select u.email,ucs.session_id from user_company_sessions ucs join users u using(user_id)
    join user_role_sessions urs using(session_id,user_id) join roles r using(role_id)
    where lower(r.role_name) in('administrador','administrator','admin') order by ucs.selected_at desc limit 1`)).rows[0];
  assert.ok(ctx);await db.query("select set_config('request.jwt.claims',$1,true)",[JSON.stringify(ctx)]);await db.query('set local role authenticated');
  const advance=(await db.query('select supplier_available_advances() value')).rows[0].value[0];assert.ok(advance,'Se requiere un anticipo disponible');
  const invoice=(await db.query(`select i.invoice_id from supplier_invoice i where i.supplier_id=$1 and i.currency_id=$2
    and i.subsidiary_id=active_subsidiary_id() and i.total_amount-coalesce((select sum(a.amount) from supplier_payment_application a where a.invoice_id=i.invoice_id),0)>=10 order by i.invoice_id limit 1`,[advance.supplierId,advance.currencyId])).rows[0];assert.ok(invoice);
  const bank=(await db.query('select bank_account_id,balance from bank_account where subsidiary_id=active_subsidiary_id() and currency_id=$1 and balance>=6 order by balance desc limit 1',[advance.currencyId])).rows[0];assert.ok(bank);
  const period=(await db.query(`select fiscal_period_id,start_date::text date from fiscal_periods where subsidiary_id=active_subsidiary_id()
    and not is_closed and not gl_closed and not ap_closed and not is_inactive order by start_date desc limit 1`)).rows[0];assert.ok(period);
  const local=(await db.query('select currency_id from subsidiaries where subsidiary_id=active_subsidiary_id()')).rows[0].currency_id;
  const rate=String(local)===String(advance.currencyId)?1:Number((await db.query('select spot_rate from exchange_rates where from_currency_id=$1 and to_currency_id=$2 and effective_date<=$3 order by effective_date desc limit 1',[advance.currencyId,local,period.date])).rows[0]?.spot_rate||1);
  const result=(await db.query('select save_supplier_payment_with_advances($1::jsonb,$2::bigint) value',[JSON.stringify({supplier_id:advance.supplierId,account_id:bank.bank_account_id,date:period.date,period_id:period.fiscal_period_id,rate,reference:'ADVANCE-TEST',memo:'Reversible advance test',applications:[{invoice_id:invoice.invoice_id,amount:10}],advances:[{advanceLineId:advance.id,amount:4}]}),null])).rows[0].value;
  assert.equal(Number(result.grossTotal),10);assert.equal(Number(result.advanceTotal),4);assert.equal(Number(result.cashTotal),6);
  assert.equal(Number((await db.query('select balance from bank_account where bank_account_id=$1',[bank.bank_account_id])).rows[0].balance),Number(bank.balance)-6);
  assert.equal(Number((await db.query('select amount from bank_transaction where transaction_id=(select transaction_id from supplier_payment where payment_id=$1)',[result.id])).rows[0].amount),-6);
  assert.equal(Number((await db.query('select amount from supplier_payment_application where payment_id=$1',[result.id])).rows[0].amount),10);
  assert.equal(Number((await db.query('select amount from supplier_advance_application where payment_id=$1',[result.id])).rows[0].amount),4);
  const remaining=(await db.query('select supplier_available_advances() value')).rows[0].value.find(row=>String(row.id)===String(advance.id));assert.equal(Number(remaining.available),Number(advance.available)-4);
  const lines=(await db.query('select account_id,debit,credit from journal_line where journal_id=$1',[result.journalId])).rows;
  assert.ok(lines.some(line=>String(line.account_id)===String(advance.accountId)&&Number(line.credit)===4));
  assert.equal(lines.reduce((sum,line)=>sum+Number(line.debit)-Number(line.credit),0),0);
  const bankAfterPartial=Number((await db.query('select balance from bank_account where bank_account_id=$1',[bank.bank_account_id])).rows[0].balance);
  const full=(await db.query('select save_supplier_payment_with_advances($1::jsonb,$2::bigint) value',[JSON.stringify({supplier_id:advance.supplierId,account_id:bank.bank_account_id,date:period.date,period_id:period.fiscal_period_id,rate,reference:'ADVANCE-FULL-TEST',memo:'Full advance test',applications:[{invoice_id:invoice.invoice_id,amount:5}],advances:[{advanceLineId:advance.id,amount:5}]}),null])).rows[0].value;
  assert.equal(Number(full.cashTotal),0);
  assert.equal(Number((await db.query('select balance from bank_account where bank_account_id=$1',[bank.bank_account_id])).rows[0].balance),bankAfterPartial);
  assert.equal(Number((await db.query('select count(*) n from bank_transaction where transaction_id=(select transaction_id from supplier_payment where payment_id=$1)',[full.id])).rows[0].n),0);
  const fullLines=(await db.query('select debit,credit from journal_line where journal_id=$1',[full.journalId])).rows;
  assert.equal(fullLines.reduce((sum,line)=>sum+Number(line.debit)-Number(line.credit),0),0);
  await db.query('rollback');
  console.log('PASS: moneda, anticipos parcial y total, factura por bruto, banco por neto, asiento balanceado y remanente disponible. Datos revertidos.');
}catch(error){await db.query('rollback');throw error;}finally{await db.end();}
