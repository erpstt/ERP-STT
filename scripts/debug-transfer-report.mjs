import pg from 'pg';
if(process.loadEnvFile)process.loadEnvFile('.env');
const ref=new URL(process.env.SUPABASE_URL).hostname.split('.')[0];
const client=new pg.Client({host:'aws-0-us-east-1.pooler.supabase.com',port:6543,database:'postgres',user:`postgres.${ref}`,password:process.env.PGPASSWORD,ssl:{rejectUnauthorized:false}});
await client.connect();
try{
 const transfer=(await client.query('select transfer_id,subsidiary_id from bank_transfer order by transfer_id desc limit 1')).rows[0];
 const sessions=await client.query('select u.email,ucs.session_id,ucs.subsidiary_id,ucs.selected_at from user_company_sessions ucs join users u using(user_id) where ucs.subsidiary_id=$1 order by ucs.selected_at desc',[transfer.subsidiary_id]);
 for(const session of sessions.rows){
  await client.query("select set_config('request.jwt.claims',$1,false)",[JSON.stringify({email:session.email,session_id:session.session_id})]);
  const active=(await client.query('select active_subsidiary_id() sid')).rows[0].sid;
  const report=(await client.query("select run_bank_transfer_report('{\"dateFrom\":\"2026-09-01\",\"dateTo\":\"2026-09-30\",\"sourceAccountIds\":[],\"destinationAccountIds\":[],\"currencyView\":\"TRANSACTIONAL\",\"search\":\"\"}'::jsonb) result")).rows[0].result;
  console.log({sessionSubsidiary:session.subsidiary_id,active,rows:report.rows.length});
 }
}finally{await client.end()}
