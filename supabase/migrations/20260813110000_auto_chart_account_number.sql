create or replace function public.assign_chart_account_number()
returns trigger language plpgsql security definer set search_path=public as $$
declare group_code_value text; next_suffix bigint;
begin
  perform pg_advisory_xact_lock(new.account_group_id);
  select group_code into group_code_value from public.account_group where group_id=new.account_group_id;
  if group_code_value is null then raise exception 'El grupo de cuentas seleccionado no existe.'; end if;
  select coalesce(max(substring(account_number from length(group_code_value)+1)::bigint),0)+1 into next_suffix
  from public.chart_accounts
  where account_group_id=new.account_group_id and account_number ~ ('^'||group_code_value||'[0-9]+$');
  new.account_number:=group_code_value||lpad(next_suffix::text,greatest(3,length(next_suffix::text)),'0');
  return new;
end;$$;
drop trigger if exists chart_account_auto_number on public.chart_accounts;
create trigger chart_account_auto_number before insert on public.chart_accounts for each row execute function public.assign_chart_account_number();
