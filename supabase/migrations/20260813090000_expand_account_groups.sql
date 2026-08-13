alter table public.account_group add column if not exists level integer;
alter table public.account_group add column if not exists parent_id bigint references public.account_group(group_id) on delete set null;
alter table public.account_group add column if not exists nature text;
alter table public.account_group add column if not exists financial_statement text;
alter table public.account_group add column if not exists full_ifrs_only boolean not null default false;
alter table public.account_group add column if not exists pending_fx_revaluation boolean not null default false;

alter table public.account_group drop constraint if exists account_group_nature_allowed;
alter table public.account_group add constraint account_group_nature_allowed check(nature in ('Deudora','Acreedora')) not valid;
alter table public.account_group drop constraint if exists account_group_statement_allowed;
alter table public.account_group add constraint account_group_statement_allowed check(financial_statement in ('Balance General','Estado de Resultados')) not valid;
alter table public.account_group drop constraint if exists account_group_category_allowed;
alter table public.account_group add constraint account_group_category_allowed check(category in ('Activo','Pasivo','Patrimonio','Ingreso','Costo','Gasto')) not valid;
alter table public.account_group drop constraint if exists account_group_fx_revaluation_scope;
alter table public.account_group add constraint account_group_fx_revaluation_scope check(not pending_fx_revaluation or category in ('Activo','Pasivo'));

create index if not exists account_group_parent_idx on public.account_group(parent_id);
