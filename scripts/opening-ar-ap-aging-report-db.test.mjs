import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
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

const migration=await readFile(
  new URL('../supabase/migrations/20261023130000_opening_ar_ap_aging_report.sql',import.meta.url),
  'utf8'
);

const amount=value=>Number(value??0);
const close=(actual,expected,tolerance=.005)=>Math.abs(amount(actual)-amount(expected))<=tolerance;
const isoDate=value=>value instanceof Date
  ?`${value.getFullYear()}-${String(value.getMonth()+1).padStart(2,'0')}-${String(value.getDate()).padStart(2,'0')}`
  :String(value).slice(0,10);

async function contextFor(subsidiaryId){
  const {rows:[context]}=await db.query(`
    select users.email,session.session_id
    from public.user_company_sessions session
    join public.users users using(user_id)
    where session.subsidiary_id=$1
    order by session.selected_at desc,session.session_id desc
    limit 1
  `,[subsidiaryId]);
  assert.ok(context,`No existe una sesión de prueba para la subsidiaria ${subsidiaryId}.`);
  await db.query("select set_config('request.jwt.claims',$1,true)",[
    JSON.stringify({email:context.email,session_id:context.session_id,role:'authenticated'})
  ]);
}

async function aging(kind,subsidiaryId,cutoff,extra={}){
  const filters={
    subsidiaryIds:[Number(subsidiaryId)],
    dateTo:isoDate(cutoff),
    agingCurrencyMode:'LOCAL',
    onlyPending:true,
    page:1,
    pageSize:250,
    ...extra
  };
  const {rows:[row]}=await db.query(
    'select public.run_aging_report($1,$2::jsonb)value',
    [kind,JSON.stringify(filters)]
  );
  return row.value;
}

async function assertOrdinaryDocument(kind){
  const payable=kind==='AP';
  const table=payable?'supplier_invoice':'invoice';
  const entityColumn=payable?'supplier_id':'customer_id';
  const {rows:[candidate]}=await db.query(`
    select document.invoice_id,document.subsidiary_id,
      document.${entityColumn} entity_id,tran.tran_date
    from public.${table} document
    join public."transaction" tran using(transaction_id)
    where not coalesce(document.is_opening_balance,false)
      and exists(
        select 1 from public.user_company_sessions session
        where session.subsidiary_id=document.subsidiary_id
      )
    order by tran.tran_date,document.due_date,document.invoice_id
    limit 1
  `);
  assert.ok(candidate,`No existe una factura ordinaria ${kind} para la prueba de regresión.`);
  await contextFor(candidate.subsidiary_id);

  let report=await aging(kind,candidate.subsidiary_id,candidate.tran_date,{
    agingEntityId:candidate.entity_id,
    onlyPending:false
  });
  let rows=report.rows??[];
  for(let page=2;page<=Math.ceil(Number(report.total||0)/250)&&!rows.some(row=>String(row.document_id)===String(candidate.invoice_id));page+=1){
    const next=await aging(kind,candidate.subsidiary_id,candidate.tran_date,{
      agingEntityId:candidate.entity_id,
      onlyPending:false,
      page
    });
    rows=rows.concat(next.rows??[]);
  }
  assert.ok(
    rows.some(row=>String(row.document_id)===String(candidate.invoice_id)),
    `La factura ordinaria ${kind} ${candidate.invoice_id} desapareció del reporte.`
  );
  return candidate.invoice_id;
}

