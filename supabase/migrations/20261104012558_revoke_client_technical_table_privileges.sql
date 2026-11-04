-- Process 77: remove technical client rights without changing CRUD or RLS.
set local lock_timeout='5s';
set local statement_timeout='60s';
do $revoke$
declare name text;col record;
begin
 if current_setting('server_version_num')::int<170000 then
  raise exception 'This migration requires PostgreSQL 17 or newer for MAINTAIN';
 end if;
 if exists(select 1 from pg_default_acl d cross join lateral aclexplode(d.defaclacl)x
  where d.defaclrole='postgres'::regrole and d.defaclnamespace=0 and d.defaclobjtype='r'
  and x.privilege_type in('TRUNCATE','REFERENCES','TRIGGER','MAINTAIN')
  and(x.grantee=0 or x.grantee in(select oid from pg_roles where rolname in('anon','authenticated'))))then
  raise exception using errcode='55000',message='Global technical defaults require separate review';
 end if;
 foreach name in array array['account_group','account_subsidiaries','accounting_books','activity_log','ai_agents','ai_conversation','ai_document','ai_prediction','ai_prompt','allocation_rules','asset_impairment','asset_revaluation','audit_log','bank_account','banks','change_log','chart_accounts','deleted_records','document_permission','document_relation','document_type','document_types','document_version','documents','event_log','folders','gl_impact','holidays','intercompany_eliminations','journal_support','menu_permissions','menus','password_history','payment_methods','payment_terms','permissions','price_list','price_list_item','purchase_quote','purchase_requisition','role_access_matrix','role_permissions','roles','series','subsidiary_approver_options','transaction','transaction_line','treasury_schedule','user_company_sessions','user_role_sessions','user_roles','user_subsidiaries']loop
  execute format('revoke truncate,references,trigger,maintain on table public.%I from public,anon,authenticated restrict',name);
  -- Column REFERENCES is independent of table-level ACLs.
  for col in select a.attname from pg_attribute a where a.attrelid=to_regclass(format('public.%I',name))
   and a.attnum>0 and not a.attisdropped and exists(select 1 from aclexplode(a.attacl)x
    where x.privilege_type='REFERENCES'and(x.grantee=0 or x.grantee in(select oid from pg_roles where rolname in('anon','authenticated'))))
  loop
   execute format('revoke references(%I) on table public.%I from public,anon,authenticated restrict',col.attname,name);
  end loop;
 end loop;
end$revoke$;
-- Only migration-owned public defaults are in scope. Platform/storage defaults stay unchanged.
alter default privileges for role postgres in schema public
 revoke truncate,references,trigger,maintain on tables from public,anon,authenticated restrict;
notify pgrst,'reload schema';
