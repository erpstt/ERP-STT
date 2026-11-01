import{readFile}from'node:fs/promises';import{setupRateSecurity}from'./setup-rate-security.mjs';
export const migration='20261101210345_secure_country_currency_catalogs.sql',activation='20261101210408_activate_country_currency_catalogs_after_server.sql';
export async function setupCoreDictionarySecurity(db){await setupRateSecurity(db);await installCoreDictionarySecurity(db);}
export async function installCoreDictionarySecurity(db){
 await db.exec(`alter table currencies alter column currency_id add generated always as identity(start with 100);alter table currencies add column if not exists symbol varchar(10),add column if not exists fx_rate_precision smallint default 6;update currencies set symbol='$';alter table currencies add unique(currency_code);
 insert into currencies(currency_code,name,symbol)select code,code,'$'from unnest(array['DOP','GTQ','JMD','ARS','NIO','PEN'])code;
 create table countries(country_id bigint generated always as identity primary key,name text not null unique,country_code_iso2 varchar(2),country_code_iso3 varchar(3),phone_code varchar(12));
 insert into countries(name,country_code_iso2,country_code_iso3,phone_code)values('Costa Rica','CR','CRI','506'),('Unused country','XX','XXX',null);
 alter table subsidiaries add column country_id bigint references countries;update subsidiaries set country_id=1;
 create table synthetic_country_children(id bigint primary key,country_id bigint references countries on delete cascade);insert into synthetic_country_children values(1,2);
 insert into user_subsidiaries(user_id,subsidiary_id)values(1,5)on conflict do nothing;
 insert into role_access_matrix(role_id,resource_key,can_view,can_create,can_edit,can_delete)values(1,'core:countries',true,true,true,true),(1,'core:currencies',true,true,true,true),(3,'core:countries',true,false,false,false),(3,'core:currencies',true,false,false,false);
 grant all on countries,currencies to anon,authenticated,service_role;
 create policy unsafe_country on countries for all to authenticated using(true)with check(true);
 grant usage,select on all sequences in schema public to authenticated,service_role;`);
 for(const n of[migration,activation])await db.exec(await readFile(new URL('../../supabase/migrations/'+n,import.meta.url),'utf8'));
}
