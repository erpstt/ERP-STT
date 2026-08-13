alter table public.account_group
  add column if not exists is_inactive boolean not null default false;

create or replace function public.cascade_inactive_account_group()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.is_inactive and not old.is_inactive then
    with recursive group_tree as (
      select new.group_id
      union all
      select child.group_id
      from public.account_group child
      join group_tree parent on child.parent_id = parent.group_id
    )
    update public.chart_accounts
       set is_inactive = true
     where account_group_id in (select group_id from group_tree)
       and not is_inactive;

    with recursive group_tree as (
      select new.group_id
      union all
      select child.group_id
      from public.account_group child
      join group_tree parent on child.parent_id = parent.group_id
    )
    update public.account_group
       set is_inactive = true
     where group_id in (select group_id from group_tree)
       and group_id <> new.group_id
       and not is_inactive;
  end if;
  return new;
end;
$$;

drop trigger if exists account_group_inactive_cascade on public.account_group;
create trigger account_group_inactive_cascade
after update of is_inactive on public.account_group
for each row execute function public.cascade_inactive_account_group();

create or replace function public.inherit_account_group_inactive()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if exists (
    select 1 from public.account_group
    where group_id = new.account_group_id and is_inactive
  ) then
    new.is_inactive := true;
  end if;
  return new;
end;
$$;

drop trigger if exists chart_account_inherit_group_inactive on public.chart_accounts;
create trigger chart_account_inherit_group_inactive
before insert or update of account_group_id on public.chart_accounts
for each row execute function public.inherit_account_group_inactive();
