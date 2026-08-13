alter table public.related_companies
  add column if not exists country_id bigint
  references public.countries(country_id) on delete restrict;

update public.related_companies company
set country_id=coalesce(
  (
    select subsidiary.country_id
    from public.related_company_subsidiaries link
    join public.subsidiaries subsidiary on subsidiary.subsidiary_id=link.subsidiary_id
    where link.related_company_id=company.related_company_id
    order by subsidiary.subsidiary_id
    limit 1
  ),
  (select country_id from public.countries order by country_id limit 1)
)
where country_id is null;

alter table public.related_companies alter column country_id set not null;
create index if not exists related_companies_country_idx on public.related_companies(country_id);

create or replace function public.validate_related_company_subsidiary_country()
returns trigger language plpgsql security definer set search_path=public as $$
begin
  if not exists(
    select 1
    from public.related_companies company
    join public.subsidiaries subsidiary on subsidiary.subsidiary_id=new.subsidiary_id
    where company.related_company_id=new.related_company_id
      and company.country_id=subsidiary.country_id
  ) then
    raise exception 'La subsidiaria debe pertenecer al país de la compañía relacionada.';
  end if;
  return new;
end;$$;

drop trigger if exists related_company_subsidiary_country_check on public.related_company_subsidiaries;
create trigger related_company_subsidiary_country_check
before insert or update on public.related_company_subsidiaries
for each row execute function public.validate_related_company_subsidiary_country();
