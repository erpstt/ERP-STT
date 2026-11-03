-- A-05/M-08: explicit direct ledger reads and customer statement permissions.
set local lock_timeout='5s';set local statement_timeout='60s';
create schema statement_access_private;
revoke all on schema statement_access_private from public,anon,authenticated,service_role;
grant usage on schema statement_access_private to authenticated;

create function statement_access_private.allowed(resource text)returns boolean language plpgsql stable security definer
set search_path=pg_catalog,public,pg_temp as $$
begin perform report_template_private.enter(resource,'view');return true;exception when insufficient_privilege then return false;end$$;

create function statement_access_private.line_visible(p_journal bigint)returns boolean language plpgsql stable security definer
set search_path=pg_catalog,public,pg_temp as $$
declare resource text;sid bigint;
begin
 if auth.uid()is null then return false;end if;
 if public.app_is_admin()then resource:='accounting:journals';
 else select m.resource_key into resource from public.role_access_matrix m where m.role_id=public.app_active_role_id()
  and m.can_view and m.resource_key in('accounting:journals','accounting:journal-lines','reports:accounting-reports')limit 1;end if;
 if resource is null then return false;end if;
 sid:=report_template_private.enter(resource,'view');
 return exists(select 1 from public.journal h where h.journal_id=p_journal and h.subsidiary_id=sid);
exception when insufficient_privilege then return false;
end$$;

create function statement_access_private.enter(p_action text,p_sid bigint default null)returns bigint language plpgsql stable security definer
set search_path=pg_catalog,public,pg_temp as $$
declare sid bigint;
begin
 sid:=report_template_private.enter('reports:accounting-reports','view');
 perform report_template_private.enter('entities:customers','view');
 if p_action='send'then perform report_template_private.enter('entities:customers','edit');
 elsif p_action<>'get'then raise exception using errcode='22023',message='Acción de estado de cuenta inválida.';end if;
 if p_sid is not null then
  if not exists(select 1 from public.user_subsidiaries where user_id=public.app_user_id()and subsidiary_id=p_sid)
  then raise exception using errcode='42501',message='Subsidiaria no autorizada.';end if;sid:=p_sid;
 end if;
 return sid;
end$$;
revoke all on all functions in schema statement_access_private from public,anon,authenticated,service_role;
grant execute on function statement_access_private.allowed(text),statement_access_private.line_visible(bigint)to authenticated;

alter policy company_select on public.journal using(
 subsidiary_id=(select public.active_subsidiary_id_without_report_context())
 and((select statement_access_private.allowed('accounting:journals'))or(select statement_access_private.allowed('reports:accounting-reports')))
);
alter policy company_select on public.journal_line using(statement_access_private.line_visible(journal_id));
alter policy company_select on public.gl_impact using(
 subsidiary_id=(select public.active_subsidiary_id_without_report_context())
 and((select statement_access_private.allowed('accounting:gl-impacts'))or(select statement_access_private.allowed('reports:accounting-reports')))
);

do $guard$
declare sig text;f record;guard text;src text;
begin
 foreach sig in array array['statement_customer(bigint,date,bigint)','statement_send(bigint,date,text,uuid,bigint)','statement_settings(text,jsonb)']loop
  select oid,proname,prosrc into strict f from pg_proc where oid=to_regprocedure('public.'||sig);
  guard:=case f.proname when 'statement_customer'then $read$perform statement_access_private.enter('get',p_sid);$read$
    when 'statement_send'then $send$perform statement_access_private.enter('send',p_sid);$send$
    else $settings$perform report_template_private.enter('configuration:notification-templates',case when p_action='save'then 'edit'else 'view'end);$settings$end;
  src:='begin '||guard||E'\n'||trim(f.prosrc)||case when right(trim(f.prosrc),1)=';'then ''else ';'end||E'\nend';
  execute format('create or replace function public.%s returns %s language plpgsql %s security definer set search_path=pg_catalog,public,pg_temp as %L',
   (select proname||'('||pg_get_function_arguments(oid)||')'from pg_proc where oid=f.oid),pg_get_function_result(f.oid),case(select provolatile from pg_proc where oid=f.oid)when's'then'stable'else'volatile'end,src);
  execute 'revoke all on function public.'||sig||' from public,anon,service_role';
  execute 'grant execute on function public.'||sig||' to authenticated';
 end loop;
end$guard$;
notify pgrst,'reload schema';
