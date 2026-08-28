create or replace function public.assign_journal_fiscal_period()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  matched_period_id bigint;
begin
  select p.fiscal_period_id into matched_period_id
  from public.fiscal_periods p
  where p.subsidiary_id = new.subsidiary_id
    and new.journal_date between p.start_date and p.end_date
    and coalesce(p.is_inactive, false) = false
  order by p.start_date desc
  limit 1;

  if matched_period_id is null then
    raise exception 'No existe un período contable activo para la fecha % y la subsidiaria seleccionada.', new.journal_date;
  end if;

  new.fiscal_period_id := matched_period_id;
  return new;
end;
$$;

drop trigger if exists trg_assign_journal_fiscal_period on public.journal;
create trigger trg_assign_journal_fiscal_period
before insert or update of journal_date, subsidiary_id, fiscal_period_id
on public.journal
for each row execute function public.assign_journal_fiscal_period();
