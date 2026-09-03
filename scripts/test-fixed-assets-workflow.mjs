import pg from 'pg';
process.loadEnvFile?.('.env');
const ref=new URL(process.env.SUPABASE_URL).hostname.split('.')[0];
const client=new pg.Client({host:process.env.SUPABASE_DB_HOST||'aws-0-us-east-1.pooler.supabase.com',port:Number(process.env.SUPABASE_DB_PORT||6543),database:'postgres',user:process.env.SUPABASE_DB_USER||`postgres.${ref}`,password:process.env.SUPABASE_DB_PASSWORD,ssl:{rejectUnauthorized:false}});
await client.connect();
try{
 await client.query('begin');
 const context=(await client.query('select u.email,ucs.session_id from user_company_sessions ucs join users u using(user_id) order by selected_at desc limit 1')).rows[0];
 await client.query("select set_config('request.jwt.claims',$1,false)",[JSON.stringify(context)]);
 const options=(await client.query('select fixed_asset_options() value')).rows[0].value;
 if(!options.subsidiary||!options.categories.length||!options.locations.length||options.currencies.length!==1||String(options.currencies[0].id)!==String(options.subsidiary.currencyId))throw Error('La moneda local u opciones del activo son inválidas.');
 if(options.departments.some(item=>!['Interno','Cliente'].includes(item.type)))throw Error('Existe un tipo de departamento inválido.');
 const period=options.periods.find(item=>!item.closed),date=period?.start;
 const saved=(await client.query('select save_fixed_asset($1::jsonb,null) value',[JSON.stringify({name:'Activo de prueba reversible',category_id:options.categories[0].id,location_id:options.locations[0].id,currency_id:options.subsidiary.currencyId,purchase_date:date,service_date:date,cost:1200,rate:1,status:'ACTIVO'})])).rows[0].value;
 if(!/^ACT-\d{6}$/.test(saved.number))throw Error(`Número automático inválido: ${saved.number}`);
 const report=(await client.query("select fixed_asset_report('{}'::jsonb) value")).rows[0].value;
 if(!report.rows.some(item=>item.id===saved.id))throw Error('El activo no aparece en el reporte.');
 const preview=(await client.query('select fixed_asset_depreciation_preview($1) value',[date])).rows[0].value;
 if(!preview.rows.some(item=>item.id===saved.id&&Number(item.amount)>0))throw Error('No se calculó la depreciación pendiente.');
 const run=(await client.query('select run_fixed_asset_depreciation($1,$2::jsonb) value',[date,JSON.stringify([saved.id])])).rows[0].value;
 if(run.processed!==1)throw Error('No se contabilizó la depreciación.');
 const posted=(await client.query('select ad.depreciation_id,ad.depreciation_amount,j.transaction_id,(select count(*) from gl_impact g where g.transaction_id=j.transaction_id) impacts from asset_depreciation ad join gl_impact gi on gi.gl_impact_id=ad.gl_impact_id join journal j on j.transaction_id=gi.transaction_id where ad.asset_id=$1',[saved.id])).rows[0];
 if(!posted||Number(posted.impacts)!==2)throw Error('El impacto contable de depreciación está incompleto.');
 console.log(JSON.stringify({options:true,localCurrencyOnly:options.currencies[0].code,departmentTypes:[...new Set(options.departments.map(item=>item.type))],automaticNumber:saved.number,report:true,depreciationPreview:true,depreciationPosting:true,glImpacts:Number(posted.impacts),rollback:true}));
 await client.query('rollback');
}catch(error){await client.query('rollback');throw error}finally{await client.end()}
