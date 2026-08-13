alter table public.bank_account
  add column if not exists is_credit_card boolean not null default false;
