import pg from 'pg';
process.loadEnvFile?.('.env');
const ref=new URL(process.env.SUPABASE_URL).hostname.split('.')[0];
const client=new pg.Client({host:process.env.SUPABASE_DB_HOST,port:Number(process.env.SUPABASE_DB_PORT),database:'postgres',user:process.env.SUPABASE_DB_USER||`postgres.${ref}`,password:process.env.SUPABASE_DB_PASSWORD,ssl:{rejectUnauthorized:false}});
await client.connect();
try{
 await client.query('begin');
 const context=(await client.query('select u.email,ucs.session_id from user_company_sessions ucs join users u using(user_id) order by selected_at desc limit 1')).rows[0];
 if(!context)throw Error('No existe una sesión de empresa para ejecutar la prueba.');
 await client.query("select set_config('request.jwt.claims',$1,true)",[JSON.stringify(context)]);
 const options=(await client.query('select fixed_asset_operation_options() value')).rows[0].value;
 const asset=options.assets[0];
 if(!asset)throw Error('Se requiere al menos un activo vigente.');
 const saved=[];
 const supplier=options.suppliers[0];
 const maintenance=(await client.query('select save_fixed_asset_operation($1::jsonb,null)value',[JSON.stringify({type:'MAINTENANCE',date:'2026-09-03',asset_id:asset.id,maintenance_type:'PREVENTIVO',status:'PROGRAMADO',description:'Prueba reversible',cost:10,supplier_id:supplier?.id||'',reference:'TEST'})])).rows[0].value;saved.push(['MAINTENANCE',maintenance.id]);
 const target=options.subsidiaries.find(x=>String(x.id)!==String(options.subsidiary.id)),targetLocation=options.locations.find(x=>String(x.subsidiaryId)===String(target?.id));
 if(target&&targetLocation){const transfer=(await client.query('select save_fixed_asset_operation($1::jsonb,null)value',[JSON.stringify({type:'TRANSFER',date:'2026-09-03',asset_id:asset.id,source_location_id:asset.locationId,target_subsidiary_id:target.id,target_location_id:targetLocation.id,note:'Prueba reversible'})])).rows[0].value;saved.push(['TRANSFER',transfer.id]);}
 const disposal=(await client.query('select save_fixed_asset_operation($1::jsonb,null)value',[JSON.stringify({type:'DISPOSAL',date:'2026-09-03',asset_id:asset.id,disposal_type:'VENTA',sale_amount:asset.bookValue,note:'Prueba reversible'})])).rows[0].value;saved.push(['DISPOSAL',disposal.id]);
 for(const kind of ['TRANSFER','DISPOSAL','MAINTENANCE']){const report=(await client.query('select fixed_asset_operation_report($1::jsonb)value',[JSON.stringify({type:kind,from:'2026-09-01',to:'2026-09-30',search:'Prueba reversible'})])).rows[0].value;if(kind!=='TRANSFER'||target&&targetLocation){if(!report.rows.length)throw Error(`El reporte ${kind} no devolvió la operación creada.`);}}
 for(const [kind,id] of saved.reverse())await client.query('select delete_fixed_asset_operation($1,$2)',[kind,id]);
 console.log(JSON.stringify({options:{assets:options.assets.length,subsidiaries:options.subsidiaries.length,locations:options.locations.length,suppliers:options.suppliers.length},maintenance:true,transfer:Boolean(target&&targetLocation),disposal:true,reports:true,delete:true,rollback:true}));
 await client.query('rollback');
}catch(error){await client.query('rollback');throw error}finally{await client.end()}
