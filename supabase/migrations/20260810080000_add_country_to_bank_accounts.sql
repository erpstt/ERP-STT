alter table public.bank_account add column if not exists country_id bigint references public.countries(country_id);

update public.bank_account account
set country_id=subsidiary.country_id
from public.subsidiaries subsidiary
where subsidiary.subsidiary_id=account.subsidiary_id and account.country_id is null;

alter table public.bank_account alter column country_id set not null;

create or replace function public.validate_bank_account_country()
returns trigger
language plpgsql
set search_path=public
as $$
declare bank_country bigint; subsidiary_country bigint;
begin
  select country_id into bank_country from public.banks where bank_id=new.bank_id;
  select country_id into subsidiary_country from public.subsidiaries where subsidiary_id=new.subsidiary_id;
  if bank_country is distinct from new.country_id then
    raise exception 'El banco debe pertenecer al país seleccionado.';
  end if;
  if subsidiary_country is distinct from new.country_id then
    raise exception 'La subsidiaria debe pertenecer al país seleccionado.';
  end if;
  return new;
end;
$$;

drop trigger if exists validate_bank_account_country_trigger on public.bank_account;
create trigger validate_bank_account_country_trigger
before insert or update of country_id,bank_id,subsidiary_id on public.bank_account
for each row execute function public.validate_bank_account_country();

create index if not exists bank_account_country_idx on public.bank_account(country_id);
