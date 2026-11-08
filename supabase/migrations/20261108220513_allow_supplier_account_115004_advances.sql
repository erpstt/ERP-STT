-- Supplier advances may be selected/applied only from account 115004.
-- Account presentation groups never make other prepaid expenses eligible.
-- No historical postings, classifications, FX calculations or grants change.
set local lock_timeout='5s';
set local statement_timeout='60s';

do $patch$
declare patch jsonb;replacement jsonb;target regprocedure;definition text;needle text;
begin
 for patch in select value from jsonb_array_elements($specs$[
  {
    "signature": "supplier_payment_private.prepare(jsonb,bigint,bigint)",
    "beforeMd5": "5f7a47109e9e4956634c071862246844",
    "replacements": [
      {
        "needle": "or not exists(with recursive g as(select group_id,parent_id,group_name from public.account_group where group_id=(select account_group_id from public.chart_accounts where account_id=l.account_id) union select p.group_id,p.parent_id,p.group_name from public.account_group p join g on p.group_id=g.parent_id) select 1 from g where lower(trim(group_name))='gastos pagados por anticipado')",
        "replacement": "or not exists(select 1 from public.chart_accounts a where a.account_id=l.account_id and a.account_number='115004')"
      }
    ]
  },
  {
    "signature": "supplier_payment_private.save_supplier_payment_with_advances_base(jsonb,bigint)",
    "beforeMd5": "fa418c9b475004a826799c40a5e14c06",
    "replacements": [
      {
        "needle": "or not exists(with recursive g as(select group_id,parent_id,group_name from account_group where group_id=(select account_group_id from chart_accounts where account_id=source.account_id)\n        union all select p.group_id,p.parent_id,p.group_name from account_group p join g on p.group_id=g.parent_id)\n        select 1 from g where lower(trim(group_name))='gastos pagados por anticipado')",
        "replacement": "or not exists(select 1 from public.chart_accounts a where a.account_id=source.account_id and a.account_number='115004')"
      }
    ]
  },
  {
    "signature": "supplier_payment_private.supplier_available_advances()",
    "beforeMd5": "f1de7f928d415f44614e93597b3dccf0",
    "replacements": [
      {
        "needle": "with recursive advance_groups as(\n    select group_id from account_group where lower(trim(group_name))='gastos pagados por anticipado'\n    union all select g.group_id from account_group g join advance_groups p on g.parent_id=p.group_id\n  ), rows as(",
        "replacement": "with rows as("
      },
      {
        "needle": "a.account_group_id in(select group_id from advance_groups)",
        "replacement": "a.account_number='115004'"
      }
    ]
  }
]$specs$::jsonb)loop
  target:=to_regprocedure(patch->>'signature');
  if target is null or(select md5(p.prosrc)from pg_proc p where p.oid=target) is distinct from patch->>'beforeMd5'then
   raise exception 'Unexpected supplier advance eligibility source: %',patch->>'signature';
  end if;
  definition:=pg_get_functiondef(target);
  for replacement in select value from jsonb_array_elements(patch->'replacements')loop
   needle:=replacement->>'needle';
   if needle=''or(length(definition)-length(replace(definition,needle,'')))/length(needle)<>1 then
    raise exception 'Expected exactly one supplier advance account predicate: %',patch->>'signature';
   end if;
   definition:=replace(definition,needle,replacement->>'replacement');
  end loop;
  execute definition;
 end loop;
end$patch$;
