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
  connectionTimeoutMillis:15_000
});

const migration=await readFile(new URL(
  '../supabase/migrations/20261023141000_aging_original_currency_reconciliation.sql',
  import.meta.url
),'utf8');

const number=value=>Number(value??0);
const close=(actual,expected,tolerance=.005)=>Math.abs(number(actual)-number(expected))<=tolerance;

async function contextFor(subsidiaryId){
  const {rows:[context]}=await db.query(`
    select users.user_id,users.email,session.session_id,auth_user.id auth_id
    from public.user_company_sessions session
    join public.users users using(user_id)
    join auth.users auth_user on lower(auth_user.email)=lower(users.email)
    where session.subsidiary_id=$1
    order by session.selected_at desc,session.session_id desc
    limit 1
  `,[subsidiaryId]);
  assert.ok(context,`No existe sesión para la subsidiaria ${subsidiaryId}.`);
  await db.query("select set_config('request.jwt.claims',$1,true)",[
    JSON.stringify({sub:String(context.auth_id),email:context.email,session_id:context.session_id,role:'authenticated'})
  ]);
}

async function report(kind,subsidiaryId,currencyMode='ORIGINAL',extra={}){
  const {rows:[row]}=await db.query(
    'select public.run_aging_report($1,$2::jsonb)value',
    [kind,JSON.stringify({
      subsidiaryIds:[Number(subsidiaryId)],
      dateTo:'2026-09-30',
      agingCurrencyMode:currencyMode,
      onlyPending:false,
      page:1,
      pageSize:250,
      ...extra
    })]
  );
  return row.value;
}

function breakdownByCode(result){
  return new Map((result.summary.currencyBreakdown??[])
    .map(item=>[item.currencyCode,item]));
}

