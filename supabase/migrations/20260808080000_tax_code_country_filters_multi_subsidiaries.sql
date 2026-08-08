create table if not exists public.tax_code_subsidiaries(
  id bigint generated always as identity primary key,
  tax_code_id bigint not null references public.tax_codes(tax_code_id) on delete cascade,
  subsidiary_id bigint not null references public.subsidiaries(subsidiary_id) on delete cascade,
  unique(tax_code_id,subsidiary_id)
);

insert into public.tax_code_subsidiaries(tax_code_id,subsidiary_id)
select tax_code_id,subsidiary_id from public.tax_codes where subsidiary_id is not null
on conflict(tax_code_id,subsidiary_id) do nothing;

update public.tax_codes set subsidiary_id=null where subsidiary_id is not null;

alter table public.tax_code_subsidiaries enable row level security;
drop policy if exists "tax_code_subsidiaries_select" on public.tax_code_subsidiaries;
drop policy if exists "tax_code_subsidiaries_insert" on public.tax_code_subsidiaries;
drop policy if exists "tax_code_subsidiaries_update" on public.tax_code_subsidiaries;
drop policy if exists "tax_code_subsidiaries_delete" on public.tax_code_subsidiaries;
create policy "tax_code_subsidiaries_select" on public.tax_code_subsidiaries for select to authenticated using(true);
create policy "tax_code_subsidiaries_insert" on public.tax_code_subsidiaries for insert to authenticated with check(true);
create policy "tax_code_subsidiaries_update" on public.tax_code_subsidiaries for update to authenticated using(true) with check(true);
create policy "tax_code_subsidiaries_delete" on public.tax_code_subsidiaries for delete to authenticated using(true);

create index if not exists tax_code_subsidiaries_code_idx on public.tax_code_subsidiaries(tax_code_id);
create index if not exists tax_code_subsidiaries_subsidiary_idx on public.tax_code_subsidiaries(subsidiary_id);
