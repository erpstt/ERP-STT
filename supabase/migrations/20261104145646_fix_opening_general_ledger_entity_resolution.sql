-- Repair only the read projection of opening ledger movements. No posting,
-- opening line, journal line, GL amount, ACL or authorization is changed.
set local lock_timeout='5s';
set local statement_timeout='30s';

do $patch$
declare
 signature text;
 target oid;
 original record;
 current_metadata record;
 definition text;
 source_hash constant text := 'bfc01517ebaa48bd162d7120d1cb5638';
 old_lateral constant text := $old$left join lateral(select jl.entity_type,coalesce(c.company_name,sp.company_name,concat_ws(' ',e.first_name,e.last_name)) entity_name,cc.code cost_center,jl.note,jl.customer_id,jl.supplier_id,jl.employee_id,jl.cost_center_id from journal_line jl left join customers c using(customer_id) left join suppliers sp using(supplier_id) left join employees e using(employee_id) left join cost_centers cc using(cost_center_id) where jl.journal_id=jx.journal_id and jl.account_id=g.account_id order by jl.journal_line_id limit 1) line_data on true$old$;
 new_lateral constant text := $new$left join lateral(
    -- opening-ledger-entity-resolution-v1: exact trace, then scoped GL-only inference.
    select case when center_customer.customer_id is not null then 'Cliente' else jl.entity_type end entity_type,
      case when center_customer.customer_id is not null then center_customer.company_name
        else coalesce(c.company_name,sp.company_name,concat_ws(' ',e.first_name,e.last_name)) end entity_name,
      cc.code cost_center,jl.note,coalesce(jl.customer_id,center_customer.customer_id) customer_id,
      jl.supplier_id,jl.employee_id,jl.cost_center_id
    from journal_line jl
    left join customers c using(customer_id)
    left join suppliers sp using(supplier_id)
    left join employees e using(employee_id)
    left join cost_centers cc using(cost_center_id)
    left join opening_balance_lines opening_line
      on opening_line.id=jl.opening_balance_line_id
      and opening_line.id=g.opening_balance_line_id
      and opening_line.source_type='GL'
      and opening_line.account_id=jl.account_id
      and opening_line.cost_center_id=jl.cost_center_id
    left join opening_balance_runs opening_run
      on opening_run.id=opening_line.run_id
      and opening_run.journal_id=jx.journal_id
      and opening_run.subsidiary_id=g.subsidiary_id
      and jx.subsidiary_id=g.subsidiary_id
    left join customers center_customer
      on center_customer.customer_id=cc.customer_id
      and opening_run.id is not null
      and cc.cost_center_type='CLIENTE'
      and cc.subsidiary_id=g.subsidiary_id
      and nullif(btrim(jl.entity_type),'') is null
      and jl.customer_id is null and jl.supplier_id is null and jl.employee_id is null
      and nullif(to_jsonb(jl)->>'financial_creditor_id','') is null
      and nullif(to_jsonb(jl)->>'related_company_id','') is null
      and nullif(to_jsonb(jl)->>'tax_agency_id','') is null
      and nullif(to_jsonb(jl)->>'other_name_id','') is null
      and t.customer_id is null and t.supplier_id is null
      and exists(select 1 from entity_subsidiaries scope
        where scope.customer_id=center_customer.customer_id and scope.subsidiary_id=g.subsidiary_id)
    where jl.journal_id=jx.journal_id and jl.account_id=g.account_id
      and(g.opening_balance_line_id is null or jl.opening_balance_line_id=g.opening_balance_line_id)
    order by jl.journal_line_id limit 1
   ) line_data on true$new$;
begin
 -- These two pre-existing bodies were verified to be identical. Stop on drift;
 -- retain the public authorization wrappers and trusted delivery entry points.
 foreach signature in array array[
   'public.run_accounting_report_before_intercompany_loans(text,jsonb)',
   'report_delivery_private.run_accounting_report_before_intercompany_loans(text,jsonb)'
 ] loop
  target:=to_regprocedure(signature);
  if target is null then raise exception 'Missing ledger calculation: %',signature;end if;
  select p.*,l.lanname into strict original from pg_proc p join pg_language l on l.oid=p.prolang where p.oid=target;
  if original.lanname<>'plpgsql' or not original.prosecdef or original.provolatile<>'s'
    or md5(original.prosrc)<>source_hash
    or (length(original.prosrc)-length(replace(original.prosrc,old_lateral,'')))<>length(old_lateral)
  then raise exception 'Unexpected ledger calculation; review before migrating: %',signature;end if;
 end loop;

 foreach signature in array array[
   'public.run_accounting_report_before_intercompany_loans(text,jsonb)',
   'report_delivery_private.run_accounting_report_before_intercompany_loans(text,jsonb)'
 ] loop
  target:=to_regprocedure(signature);
  select proowner,proacl,proconfig,provolatile,prosecdef,proisstrict,proparallel
    into strict original from pg_proc where oid=target;
  definition:=pg_get_functiondef(target);
  execute replace(definition,old_lateral,new_lateral);
  select proowner,proacl,proconfig,provolatile,prosecdef,proisstrict,proparallel
    into strict current_metadata from pg_proc where oid=target;
  if current_metadata is distinct from original then
   raise exception 'Ledger metadata changed unexpectedly: %',signature;
  end if;
 end loop;
end
$patch$;

notify pgrst,'reload schema';
