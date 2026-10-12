import {readFile} from 'node:fs/promises';
import pg from 'pg';
process.loadEnvFile?.('.env');
const projectRef=new URL(process.env.SUPABASE_URL).hostname.split('.')[0];
const client=new pg.Client({host:process.env.SUPABASE_DB_HOST||'aws-0-us-east-1.pooler.supabase.com',port:Number(process.env.SUPABASE_DB_PORT||6543),database:process.env.SUPABASE_DB_NAME||'postgres',user:process.env.SUPABASE_DB_USER||`postgres.${projectRef}`,password:process.env.SUPABASE_DB_PASSWORD||process.env.PGPASSWORD,ssl:{rejectUnauthorized:false},connectionTimeoutMillis:15000});
const sql=await readFile(new URL('../supabase/migrations/20261012110000_role_access_matrix.sql',import.meta.url),'utf8');
await client.connect();
try{
 await client.query('begin');await client.query(sql);
 const actor=(await client.query("select u.email,r.role_id,au.id auth_id from users u join auth.users au on lower(au.email)=lower(u.email) join user_roles ur using(user_id) join roles r using(role_id) where lower(r.role_name) in('administrador','administrator','admin') limit 1")).rows[0];
 if(!actor)throw new Error('No existe un usuario administrador para la prueba.');
 const sessionId=`matrix-test-${Date.now()}`;
 await client.query("select set_config('request.jwt.claims',$1,true)",[JSON.stringify({sub:actor.auth_id,email:actor.email,session_id:sessionId})]);
 await client.query("insert into user_role_sessions(session_id,user_id,role_id)select $1,user_id,$2 from users where lower(email)=lower($3)",[sessionId,actor.role_id,actor.email]);
 const target=(await client.query("select role_id from roles where lower(role_name)='contabilidad' limit 1")).rows[0]??(await client.query('select role_id from roles where role_id<>$1 order by role_id limit 1',[actor.role_id])).rows[0];
 if(!target)throw new Error('No existe un rol de prueba.');
 const before=(await client.query('select security_role_access_matrix_data($1) data',[target.role_id])).rows[0].data;
 if(!Array.isArray(before.roles)||!before.roles.length)throw new Error('La consulta no devolvió roles.');
 if(!Array.isArray(before.specialPermissions)||before.specialPermissions.length!==31)throw new Error(`Se esperaban 31 permisos operativos y se obtuvieron ${before.specialPermissions?.length??0}.`);
 const entries=[{resourceKey:'accounting:chart-accounts',canView:true,canCreate:true,canEdit:false,canDelete:false},{resourceKey:'reports:accounting-reports',canView:true,canCreate:false,canEdit:false,canDelete:false}];
 const specialId=before.specialPermissions[0].permissionId;
 const saved=(await client.query('select security_save_role_access_matrix($1,$2::jsonb,$3::bigint[]) data',[target.role_id,JSON.stringify(entries),[specialId]])).rows[0].data;
 if(saved.saved!==2||saved.specialSaved!==1)throw new Error('No se guardaron las opciones y la acción especial esperadas.');
 await client.query(sql);
 const after=(await client.query('select security_role_access_matrix_data($1) data',[target.role_id])).rows[0].data;
 if(after.grants.length!==2||after.grants.some(x=>!x.canView||x.resourceKey==='legacy:all'))throw new Error('La matriz guardada no coincide o fue sobrescrita al reaplicar la migración.');
 if(after.specialPermissions.filter(item=>item.enabled).length!==1||!after.specialPermissions.find(item=>item.permissionId===specialId)?.enabled)throw new Error('La acción especial no se guardó de forma atómica.');
 await client.query('update user_role_sessions set role_id=$1 where session_id=$2',[target.role_id,sessionId]);
 await client.query("select security_assert_role_access('accounting:chart-accounts','view')");
 await client.query('savepoint denied_action');let denied=false;
 try{await client.query("select security_assert_role_access('accounting:chart-accounts','edit')")}catch(error){denied=error.code==='42501';await client.query('rollback to savepoint denied_action')}
 if(!denied)throw new Error('La acción no asignada no fue rechazada.');
 console.log(`OK: matriz transaccional validada para ${before.roles.find(x=>x.roleId===target.role_id)?.name||target.role_id}; rollback aplicado.`);
}finally{await client.query('rollback').catch(()=>{});await client.end();}
