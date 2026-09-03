import pg from 'pg';
process.loadEnvFile?.('.env');
const ref=new URL(process.env.SUPABASE_URL).hostname.split('.')[0];
const c=new pg.Client({host:'aws-0-us-east-1.pooler.supabase.com',port:6543,database:'postgres',user:`postgres.${ref}`,password:process.env.PGPASSWORD||process.env.SUPABASE_DB_PASSWORD,ssl:{rejectUnauthorized:false}});
await c.connect();
try{
 await c.query('begin');
 const ctx=(await c.query('select u.email,ucs.session_id,ucs.subsidiary_id from user_company_sessions ucs join users u using(user_id) order by selected_at desc limit 1')).rows[0];
 if(!ctx)throw Error('No existe una sesión activa.');
 await c.query("select set_config('request.jwt.claims',$1,true)",[JSON.stringify({email:ctx.email,session_id:ctx.session_id})]);
 const options=(await c.query('select purchase_workflow_options() result')).rows[0].result;
 if(!options?.periods?.length||!options?.currencies?.length)throw Error('Faltan período o moneda para la prueba.');
 const p=options.products?.[0],period=options.periods[0],date=String(period.start).slice(0,10),supplier=options.suppliers?.[0],location=options.locations?.[0];
 if(!p||!supplier)throw Error(`Falta configuración. productos=${options.products?.length||0}, proveedores=${options.suppliers?.length||0}, subsidiaria=${ctx.subsidiary_id}`);
 const ids=[];
 for(const type of['REQUISITION','QUOTE','ORDER','RECEIPT']){
  const payload={type,date,currency_id:options.subsidiary.currencyId,rate:1,period_id:period.id,location_id:location?.id||null,supplier_id:type==='REQUISITION'?null:supplier.id,source_id:ids.at(-1)||null,status:'BORRADOR',memo:'Prueba automática con rollback',lines:[{product_id:p.id,account_id:p.accountId,description:p.name,quantity:1,unit_cost:p.cost||1,tax_rate:0}]};
  ids.push((await c.query('select save_purchase_document($1::jsonb) result',[JSON.stringify(payload)])).rows[0].result.id);
 }
 for(let i=0;i<ids.length;i++){
  const t=['REQUISITION','QUOTE','ORDER','RECEIPT'][i],report=(await c.query('select purchase_document_report($1::jsonb) result',[JSON.stringify({type:t,from:date,to:date})])).rows[0].result;
  if(!report.rows.some(x=>Number(x.id)===Number(ids[i])))throw Error(`El reporte no mostró ${ids[i]}`);
  const d=(await c.query('select purchase_document_detail($1) result',[ids[i]])).rows[0].result;
  if(d.lines.length!==1)throw Error('El detalle no conservó las líneas.');
 }
 const movement=(await c.query('select count(*)::int n from stock_movements sm join purchase_document d on d.transaction_id=sm.transaction_id where d.document_id=$1',[ids.at(-1)])).rows[0].n;
 if(!movement)throw Error('La recepción no generó movimiento de inventario.');
 console.log(JSON.stringify({options:true,workflow:ids.length,reports:true,detail:true,inventory:true,rollback:true}));
 await c.query('rollback');
}catch(e){await c.query('rollback');throw e}finally{await c.end()}
