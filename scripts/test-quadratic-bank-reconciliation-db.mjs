import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import pg from 'pg';

process.loadEnvFile?.('.env');
const ref=new URL(process.env.SUPABASE_URL).hostname.split('.')[0];
const db=new pg.Client({
  host:process.env.SUPABASE_DB_HOST||'aws-0-us-east-1.pooler.supabase.com',
  port:Number(process.env.SUPABASE_DB_PORT||6543),database:'postgres',
  user:process.env.SUPABASE_DB_USER||`postgres.${ref}`,
  password:process.env.SUPABASE_DB_PASSWORD||process.env.PGPASSWORD,
  ssl:{rejectUnauthorized:false},connectionTimeoutMillis:15000
});
const scalar=async(sql,args=[]) => (await db.query(sql,args)).rows[0]?.value;
await db.connect();
try{
  await db.query('begin');
  await db.query("set local lock_timeout='10s';set local statement_timeout='120s'");
  const installed=(await db.query("select to_regprocedure('public.quadratic_reconciliation_get(bigint)') is not null value")).rows[0].value;
  if(!installed)await db.query(await readFile(new URL('../supabase/migrations/20261001140000_quadratic_bank_reconciliation.sql',import.meta.url),'utf8'));
  const context=(await db.query(`select u.email,au.id auth_id,ucs.session_id,ucs.subsidiary_id,ba.bank_account_id
    from user_company_sessions ucs join user_role_sessions urs using(session_id,user_id)
    join roles r on r.role_id=urs.role_id and lower(r.role_name)in('administrador','administrator','admin')
    join users u using(user_id)join auth.users au on lower(au.email)=lower(u.email)
    join bank_account ba on ba.subsidiary_id=ucs.subsidiary_id
    order by ucs.selected_at desc,ba.bank_account_id limit 1`)).rows[0];
  assert.ok(context,'Se requiere una sesion administrativa activa con cuenta bancaria.');
  await db.query("select set_config('request.jwt.claims',$1,true)",[JSON.stringify({
    sub:context.auth_id,email:context.email,session_id:context.session_id,role:'authenticated'
  })]);
  const year=2198,month=1,d1=`${year}-01-01`,d2=`${year}-01-31`,stamp=`QBR-${Date.now()}`;
  const opening=Number((await db.query('select coalesce(sum(amount),0)::numeric value from bank_transaction where bank_account_id=$1 and tran_date<$2',[context.bank_account_id,d1])).rows[0].value);
  const statement=(await db.query(`insert into bank_statement(statement_date,bank_account_id,opening_balance,closing_balance,source_file_name)
    values($1,$2,$3,$4,$5)returning statement_id`,[d2,context.bank_account_id,opening,opening+60,`${stamp}.csv`])).rows[0];
  const deposit=(await db.query(`insert into bank_transaction(tran_date,value_date,bank_account_id,amount,tran_type,reference_number,description)
    values($1,$1,$2,100,'TEST',$3,'Ingreso de prueba')returning bank_tran_id`,[`${year}-01-10`,context.bank_account_id,`${stamp}-IN`])).rows[0];
  const payment=(await db.query(`insert into bank_transaction(tran_date,value_date,bank_account_id,amount,tran_type,reference_number,description)
    values($1,$1,$2,-40,'TEST',$3,'Egreso de prueba')returning bank_tran_id`,[`${year}-01-12`,context.bank_account_id,`${stamp}-OUT`])).rows[0];
  await db.query(`insert into bank_statement_line(statement_id,bank_date,value_date,reference,description,amount,source_row)
    values($1,$2,$2,$3,'Ingreso extracto',100,1),($1,$4,$4,$5,'Egreso extracto',-40,2)`,[
    statement.statement_id,`${year}-01-10`,`${stamp}-IN`,`${year}-01-12`,`${stamp}-OUT`
  ]);
  await db.query('set local role authenticated');
  const options=await scalar('select quadratic_reconciliation_options()value');
  assert.equal(options.permissions.manage,true);assert.equal(options.permissions.approve,true);
  assert.ok(options.accounts.some(row=>String(row.id)===String(context.bank_account_id)));
  assert.equal(options.accounts.every(row=>String(row.subsidiaryId)===String(context.subsidiary_id)),true);
  const saved=await scalar('select quadratic_reconciliation_save($1::jsonb)value',[JSON.stringify({
    bankAccountId:context.bank_account_id,periodYear:year,periodMonth:month,
    bankStartBalance:opening,bankTotalReceipts:100,bankTotalDisbursements:40,bankEndBalance:opening+60,
    notes:'Prueba de integracion con rollback'
  })]);
  const id=saved.id;assert.ok(id);assert.equal(saved.created,true);
  assert.equal(saved.result.matrix.balanced,true);assert.equal(saved.result.continuity.required,false);
  const january=await scalar('select quadratic_reconciliation_list($1::jsonb)value',[JSON.stringify({bankAccountId:context.bank_account_id,periodYear:year,periodMonth:1})]);
  const februaryBefore=await scalar('select quadratic_reconciliation_list($1::jsonb)value',[JSON.stringify({bankAccountId:context.bank_account_id,periodYear:year,periodMonth:2})]);
  assert.equal(january.rows.length,1);assert.equal(String(january.rows[0].id),String(id));assert.equal(februaryBefore.rows.length,0);
  const automatic=await scalar('select quadratic_reconciliation_auto_match($1,$2)value',[id,3]);
  assert.equal(Number(automatic.matched),2);
  let detail=await scalar('select quadratic_reconciliation_get($1)value',[id]);
  assert.equal(detail.matches.length,2);assert.equal(detail.statementLines.every(row=>row.matchId),true);
  assert.equal(detail.bookTransactions.every(row=>row.matchId),true);
  const extra=await scalar('select quadratic_reconciliation_item_save($1,$2::jsonb)value',[id,JSON.stringify({
    itemType:'UNRECORDED_BANK_CREDIT',description:'Credito bancario de prueba',referenceNumber:`${stamp}-ADJ`,
    transactionDate:`${year}-01-20`,amount:10
  })]);
  assert.equal(Number(extra.matrix.bookAdjustments.receipts),10);assert.equal(extra.matrix.balanced,false);
  await scalar('select quadratic_reconciliation_item_delete($1,$2)value',[id,extra.id]);
  detail=await scalar('select quadratic_reconciliation_get($1)value',[id]);assert.equal(detail.matrix.balanced,true);
  await scalar("select quadratic_reconciliation_transition($1,'in_review')value",[id]);
  await scalar("select quadratic_reconciliation_transition($1,'approved')value",[id]);
  const closed=await scalar("select quadratic_reconciliation_transition($1,'closed')value",[id]);
  assert.equal(closed.status,'closed');assert.equal(closed.result.matrix.balanced,true);
  const next=await scalar('select quadratic_reconciliation_save($1::jsonb)value',[JSON.stringify({
    bankAccountId:context.bank_account_id,periodYear:year,periodMonth:2,
    bankStartBalance:opening+60,bankTotalReceipts:0,bankTotalDisbursements:0,bankEndBalance:opening+60
  })]);
  assert.equal(next.result.continuity.required,true);assert.equal(next.result.continuity.ok,true);
  assert.equal(String(next.result.continuity.previousReconciliationId),String(id));
  await db.query('savepoint closed_guard');
  await assert.rejects(db.query('update bank_transaction set description=description where bank_tran_id=$1',[deposit.bank_tran_id]),/periodo cerrado/i);
  await db.query('rollback to savepoint closed_guard');
  await db.query('rollback');
  console.log(JSON.stringify({database:true,rlsAndPermissions:true,activeSubsidiaryScope:true,monthlyListFilter:true,fourColumnMatrix:true,autoMatch:2,
    itemImpacts:true,statusWorkflow:true,continuity:true,closedPeriodLock:true,rollback:true}));
}catch(error){await db.query('rollback').catch(()=>{});throw error}
finally{await db.end()}
