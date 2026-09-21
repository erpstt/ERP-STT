import pg from 'pg';
import {readFile} from 'node:fs/promises';
process.loadEnvFile?.('.env');
const ref=new URL(process.env.SUPABASE_URL).hostname.split('.')[0];
const db=new pg.Client({host:process.env.SUPABASE_DB_HOST||'aws-0-us-east-1.pooler.supabase.com',port:Number(process.env.SUPABASE_DB_PORT||6543),database:'postgres',user:process.env.SUPABASE_DB_USER||`postgres.${ref}`,password:process.env.SUPABASE_DB_PASSWORD,ssl:{rejectUnauthorized:false},connectionTimeoutMillis:15000});
await db.connect();
try{
 await db.query('begin read only');
 const {rows:[context]}=await db.query('select u.email,ucs.session_id,au.id sub from user_company_sessions ucs join users u using(user_id)join auth.users au on lower(au.email)=lower(u.email) order by selected_at desc limit 1');
 await db.query("select set_config('request.jwt.claims',$1,true)",[JSON.stringify(context)]);
 const {rows:[{result}]}=await db.query("select fixed_asset_proposal_report('{}') result");
 const {rows:assets}=await db.query(`select a.asset_id,a.asset_number,a.asset_name,a.description,a.purchase_date,a.in_service_date,a.purchase_cost,a.status,a.subsidiary_id,a.currency_id,c.asset_account_id,c.category_name,
 (select count(*)::int from asset_depreciation where asset_id=a.asset_id) depreciation_count,
 (select coalesce(sum(depreciation_amount),0) from asset_depreciation where asset_id=a.asset_id) accumulated,
 (select count(*)::int from fixed_asset_proposal_allocation where asset_id=a.asset_id) links
 from asset a join asset_category c using(category_id)where a.subsidiary_id=active_subsidiary_id()order by a.asset_id`);
 console.log(JSON.stringify({subsidiary:result.options.subsidiary,currency:result.options.currency,proposals:result.rows,reconciliation:result.reconciliation,assets}));
 await db.query('rollback');
}finally{await db.end()}
