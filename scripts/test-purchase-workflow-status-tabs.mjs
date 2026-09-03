import pg from 'pg';

process.loadEnvFile?.('.env');
const ref = new URL(process.env.SUPABASE_URL).hostname.split('.')[0];
const client = new pg.Client({host:process.env.SUPABASE_DB_HOST||'aws-0-us-east-1.pooler.supabase.com',port:Number(process.env.SUPABASE_DB_PORT||6543),database:'postgres',user:process.env.SUPABASE_DB_USER||`postgres.${ref}`,password:process.env.SUPABASE_DB_PASSWORD,ssl:{rejectUnauthorized:false}});
await client.connect();
try {
  const context=(await client.query('select u.email,ucs.session_id from user_company_sessions ucs join users u using(user_id) order by selected_at desc limit 1')).rows[0];
  await client.query("select set_config('request.jwt.claims',$1,false)",[JSON.stringify(context)]);
  const result={};
  for(const type of ['REQUISITION','QUOTE','RECEIPT']){
    const rows=(await client.query('select purchase_document_report($1::jsonb) value',[JSON.stringify({type,from:'2000-01-01',to:'2099-12-31'})])).rows[0].value.rows||[];
    if(type==='RECEIPT')result[type]={pending:rows.filter(x=>!x.invoiced).length,processed:rows.filter(x=>x.invoiced).length};
    else result[type]={pending:rows.filter(x=>!x.hasNextDocument).length,processed:rows.filter(x=>x.hasNextDocument).length};
  }
  console.log(JSON.stringify({...result,classification:true}));
} finally { await client.end(); }
