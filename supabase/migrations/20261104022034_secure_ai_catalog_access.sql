-- Process 79: resource permissions, private conversations and scoped OCR/predictions.
-- No data updates, permission assignments, producer or audit-trigger changes.
set local lock_timeout='5s';
set local statement_timeout='60s';
create schema ai_access_private;
revoke all on schema ai_access_private from public,anon,authenticated,service_role;
grant usage on schema ai_access_private to authenticated;

create function ai_access_private.allowed(resource text,action text,p_key bigint default null)
returns boolean language plpgsql stable security definer
set search_path=pg_catalog,public,pg_temp as $$
declare sid bigint;
begin
 if auth.uid() is null or resource is null or action is null
  or resource not in('ai:ai-agents','ai:ai-prompts','ai:ai-conversations','ai:ai-documents','ai:ai-predictions')
  or action not in('view','create','edit','delete')then return false;end if;
 sid:=report_template_private.enter(resource,action);
 -- Catalog access cannot inherit temporary cross-company report context.
 if sid is distinct from public.active_subsidiary_id_without_report_context()then return false;end if;
 case resource
  when 'ai:ai-agents'then
   -- FK cascades bypass child RLS. Require child deletion permission even for an
   -- empty agent, closing races with concurrent insertion of a prompt.
   if action='delete'then perform report_template_private.enter('ai:ai-prompts','delete');end if;
   return true;
  when 'ai:ai-prompts'then
   -- Global maintenance follows the existing A-06 permissions, including
   -- explicitly authorized non-administrative roles.
   return true;
  when 'ai:ai-conversations'then
   -- This table has no company column. Privacy is by owner, even for admins.
   return p_key=public.app_user_id();
  when 'ai:ai-documents'then
   -- Independent OCR permission: no need for a parent catalog SELECT grant.
   return exists(select 1 from public.documents d join public.folders f using(folder_id)
    where d.document_id=p_key and f.subsidiary_id=sid);
  when 'ai:ai-predictions'then
   return p_key=sid;
 end case;
 return false;
exception when insufficient_privilege then return false;
end$$;
revoke all on all functions in schema ai_access_private from public,anon,authenticated,service_role;
grant execute on function ai_access_private.allowed(text,text,bigint) to authenticated;

-- The database derives the ERP owner from the verified caller, not browser data.
-- Existing rows and ownership stay unchanged; UPDATE is also checked by RLS.
alter table public.ai_conversation alter column user_id set default public.app_user_id();
revoke all on table public.ai_agents,public.ai_prompt,public.ai_conversation,public.ai_document,public.ai_prediction from public,anon;

do $policies$
declare item record;op record;predicate text;expression text;
begin
 for item in select * from(values
  ('ai_agents','ai:ai-agents',null,'ai'),
  ('ai_prompt','ai:ai-prompts',null,'ai'),
  ('ai_conversation','ai:ai-conversations','user_id','ai'),
  ('ai_document','ai:ai-documents','document_id','ai'),
  ('ai_prediction','ai:ai-predictions','subsidiary_id','company')
 )v(tbl,resource,col,prefix)loop
  for op in select * from(values('select','view'),('insert','create'),('update','edit'),('delete','delete'))v(cmd,action)loop
   predicate:=case when item.col is null then
    format('(select ai_access_private.allowed(%L,%L))',item.resource,op.action)
    else format('ai_access_private.allowed(%L,%L,%I)',item.resource,op.action,item.col)end;
   expression:=case op.cmd when 'insert'then 'with check ('||predicate||')'
    when 'update'then 'using ('||predicate||') with check ('||predicate||')'
    else 'using ('||predicate||')'end;
   execute format('alter policy %I on public.%I %s',item.prefix||'_'||op.cmd,item.tbl,expression);
  end loop;
 end loop;
end$policies$;
notify pgrst,'reload schema';
