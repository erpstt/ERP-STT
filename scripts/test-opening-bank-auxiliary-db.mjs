import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import pg from 'pg';

process.loadEnvFile?.('.env');

const projectRef=new URL(process.env.SUPABASE_URL).hostname.split('.')[0];
const db=new pg.Client({
 host:process.env.SUPABASE_DB_HOST||'aws-0-us-east-1.pooler.supabase.com',
 port:Number(process.env.SUPABASE_DB_PORT||6543),database:process.env.SUPABASE_DB_NAME||'postgres',
 user:process.env.SUPABASE_DB_USER||`postgres.${projectRef}`,password:process.env.SUPABASE_DB_PASSWORD||process.env.PGPASSWORD,
 ssl:{rejectUnauthorized:false},connectionTimeoutMillis:15_000,
});
const migration=await readFile(new URL('../supabase/migrations/20261021100000_opening_bank_auxiliary.sql',import.meta.url),'utf8');
const zeroBalanceMigration=await readFile(new URL('../supabase/migrations/20261021110000_opening_bank_zero_balance.sql',import.meta.url),'utf8');
const one=async(text,params=[])=>(await db.query(text,params)).rows[0];

await db.connect();
try{
 await db.query('begin');
 await db.query("set local lock_timeout='8s'; set local statement_timeout='240s'");
 const installed=Boolean((await one("select to_regclass('public.opening_bank_accounts') is not null installed")).installed);
 if(!installed)await db.query(migration);
 await db.query(zeroBalanceMigration);

 const tables=(await db.query(`select relname from pg_class where relnamespace='public'::regnamespace
  and relname=any($1::text[])`,[['opening_bank_accounts','opening_bank_items','opening_bank_gl_links']])).rows.map(row=>row.relname).sort();
 assert.deepEqual(tables,['opening_bank_accounts','opening_bank_gl_links','opening_bank_items']);

 const definitions=Object.fromEntries((await db.query(`select proname,pg_get_functiondef(oid)definition from pg_proc
  where pronamespace='public'::regnamespace and proname=any($1::text[])`,[ [
   'opening_bank_stage','opening_bank_reconciliation','opening_bank_activate','opening_balance_validate','opening_balance_post',
   'opening_balance_reverse','protect_opening_bank_transaction','prevent_opening_balance_match','quadratic_book_values',
   'run_bank_reconciliation_report','quadratic_validate_match','quadratic_reconciliation_get',
   'quadratic_reconciliation_match','quadratic_reconciliation_auto_match',
  ] ])).rows.map(row=>[row.proname,row.definition]));
 assert.match(definitions.opening_bank_stage,/CHEQUE_EN_TRANSITO[\s\S]*original_value\s*>=\s*0/i);
 assert.match(definitions.opening_bank_stage,/DEPOSITO_EN_TRANSITO[\s\S]*original_value\s*<=\s*0/i);
 assert.match(definitions.opening_bank_stage,/ambos cero o conservar el mismo signo/i);
 assert.doesNotMatch(definitions.opening_bank_stage,/no existe saldo en el Libro Mayor para la cuenta contable y moneda vinculadas/i);
 assert.match(definitions.opening_bank_reconciliation,/ledger_original/i);
 assert.match(definitions.opening_bank_reconciliation,/ledger_local/i);
 assert.match(definitions.opening_bank_activate,/on conflict do nothing/i);
 assert.match(definitions.opening_bank_activate,/set balance\s*=\s*coalesce\(\(select sum\(movement\.amount\)/i);
 assert.match(definitions.opening_balance_validate,/status\s*=\s*'POSTED'[\s\S]*opening_bank_stage/i);
 assert.match(definitions.opening_balance_post,/opening_bank_activate/i);
 assert.match(definitions.opening_balance_reverse,/bank_reconciliation_match/i);
 assert.match(definitions.opening_balance_reverse,/quadratic_reconciliation_matches/i);
 assert.match(definitions.opening_balance_reverse,/quadratic_reconciliation_items/i);
 assert.match(definitions.opening_balance_reverse,/delete from public\.bank_transaction/i);
 assert.match(definitions.protect_opening_bank_transaction,/reconciliation_status/i);
 assert.match(definitions.protect_opening_bank_transaction,/value_date/i);
 assert.match(definitions.prevent_opening_balance_match,/SALDO_INICIAL/i);
 assert.match(definitions.quadratic_book_values,/is_opening_balance/i);
 assert.match(definitions.quadratic_book_values,/not coalesce\(b\.is_opening_balance,false\)/i);
 assert.match(definitions.run_bank_reconciliation_report,/bt\.tran_type\s*<>\s*'SALDO_INICIAL'/i);
 assert.match(definitions.quadratic_validate_match,/is distinct from new\.match_id/i);
 assert.match(definitions.quadratic_reconciliation_get,/DEPOSITO_EN_TRANSITO/i);
 assert.match(definitions.quadratic_reconciliation_get,/CHEQUE_EN_TRANSITO/i);
 assert.match(definitions.quadratic_reconciliation_match,/bt\.tran_type\s*=\s*'SALDO_INICIAL'/i);
 assert.match(definitions.quadratic_reconciliation_auto_match,/bt\.tran_type\s*<>\s*'SALDO_INICIAL'/i);

 const rls=(await db.query(`select relname,relrowsecurity from pg_class where relnamespace='public'::regnamespace
  and relname=any($1::text[])`,[tables])).rows;
 assert.ok(rls.every(row=>row.relrowsecurity), 'Las tres tablas del auxiliar deben tener RLS.');
 const privileges=await one(`select
  has_function_privilege('authenticated','opening_balance_validate(jsonb)','execute') authenticated_validate,
  has_function_privilege('anon','opening_balance_validate(jsonb)','execute') anon_validate,
  has_function_privilege('authenticated','opening_bank_stage(bigint,jsonb)','execute') direct_stage,
  has_function_privilege('authenticated','opening_bank_activate(bigint)','execute') direct_activate,
  has_table_privilege('authenticated','opening_bank_items','select') item_select,
  has_table_privilege('authenticated','opening_bank_items','insert') item_insert`);
 assert.equal(privileges.authenticated_validate,true);
 assert.equal(privileges.anon_validate,false);
 assert.equal(privileges.direct_stage,false);
 assert.equal(privileges.direct_activate,false);
 assert.equal(privileges.item_select,true);
 assert.equal(privileges.item_insert,false);

 const fixture=await one(`
  select ucs.session_id,u.user_id,u.email,auth_user.id auth_id,s.subsidiary_id,s.country_id,s.currency_id,currency.currency_code,
   bank.bank_id,bank.bank_code,bank_account.account_id ledger_account_id,ledger.account_number ledger_account_number,
   transition.account_id transition_account_id,transition.account_number transition_account_number,
   zero_ledger.account_id zero_ledger_account_id,
   period.opening_date,period.end_date,asset_state.asset_count
  from user_company_sessions ucs
  join user_role_sessions urs on urs.session_id=ucs.session_id and urs.user_id=ucs.user_id
  join roles role on role.role_id=urs.role_id and lower(role.role_name)in('administrador','administrator','admin')
  join users u on u.user_id=ucs.user_id and u.is_active
  join auth.users auth_user on lower(auth_user.email)=lower(u.email)
  join user_subsidiaries access on access.user_id=u.user_id and access.subsidiary_id=ucs.subsidiary_id
  join subsidiaries s on s.subsidiary_id=ucs.subsidiary_id and s.is_active
  join currencies currency on currency.currency_id=s.currency_id
  join lateral(
   select existing.bank_id,existing.account_id from bank_account existing
   join account_subsidiaries scope on scope.account_id=existing.account_id and scope.subsidiary_id=existing.subsidiary_id and scope.is_active
   join chart_accounts account on account.account_id=existing.account_id and account.accepts_entries and not account.is_inactive
   where existing.subsidiary_id=s.subsidiary_id and existing.currency_id=s.currency_id and not coalesce(existing.is_credit_card,false)
   order by existing.bank_account_id limit 1
  )bank_account on true
  join banks bank on bank.bank_id=bank_account.bank_id
  join chart_accounts ledger on ledger.account_id=bank_account.account_id
  join chart_accounts transition on transition.account_number='319999'and transition.accepts_entries and not transition.is_inactive
  join account_subsidiaries transition_scope on transition_scope.account_id=transition.account_id
   and transition_scope.subsidiary_id=s.subsidiary_id and transition_scope.is_active
  join lateral(
   select candidate.account_id from chart_accounts candidate
   join account_subsidiaries candidate_scope on candidate_scope.account_id=candidate.account_id
    and candidate_scope.subsidiary_id=s.subsidiary_id and candidate_scope.is_active
    where candidate.accepts_entries and not candidate.is_inactive
    and candidate.account_id not in(bank_account.account_id,transition.account_id)
    order by case when candidate.account_type=ledger.account_type then 0 else 1 end,candidate.account_id limit 1
  )zero_ledger on true
  join lateral(
   select greatest(fp.start_date,least((fp.end_date-1)::date,current_date-1))::date opening_date,fp.end_date from fiscal_periods fp
   where fp.subsidiary_id=s.subsidiary_id and not fp.is_closed and not coalesce(fp.gl_closed,false)
    and not coalesce(fp.is_inactive,false)and fp.start_date<fp.end_date and fp.start_date<=current_date
   order by fp.start_date desc limit 1
  )period on true
  cross join lateral(
   select count(*)asset_count from asset existing_asset
   where existing_asset.subsidiary_id=s.subsidiary_id
    and existing_asset.purchase_date<=period.opening_date
    and existing_asset.opening_reversed_at is null
  )asset_state
  where(select count(*)from accounting_books book where book.subsidiary_id=s.subsidiary_id and book.is_primary and book.is_active)=1
  order by asset_state.asset_count,ucs.selected_at desc limit 1`);
 assert.ok(fixture,'Se requiere una subsidiaria administrable con cuenta bancaria local, período abierto, libro principal y cuenta 319999.');
 assert.equal(Number(fixture.asset_count),0,'La prueba necesita una subsidiaria sin activos preexistentes en la fecha de apertura.');
 await db.query("select set_config('request.jwt.claims',$1,true)",[JSON.stringify({
  sub:fixture.auth_id,email:fixture.email,session_id:fixture.session_id,role:'authenticated',
 })]);
 assert.equal(String((await one('select active_subsidiary_id()sid')).sid),String(fixture.subsidiary_id));

 // Isolate the scenario from a real opening. ROLLBACK restores every status.
 await db.query("update opening_balance_runs set status='REVERSED' where subsidiary_id=$1 and status<>'REVERSED'",[fixture.subsidiary_id]);
 const accountNumber=`000TEST${Date.now()}`;
 const createdAccount=await one(`insert into bank_account(account_number,bank_id,subsidiary_id,country_id,currency_id,account_id,balance)
  values($1,$2,$3,$4,$5,$6,0)returning bank_account_id`,[
  accountNumber,fixture.bank_id,fixture.subsidiary_id,fixture.country_id,fixture.currency_id,fixture.ledger_account_id,
 ]);
 const zeroAccountNumber=`000ZERO${Date.now()}`;
 const zeroAccount=await one(`insert into bank_account(account_number,bank_id,subsidiary_id,country_id,currency_id,account_id,balance)
  values($1,$2,$3,$4,$5,$6,0)returning bank_account_id`,[
  zeroAccountNumber,fixture.bank_id,fixture.subsidiary_id,fixture.country_id,fixture.currency_id,fixture.zero_ledger_account_id,
 ]);
 const openingDate=new Date(fixture.opening_date).toISOString().slice(0,10);
 const nextDate=new Date(`${openingDate}T00:00:00Z`);nextDate.setUTCDate(nextDate.getUTCDate()+1);
 const movementDate=nextDate.toISOString().slice(0,10);
 const basePayload={expectedSubsidiaryId:String(fixture.subsidiary_id),openingDate,loadType:'FISCAL_YEAR',
  transitionAccountId:String(fixture.transition_account_id),assets:[],pending:[],rows:[
   {sourceType:'GL',sourceRow:2,account:fixture.ledger_account_number,currency:fixture.currency_code,debit:'1000',credit:'0',debitFx:'1000',creditFx:'0',note:'Banco inicial de prueba'},
   {sourceType:'GL',sourceRow:3,account:fixture.transition_account_number,currency:fixture.currency_code,debit:'0',credit:'1000',debitFx:'0',creditFx:'1000',note:'Contrapartida de prueba'},
  ]};
 // Simulates a run posted before this migration, then attaches the sixth
 // auxiliary without posting the general ledger a second time.
 const legacyPreview=(await one('select opening_balance_validate_before_opening_bank($1::jsonb)value',[JSON.stringify(basePayload)])).value;
 const runId=legacyPreview.run.id;
 const legacyPost=(await one('select opening_balance_post_before_opening_bank($1)value',[runId])).value;
 assert.ok(legacyPost.journalId);
 const glImpactCount=Number((await one(`select count(*)n from gl_impact impact join journal on journal.transaction_id=impact.transaction_id
  where journal.journal_id=$1`,[legacyPost.journalId])).n);
 assert.equal(glImpactCount,2);

 const banks=[
  {sourceRow:2,bankCode:fixture.bank_code,accountNumber,currency:fixture.currency_code,recordType:'SALDO_CONCILIADO',transactionDate:openingDate,valueDate:openingDate,reference:'SALDO-TEST',beneficiary:'',description:'Saldo conciliado',originalAmount:'900',localEquivalent:'900'},
  {sourceRow:3,bankCode:fixture.bank_code,accountNumber,currency:fixture.currency_code,recordType:'DEPOSITO_EN_TRANSITO',transactionDate:openingDate,valueDate:'',reference:'DEP-TEST',beneficiary:'Cliente',description:'Depósito inicial',originalAmount:'200',localEquivalent:'200'},
  {sourceRow:4,bankCode:fixture.bank_code,accountNumber,currency:fixture.currency_code,recordType:'CHEQUE_EN_TRANSITO',transactionDate:openingDate,valueDate:'',reference:'CHQ-TEST',beneficiary:'Proveedor',description:'Cheque inicial',originalAmount:'-100',localEquivalent:'-100'},
  {sourceRow:5,bankCode:fixture.bank_code,accountNumber:zeroAccountNumber,currency:fixture.currency_code,recordType:'SALDO_CONCILIADO',transactionDate:openingDate,valueDate:openingDate,reference:'SALDO-CERO',beneficiary:'',description:'Saldo conciliado cero',originalAmount:'0',localEquivalent:'0'},
  {sourceRow:6,bankCode:fixture.bank_code,accountNumber:zeroAccountNumber,currency:fixture.currency_code,recordType:'DEPOSITO_EN_TRANSITO',transactionDate:openingDate,valueDate:'',reference:'DEP-CERO',beneficiary:'Cliente',description:'DepÃ³sito inicial en cuenta neta cero',originalAmount:'100',localEquivalent:'100'},
  {sourceRow:7,bankCode:fixture.bank_code,accountNumber:zeroAccountNumber,currency:fixture.currency_code,recordType:'CHEQUE_EN_TRANSITO',transactionDate:openingDate,valueDate:'',reference:'CHQ-CERO',beneficiary:'Proveedor',description:'Cheque inicial en cuenta neta cero',originalAmount:'-100',localEquivalent:'-100'},
 ];
 const bankPreview=(await one('select opening_balance_validate($1::jsonb)value',[JSON.stringify({...basePayload,rows:[],banks})])).value;
 assert.equal(String(bankPreview.run.id),String(runId));
 assert.equal(bankPreview.bankSummary.balanced,true);
 assert.equal(Number(bankPreview.bankSummary.openingLocal),900);
 assert.equal(Number(bankPreview.bankSummary.transitDepositsLocal),300);
 assert.equal(Number(bankPreview.bankSummary.transitChecksLocal),200);
 assert.ok(bankPreview.bankReconciliation.every(row=>Math.abs(Number(row.difference))<.005&&Math.abs(Number(row.localDifference))<.005));
 const bankPost=(await one('select opening_balance_post($1)value',[runId])).value;
 assert.equal(bankPost.bankOnly,true);
 assert.equal(Number(bankPost.bankItemsCreated),6);
 assert.equal(Number((await one(`select count(*)n from gl_impact impact join journal on journal.transaction_id=impact.transaction_id
  where journal.journal_id=$1`,[legacyPost.journalId])).n),glImpactCount,'El auxiliar no debe duplicar impactos del Mayor.');

 const transactions=(await db.query(`select bank_tran_id,tran_type,amount,reconciliation_status,is_opening_balance
  from bank_transaction where bank_account_id=$1 order by amount desc`,[createdAccount.bank_account_id])).rows;
 assert.deepEqual(transactions.map(row=>[row.tran_type,Number(row.amount),row.reconciliation_status,row.is_opening_balance]),[
  ['SALDO_INICIAL',900,'CONCILIADO',true],['DEPOSITO_EN_TRANSITO',200,'PENDIENTE_EN_TRANSITO',true],['CHEQUE_EN_TRANSITO',-100,'PENDIENTE_EN_TRANSITO',true],
 ]);
 assert.equal(Number((await one('select balance from bank_account where bank_account_id=$1',[createdAccount.bank_account_id])).balance),1000);
 assert.equal(Number((await one('select balance from bank_account where bank_account_id=$1',[zeroAccount.bank_account_id])).balance),0);
 assert.deepEqual((await db.query(`select tran_type,amount from bank_transaction where bank_account_id=$1 order by amount desc`,[zeroAccount.bank_account_id])).rows.map(row=>[row.tran_type,Number(row.amount)]),[
  ['DEPOSITO_EN_TRANSITO',100],['SALDO_INICIAL',0],['CHEQUE_EN_TRANSITO',-100],
 ]);
 const secondPost=(await one('select opening_balance_post($1)value',[runId])).value;
 assert.equal(Number(secondPost.bankItemsCreated),0);
 assert.equal(Number((await one('select count(*)n from bank_transaction where bank_account_id=$1',[createdAccount.bank_account_id])).n),3);

 await db.query(`insert into bank_transaction(tran_date,value_date,bank_account_id,amount,tran_type,reference_number,description)
  values($1,$1,$2,50,'TEST_POST_APERTURA','TEST-50','Movimiento operativo de control')`,[movementDate,createdAccount.bank_account_id]);
 const quadratic=await one('select * from quadratic_book_values($1,$2,$3)',[
  createdAccount.bank_account_id,Number(openingDate.slice(0,4)),Number(openingDate.slice(5,7)),
 ]);
 assert.equal(Number(quadratic.start_balance),1000,'Todos los ítems iniciales deben formar el saldo inicial.');
 assert.equal(Number(quadratic.receipts),50,'Solo el movimiento operativo debe ser ingreso del mes.');
 assert.equal(Number(quadratic.disbursements),0,'El cheque inicial no debe figurar como egreso del mes.');
 assert.equal(Number(quadratic.end_balance),1050);
 await db.query("delete from bank_transaction where bank_account_id=$1 and tran_type='TEST_POST_APERTURA'",[createdAccount.bank_account_id]);

 const report=(await one('select run_bank_reconciliation_report($1::jsonb)value',[JSON.stringify({
  bankAccountId:createdAccount.bank_account_id,dateFrom:openingDate,dateTo:movementDate,bankView:'WORKSPACE',page:1,pageSize:50,
 })])).value;
 assert.equal(report.rows.some(row=>row.transaction_type==='SALDO_INICIAL'),false);
 assert.equal(Number(report.summary.openingBalance),1000);
 assert.equal(Number(report.summary.transitDeposits),200);
 assert.equal(Number(report.summary.transitPayments),100);

 await db.query('savepoint before_matching');
 const statementId=(await one(`select import_bank_statement($1,$2,0,1100,'opening-bank-test.csv',$3::jsonb)id`,[
  createdAccount.bank_account_id,openingDate,JSON.stringify([
   {date:openingDate,valueDate:openingDate,reference:'DEP-TEST',description:'Depósito',beneficiary:'Cliente',amount:200},
   {date:openingDate,valueDate:openingDate,reference:'SALDO-TEST',description:'Saldo',beneficiary:'',amount:900},
  ]),
 ])).id;
 const statementLines=(await db.query('select statement_line_id,amount from bank_statement_line where statement_id=$1',[statementId])).rows;
 const deposit=transactions.find(row=>row.tran_type==='DEPOSITO_EN_TRANSITO');
 const opening=transactions.find(row=>row.tran_type==='SALDO_INICIAL');
 await db.query('select match_bank_transaction($1,$2,$3)',[deposit.bank_tran_id,statementLines.find(row=>Number(row.amount)===200).statement_line_id,openingDate]);
 assert.equal((await one('select reconciliation_status from bank_transaction where bank_tran_id=$1',[deposit.bank_tran_id])).reconciliation_status,'CONCILIADO');
 await db.query('savepoint reject_opening_match');
 await assert.rejects(db.query('select match_bank_transaction($1,$2,$3)',[
  opening.bank_tran_id,statementLines.find(row=>Number(row.amount)===900).statement_line_id,openingDate,
 ]),/saldo bancario inicial/i);
 await db.query('rollback to savepoint reject_opening_match');
 await db.query('savepoint reject_matched_reversal');
 await assert.rejects(db.query('select opening_balance_reverse($1)',[runId]),/partidas iniciales ya conciliadas/i);
 await db.query('rollback to savepoint reject_matched_reversal');
 await db.query('rollback to savepoint before_matching');

 const reversed=(await one('select opening_balance_reverse($1)value',[runId])).value;
 assert.equal(Number(reversed.bankItemsReversed),6);
 assert.equal(Number((await one('select count(*)n from bank_transaction where bank_account_id=$1',[createdAccount.bank_account_id])).n),0);
 assert.equal(Number((await one('select count(*)n from bank_transaction where bank_account_id=$1',[zeroAccount.bank_account_id])).n),0);
 assert.equal(Number((await one('select balance from bank_account where bank_account_id=$1',[createdAccount.bank_account_id])).balance),0);
 assert.equal((await one('select status from opening_balance_runs where id=$1',[runId])).status,'REVERSED');

 console.log('OK: migración, seguridad, conciliación GL/auxiliar, carga posterior, idempotencia, prueba de efectivo, punteo y reversión bancarios verificados con ROLLBACK.');
}finally{
 await db.query('rollback').catch(()=>{});
 await db.end();
}
