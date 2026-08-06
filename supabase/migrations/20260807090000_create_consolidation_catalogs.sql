create table if not exists public.intercompany_eliminations(
  elimination_id bigint generated always as identity primary key,
  from_subsidiary_id bigint not null references public.subsidiaries(subsidiary_id),
  to_subsidiary_id bigint not null references public.subsidiaries(subsidiary_id),
  transaction_id bigint not null references public."transaction"(transaction_id),
  fiscal_period_id bigint not null references public.fiscal_periods(fiscal_period_id),
  elimination_amount numeric(24,6) not null check(elimination_amount>0),
  check(from_subsidiary_id<>to_subsidiary_id),
  unique(from_subsidiary_id,to_subsidiary_id,transaction_id,fiscal_period_id)
);
alter table public.intercompany_eliminations enable row level security;
drop policy if exists "consolidation_select" on public.intercompany_eliminations;
drop policy if exists "consolidation_insert" on public.intercompany_eliminations;
drop policy if exists "consolidation_update" on public.intercompany_eliminations;
drop policy if exists "consolidation_delete" on public.intercompany_eliminations;
create policy "consolidation_select" on public.intercompany_eliminations for select to authenticated using(true);
create policy "consolidation_insert" on public.intercompany_eliminations for insert to authenticated with check(true);
create policy "consolidation_update" on public.intercompany_eliminations for update to authenticated using(true) with check(true);
create policy "consolidation_delete" on public.intercompany_eliminations for delete to authenticated using(true);
