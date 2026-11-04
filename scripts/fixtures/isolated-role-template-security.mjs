import {readFile} from 'node:fs/promises';
import {isolatedUserAccessDatabase,assumeSecurityUser,assumeSqlRole,beginIsolatedCase,deniedSql,authId,authSession,hash} from './isolated-user-access-db-test.mjs';

export {assumeSecurityUser,assumeSqlRole,beginIsolatedCase,deniedSql,authId,authSession,hash};
const source=name=>readFile(new URL('../../supabase/migrations/'+name,import.meta.url),'utf8');
function definition(sql,name){
 const marker='CREATE OR REPLACE FUNCTION public.'+name+'(',start=sql.indexOf(marker),end=sql.indexOf('$function$;',start);
 if(start<0||end<0||sql.indexOf(marker,start+marker.length)!==-1)throw Error('Expected one reviewed authorization definition');
 return sql.slice(start,end+'$function$;'.length);
}

// Use current central-admin/session wrappers with entirely synthetic matrix and
// permission rows. Apply only the reviewed A06 function patches, unchanged and
// with their original function fingerprints; never load the production matrix.
export async function isolatedRoleTemplateDatabase({templates=false}={}){
 const db=await isolatedUserAccessDatabase();
 try{
  await db.exec("insert into permissions(code,module,description,is_operational) select 'SYNTHETIC_OPERATION_'||n,'SYNTHETIC','Synthetic operational action',true from generate_series(1,31)n;insert into permissions(code,module,description,is_operational) values('SYNTHETIC_INTERNAL','SYNTHETIC','Synthetic non-operational action',false)");
  if(templates){
   await db.exec(`alter table subsidiaries add column logo_url text;
    create table configuraciones_correos(
     id_configuracion bigint generated always as identity primary key,
     id_subsidiaria bigint not null references subsidiaries(subsidiary_id),
     tipo_notificacion text not null,asunto_template text,cuerpo_template text,
     activo boolean default true,updated_by_email text,updated_at timestamptz default now(),
     unique(id_subsidiaria,tipo_notificacion));`);
   await db.exec((await source('20261026103000_user_invitation_email_template.sql')).replaceAll('\r\n','\n'));
   await db.exec("insert into role_access_matrix(role_id,resource_key,can_view,can_create,can_edit,can_delete) values(3,'configuration:notification-templates',true,false,false,false),(1,'configuration:notification-templates',true,false,true,false),(2,'security:users',true,true,false,false)");
  }
  const reviewed=(await readFile(new URL('./legacy-authorization-functions.sql',import.meta.url),'utf8')).replaceAll('\r\n','\n');
  const names=['security_assert_role_access','security_resource_allowed',...(templates?['user_invitation_email_settings']:[])];
  for(const name of names)await db.exec(definition(reviewed,name));
  const activation=await source('20261102014321_activate_legacy_authorization_retirement_after_server.sql');
  const boundary=activation.match(/delete from public\.role_access_matrix where resource_key='legacy:all';\s*alter table public\.role_access_matrix add constraint no_legacy_authorization check\(resource_key<>'legacy:all'\);/);
  if(!boundary)throw Error('Reviewed A06 matrix boundary missing');
  await db.exec(boundary[0]);
  const patches=[...activation.matchAll(/do \$patch\$[\s\S]*?end\$patch\$;/g)].map(match=>match[0]);
  for(const name of names){
   const signature=name==='user_invitation_email_settings'?name+'(text,jsonb)':name+'(text,text)';
   const selected=patches.filter(patch=>patch.includes("oid='public."+signature+"'::regprocedure"));
   if(selected.length!==1)throw Error('Expected one unchanged A06 activation patch');
   await db.exec(selected[0]);
  }
  return db;
 }catch(error){await db.close();throw error;}
}
