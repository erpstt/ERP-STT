create table if not exists public.journal_support (
  support_id bigint generated always as identity primary key,
  journal_id bigint not null references public.journal(journal_id) on delete cascade,
  support_type text not null check (support_type in ('Archivo','Enlace')),
  display_name text not null,
  support_url text,
  file_name text,
  mime_type text,
  file_size bigint,
  file_data text,
  created_at timestamptz not null default now(),
  check ((support_type='Enlace' and support_url is not null and file_data is null) or (support_type='Archivo' and file_name is not null and file_data is not null and file_size between 0 and 5242880))
);
create index if not exists journal_support_journal_idx on public.journal_support(journal_id);
alter table public.journal_support enable row level security;
drop policy if exists journal_support_select on public.journal_support;
drop policy if exists journal_support_insert on public.journal_support;
drop policy if exists journal_support_update on public.journal_support;
drop policy if exists journal_support_delete on public.journal_support;
create policy journal_support_select on public.journal_support for select to authenticated using (exists(select 1 from public.journal j where j.journal_id=journal_support.journal_id and j.subsidiary_id=public.active_subsidiary_id()));
create policy journal_support_insert on public.journal_support for insert to authenticated with check (exists(select 1 from public.journal j where j.journal_id=journal_support.journal_id and j.subsidiary_id=public.active_subsidiary_id()));
create policy journal_support_update on public.journal_support for update to authenticated using (exists(select 1 from public.journal j where j.journal_id=journal_support.journal_id and j.subsidiary_id=public.active_subsidiary_id())) with check (exists(select 1 from public.journal j where j.journal_id=journal_support.journal_id and j.subsidiary_id=public.active_subsidiary_id()));
create policy journal_support_delete on public.journal_support for delete to authenticated using (exists(select 1 from public.journal j where j.journal_id=journal_support.journal_id and j.subsidiary_id=public.active_subsidiary_id()));
