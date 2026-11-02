import { readFile } from 'node:fs/promises';

export const migration = '20261102162941_add_other_names_entities.sql';
const read = path => readFile(new URL(path, import.meta.url), 'utf8');
const functionDefinition = (source, name) => {
  const start = source.indexOf(`create or replace function public.${name}(`);
  if (start < 0) throw new Error(`Missing real audit function ${name}`);
  const end = source.indexOf('$$;', start);
  if (end < 0) throw new Error(`Missing audit function body ${name}`);
  return source.slice(start, end + 3);
};

export async function setupOtherNames(db) {
  await db.exec(`
    create role anon; create role authenticated; create role service_role;
    create schema auth; create schema entity_master_private;
    create table auth.users(id uuid primary key,email text,raw_app_meta_data jsonb default '{}');
    create function auth.jwt() returns jsonb language sql stable as $$
      select coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb
    $$;
    create table users(user_id bigint primary key,auth_user_id uuid,email text,first_name text,last_name text,is_active boolean default true);
    create table roles(role_id bigint primary key,role_name text,is_system_role boolean default false);
    create table user_roles(user_id bigint,role_id bigint);
    create table user_subsidiaries(user_id bigint,subsidiary_id bigint);
    create table user_role_sessions(session_id text primary key,user_id bigint,role_id bigint);
    create table user_company_sessions(session_id text primary key,user_id bigint,subsidiary_id bigint);
    create table subsidiaries(subsidiary_id bigint primary key,name text,is_active boolean default true);
    create table banks(bank_id bigint primary key,bank_name text,bank_code text,country_id bigint);
    create table role_access_matrix(role_id bigint,resource_key text,can_view boolean,can_create boolean,can_edit boolean,can_delete boolean,primary key(role_id,resource_key));
    create function public.app_session_id() returns text language sql stable as $$ select auth.jwt()->>'session_id' $$;
    create function public.app_user_id() returns bigint language sql stable security definer as $$
      select user_id from public.users where auth_user_id::text=auth.jwt()->>'sub' and is_active
    $$;
    create function public.app_active_role_id() returns bigint language sql stable security definer as $$
      select role_id from public.user_role_sessions where session_id=public.app_session_id() and user_id=public.app_user_id()
    $$;
    create function entity_master_private.identity() returns bigint language plpgsql stable security definer as $$
    declare sid bigint;
    begin
      select s.subsidiary_id into sid from public.user_company_sessions s
      join public.subsidiaries c on c.subsidiary_id=s.subsidiary_id and c.is_active
      join public.user_subsidiaries us on us.user_id=s.user_id and us.subsidiary_id=s.subsidiary_id
      where s.session_id=public.app_session_id() and s.user_id=public.app_user_id();
      if sid is null or not exists(select 1 from public.user_roles
        where user_id=public.app_user_id() and role_id=public.app_active_role_id()) then
        raise exception using errcode='42501',message='Contexto de usuario, rol o filial inválido.';
      end if;
      return sid;
    end $$;
    create table audit_log(log_id bigint generated always as identity primary key,user_id bigint,action text,module text,
      entity_type text,entity_id bigint,entity_key text,description text,result text,ip_address inet,session_id text,"timestamp" timestamptz default now());
    create table change_log(audit_log_id bigint,field_name text,old_value text,new_value text,change_type text);
    create table deleted_records(original_table_name text,original_record_id bigint,deleted_by_user_id bigint,record_data_json text,module text,audit_log_id bigint);
    create table activity_log(user_id bigint,activity_type text,path_accessed text);
    insert into auth.users(id,email) values
      ('00000000-0000-4000-8000-000000000001','manager@example.invalid'),
      ('00000000-0000-4000-8000-000000000002','foreign@example.invalid');
    insert into users values
      (1,'00000000-0000-4000-8000-000000000001','manager@example.invalid','Synthetic','Manager',true),
      (2,'00000000-0000-4000-8000-000000000002','foreign@example.invalid','Synthetic','Foreign',true);
    insert into roles values(1,'Administrador',true),(2,'Manager',false),(3,'Reader',false),(4,'Admin without grant',false),(5,'Admin',false);
    insert into user_roles values(1,1),(1,2),(1,3),(1,4),(1,5),(2,2);
    insert into subsidiaries values(1,'Synthetic A',true),(2,'Synthetic B',true),(3,'Inactive',false);
    insert into user_subsidiaries values(1,1),(1,2),(1,3),(2,2);
    insert into banks values(1,'Synthetic Bank','SYN',1),(2,'Foreign Bank','FOR',2);
  `);
  // Load the real audit engine functions, rather than an imitation of its triggers.
  const central = await read('../../supabase/migrations/20260826160000_enable_central_auditing.sql');
  const actors = await read('../../supabase/migrations/20260913090000_actor_audit_engine.sql');
  const redaction = await read('../../supabase/migrations/20261026113000_redact_audit_secrets.sql');
  const auditReport = await read('../../supabase/migrations/20261019110000_audit_change_report.sql');
  for (const name of ['audit_request_ip', 'audit_primary_key', 'install_audit_trigger']) await db.exec(functionDefinition(central, name));
  for (const name of ['audit_field_is_sensitive', 'audit_redact_jsonb', 'audit_redact_json_text', 'capture_row_audit']) await db.exec(functionDefinition(redaction, name));
  for (const name of ['resolve_audit_actor', 'stamp_actor_audit', 'reject_audit_mutation', 'reject_audit_truncate', 'install_actor_audit']) await db.exec(functionDefinition(actors, name));
  await db.exec(functionDefinition(auditReport, 'audit_change_entity_meta'));
  const originalAuditMetadata = (await db.query(`select sample,public.audit_change_entity_meta(sample,'public') as metadata
    from unnest(array['customers','suppliers','employees','invoice','journal','users','bank_check','unknown_entity']) sample`)).rows;
  await db.exec('begin');
  await db.exec(await read('../../supabase/migrations/' + migration));
  await db.exec('commit');
  await db.exec(`insert into role_access_matrix values
    (2,'entities:other-names',true,true,true,true),(3,'entities:other-names',true,false,false,false)`);
  return { originalAuditMetadata };
}
