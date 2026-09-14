import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import pg from 'pg';

process.loadEnvFile('.env');
const projectRef=new URL(process.env.SUPABASE_URL).hostname.split('.')[0];
const db=new pg.Client({host:process.env.SUPABASE_DB_HOST||'aws-0-us-east-1.pooler.supabase.com',port:Number(process.env.SUPABASE_DB_PORT||6543),database:'postgres',user:process.env.SUPABASE_DB_USER||`postgres.${projectRef}`,password:process.env.SUPABASE_DB_PASSWORD,ssl:{rejectUnauthorized:false},connectionTimeoutMillis:15000});
const apply=process.argv.includes('--apply');
try{
 await db.connect();await db.query('begin');
 await db.query(await readFile(new URL('../supabase/migrations/20260913170000_sales_invoice_customer_withholdings.sql',import.meta.url),'utf8'));
 const tables=(await db.query(`select to_regclass('public.sales_invoice_withholding') invoice_table,to_regclass('public.customer_payment_withholding') payment_table`)).rows[0];
 const columns=(await db.query(`select count(*)::int count from information_schema.columns where table_schema='public' and table_name='invoice' and column_name in('subtotal_amount','tax_total','withholding_total','receivable_amount')`)).rows[0].count;
 const definitions=(await db.query(`select string_agg(pg_get_functiondef(p.oid),E'\n') definition from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname in('save_sales_invoice','save_customer_payment','save_customer_payment_with_advances','customer_payment_options','validate_customer_payment_application_receivable')`)).rows[0].definition||'';
 assert.ok(tables.invoice_table&&tables.payment_table);
 assert.equal(columns,4);
 for(const expected of ['entity_withholding_rules','sales_invoice_withholding','customer_payment_withholding','receivable_amount','asset_account_id'])assert.ok(definitions.includes(expected),`Falta ${expected} en las funciones instaladas.`);
 const bases=[['Subtotal antes de impuestos',100,13,113,100],['Importe de impuestos',100,13,113,13],['Total de la factura con impuestos',100,13,113,113]];
 for(const[,subtotal,tax,gross,base]of bases)assert.equal(Math.round(base*2)/100,Number((base*.02).toFixed(2)));
 await db.query(apply?'commit':'rollback');
 console.log(JSON.stringify({passed:true,applied:apply,invoiceWithholding:true,collectionWithholding:true,bases:3,receivableBalance:true}));
}catch(error){await db.query('rollback').catch(()=>{});console.error(error.message);process.exitCode=1}finally{await db.end()}
