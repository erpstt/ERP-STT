import pg from 'pg';
process.loadEnvFile?.('.env');
const ref=new URL(process.env.SUPABASE_URL).hostname.split('.')[0];
const client=new pg.Client({host:process.env.SUPABASE_DB_HOST,port:Number(process.env.SUPABASE_DB_PORT),database:'postgres',user:`postgres.${ref}`,password:process.env.SUPABASE_DB_PASSWORD,ssl:{rejectUnauthorized:false}});
await client.connect();
try{
 const columns=await client.query(`select column_name from information_schema.columns where table_schema='public' and table_name='customers' and column_name=any($1) order by ordinal_position`,[['customer_type','email','phone','sales_representative_id','department_id','address','comments']]);
 const rows=await client.query(`select customer_id,customer_type,email,phone,sales_representative_id,department_id,address,comments from public.customers order by customer_id desc limit 5`);
 const changes=await client.query(`select c.field_name,c.new_value,a."timestamp" from public.change_log c join public.audit_log a on a.log_id=c.audit_log_id where a.entity_type='customers' and c.field_name=any($1) order by a."timestamp" desc limit 20`,[['customer_type','email','phone','sales_representative_id','department_id','address','comments']]);
 console.log(JSON.stringify({columns:columns.rows.map(x=>x.column_name),rows:rows.rows,changes:changes.rows}));
}finally{await client.end();}
