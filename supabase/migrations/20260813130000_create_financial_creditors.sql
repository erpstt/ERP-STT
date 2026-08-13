create table if not exists public.financial_creditors (
  financial_creditor_id bigint generated always as identity primary key,
  code text not null unique,
  name text not null,
  identification text not null unique,
  subsidiary_id bigint references public.subsidiaries(subsidiary_id) on delete set null,
  is_inactive boolean not null default false
);

create table if not exists public.financial_creditor_subsidiaries (
  financial_creditor_id bigint not null references public.financial_creditors(financial_creditor_id) on delete cascade,
  subsidiary_id bigint not null references public.subsidiaries(subsidiary_id) on delete cascade,
  primary key(financial_creditor_id,subsidiary_id)
);

alter table public.financial_creditors enable row level security;
alter table public.financial_creditor_subsidiaries enable row level security;

do $$ declare target text;
begin
  foreach target in array array['financial_creditors','financial_creditor_subsidiaries'] loop
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

create index if not exists financial_creditor_subsidiaries_subsidiary_idx
  on public.financial_creditor_subsidiaries(subsidiary_id);