await db.connect();
try{
  await db.query('begin');
  await db.query("set local statement_timeout='60s'");
  const {rows:[installed]}=await db.query(`
    select to_regprocedure(
      'public.aging_original_currency_breakdown(text,jsonb,boolean)'
    )is not null value
  `);
  if(process.env.FORCE_AGING_MIGRATION==='1'||!installed.value)await db.query(migration);

  await contextFor(24);
  const ar=await report('AR',24);
  assert.equal(ar.total,55);
  assert.ok(ar.rows.every(row=>row.currency_code==='USD'));
  assert.ok(ar.rows.every(row=>row.currency_symbol&&row.currency_name));
  assert.equal(ar.summary.currencyBreakdown.length,1);
  assert.equal(ar.summary.mixedCurrencies,false);
  assert.equal(ar.summary.currencyCode,'USD');
  assert.ok(close(ar.summary.subledger,393_988.76));
  assert.ok(close(ar.summary.controlBalance,393_988.76));
  assert.ok(close(ar.summary.difference,0));
  assert.ok(close(ar.rows.reduce((sum,row)=>sum+number(row.pending),0),393_988.76));

  const localAr=await report('AR',24,'LOCAL');
  assert.ok(close(localAr.summary.subledger,59_492_302.76));
  assert.ok(close(localAr.summary.controlBalance,59_492_302.76));
  assert.ok(close(localAr.summary.difference,0));

  const ap=await report('AP',24);
  assert.equal(ap.total,4);
  assert.ok(ap.rows.every(row=>row.currency_code==='JMD'));
  assert.equal(ap.summary.currencyBreakdown.length,1);
  assert.equal(ap.summary.currencyCode,'JMD');
  assert.ok(close(ap.summary.subledger,241_245.63));
  assert.ok(close(ap.summary.controlBalance,241_245.63));
  assert.ok(close(ap.summary.difference,0));

  // Existing ordinary supplier invoices exercise the mixed JMD/USD case and
  // the transaction.currency_id fallback used by legacy GL impacts.
  await contextFor(3);
  const mixed=await report('AP',3,'ORIGINAL',{dateTo:'2026-08-30'});
  const currencies=breakdownByCode(mixed);
  assert.ok(currencies.has('JMD'),'Falta el bloque JMD.');
  assert.ok(currencies.has('USD'),'Falta el bloque USD.');
  assert.equal(mixed.summary.mixedCurrencies,true);
  assert.equal(mixed.summary.subledger,null,'No se deben sumar monedas distintas.');
  assert.equal(mixed.summary.controlBalance,null,'No se deben sumar monedas distintas.');
  assert.equal(mixed.summary.difference,null,'No se deben restar monedas distintas.');
  assert.ok(mixed.rows.some(row=>row.currency_code==='USD'));
  assert.ok(mixed.rows.some(row=>row.currency_code==='JMD'));
  for(const [code,summary]of currencies){
    const rowTotal=mixed.rows.filter(row=>row.currency_code===code)
      .reduce((sum,row)=>sum+number(row.pending),0);
    assert.ok(close(summary.subledger,rowTotal),
      `El auxiliar ${code} no coincide con sus documentos.`);
  }

  const usdInvoice=mixed.rows.find(row=>row.currency_code==='USD');
  assert.ok(usdInvoice,'Se requiere una factura USD ordinaria para la regresión.');
  const filtered=await report('AP',3,'ORIGINAL',{
    dateTo:'2026-08-30',
    agingEntityId:usdInvoice.entity_id
  });
  assert.ok(filtered.rows.every(row=>String(row.entity_id)===String(usdInvoice.entity_id)));
  assert.ok((filtered.summary.currencyBreakdown??[]).every(row=>
    ['JMD','USD'].includes(row.currencyCode)
  ));

  const localAp=await report('AP',3,'LOCAL');
  const retained=localAp.rows.find(row=>String(row.document_id)==='14');
  assert.ok(retained,'Falta la factura AP #14 con retención JMD 60.');
  assert.ok(close(retained.original_amount,11_440),
    'La factura con retención debe usar payable_amount, no total_amount.');
  assert.ok(close(retained.applied_amount,5_000));
  assert.ok(close(retained.pending,6_440));
  assert.ok(close(localAp.summary.difference,0),
    `La retención no debe generar diferencia local: ${localAp.summary.difference}.`);

  // Applications are stored in the payment currency. Verify that a payment
  // in a different currency is converted with the payment's historical rate.
  const {rows:[crossSource]}=await db.query(`
    select application.payment_id,payment.transaction_id,
      invoice.currency_id invoice_currency_id,
      coalesce(nullif(invoice.exchange_rate,0),1)invoice_rate,
      invoice.supplier_id
    from public.supplier_payment_application application
    join public.supplier_payment payment using(payment_id)
    join public.supplier_invoice invoice using(invoice_id)
    where application.invoice_id=14
    order by application.payment_id
    limit 1
  `);
  const {rows:[otherCurrency]}=await db.query(`
    select currency_id
    from public.currencies
    where currency_id<>$1 and currency_code='USD'
    limit 1
  `,[crossSource?.invoice_currency_id??0]);
  assert.ok(crossSource&&otherCurrency,
    'Se requiere una aplicación y una moneda distinta para la prueba cruzada.');
  await db.query(`
    update public.supplier_payment
    set currency_id=$2,exchange_rate=150
    where payment_id=$1
  `,[crossSource.payment_id,otherCurrency.currency_id]);
  await db.query(`
    update public."transaction"
    set currency_id=$2,exchange_rate=150
    where transaction_id=$1
  `,[crossSource.transaction_id,otherCurrency.currency_id]);
  await db.query(`
    update public.supplier_payment_application
    set amount=10
    where payment_id=$1 and invoice_id=14
  `,[crossSource.payment_id]);

  const crossOriginal=await report('AP',3,'ORIGINAL',{
    agingEntityId:crossSource.supplier_id
  });
  const crossOriginalRow=crossOriginal.rows.find(row=>String(row.document_id)==='14');
  const expectedOriginalApplication=10*150/number(crossSource.invoice_rate);
  assert.ok(close(crossOriginalRow.applied_amount,expectedOriginalApplication),
    'La aplicación cruzada debe convertirse a la moneda original de la factura.');
  assert.equal(crossOriginal.summary.reconciliationAvailable,false);
  assert.equal(crossOriginal.summary.reconciliationReason,'CROSS_CURRENCY');
  const crossOriginalBreakdown=breakdownByCode(crossOriginal);
  const invoiceCurrencyCode=(await db.query(
    'select currency_code from public.currencies where currency_id=$1',
    [crossSource.invoice_currency_id]
  )).rows[0].currency_code;
  assert.ok(close(
    crossOriginalBreakdown.get(invoiceCurrencyCode).subledger,
    crossOriginal.rows.filter(row=>row.currency_code===invoiceCurrencyCode)
      .reduce((sum,row)=>sum+number(row.pending),0)
  ),'El resumen original debe usar la misma conversión que sus documentos.');

  const crossLocal=await report('AP',3,'LOCAL',{
    agingEntityId:crossSource.supplier_id
  });
  const crossLocalRow=crossLocal.rows.find(row=>String(row.document_id)==='14');
  assert.ok(close(crossLocalRow.applied_amount,1_500),
    'La aplicación cruzada local debe usar la tasa del pago.');
  assert.ok(close(
    crossLocal.summary.subledger,
    crossLocal.rows.reduce((sum,row)=>sum+number(row.pending),0)
  ),'El resumen local debe usar la misma conversión que sus documentos.');

  const {rows:[costCenter]}=await db.query(`
    select center.cost_center_id
    from public.cost_centers center
    where center.subsidiary_id=3
    order by center.cost_center_id
    limit 1
  `);
  assert.ok(costCenter,'Se requiere un centro de costo para validar el alcance analítico.');
  const analytical=await report('AP',3,'ORIGINAL',{
    costCenterId:costCenter.cost_center_id
  });
  assert.equal(analytical.summary.reconciliationAvailable,false);
  assert.equal(analytical.summary.controlBalance,null);
  assert.equal(analytical.summary.difference,null);

  const {rows:[wrapper]}=await db.query(`
    select pg_get_functiondef('public.run_aging_report(text,jsonb)'::regprocedure)definition
  `);
  assert.match(wrapper.definition,
    /agingCurrencyMode'\s*,\s*'LOCAL'/i,
    'El consolidado debe seguir solicitando saldos locales antes de convertir a USD.');

  console.log(JSON.stringify({
    passed:true,
    rolledBack:true,
    opening:{
      ar:{currency:'USD',amount:ar.summary.subledger,difference:ar.summary.difference},
      ap:{currency:'JMD',amount:ap.summary.subledger,difference:ap.summary.difference}
    },
    mixedCurrencies:[...currencies.keys()],
    mixedScalarsAreNull:true,
    rowsCarryCurrency:true,
    entityFilter:true,
    supplierWithholdingBase:true,
    crossCurrencyApplications:true,
    analyticalScopeDoesNotClaimReconciliation:true,
    consolidatedWrapperPreserved:true
  }));
}finally{
  await db.query('rollback').catch(()=>{});
  await db.end();
}
