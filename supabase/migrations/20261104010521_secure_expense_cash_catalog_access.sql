-- Process 76: direct expense/cash CRUD requires its own resource and active company.
set local lock_timeout='5s';
set local statement_timeout='60s';
create schema expense_cash_private;
revoke all on schema expense_cash_private from public,anon,authenticated,service_role;
grant usage on schema expense_cash_private to authenticated;
create function expense_cash_private.allowed(resource text,action text,p_key bigint default null,p_other bigint default null)
returns boolean language plpgsql stable security definer set search_path=pg_catalog,public,pg_temp as $$
declare sid bigint;
begin
 if auth.uid()is null or resource is null or action is null
 or resource not in('expenses:expense-types','expenses:expense-policies','expenses:expenses','expenses:expense-lines','expenses:expense-approvals','expenses:expense-payments','treasury:cashboxes','treasury:cash-transactions','treasury:cash-openings','treasury:cash-closings','treasury:cash-transfers')
 or action not in('view','create','edit','delete')then return false;end if;
 sid:=report_template_private.enter(resource,action);
 if sid is distinct from public.active_subsidiary_id_without_report_context()then return false;end if;
 case resource
 when'expenses:expense-types'then return action='view'or public.app_is_admin();
 when'expenses:expense-policies','expenses:expenses','treasury:cashboxes'then return p_key is not null and p_key=sid;
 when'expenses:expense-lines','expenses:expense-approvals','expenses:expense-payments'then
  return exists(select 1 from public.expense e where e.expense_id=p_key and e.subsidiary_id=sid);
 when'treasury:cash-transfers'then
  return p_key is not null and p_other is not null and p_key<>p_other
   and(select count(*)from public.cashbox c where c.cashbox_id in(p_key,p_other)and c.subsidiary_id=sid)=2;
 else return exists(select 1 from public.cashbox c where c.cashbox_id=p_key and c.subsidiary_id=sid);
 end case;
exception when insufficient_privilege then return false;
end$$;
revoke all on all functions in schema expense_cash_private from public,anon,authenticated,service_role;
grant execute on function expense_cash_private.allowed(text,text,bigint,bigint)to authenticated;

do $policies$
declare item record;op record;predicate text;
begin
 for item in select * from(values
 ('expense_type','expenses:expense-types',null,null,'expenses'),
 ('expense_policy','expenses:expense-policies','subsidiary_id',null,'company'),
 ('expense','expenses:expenses','subsidiary_id',null,'company'),
 ('expense_line','expenses:expense-lines','expense_id',null,'company'),
 ('expense_approval','expenses:expense-approvals','expense_id',null,'company'),
 ('expense_payment','expenses:expense-payments','expense_id',null,'company'),
 ('cashbox','treasury:cashboxes','subsidiary_id',null,'company'),
 ('cash_transaction','treasury:cash-transactions','cashbox_id',null,'company'),
 ('cash_opening','treasury:cash-openings','cashbox_id',null,'company'),
 ('cash_closing','treasury:cash-closings','cashbox_id',null,'company'),
 ('cash_transfer','treasury:cash-transfers','from_cashbox_id','to_cashbox_id','treasury')
 )v(tbl,resource,col,other_col,policy_prefix)loop
  -- PostgREST catalog maintenance uses CRUD only, never TRUNCATE/TRIGGER/REFERENCES.
  execute format('revoke all on table public.%I from anon,authenticated',item.tbl);
  execute format('grant select,insert,update,delete on table public.%I to authenticated',item.tbl);
  for op in select * from(values('select','view'),('insert','create'),('update','edit'),('delete','delete'))v(cmd,action)loop
   if item.col is null then predicate:=format('(select expense_cash_private.allowed(%L,%L))',item.resource,op.action);
   elsif item.other_col is null then predicate:=format('expense_cash_private.allowed(%L,%L,%I)',item.resource,op.action,item.col);
   else predicate:=format('expense_cash_private.allowed(%L,%L,%I,%I)',item.resource,op.action,item.col,item.other_col);end if;
   execute format('alter policy %I on public.%I %s',item.policy_prefix||'_'||op.cmd,item.tbl,
    case op.cmd when'insert'then 'with check('||predicate||')'when'update'then 'using('||predicate||')with check('||predicate||')'else 'using('||predicate||')'end);
  end loop;
 end loop;
end$policies$;
notify pgrst,'reload schema';
