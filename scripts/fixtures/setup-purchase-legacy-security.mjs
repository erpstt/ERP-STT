import {readFile} from 'node:fs/promises';
export const legacyPurchaseTables=['purchase_requisition','purchase_quote'];
export async function installRealLegacyPurchaseTables(db){
 const original=await readFile('supabase/migrations/20260807000000_create_purchasing_catalogs.sql','utf8');
 await db.exec(original.split('\n').slice(0,2).join('\n'));
 for(const [table,prefix]of [['purchase_requisition','company'],['purchase_quote','purchasing']]){
  await db.exec('alter table '+table+' enable row level security');
  for(const op of ['select','insert','update','delete'])await db.exec('create policy '+prefix+'_'+op+' on '+table+' for '+op+' to authenticated '+(op==='insert'?'with check(true)':op==='update'?'using(true)with check(true)':'using(true)'));
 }
 await db.exec('grant all on purchase_requisition,purchase_quote to anon,authenticated,service_role;grant usage,select,update on sequence purchase_requisition_requisition_id_seq,purchase_quote_quote_id_seq to anon,authenticated,service_role;grant insert(requisition_number),update(status_id)on purchase_requisition to authenticated;grant update(valid_until)on purchase_quote to public;');
}
export async function installRealPurchaseContextGuard(db){
 const source=await readFile('supabase/migrations/20261103032056_secure_financial_reports_pdf_templates.sql','utf8');
 await db.exec('create schema report_template_private;revoke all on schema report_template_private from public');
 await db.exec(source.match(/create function report_template_private.enter[\s\S]*?end\$\$;/)[0]);
}
export async function setupPurchaseLegacySecurity(db){
 await db.exec(`create role anon;create role authenticated;create role service_role bypassrls;create schema auth;
 create function auth.uid()returns uuid language sql stable as $$select nullif(current_setting('fixture.uid',true),'')::uuid$$;
 create function app_user_id()returns bigint language sql stable as $$select nullif(current_setting('fixture.user',true),'')::bigint$$;
 create function app_active_role_id()returns bigint language sql stable as $$select nullif(current_setting('fixture.role',true),'')::bigint$$;
 create function active_subsidiary_id_without_report_context()returns bigint language sql stable as $$select nullif(current_setting('fixture.sid',true),'')::bigint$$;
 create function active_subsidiary_id()returns bigint language sql stable as $$select coalesce(nullif(current_setting('fixture.report_sid',true),'')::bigint,active_subsidiary_id_without_report_context())$$;
 create function app_is_admin()returns boolean language sql stable as $$select app_user_id()=2$$;
 create table users(user_id bigint primary key,is_active boolean);insert into users values(1,true),(2,true),(3,false);
 create table user_roles(user_id bigint,role_id bigint);insert into user_roles values(1,10),(1,11),(1,12),(1,13),(1,14),(2,99),(3,12);
 create table user_subsidiaries(user_id bigint,subsidiary_id bigint);insert into user_subsidiaries values(1,1),(1,2),(2,1),(2,2),(3,1);
 create table grants(role_id bigint,resource text,v boolean,c boolean,e boolean,d boolean);
 insert into grants values(10,'purchasing:requisitions',true,true,true,true),(11,'purchasing:quotes',true,true,true,true),(12,'purchasing:requisitions',true,true,true,true),(12,'purchasing:quotes',true,true,true,true),(14,'purchasing:requisitions',false,true,true,true),(14,'purchasing:quotes',false,true,true,true);
 create function security_assert_role_access(r text,a text)returns void language plpgsql stable security definer set search_path=pg_catalog,public as $$begin if app_is_admin()then return;end if;if not exists(select 1 from grants where role_id=app_active_role_id()and resource=r and case a when'view'then v when'create'then c when'edit'then e when'delete'then d else false end)then raise exception using errcode='42501';end if;end$$;
 create table subsidiaries(subsidiary_id bigint primary key);insert into subsidiaries values(1),(2);
 create table suppliers(supplier_id bigint primary key);insert into suppliers values(1);
 create table employees(employee_id bigint primary key,subsidiary_id bigint);insert into employees values(1,1),(2,2);
 create table status(status_id bigint primary key);insert into status values(1);
 create table public."transaction"(transaction_id bigint generated always as identity primary key,subsidiary_id bigint);insert into public."transaction"(subsidiary_id)values(1),(2);
 alter table public."transaction"enable row level security;grant select on public."transaction"to authenticated;
 create sequence unrelated_sequence;grant all on sequence unrelated_sequence to authenticated,service_role;create table unrelated_records(id bigint);alter table unrelated_records enable row level security;create policy preserved on unrelated_records for select to authenticated using(true);
 create function unrelated_rpc()returns text language sql security definer as $$select 'Synthetic unchanged'::text$$;grant execute on function unrelated_rpc()to authenticated,service_role;`);
 await installRealPurchaseContextGuard(db);await installRealLegacyPurchaseTables(db);
 await db.exec(`insert into purchase_requisition(requisition_number,transaction_id,employee_id,subsidiary_id,status_id)values('SYN-REQ-OWN',1,1,1,1),('SYN-REQ-FOREIGN',2,2,2,1);
 insert into purchase_quote(quote_number,transaction_id,supplier_id,valid_until)values('SYN-QUOTE-OWN',1,1,'2026-11-03'),('SYN-QUOTE-FOREIGN',2,1,'2026-11-03'),('SYN-QUOTE-UNATTRIBUTED',null,1,'2026-11-03');`);
}
