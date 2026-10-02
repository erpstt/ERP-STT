import assert from 'node:assert/strict';
import pg from 'pg';
import {readFile} from 'node:fs/promises';

process.loadEnvFile?.('.env');
const ref=new URL(process.env.SUPABASE_URL).hostname.split('.')[0];
const db=new pg.Client({
  host:process.env.SUPABASE_DB_HOST||'aws-0-us-east-1.pooler.supabase.com',
  port:Number(process.env.SUPABASE_DB_PORT||6543),database:'postgres',
  user:process.env.SUPABASE_DB_USER||`postgres.${ref}`,
  password:process.env.SUPABASE_DB_PASSWORD||process.env.PGPASSWORD,
  ssl:{rejectUnauthorized:false},connectionTimeoutMillis:15000
});
const one=async(sql,values=[])=>(await db.query(sql,values)).rows[0];

await db.connect();
try{
  await db.query('begin');
  await db.query("set local lock_timeout='5s'; set local statement_timeout='120s'");
  const installed=await one(`select
    to_regprocedure('public.purchase_transaction_support(bigint)') is not null
    and coalesce(position('support_count' in pg_get_functiondef(to_regprocedure('public.run_purchase_transaction_report(jsonb)')))>0,false) value`);
  if(!installed.value){
    const sql=await readFile(new URL('../supabase/migrations/20261001130000_purchase_transaction_cost_centers_supports.sql',import.meta.url),'utf8');
    await db.query(sql);
  }

  const context=await one(`select u.email,session.session_id,auth_user.id sub,session.subsidiary_id,
      invoice.invoice_id,invoice.transaction_id,journal.journal_id,to_char(tx.tran_date,'YYYY-MM-DD') tran_date
    from public.user_company_sessions session
    join public.users u using(user_id)
    join auth.users auth_user on lower(auth_user.email)=lower(u.email)
    join public.supplier_invoice invoice on invoice.subsidiary_id=session.subsidiary_id
    join public."transaction" tx on tx.transaction_id=invoice.transaction_id
    join public.journal journal on journal.transaction_id=invoice.transaction_id
    where exists(select 1 from public.user_subsidiaries access
      where access.user_id=u.user_id and access.subsidiary_id=session.subsidiary_id)
    order by session.session_id desc,invoice.invoice_id desc limit 1`);
  assert.ok(context,'Se requiere una factura de proveedor contabilizada y una sesión con acceso a su subsidiaria.');

  const marker=`Prueba reporte ${Date.now()}`;
  const link=(await one(`insert into public.journal_support(
      journal_id,support_type,display_name,support_url
    )values($1,'Enlace',$2,'https://example.com/respaldo-prueba')returning support_id`,
    [context.journal_id,`${marker} enlace`])).support_id;
  const fileData='data:text/plain;base64,UHJ1ZWJhIGRlIHJlc3BhbGRv';
  const file=(await one(`insert into public.journal_support(
      journal_id,support_type,display_name,file_name,mime_type,file_size,file_data
    )values($1,'Archivo',$2,'respaldo-prueba.txt','text/plain',18,$3)returning support_id`,
    [context.journal_id,`${marker} archivo`,fileData])).support_id;
  const expectedCenters=(await one(`select coalesce(string_agg(distinct center.code,', ' order by center.code),'—') value
    from public.journal_line line join public.cost_centers center using(cost_center_id)
    where line.journal_id=$1`,[context.journal_id])).value;

  await db.query("select set_config('request.jwt.claims',$1,true)",[JSON.stringify(context)]);
  await db.query('set local role authenticated');
  const filters={
    subsidiaryIds:[context.subsidiary_id],dateFrom:String(context.tran_date).slice(0,10),
    dateTo:String(context.tran_date).slice(0,10),purchaseTransactionTypes:['FAC_PRO'],
    purchaseCurrencyMode:'BASE',purchaseGroupMode:'TRANSACTION',excludePurchaseCancelled:false,
    page:1,pageSize:250
  };
  const report=(await one('select public.run_purchase_transaction_report($1::jsonb) value',[JSON.stringify(filters)])).value;
  const row=report.rows.find(item=>Number(item.document_id)===Number(context.invoice_id));
  assert.ok(row,'La factura de prueba debe aparecer en el reporte.');
  assert.equal(row.cost_centers,expectedCenters);
  assert.ok(Array.isArray(row.supports));
  assert.equal(row.support_count,row.supports.length);
  assert.deepEqual(
    row.supports.filter(item=>[Number(link),Number(file)].includes(Number(item.id))).map(item=>item.type).sort(),
    ['Archivo','Enlace']
  );
  const fileMetadata=row.supports.find(item=>Number(item.id)===Number(file));
  assert.equal(fileMetadata.fileData,undefined,'El reporte no debe incorporar el contenido pesado del archivo.');
  const linkMetadata=row.supports.find(item=>Number(item.id)===Number(link));
  assert.equal(linkMetadata.url,'https://example.com/respaldo-prueba');

  const fetched=(await one('select public.purchase_transaction_support($1) value',[file])).value;
  assert.equal(fetched.fileData,fileData);
  assert.equal(fetched.fileName,'respaldo-prueba.txt');

  let missingRejected=false;
  await db.query('savepoint missing_support_check');
  try{await db.query('select public.purchase_transaction_support($1)',[Number.MAX_SAFE_INTEGER])}
  catch(error){missingRejected=/no existe|no pertenece/i.test(error.message);await db.query('rollback to savepoint missing_support_check')}
  await db.query('release savepoint missing_support_check');
  assert.equal(missingRejected,true,'Un respaldo inexistente debe ser rechazado.');

  await db.query('reset role');
  await db.query('rollback');
  console.log(JSON.stringify({
    migration:installed.value?'already-installed':'validated-with-rollback',
    costCenters:true,supportMetadata:true,lazyFileContent:true,authorizedReader:true,
    missingSupportRejected:true,rollback:true
  }));
}catch(error){await db.query('rollback').catch(()=>{});throw error}
finally{await db.end()}
