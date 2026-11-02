import{readFile}from'node:fs/promises';import{setupGlobalConfigurationSecurity}from'./setup-global-configuration-security.mjs';
export const migration='20261102004543_secure_locale_catalogs.sql',activation='20261102004600_activate_locale_catalog_boundary_after_server.sql';
export async function setupLocaleCatalogSecurity(db){await setupGlobalConfigurationSecurity(db);await installLocaleCatalogSecurity(db);}
export async function installLocaleCatalogSecurity(db){await db.exec(`
create table languages(language_id bigint generated always as identity primary key,code varchar(10)unique not null,iso_code varchar(10),name text not null,is_active boolean not null default true);
insert into languages(code,iso_code,name)values('1','SPA','Spanish'),('2','ENG','English'),('3','POR','Portuguese'),('FR','FRA','French');
alter table timezones alter column timezone_id add generated always as identity(start with 100);alter table timezones add column utc_offset varchar(10)not null default 'UTC+00:00';
insert into timezones(timezone_id,name,is_active,utc_offset)overriding system value values(2,'Unused',true,'UTC-06:00');
alter table users add column language_id bigint references languages on delete set null;alter table users add foreign key(timezone_id)references timezones on delete set null;
update users set language_id=1,timezone_id=1 where user_id=1;alter table subsidiaries add column timezone_id bigint references timezones;update subsidiaries set timezone_id=1;
insert into role_access_matrix(role_id,resource_key,can_view,can_create,can_edit,can_delete)values(1,'core:languages',true,true,true,true),(1,'core:timezones',true,true,true,true),(3,'core:languages',true,false,false,false),(3,'core:timezones',true,false,false,false);
grant all on languages,timezones to anon,authenticated,service_role;grant all on sequence languages_language_id_seq,timezones_timezone_id_seq to anon,authenticated,service_role;
create or replace function public.app_supported_language_locale(
  p_code text,
  p_iso_code text
) returns text
language sql
immutable
set search_path=public,pg_temp
as $$
  select case
    when upper(btrim(coalesce(p_iso_code,''))) in ('ES','SPA','ESP','ES-ES','ES-CR')
      or upper(btrim(coalesce(p_code,''))) in ('ES','SPA','ESP','SPANISH','ESPAÑOL') then 'es'
    when upper(btrim(coalesce(p_iso_code,''))) in ('EN','ENG','EN-US','EN-GB')
      or upper(btrim(coalesce(p_code,''))) in ('EN','ENG','ENGLISH','INGLÉS','INGLES') then 'en'
    when upper(btrim(coalesce(p_iso_code,''))) in ('PT','POR','PRT','PT-BR','PT-PT')
      or upper(btrim(coalesce(p_code,''))) in ('PT','POR','PRT','PORTUGUESE','PORTUGUÊS','PORTUGUES') then 'pt'
    else null
  end
$$;


`);for(const n of[migration,activation])await db.exec(await readFile(new URL('../../supabase/migrations/'+n,import.meta.url),'utf8'));}
