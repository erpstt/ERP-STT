create table if not exists public.subsidiary_currencies(
 subsidiary_id bigint not null references public.subsidiaries(subsidiary_id) on delete cascade,
 currency_id bigint not null references public.currencies(currency_id) on delete restrict,
 is_primary boolean not null default false,
 primary key(subsidiary_id,currency_id)
);
create unique index if not exists subsidiary_one_primary_currency on public.subsidiary_currencies(subsidiary_id) where is_primary=true;
insert into public.subsidiary_currencies(subsidiary_id,currency_id,is_primary)
select subsidiary_id,currency_id,true from public.subsidiaries
on conflict(subsidiary_id,currency_id) do update set is_primary=true;
alter table public.subsidiary_currencies enable row level security;
drop policy if exists subsidiary_currencies_select on public.subsidiary_currencies;
drop policy if exists subsidiary_currencies_write on public.subsidiary_currencies;
create policy subsidiary_currencies_select on public.subsidiary_currencies for select to authenticated using(true);
create policy subsidiary_currencies_write on public.subsidiary_currencies for all to authenticated using(true) with check(true);

create or replace function public.validate_transaction_currency_for_subsidiary() returns trigger language plpgsql set search_path=public,pg_temp as $$begin if not exists(select 1 from subsidiary_currencies allowed where allowed.subsidiary_id=new.subsidiary_id and allowed.currency_id=new.currency_id) then raise exception 'La moneda seleccionada no está autorizada para esta subsidiaria.';end if;return new;end$$;
drop trigger if exists transaction_allowed_currency on public."transaction";
create trigger transaction_allowed_currency before insert or update of subsidiary_id,currency_id on public."transaction" for each row execute function public.validate_transaction_currency_for_subsidiary();
