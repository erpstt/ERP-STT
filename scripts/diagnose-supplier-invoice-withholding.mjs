import pg from 'pg';
process.loadEnvFile('.env');
const number=process.argv[2];
const ref=new URL(process.env.SUPABASE_URL).hostname.split('.')[0];
const db=new pg.Client({host:process.env.SUPABASE_DB_HOST||'aws-0-us-east-1.pooler.supabase.com',port:6543,database:'postgres',user:`postgres.${ref}`,password:process.env.SUPABASE_DB_PASSWORD,ssl:{rejectUnauthorized:false}});
await db.connect();
try{
 const invoice=await db.query(`select invoice_id,invoice_number,supplier_id,subsidiary_id,subtotal_amount,tax_total,total_amount,withholding_total,payable_amount,journal_id from supplier_invoice where invoice_number=$1 order by invoice_id desc limit 1`,[number]);
 if(!invoice.rowCount)throw Error('Factura no encontrada.');
 const row=invoice.rows[0];
 const rules=await db.query(`select r.rule_id,tc.code_name,tc.rate_percentage,tc.withholding_calculation_base,tc.withholding_application_moment,tt.applies_to,tt.liability_account_id from entity_withholding_rules r join tax_codes tc using(tax_code_id) join tax_types tt using(tax_type_id) where r.supplier_id=$1 and r.subsidiary_id=$2`,[row.supplier_id,row.subsidiary_id]);
 const withholdings=await db.query(`select invoice_withholding_id,tax_code_id,base_amount,rate_percentage,withholding_amount,application_moment from supplier_invoice_withholding where invoice_id=$1`,[row.invoice_id]);
 console.log(JSON.stringify({invoice:row,rules:rules.rows,withholdings:withholdings.rows},null,2));
}finally{await db.end()}
