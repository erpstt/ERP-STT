import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
export const scheduledPresentationMigration='20261104170234_financial_statement_presentation_scheduled_delivery.sql';
const source=name=>readFile(new URL('../../supabase/migrations/'+name,import.meta.url),'utf8').then(value=>value.replace(/\r\n/g,'\n'));
function definition(sql,name){
 const start=sql.search(new RegExp('create(?: or replace)? function (?:public\\.)?'+name+'\\(','i'));
 const end=sql.indexOf('end$$;',start)+7;
 assert.ok(start>=0&&end>start,'One actual function source required: '+name);
 return sql.slice(start,end);
}
export async function scheduledPresentationSources(){
 const catalog=await source('20260921200000_scheduled_report_catalog.sql');
 let snapshot=definition(catalog,'scheduled_report_snapshot_v2');
 const names=['run_accounting_report','run_pending_invoice_control_report','run_general_journal_report','run_sales_transaction_report','run_purchase_transaction_report','run_bank_reconciliation_report','run_bank_balance_period_report'];
 for(const name of names)snapshot=snapshot.replace(new RegExp('(^|[^a-zA-Z0-9_.])(?:public[.])?'+name+'([\\s]*\\()','g'),'$1report_delivery_private.'+name+'$2');
 snapshot=snapshot.replace('set search_path=public,pg_temp','set search_path=pg_catalog,public,pg_temp');
 return [definition(catalog,'scheduled_report_validate_options'),definition(catalog,'scheduled_report_manage'),snapshot];
}
export async function setupScheduledPresentation(db){
 await db.exec([
 "create role anon;create role authenticated;create role service_role;create schema auth;create schema report_delivery_private;",
 "revoke all on schema report_delivery_private from public,anon,authenticated,service_role;",
 "create function auth.jwt()returns jsonb language sql stable as $$select coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb$$;",
 "create function auth.role()returns text language sql stable as $$select auth.jwt()->>'role'$$;",
 "create table users(user_id bigint primary key,email text,is_active boolean);insert into users values(1,'one@example.invalid',true),(2,'two@example.invalid',true),(3,'inactive@example.invalid',false),(4,'four@example.invalid',true);",
 "create table user_roles(user_id bigint,role_id bigint);insert into user_roles values(1,10),(2,10),(3,10),(4,10);",
 "create table user_subsidiaries(user_id bigint,subsidiary_id bigint);insert into user_subsidiaries values(1,1),(2,2),(3,1),(4,1);",
 "create table permissions(permission_id bigint,code text);insert into permissions values(1,'REPORT_SCHEDULE_MANAGE');",
 "create table role_permissions(role_id bigint,permission_id bigint);insert into role_permissions values(10,1);",
 "create function app_user_id()returns bigint language sql stable as $$select user_id from users where email=auth.jwt()->>'email'$$;",
 "create function app_active_role_id()returns bigint language sql stable as $$select nullif(current_setting('fixture.role',true),'')::bigint$$;",
 "create function active_subsidiary_id()returns bigint language sql stable as $$select coalesce(nullif(auth.jwt()->>'scheduled_report_sid','')::bigint,nullif(current_setting('fixture.sid',true),'')::bigint)$$;",
 "create function app_is_admin()returns boolean language sql stable as $$select false$$;",
 "create table currencies(currency_id bigint primary key,currency_code text);insert into currencies values(1,'JMD'),(2,'USD');",
 "create table subsidiaries(subsidiary_id bigint primary key,name text,currency_id bigint);insert into subsidiaries values(1,'Synthetic one',1),(2,'Synthetic two',2);",
 "create table accounting_books(accounting_book_id bigint,subsidiary_id bigint,is_active boolean,is_primary boolean);insert into accounting_books values(1,1,true,true),(2,2,true,true);",
 "create table bank_account(bank_account_id bigint,subsidiary_id bigint);insert into bank_account values(1,1),(2,2);",
 "create table scheduled_report_catalog(code text primary key,name text);insert into scheduled_report_catalog values('balance-sheet','Balance'),('income-statement','Income'),('cash-flow','Cash'),('general-ledger','Ledger'),('AR','AR'),('bank-reconciliation','Bank');",
 "create table scheduled_reports(id bigint generated always as identity primary key,subsidiary_id bigint,owner_id bigint,name text,period_mode text,report_options jsonb default '{}');",
 "create function scheduled_report_manage_before_catalog(p_action text,p jsonb)returns jsonb language plpgsql security definer as $$declare result jsonb;begin if p_action<>'save'then return jsonb_build_object('unchanged',true);end if;insert into scheduled_reports(subsidiary_id,owner_id,name)values(active_subsidiary_id(),app_user_id(),p->>'name')returning to_jsonb(scheduled_reports)into result;return result;end$$;",
 "create function scheduled_report_catalog_options()returns jsonb language sql as $$select '{}'::jsonb$$;",
 "create table synthetic_balances(id bigint primary key,amount numeric);insert into synthetic_balances values(1,123.45);",
 "create function report_delivery_private.run_accounting_report(kind text,filters jsonb)returns jsonb language sql stable security definer as $$select jsonb_build_object('rows',(select jsonb_agg(to_jsonb(x))from synthetic_balances x),'total',1,'summary',jsonb_build_object('amount',123.45))$$;",
 "create function report_delivery_private.run_financial_statement_presentation(kind text,filters jsonb,owner_id bigint)returns jsonb language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$begin if current_setting('fixture.fail',true)='true'then raise exception 'Synthetic conversion failure';end if;return jsonb_build_object('rows',jsonb_build_array(jsonb_build_object('id',1,'amount',0.75)),'total',1,'summary',jsonb_build_object('amount',0.75),'presentationCurrency','USD','presentationCurrencyCode','USD','localCurrencyCode','JMD','receivedOwner',owner_id,'receivedFilters',filters);end$$;",
 "revoke all on function report_delivery_private.run_accounting_report(text,jsonb),report_delivery_private.run_financial_statement_presentation(text,jsonb,bigint)from public,anon,authenticated,service_role;"
 ].join('\n'));
 const legacy=await source('20260921190000_scheduled_reports.sql');
 for(const name of ['scheduled_report_access','scheduled_report_owner_allowed']){
  // Access includes a CRLF body in the old checked-in source; tests normalize it.
  if(name==='scheduled_report_owner_allowed'){
   const start=legacy.indexOf('create function '+name+'('),end=legacy.indexOf('$$;',legacy.indexOf('as $$',start)+5)+3;
   assert.ok(start>=0&&end>start);await db.exec(legacy.slice(start,end));
  }else await db.exec(definition(legacy,name));
 }
 for(const sql of await scheduledPresentationSources())await db.exec(sql);
 await db.exec("revoke all on function scheduled_report_access(),scheduled_report_owner_allowed(bigint,bigint),scheduled_report_validate_options(bigint,text,jsonb),scheduled_report_manage(text,jsonb),scheduled_report_snapshot_v2(bigint,text,date,jsonb,bigint)from public,anon,authenticated,service_role;grant execute on function scheduled_report_access(),scheduled_report_owner_allowed(bigint,bigint),scheduled_report_validate_options(bigint,text,jsonb)to service_role;grant execute on function scheduled_report_manage(text,jsonb),scheduled_report_snapshot_v2(bigint,text,date,jsonb,bigint)to authenticated,service_role;");
}
export async function applyScheduledPresentation(db){
 await db.exec('begin');try{await db.exec(await source(scheduledPresentationMigration));await db.exec('commit');}catch(error){await db.exec('rollback');throw error;}
}
