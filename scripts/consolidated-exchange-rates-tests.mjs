import pg from'pg';
process.loadEnvFile?.('.env');
const ref=new URL(process.env.SUPABASE_URL).hostname.split('.')[0],db=new pg.Client({host:process.env.SUPABASE_DB_HOST||'aws-0-us-east-1.pooler.supabase.com',port:Number(process.env.SUPABASE_DB_PORT||6543),database:'postgres',user:process.env.SUPABASE_DB_USER||`postgres.${ref}`,password:process.env.SUPABASE_DB_PASSWORD,ssl:{rejectUnauthorized:false}});
await db.connect();try{
 const columns=await db.query("select column_name from information_schema.columns where table_schema='public'and table_name='consolidated_exchange_rates'and column_name in('holding_subsidiary_id','period','closing_rate','average_rate','historical_rate','is_locked','locked_at','locked_by')");
 if(columns.rowCount!==8)throw Error(`Estructura NIC 21 incompleta: ${columns.rowCount}/8 columnas.`);
 const functions=await db.query("select count(distinct proname)::int n from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public'and proname in('consolidated_exchange_rate_suggestion','consolidated_rate_for','consolidation_translation_adjustment')");
 if(functions.rows[0].n!==3)throw Error('No se instalaron las tres funciones del motor de consolidación.');
 const permission=await db.query("select count(*)::int n from permissions where code in('consolidation:rates:view','consolidation:rates:manage','consolidation:rates:lock')");
 if(permission.rows[0].n!==3)throw Error('Permisos de consolidación incompletos.');
 const pair=(await db.query('select e.from_currency_id,e.to_currency_id,to_char(max(e.effective_date),\'YYYY-MM\') period from exchange_rates e group by e.from_currency_id,e.to_currency_id order by count(*)desc limit 1')).rows[0],holding=(await db.query('select subsidiary_id from subsidiaries where is_active order by subsidiary_id limit 1')).rows[0];
 let suggestion=null;if(pair&&holding)suggestion=(await db.query('select consolidated_exchange_rate_suggestion($1,$2,$3,$4)value',[holding.subsidiary_id,pair.period,pair.from_currency_id,pair.to_currency_id])).rows[0].value;
 console.log(JSON.stringify({columns:8,functions:3,permissions:3,suggestion:suggestion?{period:suggestion.period,dailyRates:suggestion.dailyRates,closingRate:suggestion.closingRate,averageRate:suggestion.averageRate}:null,auditColumns:columns.rows.some(x=>x.column_name==='locked_by')}));
}finally{await db.end()}
