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
 ssl:{rejectUnauthorized:false},connectionTimeoutMillis:15000,
});

const migration=await readFile(new URL('../supabase/migrations/20261014100000_eight_column_balance_report.sql',import.meta.url),'utf8');
const close=(actual,expected,label)=>assert.ok(Math.abs(Number(actual)-Number(expected))<0.000001,`${label}: ${actual} != ${expected}`);
const one=async(text,params=[])=>(await db.query(text,params)).rows[0];

await db.connect();
try{
 await db.query('begin');
 await db.query("set local lock_timeout='5s'; set local statement_timeout='120s'");
 await db.query(migration);
 await db.query(migration); // La migración debe ser reaplicable.

 const context=await one(`
  select app_user.email,app_user.user_id,auth_user.id auth_id,company_session.session_id,
    company_session.subsidiary_id,role_session.role_id,company.currency_id,
    period.fiscal_period_id,period.start_date,
    type_record.transaction_type_id,status_record.status_id
  from user_company_sessions company_session
  join users app_user using(user_id)
  join auth.users auth_user on lower(auth_user.email)=lower(app_user.email)
  join user_role_sessions role_session on role_session.session_id=company_session.session_id and role_session.user_id=company_session.user_id
  join roles role_record using(role_id)
  join subsidiaries company using(subsidiary_id)
  join lateral(
    select fiscal_period_id,start_date from fiscal_periods
    where subsidiary_id=company_session.subsidiary_id
    order by start_date desc limit 1
  )period on true
  join lateral(select transaction_type_id from transaction_types order by transaction_type_id limit 1)type_record on true
  join lateral(select status_id from status order by status_id limit 1)status_record on true
  where lower(role_record.role_name)in('administrador','administrator','admin')
  order by company_session.selected_at desc limit 1
 `);
 assert.ok(context,'Se requiere una sesión administrativa con subsidiaria y periodo contable.');
 await db.query("select set_config('request.jwt.claims',$1,true)",[JSON.stringify({
  sub:context.auth_id,email:context.email,session_id:context.session_id,
 })]);

 const suffix=Date.now().toString(36).toUpperCase();
 const book=await one(`
  insert into accounting_books(book_name,subsidiary_id,base_currency_id,is_primary,is_active)
  values($1,$2,$3,false,true)returning accounting_book_id
 `,[`Libro prueba 8C ${suffix}`,context.subsidiary_id,context.currency_id]);

 const categories=[
  ['ACTIVO','Activo','Deudora','Balance General'],
  ['PASIVO','Pasivo','Acreedora','Balance General'],
  ['GASTO','Gasto','Deudora','Estado de Resultados'],
  ['INGRESO','Ingreso','Acreedora','Estado de Resultados'],
 ];
 const accounts={};
 for(const [key,category,nature,statement]of categories){
  const group=await one(`
   insert into account_group(group_code,group_name,category,level,nature,financial_statement)
   values($1,$2,$3,1,$4,$5)returning group_id
  `,[`8C-${key}-${suffix}`,`Grupo ${key} prueba 8 columnas`,category,nature,statement]);
  const account=await one(`
   insert into chart_accounts(account_number,account_name,account_group_id,level,nature,financial_statement,category,accepts_entries,is_inactive)
   values($1,$2,$3,4,$4,$5,$6,true,false)returning account_id
  `,[`8C${key.slice(0,2)}${suffix}`,`Cuenta ${key} prueba 8 columnas`,group.group_id,nature,statement,category]);
  await db.query('insert into account_subsidiaries(account_id,subsidiary_id,is_active)values($1,$2,true) on conflict(account_id,subsidiary_id)do update set is_active=true',[account.account_id,context.subsidiary_id]);
  accounts[key]=account.account_id;
 }
 const zeroAccount=await one(`
  insert into chart_accounts(account_number,account_name,account_group_id,level,nature,financial_statement,category,accepts_entries,is_inactive)
  select $1,'Cuenta cero prueba 8 columnas',account_group_id,4,nature,financial_statement,category,true,false
  from chart_accounts where account_id=$2 returning account_id
 `,[`8CZE${suffix}`,accounts.ACTIVO]);
 await db.query('insert into account_subsidiaries(account_id,subsidiary_id,is_active)values($1,$2,true) on conflict(account_id,subsidiary_id)do update set is_active=true',[zeroAccount.account_id,context.subsidiary_id]);
 const contraAsset=await one(`
  insert into chart_accounts(account_number,account_name,account_group_id,level,nature,financial_statement,category,accepts_entries,is_inactive)
  select $1,'Contraactivo prueba 8 columnas',account_group_id,4,'Acreedora',financial_statement,category,true,false
  from chart_accounts where account_id=$2 returning account_id
 `,[`8CCA${suffix}`,accounts.ACTIVO]);
 await db.query('insert into account_subsidiaries(account_id,subsidiary_id,is_active)values($1,$2,true) on conflict(account_id,subsidiary_id)do update set is_active=true',[contraAsset.account_id,context.subsidiary_id]);

 const transaction=await one(`
  insert into "transaction"(tran_number,tran_date,transaction_type_id,subsidiary_id,currency_id,
    exchange_rate,fiscal_period_id,total_amount,status_id)
  values($1,$2,$3,$4,$5,1,$6,1200,$7)returning transaction_id
 `,[`8COL-${suffix}`,context.start_date,context.transaction_type_id,context.subsidiary_id,context.currency_id,context.fiscal_period_id,context.status_id]);

 const entries=[
  [accounts.ACTIVO,1000,0],
  [contraAsset.account_id,0,50],
  [accounts.GASTO,250,0],
  [accounts.PASIVO,0,300],
  [accounts.INGRESO,0,900],
 ];
 for(const [accountId,debit,credit]of entries){
  await db.query(`
   insert into gl_impact(transaction_id,account_id,subsidiary_id,fiscal_period_id,accounting_book_id,
    debit_amount,credit_amount,debit_fx,credit_fx,posting_date)
   values($1,$2,$3,$4,$5,$6,$7,$6,$7,$8)
  `,[transaction.transaction_id,accountId,context.subsidiary_id,context.fiscal_period_id,book.accounting_book_id,debit,credit,context.start_date]);
 }

 const filters={subsidiaryId:Number(context.subsidiary_id),bookId:Number(book.accounting_book_id),dateFrom:context.start_date,dateTo:context.start_date,detailLevel:3,includeZero:false};
 const report=(await one('select run_eight_column_balance_report($1::jsonb)value',[filters])).value;
 assert.equal(report.rows.length,5,'Sin ceros solo deben aparecer las cinco cuentas con movimiento.');
 assert.equal(report.header.detailLevel,3);
 close(report.summary.debit,1250,'Débitos');
 close(report.summary.credit,1250,'Créditos');
 close(report.summary.debtorBalance,1250,'Saldo deudor');
 close(report.summary.creditorBalance,1250,'Saldo acreedor');
 close(report.summary.asset,950,'Activo');
 close(report.summary.liability,300,'Pasivo');
 close(report.summary.loss,250,'Pérdida');
 close(report.summary.gain,900,'Ganancia');
 close(report.summary.exerciseResult,650,'Resultado del ejercicio');
 close(report.summary.inventoryDifference,650,'Diferencia de inventario');
 close(report.summary.resultDifference,650,'Diferencia de resultado');
 close(report.summary.resultRow.liability,650,'Resultado en pasivo');
 close(report.summary.resultRow.loss,650,'Resultado en pérdida');
 close(report.summary.equalized.asset,950,'Activo igualado');
 close(report.summary.equalized.liability,950,'Pasivo igualado');
 close(report.summary.equalized.loss,900,'Pérdida igualada');
 close(report.summary.equalized.gain,900,'Ganancia igualada');
 assert.equal(report.summary.validations.allBalanced,true);
 const contraRow=report.rows.find(row=>Number(row.accountId)===Number(contraAsset.account_id));
 close(contraRow.asset,-50,'Contraactivo con signo negativo');
 close(contraRow.creditorBalance,50,'Saldo acreedor del contraactivo');
 assert.ok(report.rows.every(row=>Array.isArray(row.groupPath)&&row.groupPath.length>=1));

 const withZero=(await one('select run_eight_column_balance_report($1::jsonb)value',[{...filters,includeZero:true}])).value;
 assert.ok(withZero.rows.some(row=>Number(row.accountId)===Number(zeroAccount.account_id)&&Number(row.debit)===0),'La cuenta sin movimiento debe incluirse al solicitar ceros.');

 const options=(await one('select eight_column_balance_report_options()value')).value;
 assert.ok(options.subsidiaries.some(company=>Number(company.id)===Number(context.subsidiary_id)));
 assert.ok(options.books.some(item=>Number(item.id)===Number(book.accounting_book_id)&&item.isPrimary===false));
 assert.ok(options.books.filter(item=>Number(item.subsidiaryId)===Number(context.subsidiary_id)).every(item=>typeof item.isPrimary==='boolean'));

 const unauthorized=await one(`
  select company.subsidiary_id from subsidiaries company
  where company.subsidiary_id<>$1
    and not exists(select 1 from user_subsidiaries access where access.user_id=$2 and access.subsidiary_id=company.subsidiary_id)
  order by company.subsidiary_id limit 1
 `,[context.subsidiary_id,context.user_id]);
 if(unauthorized){
  await assert.rejects(
   db.query('select run_eight_column_balance_report($1::jsonb)',[{...filters,subsidiaryId:Number(unauthorized.subsidiary_id)}]),
   /no tiene acceso/i,
  );
 }
 await assert.rejects(db.query('select run_eight_column_balance_report($1::jsonb)',[{...filters,dateFrom:'2026-12-31',dateTo:'2026-01-01'}]),/fecha inicial/i);

 console.log(JSON.stringify({passed:true,rollback:true,subsidiaryId:Number(context.subsidiary_id),bookId:Number(book.accounting_book_id),rows:report.rows.length,summary:report.summary},null,2));
}finally{
 await db.query('rollback').catch(()=>{});
 await db.end();
}
