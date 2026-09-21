import pg from 'pg';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
process.loadEnvFile?.('.env');
const ref=new URL(process.env.SUPABASE_URL).hostname.split('.')[0];
const db=new pg.Client({host:process.env.SUPABASE_DB_HOST||'aws-0-us-east-1.pooler.supabase.com',port:Number(process.env.SUPABASE_DB_PORT||6543),database:'postgres',user:process.env.SUPABASE_DB_USER||`postgres.${ref}`,password:process.env.SUPABASE_DB_PASSWORD,ssl:{rejectUnauthorized:false}});
await db.connect();
const query=async(sql,params=[]) => (await db.query(sql,params)).rows;
const scalar=async(sql,params=[]) => (await query(sql,params))[0]?.value;
const rejected=async(sql,params,pattern)=>{await db.query('savepoint invalid');let error;try{await db.query(sql,params)}catch(cause){error=cause;await db.query('rollback to savepoint invalid')}assert.ok(error,'Se esperaba rechazo');if(pattern)assert.match(error.message,pattern)};
try{
 await db.query('begin');await db.query("set local lock_timeout='5s';set local statement_timeout='60s'");
 await db.query(await readFile(new URL('../supabase/migrations/20260917160000_supplier_invoice_line_quantities.sql',import.meta.url),'utf8'));
 const normalized=await scalar('select normalize_supplier_invoice_quantities($1::jsonb)value',[JSON.stringify({lines:[{quantity:10,unit_price:1500,amount:1},{amount:123.45},{quantity:2.5,unit_price:3.123456}]})]);
 assert.equal(normalized.lines[0].amount,15000);assert.equal(normalized.lines[1].quantity,1);assert.equal(normalized.lines[1].unit_price,123.45);assert.equal(normalized.lines[2].amount,7.80864);
 for(const quantity of [0,-1,'NaN'])await rejected('select normalize_supplier_invoice_quantities($1::jsonb)',[JSON.stringify({lines:[{quantity,unit_price:2}]})],/mayores/);
 if(process.argv.includes('--apply')){await db.query('commit');console.log(JSON.stringify({applied:true,quantityPriceCalculation:true,legacyAmountsPreserved:true}));}
 else{
 const {rows:[context]}=await db.query('select u.email,ucs.session_id,au.id sub from user_company_sessions ucs join users u using(user_id)join auth.users au on lower(au.email)=lower(u.email)order by selected_at desc limit 1');
 await db.query("select set_config('request.jwt.claims',$1,true)",[JSON.stringify(context)]);
 const options=await scalar('select fixed_asset_options()value'),sid=options.subsidiary.id,period=options.periods.find(p=>!p.closed);
 const seed=(await query('select supplier_id,payment_term_id from supplier_invoice where subsidiary_id=$1 and payment_term_id is not null limit 1',[sid]))[0];
 const account=await scalar('select asset_account_id value from asset_category where subsidiary_id=$1 and is_active limit 1',[sid]);
 const payload={invoice_number:'QUANTITY-TEST-'+Date.now(),invoice_type:'Factura Activos Fijos',supplier_id:seed.supplier_id,payment_term_id:seed.payment_term_id,invoice_date:period.start,fiscal_period_id:period.id,currency_id:options.currency.id,exchange_rate:1,lines:[{account_id:account,quantity:10,unit_price:1500,amount:1,tax_rate:0,note:'Quantity test',es_activo_fijo:true}]};
 const saved=await scalar('select save_supplier_invoice($1::jsonb,null)value',[JSON.stringify(payload)]);
 let line=(await query('select * from supplier_invoice_line where invoice_id=$1',[saved.invoiceId]))[0];assert.equal(Number(line.quantity),10);assert.equal(Number(line.unit_price),1500);assert.equal(Number(line.amount),15000);assert.equal(Number(saved.total),15000);
 payload.lines[0].quantity=2;const edited=await scalar('select save_supplier_invoice($1::jsonb,$2)value',[JSON.stringify(payload),saved.invoiceId]);line=(await query('select * from supplier_invoice_line where invoice_id=$1',[saved.invoiceId]))[0];assert.equal(Number(line.quantity),2);assert.equal(Number(edited.total),3000);
 const proposed=await scalar('select amount_local value from activos_fijos_propuestas where transaction_id=(select transaction_id from supplier_invoice where invoice_id=$1)',[saved.invoiceId]);assert.equal(Number(proposed),3000);
 await db.query('rollback');console.log(JSON.stringify({saved:true,edited:true,serverRecalculation:true,proposalAmount:true,rollback:true}));
 }
}catch(error){await db.query('rollback').catch(()=>{});throw error}finally{await db.end()}
