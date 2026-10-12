import assert from'node:assert/strict';
import{readFile}from'node:fs/promises';
import pg from'pg';

process.loadEnvFile?.('.env');
const ref=new URL(process.env.SUPABASE_URL).hostname.split('.')[0];
const db=new pg.Client({host:process.env.SUPABASE_DB_HOST||'aws-0-us-east-1.pooler.supabase.com',port:Number(process.env.SUPABASE_DB_PORT||6543),database:process.env.SUPABASE_DB_NAME||'postgres',user:process.env.SUPABASE_DB_USER||`postgres.${ref}`,password:process.env.SUPABASE_DB_PASSWORD,ssl:{rejectUnauthorized:false},connectionTimeoutMillis:15000});
const sql=await readFile(new URL('../supabase/migrations/20261012150000_opening_fixed_asset_auxiliary.sql',import.meta.url),'utf8');
const expectDenied=async(statement,parameters=[])=>{
 await db.query('savepoint permission_denied');let denied=false;
 try{await db.query(statement,parameters)}catch(error){denied=error.code==='42501';await db.query('rollback to savepoint permission_denied')}
 assert.equal(denied,true,`La llamada debió ser rechazada: ${statement}`);
};

await db.connect();
try{
 await db.query('begin');await db.query("set local lock_timeout='5s';set local statement_timeout='120s'");await db.query(sql);
 const context=(await db.query(`select u.user_id,u.email,au.id auth_id,ucs.session_id,ucs.subsidiary_id
  from user_company_sessions ucs join user_role_sessions urs using(session_id,user_id)join users u using(user_id)
  join user_subsidiaries us on us.user_id=u.user_id and us.subsidiary_id=ucs.subsidiary_id
  join auth.users au on lower(au.email)=lower(u.email)order by ucs.selected_at desc limit 1`)).rows[0];
 assert.ok(context,'Se requiere una sesión activa para probar permisos.');
 await db.query("select set_config('request.jwt.claims',$1,true)",[JSON.stringify({sub:context.auth_id,email:context.email,session_id:context.session_id})]);
 const role=(await db.query("insert into roles(role_name,description)values($1,'Rol temporal de prueba')returning role_id",[`TEST-APERTURA-${Date.now()}`])).rows[0];
 await db.query('insert into user_roles(user_id,role_id)values($1,$2)on conflict do nothing',[context.user_id,role.role_id]);
 await db.query('update user_role_sessions set role_id=$1 where session_id=$2',[role.role_id,context.session_id]);

 await expectDenied('select opening_balance_options()');
 await expectDenied("select opening_balance_validate('{}'::jsonb)");
 await db.query("insert into role_access_matrix(role_id,resource_key,can_view)values($1,'accounting:opening-balances',true)",[role.role_id]);
 const viewOptions=(await db.query('select opening_balance_options() value')).rows[0].value;
 assert.ok(viewOptions?.subsidiary);assert.equal(viewOptions.canCreate,false);assert.equal(viewOptions.canReverse,false);
 await expectDenied("select opening_balance_validate('{}'::jsonb)");
 await expectDenied('select opening_balance_reverse(0)');
 await db.query("update role_access_matrix set can_create=true where role_id=$1 and resource_key='accounting:opening-balances'",[role.role_id]);
 const createOptions=(await db.query('select opening_balance_options() value')).rows[0].value;
 assert.equal(createOptions.canCreate,true);assert.equal(createOptions.canReverse,false);
 await expectDenied('select opening_balance_reverse(0)');
 await db.query('savepoint business_validation');let reachedValidation=false;
 try{await db.query("select opening_balance_validate('{}'::jsonb)")}catch(error){reachedValidation=error.code!=='42501';await db.query('rollback to savepoint business_validation')}
 assert.equal(reachedValidation,true,'El permiso create debe llegar a la validación funcional.');
 await db.query("update role_access_matrix set can_delete=true where role_id=$1 and resource_key='accounting:opening-balances'",[role.role_id]);
 assert.equal((await db.query('select opening_balance_options() value')).rows[0].value.canReverse,true);
 await db.query('savepoint reverse_business_validation');let reachedReverseValidation=false;
 try{await db.query('select opening_balance_reverse(0)')}catch(error){reachedReverseValidation=error.code!=='42501';await db.query('rollback to savepoint reverse_business_validation')}
 assert.equal(reachedReverseValidation,true,'El permiso delete debe llegar a la validación funcional de reversión.');

 const privileges=(await db.query(`select
  has_function_privilege('anon','opening_balance_options()','EXECUTE')anon_options,
  has_function_privilege('anon','opening_balance_preview(bigint)','EXECUTE')anon_preview,
  has_function_privilege('authenticated','opening_balance_rate(bigint,date)','EXECUTE')authenticated_rate`)).rows[0];
 assert.equal(privileges.anon_options,false);assert.equal(privileges.anon_preview,false);assert.equal(privileges.authenticated_rate,false);
 console.log('OK: lectura y creación respetan la matriz por rol; RPC públicos y helpers no permiten bypass.');
}finally{await db.query('rollback').catch(()=>{});await db.end();}
