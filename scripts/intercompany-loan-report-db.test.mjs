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
  ssl:{rejectUnauthorized:false},
  connectionTimeoutMillis:15000
});

const migration=await readFile(new URL(
  '../supabase/migrations/20261023150000_intercompany_loan_report.sql',
  import.meta.url
),'utf8');
const amount=value=>Number(value??0);
const close=(actual,expected)=>Math.abs(amount(actual)-expected)<.0001;
const iso=value=>value instanceof Date
  ?value.toISOString().slice(0,10):String(value).slice(0,10);

await db.connect();
try{
  await db.query('begin');
  await db.query("set local statement_timeout='120s'");
  await db.query(migration);

  const {rows:[context]}=await db.query(`
    select session.session_id,users.email,auth_user.id auth_user_id,
      subsidiary.subsidiary_id,subsidiary.country_id,
      subsidiary.currency_id local_currency_id,
      period.fiscal_period_id,period.start_date,period.end_date,
      book.accounting_book_id
    from public.user_company_sessions session
    join public.users users using(user_id)
    join auth.users auth_user on lower(auth_user.email)=lower(users.email)
    join public.subsidiaries subsidiary using(subsidiary_id)
    join lateral(
      select fiscal_period_id,start_date,end_date
      from public.fiscal_periods candidate
      where candidate.subsidiary_id=subsidiary.subsidiary_id
        and candidate.end_date>candidate.start_date
      order by candidate.end_date desc limit 1
    )period on true
    join lateral(
      select accounting_book_id from public.accounting_books candidate
      where candidate.subsidiary_id=subsidiary.subsidiary_id
        and candidate.is_primary and candidate.is_active
      order by accounting_book_id limit 1
    )book on true
    where exists(
      select 1 from public.account_subsidiaries scope
      join public.chart_accounts account using(account_id)
      where scope.subsidiary_id=subsidiary.subsidiary_id and scope.is_active
        and account.account_number='119001'
    )and exists(
      select 1 from public.account_subsidiaries scope
      join public.chart_accounts account using(account_id)
      where scope.subsidiary_id=subsidiary.subsidiary_id and scope.is_active
        and account.account_number='219001'
    )
    order by session.selected_at desc limit 1
  `);
  assert.ok(context,'No existe una subsidiaria accesible con libro y período.');

  await db.query("select set_config('request.jwt.claims',$1,true)",[
    JSON.stringify({
      sub:context.auth_user_id,email:context.email,
      session_id:context.session_id,role:'authenticated'
    })
  ]);

  const {rows:accounts}=await db.query(`
    select account_id,account_number from public.chart_accounts
    where account_number in('110001','113002','119001','219001')
  `);
  const account=Object.fromEntries(accounts.map(row=>[
    row.account_number,Number(row.account_id)
  ]));
  assert.ok(account['119001']&&account['219001']&&account['113002']);
  const offsetAccount=account['110001']||Number((await db.query(`
    select account.account_id from public.chart_accounts account
    join public.account_subsidiaries scope using(account_id)
    where scope.subsidiary_id=$1 and scope.is_active
      and not account.is_summary and not account.is_inactive
      and account.account_number not in('113002','119001','219001')
    order by account.account_id limit 1
  `,[context.subsidiary_id])).rows[0]?.account_id);
  assert.ok(offsetAccount,'No existe una cuenta de contrapartida para la prueba.');

  const {rows:[foreign]}=await db.query(`
    select currency.currency_id
    from public.subsidiary_currencies allowed
    join public.currencies currency using(currency_id)
    where allowed.subsidiary_id=$1 and currency.currency_id<>$2
    order by currency.currency_id limit 1
  `,[context.subsidiary_id,context.local_currency_id]);
  assert.ok(foreign,'Se requieren dos monedas para probar la separación.');

  const {rows:[engine]}=await db.query(`
    select transaction_type_id,status_id from public."transaction"
    order by transaction_id limit 1
  `);
  assert.ok(engine,'No existe configuración del motor de transacciones.');

  const suffix=`${Date.now()}-${Math.floor(Math.random()*100000)}`;
  const companyIds=[];
  for(const [index,name]of['Compañía prueba A','Compañía prueba B'].entries()){
    const {rows:[company]}=await db.query(`
      insert into public.related_companies(
        code,name,identification,subsidiary_id,is_inactive,country_id
      )values($1,$2,$3,$4,false,$5)returning related_company_id
    `,[`TST-IC-${index}-${suffix}`,name,`TST-ID-${index}-${suffix}`,
      context.subsidiary_id,context.country_id]);
    companyIds.push(Number(company.related_company_id));
    await db.query(`
      insert into public.related_company_subsidiaries(
        related_company_id,subsidiary_id
      )values($1,$2)on conflict do nothing
    `,[company.related_company_id,context.subsidiary_id]);
  }

  const periodStart=new Date(context.start_date);
  const periodEnd=new Date(context.end_date);
  const from=new Date(periodStart);from.setUTCDate(from.getUTCDate()+1);
  const to=new Date(from);to.setUTCDate(Math.min(
    from.getUTCDate()+1,periodEnd.getUTCDate()
  ));

  const filters={
    subsidiaryIds:[Number(context.subsidiary_id)],
    bookId:Number(context.accounting_book_id),dateFrom:iso(from),dateTo:iso(to),
    currencyIds:[Number(foreign.currency_id),Number(context.local_currency_id)],
    search:suffix
  };
  const {rows:[baselineResponse]}=await db.query(
    `select public.run_intercompany_loan_report($1::jsonb)report`,[
      JSON.stringify(filters)
    ]
  );
  const baseline=baselineResponse.report;
  const baselineForeign=baseline.currencySummaries.find(row=>
    Number(row.currencyId)===Number(foreign.currency_id)
  )??{};
  const baselineLocal=baseline.localCurrencySummaries.find(row=>
    Number(row.subsidiaryId)===Number(context.subsidiary_id)
  )??{};

  async function movement({label,date,currencyId,rate,targetAccount,
    debit=0,credit=0,relatedCompanyId=null}){
    const number=`TST-IC-${label}-${suffix}`;
    const {rows:[tran]}=await db.query(`
      insert into public."transaction"(
        tran_number,tran_date,transaction_type_id,subsidiary_id,currency_id,
        exchange_rate,fiscal_period_id,total_amount,status_id
      )values($1,$2,$3,$4,$5,$6,$7,$8,$9)returning transaction_id
    `,[number,iso(date),engine.transaction_type_id,context.subsidiary_id,
      currencyId,rate,context.fiscal_period_id,debit+credit,engine.status_id]);
    const {rows:[journal]}=await db.query(`
      insert into public.journal(
        journal_number,journal_date,transaction_id,subsidiary_id,currency_id,
        fiscal_period_id,exchange_rate,memo,journal_type,total_debit,
        total_credit,status
      )values($1,$2,$3,$4,$5,$6,$7,$8,'Estándar',$9,$9,'CONTABILIZADO')
      returning journal_id
    `,[number,iso(date),tran.transaction_id,context.subsidiary_id,currencyId,
      context.fiscal_period_id,rate,`Prueba ${label}`,debit+credit]);
    await db.query(`
      insert into public.journal_line(
        journal_id,account_id,debit,credit,debit_fx,credit_fx,note,
        related_company_id,original_currency_id,historical_exchange_rate
      )values($1,$2,$3,$4,$3,$4,$5,$6,$7,$8)
    `,[journal.journal_id,targetAccount,debit,credit,`Detalle ${label}`,
      relatedCompanyId,currencyId,rate]);
    await db.query(`
      insert into public.journal_line(
        journal_id,account_id,debit,credit,debit_fx,credit_fx,note,
        original_currency_id,historical_exchange_rate
      )values($1,$2,$3,$4,$3,$4,$5,$6,$7)
    `,[journal.journal_id,offsetAccount,credit,debit,`Contrapartida ${label}`,
      currencyId,rate]);
    await db.query('select public.sync_journal_gl_impacts($1)',[
      journal.journal_id
    ]);
  }

  await movement({label:'OPEN',date:periodStart,
    currencyId:foreign.currency_id,rate:2,targetAccount:account['119001'],
    debit:25,relatedCompanyId:companyIds[0]});
  await movement({label:'OPEN-MISSING',date:periodStart,
    currencyId:foreign.currency_id,rate:2,targetAccount:account['119001'],
    debit:2});
  await movement({label:'AR-A',date:from,currencyId:foreign.currency_id,
    rate:2,targetAccount:account['119001'],debit:100,
    relatedCompanyId:companyIds[0]});
  await movement({label:'AP-A',date:from,currencyId:foreign.currency_id,
    rate:2,targetAccount:account['219001'],credit:40,
    relatedCompanyId:companyIds[0]});
  await movement({label:'AR-B',date:to,currencyId:context.local_currency_id,
    rate:1,targetAccount:account['119001'],debit:50,
    relatedCompanyId:companyIds[1]});
  await movement({label:'UNASSIGNED',date:to,currencyId:foreign.currency_id,
    rate:2,targetAccount:account['119001'],debit:5});
  {
    const number=`TST-IC-MULTI-${suffix}`;
    const {rows:[tran]}=await db.query(`
      insert into public."transaction"(
        tran_number,tran_date,transaction_type_id,subsidiary_id,currency_id,
        exchange_rate,fiscal_period_id,total_amount,status_id
      )values($1,$2,$3,$4,$5,2,$6,18,$7)returning transaction_id
    `,[number,iso(to),engine.transaction_type_id,context.subsidiary_id,
      foreign.currency_id,context.fiscal_period_id,engine.status_id]);
    const {rows:[journal]}=await db.query(`
      insert into public.journal(
        journal_number,journal_date,transaction_id,subsidiary_id,currency_id,
        fiscal_period_id,exchange_rate,memo,journal_type,total_debit,
        total_credit,status
      )values($1,$2,$3,$4,$5,$6,2,$7,'Estándar',18,18,'CONTABILIZADO')
      returning journal_id
    `,[number,iso(to),tran.transaction_id,context.subsidiary_id,
      foreign.currency_id,context.fiscal_period_id,`Prueba multi ${suffix}`]);
    for(const [value,companyId]of [[7,companyIds[0]],[11,companyIds[1]]]){
      await db.query(`
        insert into public.journal_line(
          journal_id,account_id,debit,credit,debit_fx,credit_fx,note,
          related_company_id,original_currency_id,historical_exchange_rate
        )values($1,$2,$3,0,$3,0,$4,$5,$6,2)
      `,[journal.journal_id,account['119001'],value,
        `Línea ${companyId} ${suffix}`,companyId,foreign.currency_id]);
    }
    await db.query(`
      insert into public.journal_line(
        journal_id,account_id,debit,credit,debit_fx,credit_fx,note,
        original_currency_id,historical_exchange_rate
      )values($1,$2,0,18,0,18,$3,$4,2)
    `,[journal.journal_id,offsetAccount,`Contrapartida multi ${suffix}`,
      foreign.currency_id]);
    await db.query('select public.sync_journal_gl_impacts($1)',[
      journal.journal_id
    ]);
  }
  await movement({label:'COMMERCIAL',date:to,currencyId:foreign.currency_id,
    rate:2,targetAccount:account['113002'],debit:999,
    relatedCompanyId:companyIds[0]});

  const {rows:[exposureResponse]}=await db.query(
    'select public.fx_exposures($1,$2) exposures',[
      iso(to),foreign.currency_id
    ]
  );
  const receivableSource=`ICGL:${account['119001']}:${companyIds[0]}:${foreign.currency_id}`;
  const payableSource=`ICGL:${account['219001']}:${companyIds[0]}:${foreign.currency_id}`;
  const receivableExposure=exposureResponse.exposures.find(item=>
    item.sourceKey===receivableSource
  );
  const payableExposure=exposureResponse.exposures.find(item=>
    item.sourceKey===payableSource
  );
  assert.ok(receivableExposure,
    'La exposiciÃ³n Mayor debe conservar la compaÃ±Ã­a relacionada.');
  assert.ok(payableExposure,
    'La exposiciÃ³n por pagar debe conservar la compaÃ±Ã­a relacionada.');
  assert.equal(Number(receivableExposure.relatedCompanyId),companyIds[0]);
  assert.equal(Number(receivableExposure.currencyId),Number(foreign.currency_id));
  assert.ok(close(receivableExposure.foreignBalance,132));
  assert.ok(close(receivableExposure.bookValue,264));
  assert.ok(close(payableExposure.foreignBalance,40));
  assert.ok(close(payableExposure.bookValue,80));

  const {rows:[response]}=await db.query(
    `select public.run_accounting_report(
      'intercompany-loans',$1::jsonb
    )report`,[JSON.stringify(filters)]
  );
  const report=response.report;
  assert.equal(report.report,'intercompany-loans');
  assert.equal(report.total,6,'Debe devolver solo movimientos del período.');
  assert.equal(report.details.length,6);
  assert.equal(report.rows.length,6);
  assert.ok(report.details.every(row=>
    ['119001','219001'].includes(row.accountNumber)
  ),'Las cuentas comerciales 113002/211002 deben quedar fuera.');
  assert.equal(report.quality.unassignedMovementCount
    -baseline.quality.unassignedMovementCount,2);
  assert.equal(report.quality.unassignedOpeningMovementCount
    -baseline.quality.unassignedOpeningMovementCount,1);
  assert.equal(report.quality.unassignedPeriodMovementCount
    -baseline.quality.unassignedPeriodMovementCount,1);
  assert.equal(report.quality.fxAdjustmentMovementCount
    -baseline.quality.fxAdjustmentMovementCount,0);
  assert.equal(report.quality.hasUnassignedDimensions,true);

  const foreignSummary=report.currencySummaries.find(row=>
    Number(row.currencyId)===Number(foreign.currency_id)
  );
  assert.ok(foreignSummary);
  assert.ok(close(amount(foreignSummary.receivableOpening)
    -amount(baselineForeign.receivableOpening),27));
  assert.ok(close(amount(foreignSummary.receivableClosing)
    -amount(baselineForeign.receivableClosing),150));
  assert.ok(close(amount(foreignSummary.payableClosing)
    -amount(baselineForeign.payableClosing),40));
  assert.ok(close(amount(foreignSummary.netPosition)
    -amount(baselineForeign.netPosition),110));

  const companyPosition=report.netPositions.find(row=>
    Number(row.relatedCompanyId)===companyIds[0]
      &&Number(row.currencyId)===Number(foreign.currency_id)
  );
  assert.ok(companyPosition);
  assert.ok(close(companyPosition.receivableClosing,132));
  assert.ok(close(companyPosition.payableClosing,40));
  assert.ok(close(companyPosition.netPosition,92));

  const multiDetails=report.details.filter(row=>
    row.transactionNumber===`TST-IC-MULTI-${suffix}`
  );
  assert.deepEqual(
    multiDetails.map(row=>[Number(row.relatedCompanyId),amount(row.originalDebit)])
      .sort((left,right)=>left[0]-right[0]),
    [[companyIds[0],7],[companyIds[1],11]].sort((left,right)=>left[0]-right[0]),
    'Dos líneas de la misma cuenta deben conservar su compañía relacionada.'
  );

  const companyBMulti=multiDetails.find(row=>
    Number(row.relatedCompanyId)===companyIds[1]
  );
  assert.ok(close(companyBMulti.localRunningBalance,22),
    'El acumulado local no debe mezclar monedas originales.');

  assert.equal(report.localCurrencySummaries.length,1);
  assert.ok(close(amount(report.localCurrencySummaries[0].netPosition)
    -amount(baselineLocal.netPosition),270));

  const companyLocalPosition=report.localPositions.find(row=>
    Number(row.relatedCompanyId)===companyIds[0]
      &&Number(row.originalCurrencyId)===Number(foreign.currency_id)
  );
  assert.ok(companyLocalPosition,
    'Debe exponer el equivalente local por compaÃ±Ã­a y moneda original.');
  assert.ok(close(companyLocalPosition.receivableClosing,264));
  assert.ok(close(companyLocalPosition.payableClosing,80));
  assert.ok(close(companyLocalPosition.netPosition,184));

  const {rows:[searchResponse]}=await db.query(
    `select public.run_intercompany_loan_report($1::jsonb)report`,[
      JSON.stringify({...filters,search:`TST-IC-AR-A-${suffix}`})
    ]
  );
  assert.equal(searchResponse.report.searchScope,'DETAIL_ONLY');
  assert.equal(searchResponse.report.total,1,
    'La bÃºsqueda debe filtrar Ãºnicamente el detalle.');
  const searchedForeign=searchResponse.report.currencySummaries.find(row=>
    Number(row.currencyId)===Number(foreign.currency_id)
  );
  assert.ok(close(searchedForeign.netPosition,foreignSummary.netPosition),
    'La bÃºsqueda no debe alterar los saldos contables.');

  const {rows:[filteredResponse]}=await db.query(
    `select public.run_intercompany_loan_report($1::jsonb)report`,[
      JSON.stringify({...filters,relatedCompanyId:companyIds[0],
        direction:'PAYABLE'})
    ]
  );
  assert.equal(filteredResponse.report.total,1);
  assert.equal(filteredResponse.report.details[0].direction,'PAYABLE');

  const {rows:[optionsResponse]}=await db.query(
    'select public.accounting_report_options() options'
  );
  const option=optionsResponse.options.relatedCompanies.find(row=>
    Number(row.id)===companyIds[0]
  );
  assert.ok(option,'Las opciones deben incluir la compañía relacionada.');
  assert.ok(option.subsidiaryIds.map(Number).includes(
    Number(context.subsidiary_id)
  ));
  const optionBook=optionsResponse.options.intercompanyBooks.find(row=>
    Number(row.id)===Number(context.accounting_book_id)
  );
  assert.ok(optionBook,'Las opciones deben incluir el libro principal activo.');

  const {rows:[legacyResponse]}=await db.query(
    `select public.run_accounting_report('trial-balance',$1::jsonb)report`,[
      JSON.stringify({subsidiaryIds:[Number(context.subsidiary_id)],
        dateFrom:iso(from),dateTo:iso(to),page:1,pageSize:10})
    ]
  );
  assert.ok(Array.isArray(legacyResponse.report.rows),
    'El wrapper debe preservar los reportes contables existentes.');

  await db.query(`
    update public.fiscal_periods
    set is_closed=false,gl_closed=false,is_inactive=false
    where fiscal_period_id=$1
  `,[context.fiscal_period_id]);
  const adjustment=12.34;
  const snapshot=[{
    sourceKey:receivableSource,sourceType:'Mayor',document:'',party:'',
    entityId:null,relatedCompanyId:companyIds[0],
    currencyId:Number(foreign.currency_id),accountId:account['119001'],
    accountNumber:'119001',accountName:'PrÃ©stamos por Cobrar Intercompany',
    category:'Activo',foreignBalance:132,bookValue:264,
    signedAdjustment:adjustment
  }];
  const {rows:[run]}=await db.query(`
    insert into public.fx_revaluation_runs(
      subsidiary_id,fiscal_period_id,currency_id,closing_date,closing_rate,
      rate_source,rate_reason,auto_reverse,reversal_date,snapshot,
      gain_account_id,loss_account_id,gain_taxable,loss_deductible,created_by
    )values($1,$2,$3,$4,2.1,'MANUAL',$5,false,null,$6::jsonb,
      $7,$7,false,false,public.app_user_id())
    returning run_id
  `,[context.subsidiary_id,context.fiscal_period_id,foreign.currency_id,
    iso(to),`Prueba intercompany ${suffix}`,JSON.stringify(snapshot),
    offsetAccount]);
  const {rows:[posted]}=await db.query(
    'select public.fx_post_journal($1,$2,1,$3) journal_id',[
      run.run_id,iso(to),`Prueba FX ${suffix}`
    ]
  );
  const {rows:[fxLine]}=await db.query(`
    select line.*,journal.transaction_id
    from public.journal_line line
    join public.journal journal using(journal_id)
    where line.journal_id=$1 and line.account_id=$2
  `,[posted.journal_id,account['119001']]);
  assert.ok(fxLine,'Debe crear la lÃ­nea local de revaluaciÃ³n.');
  assert.equal(Number(fxLine.related_company_id),companyIds[0]);
  assert.equal(Number(fxLine.original_currency_id),Number(foreign.currency_id));
  assert.ok(close(fxLine.debit,adjustment));
  assert.ok(close(fxLine.credit,0));
  assert.ok(close(fxLine.debit_fx,0)&&close(fxLine.credit_fx,0),
    'La revaluaciÃ³n debe ser exclusivamente local.');
  const {rows:[fxImpact]}=await db.query(`
    select debit_amount,credit_amount,debit_fx,credit_fx
    from public.gl_impact
    where transaction_id=$1 and account_id=$2
  `,[fxLine.transaction_id,account['119001']]);
  assert.ok(fxImpact,'La revaluaciÃ³n debe llegar al Mayor.');
  assert.ok(close(fxImpact.debit_amount,adjustment));
  assert.ok(close(fxImpact.debit_fx,0)&&close(fxImpact.credit_fx,0));

  const {rows:[afterFxResponse]}=await db.query(
    `select public.run_intercompany_loan_report($1::jsonb)report`,[
      JSON.stringify(filters)
    ]
  );
  const afterFx=afterFxResponse.report;
  assert.equal(afterFx.total,7);
  assert.equal(afterFx.quality.fxAdjustmentMovementCount
    -baseline.quality.fxAdjustmentMovementCount,1);
  const fxDetail=afterFx.details.find(row=>
    Number(row.journalId)===Number(posted.journal_id)
      &&row.accountNumber==='119001'
  );
  assert.ok(fxDetail,'El reporte debe mostrar la revaluaciÃ³n local.');
  assert.equal(fxDetail.isFxRevaluation,true);
  assert.equal(Number(fxDetail.relatedCompanyId),companyIds[0]);
  assert.equal(Number(fxDetail.currencyId),Number(foreign.currency_id));
  assert.ok(close(fxDetail.originalDebit,0)
    &&close(fxDetail.originalCredit,0),
  'La revaluaciÃ³n no debe contaminar el saldo en moneda original.');
  assert.ok(close(fxDetail.localDebit,adjustment));
  const afterFxOriginal=afterFx.currencySummaries.find(row=>
    Number(row.currencyId)===Number(foreign.currency_id)
  );
  assert.ok(close(afterFxOriginal.netPosition,foreignSummary.netPosition));
  assert.ok(close(afterFx.localCurrencySummaries[0].netPosition,
    amount(report.localCurrencySummaries[0].netPosition)+adjustment));
  const afterFxLocalPosition=afterFx.localPositions.find(row=>
    Number(row.relatedCompanyId)===companyIds[0]
      &&Number(row.originalCurrencyId)===Number(foreign.currency_id)
  );
  assert.ok(close(afterFxLocalPosition.netPosition,196.34));

  const {rows:[afterExposureResponse]}=await db.query(
    'select public.fx_exposures($1,$2) exposures',[
      iso(to),foreign.currency_id
    ]
  );
  const afterExposure=afterExposureResponse.exposures.find(item=>
    item.sourceKey===receivableSource
  );
  assert.ok(close(afterExposure.foreignBalance,132));
  assert.ok(close(afterExposure.bookValue,276.34),
    'La revaluaciÃ³n previa debe aplicarse al mismo origen analÃ­tico.');

  const {rows:[reversed]}=await db.query(
    'select public.fx_post_journal($1,$2,-1,$3) journal_id',[
      run.run_id,iso(to),`Reverso FX ${suffix}`
    ]
  );
  const {rows:[reversalLine]}=await db.query(`
    select line.* from public.journal_line line
    where line.journal_id=$1 and line.account_id=$2
  `,[reversed.journal_id,account['119001']]);
  assert.equal(Number(reversalLine.related_company_id),companyIds[0]);
  assert.equal(Number(reversalLine.original_currency_id),
    Number(foreign.currency_id));
  assert.ok(close(reversalLine.credit,adjustment));
  assert.ok(close(reversalLine.debit_fx,0)&&close(reversalLine.credit_fx,0));

  const {rows:[secondaryBook]}=await db.query(`
    insert into public.accounting_books(
      book_name,subsidiary_id,base_currency_id,is_primary,is_active
    )values($1,$2,$3,false,true)returning accounting_book_id
  `,[`Libro secundario ${suffix}`,context.subsidiary_id,
    context.local_currency_id]);
  const {rows:[bookOptions]}=await db.query(
    'select public.accounting_report_options() options'
  );
  assert.ok(!bookOptions.options.intercompanyBooks.some(row=>
    Number(row.id)===Number(secondaryBook.accounting_book_id)
  ),'Las opciones del reporte no deben ofrecer libros secundarios.');
  await db.query('savepoint invalid_book_report');
  await assert.rejects(
    db.query('select public.run_intercompany_loan_report($1::jsonb)',[
      JSON.stringify({...filters,
        bookId:Number(secondaryBook.accounting_book_id)})
    ]),
    /libro contable principal activo/i,
    'Un libro secundario no debe producir cifras aparentemente vÃ¡lidas.'
  );
  await db.query('rollback to savepoint invalid_book_report');

  console.log(JSON.stringify({
    passed:true,rolledBack:true,details:report.total,
    currencies:report.currencySummaries.map(row=>row.currencyCode),
    companies:report.quality.relatedCompanyCount,
    foreignNet:foreignSummary.netPosition,
    localNet:report.localCurrencySummaries[0].netPosition,
    unassigned:report.quality.unassignedMovementCount,
    fxOriginalPreserved:afterFxOriginal.netPosition,
    fxLocalAfterPosting:afterFx.localCurrencySummaries[0].netPosition,
    secondaryBookRejected:true,legacyPreserved:true
  }));
  await db.query('rollback');
}catch(error){
  await db.query('rollback').catch(()=>{});
  throw error;
}finally{
  await db.end();
}
