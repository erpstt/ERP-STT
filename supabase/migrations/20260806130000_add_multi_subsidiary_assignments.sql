create table if not exists public.department_subsidiaries (
  department_id bigint not null references public.departments(department_id) on delete cascade,
  subsidiary_id bigint not null references public.subsidiaries(subsidiary_id) on delete cascade,
  primary key (department_id, subsidiary_id)
);
create table if not exists public.class_subsidiaries (
  class_id bigint not null references public.classes(class_id) on delete cascade,
  subsidiary_id bigint not null references public.subsidiaries(subsidiary_id) on delete cascade,
  primary key (class_id, subsidiary_id)
);
insert into public.department_subsidiaries(department_id,subsidiary_id)
select department_id,subsidiary_id from public.departments where subsidiary_id is not null on conflict do nothing;
insert into public.class_subsidiaries(class_id,subsidiary_id)
select class_id,subsidiary_id from public.classes where subsidiary_id is not null on conflict do nothing;
alter table public.departments alter column subsidiary_id drop not null;
alter table public.classes alter column subsidiary_id drop not null;
alter table public.department_subsidiaries enable row level security;
alter table public.class_subsidiaries enable row level security;
do $$
declare target_table text;
begin
  foreach target_table in array array['department_subsidiaries','class_subsidiaries'] loop
    execute format('drop policy if exists "organization_select" on public.%I',target_table);
    execute format('drop policy if exists "organization_insert" on public.%I',target_table);
    execute format('drop policy if exists "organization_delete" on public.%I',target_table);
    execute format('create policy "organization_select" on public.%I for select to authenticated using (true)',target_table);
    execute format('create policy "organization_insert" on public.%I for insert to authenticated with check (true)',target_table);
    execute format('create policy "organization_delete" on public.%I for delete to authenticated using (true)',target_table);
  end loop;
end $$;
