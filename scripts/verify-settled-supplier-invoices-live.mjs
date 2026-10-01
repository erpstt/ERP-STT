import assert from 'node:assert/strict';
import pg from 'pg';

process.loadEnvFile?.('.env');
const projectRef=new URL(process.env.SUPABASE_URL).hostname.split('.')[0];
const db=new pg.Client({
  host:process.env.SUPABASE_DB_HOST||'aws-0-us-east-1.pooler.supabase.com',
  port:Number(process.env.SUPABASE_DB_PORT||6543),database:'postgres',
  user:process.env.SUPABASE_DB_USER||`postgres.${projectRef}`,
  password:process.env.SUPABASE_DB_PASSWORD||process.env.PGPASSWORD,
  ssl:{rejectUnauthorized:false},connectionTimeoutMillis:15000
});

await db.connect();
try{
  await db.query('begin read only');
  const context=(await db.query(`select u.email,au.id auth_id,ucs.session_id,ucs.subsidiary_id,s.name subsidiary
    from user_company_sessions ucs join users u using(user_id)
    join auth.users au on lower(au.email)=lower(u.email)
    join subsidiaries s using(subsidiary_id)
    join user_subsidiaries us on us.user_id=ucs.user_id and us.subsidiary_id=ucs.subsidiary_id
    order by ucs.selected_at desc limit 1`)).rows[0];
  assert.ok(context,'No existe una sesión activa autorizada para validar el reporte.');
  await db.query("select set_config('request.jwt.claims',$1,true)",[
    JSON.stringify({sub:context.auth_id,email:context.email,session_id:context.session_id,role:'authenticated'})
  ]);
  await db.query('set local role authenticated');
  const report=(await db.query(`select run_settled_supplier_invoice_report($1::jsonb)value`,[
    JSON.stringify({periodMonth:'2026-09',supplierIds:[],settlementType:'ALL',groupBySettlementType:true,page:1,pageSize:250,export:true})
  ])).rows[0].value;
  const summary=report.summary||{},rows=report.rows||[],n=value=>Number(value||0);
  const reconciliationDelta=n(summary.appliedAmount)-n(summary.settlementBaseAmount)-n(summary.exchangeDifferenceAmount)-n(summary.overappliedAmount);
  assert.ok(Math.abs(reconciliationDelta)<0.01,`El resumen no concilia por ${reconciliationDelta}.`);
  let largestFundingDelta=0;
  for(const row of rows){
    const funding=n(row.cashAmount)+n(row.advanceAmount)+n(row.withholdingAmount)+n(row.otherFundingAmount);
    largestFundingDelta=Math.max(largestFundingDelta,Math.abs(funding-n(row.paymentAmount)));
  }
  assert.ok(largestFundingDelta<0.01,`Existe un pago cuyo desglose no concilia por ${largestFundingDelta}.`);
  console.log(JSON.stringify({
    live:true,subsidiary:context.subsidiary,period:'2026-09',invoiceCount:n(summary.invoiceCount),
    invoiceAmount:n(summary.invoiceAmount),settlementBaseAmount:n(summary.settlementBaseAmount),
    appliedAmount:n(summary.appliedAmount),exchangeDifferenceAmount:n(summary.exchangeDifferenceAmount),
    overappliedAmount:n(summary.overappliedAmount),reconciliationDelta,
    largestFundingDelta,readOnly:true
  }));
  await db.query('reset role');
  await db.query('rollback');
}catch(error){
  try{await db.query('reset role');await db.query('rollback')}catch{}
  throw error;
}finally{
  await db.end();
}
