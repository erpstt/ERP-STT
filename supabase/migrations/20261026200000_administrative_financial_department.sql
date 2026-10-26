begin;

-- Financial gains, losses and bank commissions are corporate administrative
-- results. Resolve their department in the journal subsidiary instead of
-- relying on a global id, while refusing to post when the catalog is missing
-- or ambiguous.
create or replace function public.administrative_financial_department_id(
  p_subsidiary_id bigint
)
returns bigint
language plpgsql
stable
security definer
set search_path=public,pg_temp
as $$
declare
  matches bigint[];
begin
  if p_subsidiary_id is null then
    raise exception 'No se puede asignar el departamento ADMINISTRATIVO sin subsidiaria.';
  end if;

  select array_agg(department.department_id order by department.department_id)
    into matches
  from public.departments department
  where upper(btrim(department.name))='ADMINISTRATIVO'
    and not coalesce(department.is_inactive,false)
    and(
      department.subsidiary_id=p_subsidiary_id
      or exists(
        select 1
        from public.department_subsidiaries assignment
        where assignment.department_id=department.department_id
          and assignment.subsidiary_id=p_subsidiary_id
      )
    );

  if coalesce(cardinality(matches),0)=0 then
    raise exception
      'No existe un departamento ADMINISTRATIVO activo asignado a la subsidiaria %.',
      p_subsidiary_id;
  end if;
  if cardinality(matches)>1 then
    raise exception
      'El departamento ADMINISTRATIVO es ambiguo para la subsidiaria % (coincidencias: %).',
      p_subsidiary_id,array_to_string(matches,', ');
  end if;

  return matches[1];
end
$$;

comment on function public.administrative_financial_department_id(bigint) is
  'Devuelve el unico departamento ADMINISTRATIVO activo de la subsidiaria; falla si falta o es ambiguo.';

revoke all on function public.administrative_financial_department_id(bigint)
  from public,anon,authenticated;

create or replace function public.assign_administrative_financial_department()
returns trigger
language plpgsql
security definer
set search_path=public,pg_temp
as $$
declare
  account_number_value text;
  subsidiary_key bigint;
begin
  -- Preserve every explicit dimension selected by a user or source document.
  if new.department_id is not null then
    return new;
  end if;

  select account.account_number
    into account_number_value
  from public.chart_accounts account
  where account.account_id=new.account_id;

  if account_number_value is null
     or account_number_value<>all(array[
       '422001','422002','631002','632001','632002'
     ]::text[]) then
    return new;
  end if;

  select journal.subsidiary_id
    into subsidiary_key
  from public.journal journal
  where journal.journal_id=new.journal_id;

  if subsidiary_key is null then
    raise exception
      'No se pudo determinar la subsidiaria de la linea financiera del asiento %.',
      new.journal_id;
  end if;

  new.department_id:=public.administrative_financial_department_id(subsidiary_key);
  return new;
end
$$;

comment on function public.assign_administrative_financial_department() is
  'Asigna ADMINISTRATIVO solo a lineas sin departamento de comisiones y diferencias cambiarias.';

revoke all on function public.assign_administrative_financial_department()
  from public,anon,authenticated;

drop trigger if exists journal_line_administrative_financial_department
  on public.journal_line;
create trigger journal_line_administrative_financial_department
before insert or update of journal_id,account_id,department_id
on public.journal_line
for each row
execute function public.assign_administrative_financial_department();

-- Revaluation journals are protected against direct line updates. The internal
-- flag authorizes this one-time dimension repair without weakening the
-- protection trigger. GL synchronization is deferred because department_id is
-- read directly from journal_line by dimensional reports and gl_impact does not
-- persist dimensions.
do $$
begin
  perform set_config('nexo.fx_posting','on',true);
  perform set_config('nexo.defer_journal_gl_sync','on',true);
  perform set_config('app.opening_balance_internal','1',true);

  update public.journal_line line
  set department_id=public.administrative_financial_department_id(
    journal.subsidiary_id
  )
  from public.journal journal,public.chart_accounts account
  where journal.journal_id=line.journal_id
    and account.account_id=line.account_id
    and line.department_id is null
    and account.account_number=any(array[
      '422001','422002','631002','632001','632002'
    ]::text[]);

  if exists(
    select 1
    from public.journal_line line
    join public.chart_accounts account using(account_id)
    where line.department_id is null
      and account.account_number=any(array[
        '422001','422002','631002','632001','632002'
      ]::text[])
  ) then
    raise exception
      'No fue posible asignar ADMINISTRATIVO a todas las lineas financieras existentes.';
  end if;

  perform set_config('app.opening_balance_internal','',true);
  perform set_config('nexo.defer_journal_gl_sync','off',true);
  perform set_config('nexo.fx_posting','off',true);
end
$$;

commit;

notify pgrst,'reload schema';
