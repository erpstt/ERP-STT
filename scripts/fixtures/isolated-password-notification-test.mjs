import {readFile} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
import {setupAccessAdminSecurity} from './setup-access-admin-security.mjs';

const migration=name=>readFile(new URL('../../supabase/migrations/'+name,import.meta.url),'utf8');
function definition(sql,name){
 const marker='create or replace function public.'+name+'(';
 const start=sql.indexOf(marker),end=sql.indexOf('\n$$;',start);
 if(start<0||end<0||sql.indexOf(marker,start+marker.length)!==-1)throw new Error('Expected one migration function: '+name);
 return sql.slice(start,end+4);
}

// Real notification functions and current access-administration wrappers run in
// WebAssembly PostgreSQL memory. All users, sessions, companies and hashes are
// synthetic. The reused fixture is unchanged; no network/SMTP extension exists.
export async function isolatedPasswordNotificationDatabase(){
 const db=new PGlite();
 try{
  await setupAccessAdminSecurity(db);
  await db.exec(`create function auth.role() returns text language sql stable as $$select auth.jwt()->>'role'$$;
   alter table subsidiaries add column logo_url text;
   update subsidiaries set name='Synthetic password company '||subsidiary_id;
   create table configuraciones_correos(
    id_configuracion bigint generated always as identity primary key,
    id_subsidiaria bigint not null references subsidiaries(subsidiary_id),
    tipo_notificacion text not null,asunto_template text,cuerpo_template text,
    activo boolean default true,updated_by_email text,updated_at timestamptz default now(),
    unique(id_subsidiaria,tipo_notificacion)
   );
   insert into users(user_id,auth_user_id,email,first_name,last_name,is_active) values
    (100,'00000000-0000-0000-0000-000000000100','global-password@example.invalid','Global','Synthetic',true),
    (101,'00000000-0000-0000-0000-000000000101','other-password@example.invalid','Other','Synthetic',true),
    (102,'00000000-0000-0000-0000-000000000102','inactive-password@example.invalid','Inactive','Synthetic',false);
   insert into user_subsidiaries(user_id,subsidiary_id) values(101,2),(102,1);
   insert into role_access_matrix(role_id,resource_key,can_view,can_create,can_edit,can_delete) values
    (1,'security:users',true,false,true,false),(3,'security:users',true,false,false,false);
  `);
  await db.exec(await migration('20261026102000_password_recovery_grants.sql'));
  const notification=await migration('20261027153000_user_edit_password_notification.sql');
  const global=await migration('20261029100000_admin_global_user_password_recovery.sql');
  // Install table/template seed and exact function definitions, preserving the
  // newer public wrapper instead of replaying a migration over that wrapper.
  const templateEnd=notification.indexOf('create or replace function public.security_prepare_user_password_recovery(');
  if(templateEnd<0)throw new Error('Notification migration boundary missing');
  await db.exec(notification.slice(0,templateEnd));
  await db.exec(definition(notification,'user_password_recovery_email_settings'));
  await db.exec(definition(notification,'consume_password_recovery_grant'));
  await db.exec(definition(global,'security_prepare_user_password_recovery').replace(
   'function public.security_prepare_user_password_recovery(',
   'function access_admin_private.security_prepare_user_password_recovery('
  ));
  await db.exec(definition(global,'security_audit_user_password_notification'));
  const grantsStart=notification.indexOf('revoke all on function public.security_prepare_user_password_recovery(');
  if(grantsStart<0)throw new Error('Notification migration grants missing');
  await db.exec(notification.slice(grantsStart));
  return db;
 }catch(error){await db.close();throw error;}
}
