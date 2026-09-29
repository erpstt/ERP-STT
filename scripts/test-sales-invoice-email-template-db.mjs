import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import pg from 'pg';

process.loadEnvFile?.('.env');
const projectRef=new URL(process.env.SUPABASE_URL).hostname.split('.')[0];
const db=new pg.Client({
 host:process.env.SUPABASE_DB_HOST||'aws-0-us-east-1.pooler.supabase.com',
 port:Number(process.env.SUPABASE_DB_PORT||6543),database:'postgres',
 user:process.env.SUPABASE_DB_USER||`postgres.${projectRef}`,
 password:process.env.SUPABASE_DB_PASSWORD,ssl:{rejectUnauthorized:false},connectionTimeoutMillis:15000
});
const one=async(sql,values=[])=>(await db.query(sql,values)).rows[0];
const value=async(sql,values=[])=>(await one(sql,values))?.value;

await db.connect();
try{
 await db.query('begin');
 await db.query("set local lock_timeout='5s';set local statement_timeout='90s'");
 const installed=await value("select to_regprocedure('public.sales_invoice_email_settings(text,jsonb)') is not null value");
 const migration=await readFile(new URL('../supabase/migrations/20260928130000_sales_invoice_email_template.sql',import.meta.url),'utf8');
 await db.query(migration);

 const admin=await one(`
  select u.user_id,u.email,au.id sub,r.role_id,ucs.subsidiary_id
  from public.users u
  join auth.users au on lower(au.email)=lower(u.email)
  join public.user_roles ur using(user_id)
  join public.roles r using(role_id)
  join public.user_company_sessions ucs using(user_id)
  where lower(r.role_name) in('administrador','administrator','admin')
  order by ucs.selected_at desc limit 1
 `);
 assert.ok(admin,'Se requiere un usuario administrador con una subsidiaria activa.');
 const second=await one('select subsidiary_id from public.subsidiaries where subsidiary_id<>$1 order by subsidiary_id limit 1',[admin.subsidiary_id]);
 assert.ok(second,'Se requieren al menos dos subsidiarias para validar aislamiento.');

 const adminSessionA=`test-invoice-template-admin-a-${Date.now()}`;
 const adminSessionB=`test-invoice-template-admin-b-${Date.now()}`;
 await db.query('insert into public.user_subsidiaries(user_id,subsidiary_id) values($1,$2) on conflict do nothing',[admin.user_id,second.subsidiary_id]);
 await db.query('insert into public.user_company_sessions(session_id,user_id,subsidiary_id) values($1,$2,$3),($4,$2,$5)',[adminSessionA,admin.user_id,admin.subsidiary_id,adminSessionB,second.subsidiary_id]);
 await db.query('insert into public.user_role_sessions(session_id,user_id,role_id) values($1,$2,$3),($4,$2,$3)',[adminSessionA,admin.user_id,admin.role_id,adminSessionB]);
 const setContext=session=>db.query("select set_config('request.jwt.claims',$1,true)",[JSON.stringify({email:admin.email,sub:admin.sub,session_id:session})]);

 await setContext(adminSessionA);
 assert.equal(await value('select public.app_is_admin() value'),true);
 const saved=await value("select public.sales_invoice_email_settings('save',$1::jsonb) value",[JSON.stringify({subject:'Factura A {{numero_factura}}',body:'<p>Hola {{cliente_nombre}}</p>',active:true})]);
 assert.equal(saved.template.tipo_notificacion,'FACTURA_VENTA');
 assert.equal(saved.template.asunto_template,'Factura A {{numero_factura}}');
 assert.equal(String(await value('select public.active_subsidiary_id() value')),String(admin.subsidiary_id));
 const deliveryInvoice=await one(`
  select i.invoice_id,(c.primary_subsidiary_id<>i.subsidiary_id) shared_customer
  from public.invoice i join public.customers c using(customer_id)
  where i.subsidiary_id=$1
  order by (c.primary_subsidiary_id<>i.subsidiary_id) desc,i.invoice_id desc limit 1
 `,[admin.subsidiary_id]);
 assert.ok(deliveryInvoice,'Se requiere una factura de la subsidiaria activa para validar el documento.');
 const deliverySnapshot=await value('select public.sales_invoice_delivery_snapshot($1) value',[deliveryInvoice.invoice_id]);
 assert.equal(String(deliverySnapshot.id),String(deliveryInvoice.invoice_id));
 assert.ok(deliverySnapshot.company?.name&&deliverySnapshot.customer?.name&&deliverySnapshot.currency?.code);
 assert.ok(Array.isArray(deliverySnapshot.lines)&&Array.isArray(deliverySnapshot.supports));

 await setContext(adminSessionB);
 const isolated=await value("select public.sales_invoice_email_settings('get','{}'::jsonb) value");
 assert.equal(String(await value('select public.active_subsidiary_id() value')),String(second.subsidiary_id));
 assert.equal(isolated.template.tipo_notificacion,'FACTURA_VENTA');
 assert.equal(isolated.template.activo,true);
 assert.notEqual(isolated.template.asunto_template,'Factura A {{numero_factura}}');

 const nonAdminRole=await one("select role_id from public.roles where lower(role_name) not in('administrador','administrator','admin') order by role_id limit 1");
 assert.ok(nonAdminRole,'Se requiere al menos un rol no administrador.');
 const userRoleExists=await value('select exists(select 1 from public.user_roles where user_id=$1 and role_id=$2) value',[admin.user_id,nonAdminRole.role_id]);
 if(!userRoleExists)await db.query('insert into public.user_roles(user_id,role_id) values($1,$2)',[admin.user_id,nonAdminRole.role_id]);
 const nonAdminSession=`test-invoice-template-user-${Date.now()}`;
 await db.query('insert into public.user_company_sessions(session_id,user_id,subsidiary_id) values($1,$2,$3)',[nonAdminSession,admin.user_id,admin.subsidiary_id]);
 await db.query('insert into public.user_role_sessions(session_id,user_id,role_id) values($1,$2,$3)',[nonAdminSession,admin.user_id,nonAdminRole.role_id]);
 await setContext(nonAdminSession);
 assert.equal(await value('select public.app_is_admin() value'),false);
 const readable=await value("select public.sales_invoice_email_settings('get','{}'::jsonb) value");
 assert.equal(readable.template.asunto_template,'Factura A {{numero_factura}}');
 await db.query('savepoint non_admin_save');
 await assert.rejects(
  db.query("select public.sales_invoice_email_settings('save',$1::jsonb)",[JSON.stringify({subject:'No permitido',body:'<p>No permitido</p>',active:false})]),
  /Solo un administrador/
 );
 await db.query('rollback to savepoint non_admin_save');

 await db.query('savepoint invalid_kind');
 await assert.rejects(db.query(`insert into public.configuraciones_correos(id_subsidiaria,tipo_notificacion,asunto_template,cuerpo_template)values($1,'NO_ADMITIDO','Asunto','<p>Mensaje</p>')`,[admin.subsidiary_id]),/configuraciones_correos_tipo_notificacion_check/);
 await db.query('rollback to savepoint invalid_kind');
 assert.equal(await value("select has_function_privilege('authenticated','public.sales_invoice_email_settings(text,jsonb)','execute') value"),true);
 assert.equal(await value("select has_function_privilege('authenticated','public.sales_invoice_delivery_snapshot(bigint)','execute') value"),true);

 await db.query('savepoint missing_invoice');
 await assert.rejects(
  db.query('select public.sales_invoice_delivery_snapshot($1)', ['9223372036854775000']),
  /no existe en la subsidiaria activa/
 );
 await db.query('rollback to savepoint missing_invoice');

 await db.query('rollback');
 console.log(JSON.stringify({migration:installed?'already-installed-revalidated':'validated-with-rollback',kind:true,defaultActive:true,subsidiaryIsolation:true,authenticatedGet:true,adminSave:true,nonAdminSaveDenied:true,deliverySnapshotScoped:true,deliverySnapshotData:true,sharedCustomerCovered:Boolean(deliveryInvoice.shared_customer),invalidKindDenied:true,rollback:true}));
}catch(error){await db.query('rollback').catch(()=>{});throw error;}finally{await db.end();}
