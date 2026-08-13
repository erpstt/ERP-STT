create table if not exists public.related_companies (
  related_company_id bigint generated always as identity primary key,
  code text not null unique,
  name text not null,
  identification text not null unique,
  subsidiary_id bigint references public.subsidiaries(subsidiary_id) on delete set null,
  is_inactive boolean not null default false
);

create table if not exists public.related_company_subsidiaries (
  related_company_id bigint not null references public.related_companies(related_company_id) on delete cascade,
  subsidiary_id bigint not null references public.subsidiaries(subsidiary_id) on delete cascade,
  primary key(related_company_id,subsidiary_id)
);

alter table public.related_companies enable row level security;
alter table public.related_company_subsidiaries enable row level security;

do $$ declare target text;
begin
  foreach target in array array['related_companies','related_company_subsidiaries'] loop
    execute format('drop policy if exists "organization_select" on public.%I',target);
    execute format('drop policy if exists "organization_insert" on public.%I',target);
    execute format('drop policy if exists "organization_update" on public.%I',target);
    execute format('drop policy if exists "organization_delete" on public.%I',target);
    execute format('create policy "organization_select" on public.%I for select to authenticated using(true)',target);
    execute format('create policy "organization_insert" on public.%I for insert to authenticated with check(true)',target);
    execute format('create policy "organization_update" on public.%I for update to authenticated using(true) with check(true)',target);
    execute format('create policy "organization_delete" on public.%I for delete to authenticated using(true)',target);
  end loop;
end $$;

create index if not exists related_company_subsidiaries_subsidiary_idx
  on public.related_company_subsidiaries(subsidiary_id);
