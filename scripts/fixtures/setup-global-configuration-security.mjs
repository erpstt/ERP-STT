import{readFile}from'node:fs/promises';import{setupStatusMasterSecurity}from'./setup-status-master-security.mjs';
export const migration='20261102001704_secure_global_configuration.sql',activation='20261102001731_activate_global_configuration_boundary_after_server.sql';
export async function setupGlobalConfigurationSecurity(db){await setupStatusMasterSecurity(db);await installGlobalConfigurationSecurity(db);}
export async function installGlobalConfigurationSecurity(db){await db.exec(`
 create table parameters(parameter_id bigint generated always as identity primary key,parameter_key text not null unique,parameter_value text,description text);
 create table settings(setting_id bigint generated always as identity primary key,setting_key text not null,setting_value text,scope text not null default 'global',unique(setting_key,scope));
 create table audit_log(log_id bigint generated always as identity primary key,user_id bigint,action text,module text,entity_type text,entity_id bigint,entity_key text,description text,result text,ip_address inet,session_id text);
 create table change_log(audit_log_id bigint,field_name text,old_value text,new_value text,change_type text);
 create table deleted_records(original_table_name text,original_record_id bigint,deleted_by_user_id bigint,record_data_json text,module text,audit_log_id bigint);
 create function audit_primary_key(regclass,jsonb)returns text language sql as $$select 'id='||coalesce($2->>'parameter_id',$2->>'setting_id')$$;
 create function audit_request_ip()returns inet language sql as $$select null::inet$$;
 insert into role_access_matrix(role_id,resource_key,can_view,can_create,can_edit,can_delete)values(1,'core:parameters',true,true,true,true),(1,'core:settings',true,true,true,true),(3,'core:parameters',true,false,false,false),(3,'core:settings',true,false,false,false);
 grant all on parameters,settings to anon,authenticated,service_role;grant usage,select,update on sequence parameters_parameter_id_seq,settings_setting_id_seq to anon,authenticated,service_role;
 set check_function_bodies=off;`);
 await db.exec((await readFile(new URL('./global-config-audit-functions.sql',import.meta.url),'utf8')).replaceAll('\r\n','\n'));
 await db.exec('set check_function_bodies=on;revoke all on function public.audit_redact_jsonb(jsonb),public.capture_row_audit()from public,anon,authenticated,service_role;');
 for(const n of[migration,activation])await db.exec(await readFile(new URL('../../supabase/migrations/'+n,import.meta.url),'utf8'));
 await db.exec('create trigger central_row_audit after insert or update or delete on parameters for each row execute function capture_row_audit();create trigger central_row_audit after insert or update or delete on settings for each row execute function capture_row_audit();');
}
