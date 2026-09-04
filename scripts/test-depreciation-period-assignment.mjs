import pg from 'pg';
process.loadEnvFile?.('.env');
const ref=new URL(process.env.SUPABASE_URL).hostname.split('.')[0];
const client=new pg.Client({host:process.env.SUPABASE_DB_HOST||'aws-0-us-east-1.pooler.supabase.com',port:Number(process.env.SUPABASE_DB_PORT||6543),database:'postgres',user:process.env.SUPABASE_DB_USER||`postgres.${ref}`,password:process.env.SUPABASE_DB_PASSWORD,ssl:{rejectUnauthorized:false}});
await client.connect();
try{
 const context=(await client.query('select u.email,ucs.session_id from user_company_sessions ucs join users u using(user_id) order by selected_at desc limit 1')).rows[0];
 await client.query("select set_config('request.jwt.claims',$1,false)",[JSON.stringify(context)]);
 const dates=['2026-08-31','2026-09-01'];
 const results=[];
 for(const date of dates){const value=(await client.query('select fixed_asset_depreciation_preview($1) value',[date])).rows[0].value;if(!value.period)throw Error(`No se asignó período para ${date}`);results.push({date,period:value.period.name})}
 if(results[0].period===results[1].period)throw Error('Fechas de meses diferentes recibieron el mismo período.');
 console.log(JSON.stringify({automaticAssignment:true,results}));
}finally{await client.end()}
