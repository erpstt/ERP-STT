-- Process 75: independent catalog permissions and document ancestry scope.
set local lock_timeout='5s';
set local statement_timeout='60s';
create schema document_access_private;
revoke all on schema document_access_private from public,anon,authenticated,service_role;
grant usage on schema document_access_private to authenticated;

create function document_access_private.allowed(resource text,action text,p_key bigint default null,p_parent bigint default null)
returns boolean language plpgsql stable security definer set search_path=pg_catalog,public,pg_temp as $$
declare sid bigint;
begin
 if resource is null or action is null
  or resource not in ('documents:folders','documents:documents','documents:document-types','documents:document-versions','documents:document-relations','documents:document-permissions','accounting:journal-supports')
  or action not in ('view','create','edit','delete')then return false;end if;
 sid:=report_template_private.enter(resource,action);
 -- Direct catalog scope never follows a temporary report-company context.
 if sid is distinct from public.active_subsidiary_id_without_report_context()then return false;end if;
 case resource
  when 'documents:document-types'then
   -- Shared attachment types are global; maintenance remains administrative.
   return action='view' or public.app_is_admin();
  when 'documents:folders'then
   return p_key=sid and(p_parent is null or exists(select 1 from public.folders f where f.folder_id=p_parent and f.subsidiary_id=sid));
  when 'documents:documents'then
   return exists(select 1 from public.folders f where f.folder_id=p_key and f.subsidiary_id=sid);
  when 'accounting:journal-supports'then
   return exists(select 1 from public.journal j where j.journal_id=p_key and j.subsidiary_id=sid);
  else
   return exists(select 1 from public.documents d join public.folders f using(folder_id) where d.document_id=p_key and f.subsidiary_id=sid);
 end case;
exception when insufficient_privilege then return false;
end$$;
revoke all on all functions in schema document_access_private from public,anon,authenticated,service_role;
grant execute on function document_access_private.allowed(text,text,bigint,bigint) to authenticated;
revoke all on table public.folders,public.documents,public.document_type,public.document_version,public.document_relation,public.document_permission,public.journal_support from anon;

do $policies$
declare item record;op record;prefix text;predicate text;check_predicate text;expression text;
begin
 for item in select * from(values
  ('folders','documents:folders','subsidiary_id','company'),
  ('documents','documents:documents','folder_id','company'),
  ('document_type','documents:document-types',null,'documents'),
  ('document_version','documents:document-versions','document_id','documents'),
  ('document_relation','documents:document-relations','document_id','documents'),
  ('document_permission','documents:document-permissions','document_id','documents'),
  ('journal_support','accounting:journal-supports','journal_id','journal_support')
 )v(tbl,resource,col,policy_prefix)loop
  for op in select * from(values('select','view'),('insert','create'),('update','edit'),('delete','delete'))v(cmd,action)loop
   if item.col is null then
    predicate:=format('(select document_access_private.allowed(%L,%L))',item.resource,op.action);
   else
    predicate:=format('document_access_private.allowed(%L,%L,%I)',item.resource,op.action,item.col);
   end if;
   check_predicate:=predicate;
   if item.tbl='folders'then check_predicate:=format('document_access_private.allowed(%L,%L,subsidiary_id,parent_id)',item.resource,op.action);end if;
   expression:=case op.cmd when'insert'then 'with check ('||check_predicate||')'when'update'then 'using ('||predicate||') with check ('||check_predicate||')'else 'using ('||predicate||')'end;
   execute format('alter policy %I on public.%I %s',item.policy_prefix||'_'||op.cmd,item.tbl,expression);
  end loop;
 end loop;
end$policies$;
-- Existing sales/customer-payment RESTRICTIVE support policies stay in force.
notify pgrst,'reload schema';