await db.connect();
try{
  await db.query('begin');
  await db.query("set local statement_timeout='60s'");
  await db.query(migration);

  const {rows:[opening]}=await db.query(`
    select run.id,run.subsidiary_id,run.opening_date,run.status,
      (select count(*)::integer from public.invoice invoice
       where invoice.opening_run_id=run.id)ar_documents,
      (select count(*)::integer from public.supplier_invoice invoice
       where invoice.opening_run_id=run.id)ap_documents
    from public.opening_balance_runs run
    where run.id=155
  `);
  assert.ok(opening,'No existe el lote de apertura 155.');
  assert.equal(opening.status,'POSTED','El lote 155 debe estar contabilizado para validar sus auxiliares.');
  assert.equal(opening.ar_documents,55,'El lote 155 debe contener 55 facturas por cobrar.');
  assert.equal(opening.ap_documents,4,'El lote 155 debe contener 4 facturas por pagar.');

  await contextFor(opening.subsidiary_id);
  const ar=await aging('AR',opening.subsidiary_id,opening.opening_date);
  assert.equal(Number(ar.total),55,'El reporte CxC debe incluir las 55 facturas iniciales.');
  assert.equal((ar.rows??[]).length,55,'Las 55 facturas CxC deben caber en la primera página.');
  assert.ok(close(ar.summary.subledger,ar.summary.controlBalance),
    `CxC no concilia: auxiliar ${ar.summary.subledger}, Mayor ${ar.summary.controlBalance}.`);
  assert.ok(close(ar.summary.difference,0),`La diferencia CxC es ${ar.summary.difference}.`);

  const {rows:openingAr}=await db.query(`
    select invoice.invoice_id,invoice.invoice_date,
      round(invoice.total_amount*invoice.exchange_rate,6)expected_local
    from public.invoice invoice
    where invoice.opening_run_id=155
    order by invoice.invoice_id
  `);
  const arRows=new Map((ar.rows??[]).map(row=>[String(row.document_id),row]));
  for(const invoice of openingAr){
    const row=arRows.get(String(invoice.invoice_id));
    assert.ok(row,`Falta la factura inicial CxC ${invoice.invoice_id}.`);
    assert.equal(row.issue_date,isoDate(invoice.invoice_date),`La fecha documental CxC ${invoice.invoice_id} cambió.`);
    assert.ok(close(row.pending,invoice.expected_local),`La tasa histórica CxC ${invoice.invoice_id} no fue respetada.`);
  }

  const ap=await aging('AP',opening.subsidiary_id,opening.opening_date);
  assert.equal(Number(ap.total),4,'El reporte CxP debe incluir las 4 facturas iniciales.');
  assert.equal((ap.rows??[]).length,4,'Las 4 facturas CxP deben caber en la primera página.');
  assert.ok(close(ap.summary.subledger,ap.summary.controlBalance),
    `CxP no concilia: auxiliar ${ap.summary.subledger}, Mayor ${ap.summary.controlBalance}.`);
  assert.ok(close(ap.summary.difference,0),`La diferencia CxP es ${ap.summary.difference}.`);

  const {rows:openingAp}=await db.query(`
    select invoice.invoice_id,invoice.invoice_date,
      round(invoice.total_amount*invoice.exchange_rate,6)expected_local
    from public.supplier_invoice invoice
    where invoice.opening_run_id=155
    order by invoice.invoice_id
  `);
  const apRows=new Map((ap.rows??[]).map(row=>[String(row.document_id),row]));
  for(const invoice of openingAp){
    const row=apRows.get(String(invoice.invoice_id));
    assert.ok(row,`Falta la factura inicial CxP ${invoice.invoice_id}.`);
    assert.equal(row.issue_date,isoDate(invoice.invoice_date),`La fecha documental CxP ${invoice.invoice_id} cambió.`);
    assert.ok(close(row.pending,invoice.expected_local),`La tasa histórica CxP ${invoice.invoice_id} no fue respetada.`);
  }

  const dayBefore=(await db.query("select ($1::date-1)::text value",[opening.opening_date])).rows[0].value;
  const firstOpeningAr=openingAr[0];
  const beforeOpening=await aging('AR',opening.subsidiary_id,dayBefore,{onlyPending:false});
  assert.ok(
    !(beforeOpening.rows??[]).some(row=>String(row.document_id)===String(firstOpeningAr.invoice_id)),
    'Una factura inicial aparece antes de la fecha contable de apertura.'
  );

  const ordinaryAr=await assertOrdinaryDocument('AR');
  const ordinaryAp=await assertOrdinaryDocument('AP');

  console.log(JSON.stringify({
    passed:true,
    rolledBack:true,
    openingRun:155,
    ar:{documents:ar.total,subledger:ar.summary.subledger,control:ar.summary.controlBalance,difference:ar.summary.difference},
    ap:{documents:ap.total,subledger:ap.summary.subledger,control:ap.summary.controlBalance,difference:ap.summary.difference},
    accountingCutoff:true,
    historicalRates:true,
    ordinaryDocuments:{ar:ordinaryAr,ap:ordinaryAp}
  }));
}finally{
  await db.query('rollback').catch(()=>{});
  await db.end();
}
