create table if not exists public.cash_transaction (
  cash_tran_id bigint generated always as identity primary key,
  tran_date date not null,
  cashbox_id bigint not null references public.cashbox(cashbox_id),
  transaction_id bigint references public."transaction"(transaction_id) on delete set null,
  amount numeric(24,6) not null check (amount > 0),
  type text not null,
  concept text not null
);

create table if not exists public.cash_opening (
  opening_id bigint generated always as identity primary key,
  opening_date date not null,
  cashbox_id bigint not null references public.cashbox(cashbox_id),
  user_id bigint not null references public.users(user_id),
  initial_amount numeric(24,6) not null check (initial_amount >= 0)
);

create table if not exists public.cash_closing (
  closing_id bigint generated always as identity primary key,
  closing_date date not null,
  cashbox_id bigint not null references public.cashbox(cashbox_id),
  user_id bigint not null references public.users(user_id),
  final_amount numeric(24,6) not null check (final_amount >= 0),
  difference numeric(24,6) not null default 0
);

create table if not exists public.cash_transfer (
  transfer_id bigint generated always as identity primary key,
  transfer_date date not null,
  amount numeric(24,6) not null check (amount > 0),
  from_cashbox_id bigint not null references public.cashbox(cashbox_id),
  to_cashbox_id bigint not null references public.cashbox(cashbox_id),
  check (from_cashbox_id <> to_cashbox_id)
);

do $$
declare table_name text;
begin
  foreach table_name in array array['cash_transaction','cash_opening','cash_closing','cash_transfer'] loop
    execute format('alter table public.%I enable row level security', table_name);
    execute format('drop policy if exists "treasury_select" on public.%I', table_name);
    execute format('drop policy if exists "treasury_insert" on public.%I', table_name);
    execute format('drop policy if exists "treasury_update" on public.%I', table_name);
    execute format('drop policy if exists "treasury_delete" on public.%I', table_name);
    execute format('create policy "treasury_select" on public.%I for select to authenticated using (true)', table_name);
    execute format('create policy "treasury_insert" on public.%I for insert to authenticated with check (true)', table_name);
    execute format('create policy "treasury_update" on public.%I for update to authenticated using (true) with check (true)', table_name);
    execute format('create policy "treasury_delete" on public.%I for delete to authenticated using (true)', table_name);
  end loop;
end $$;
