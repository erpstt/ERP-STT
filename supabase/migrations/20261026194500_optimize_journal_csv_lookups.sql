-- CSV validation resolves the same dimensions many times. The former helper
-- built dynamic SQL and converted every candidate row to JSON before applying
-- the name predicate, forcing a re-plan/table scan for every imported line.
-- Keep the public contract and messages, but use plan-cached, typed queries.

create index if not exists journal_csv_customers_name_idx
  on public.customers(lower(company_name));
create index if not exists journal_csv_suppliers_name_idx
  on public.suppliers(lower(company_name));
create index if not exists journal_csv_employees_name_idx
  on public.employees(lower(first_name||' '||last_name));
create index if not exists journal_csv_departments_name_idx
  on public.departments(lower(name)) where not is_inactive;
create index if not exists journal_csv_cost_centers_name_idx
  on public.cost_centers(lower(name)) where not is_inactive;
create index if not exists journal_csv_classes_name_idx
  on public.classes(lower(name)) where not is_inactive;
create index if not exists journal_csv_creditors_name_idx
  on public.financial_creditors(lower(name)) where not is_inactive;
create index if not exists journal_csv_related_companies_name_idx
  on public.related_companies(lower(name)) where not is_inactive;

create or replace function public.journal_csv_lookup(
  p_kind text,
  p_value text
)
returns jsonb
language plpgsql
security definer
set search_path=public,pg_temp
as $$
declare
  lookup_value text:=nullif(btrim(p_value),'');
  lookup_id bigint;
  uses_id boolean;
  result jsonb;
  matches integer;
  sid bigint:=coalesce(
    nullif(current_setting('nexo.journal_csv_subsidiary_id',true),'')::bigint,
    public.active_subsidiary_id()
  );
  cache_enabled boolean:=current_setting('nexo.journal_csv_lookup_cache_enabled',true)='on';
  cache_key text;
  cached_values jsonb;
begin
  if lookup_value is null then
    return null;
  end if;

  uses_id:=lookup_value ~ '^ID:[0-9]+$';
  if uses_id then
    lookup_id:=substring(lookup_value from 4)::bigint;
  end if;

  if cache_enabled then
    cache_key:=md5(concat_ws(chr(31),sid::text,p_kind,lookup_value));
    cached_values:=coalesce(
      nullif(current_setting('nexo.journal_csv_lookup_cache',true),''),
      '{}'
    )::jsonb;
    if cached_values ? cache_key then
      return cached_values->cache_key;
    end if;
  end if;

  case p_kind
    when 'Cliente' then
      select count(*)::integer,(jsonb_agg(to_jsonb(item) order by item.customer_id))->0
      into matches,result
      from public.customers item
      where exists(
        select 1
        from public.entity_subsidiaries scope
        where scope.customer_id=item.customer_id
          and scope.subsidiary_id=sid
      )
        and case when uses_id
          then item.customer_id=lookup_id
          else lower(item.company_name)=lower(lookup_value)
        end;

    when 'Proveedor' then
      select count(*)::integer,(jsonb_agg(to_jsonb(item) order by item.supplier_id))->0
      into matches,result
      from public.suppliers item
      where exists(
        select 1
        from public.entity_subsidiaries scope
        where scope.supplier_id=item.supplier_id
          and scope.subsidiary_id=sid
      )
        and case when uses_id
          then item.supplier_id=lookup_id
          else lower(item.company_name)=lower(lookup_value)
        end;

    when 'Empleado' then
      select count(*)::integer,(jsonb_agg(to_jsonb(item) order by item.employee_id))->0
      into matches,result
      from public.employees item
      where item.subsidiary_id=sid
        and item.is_active
        and case when uses_id
          then item.employee_id=lookup_id
          else lower(item.first_name||' '||item.last_name)=lower(lookup_value)
        end;

    when 'departamento' then
      select count(*)::integer,(jsonb_agg(to_jsonb(item) order by item.department_id))->0
      into matches,result
      from public.departments item
      where not item.is_inactive
        and exists(
          select 1
          from public.department_subsidiaries scope
          where scope.department_id=item.department_id
            and scope.subsidiary_id=sid
        )
        and case when uses_id
          then item.department_id=lookup_id
          else lower(item.name)=lower(lookup_value)
        end;

    when 'centro_costos' then
      select count(*)::integer,(jsonb_agg(to_jsonb(item) order by item.cost_center_id))->0
      into matches,result
      from public.cost_centers item
      where item.subsidiary_id=sid
        and not item.is_inactive
        and case when uses_id
          then item.cost_center_id=lookup_id
          else lower(item.name)=lower(lookup_value)
        end;

    when 'clase' then
      select count(*)::integer,(jsonb_agg(to_jsonb(item) order by item.class_id))->0
      into matches,result
      from public.classes item
      where not item.is_inactive
        and exists(
          select 1
          from public.class_subsidiaries scope
          where scope.class_id=item.class_id
            and scope.subsidiary_id=sid
        )
        and case when uses_id
          then item.class_id=lookup_id
          else lower(item.name)=lower(lookup_value)
        end;

    when 'acreedor_financiero' then
      select count(*)::integer,(jsonb_agg(to_jsonb(item) order by item.financial_creditor_id))->0
      into matches,result
      from public.financial_creditors item
      where not item.is_inactive
        and exists(
          select 1
          from public.financial_creditor_subsidiaries scope
          where scope.financial_creditor_id=item.financial_creditor_id
            and scope.subsidiary_id=sid
        )
        and case when uses_id
          then item.financial_creditor_id=lookup_id
          else lower(item.name)=lower(lookup_value)
        end;

    when 'compania_relacionada' then
      select count(*)::integer,(jsonb_agg(to_jsonb(item) order by item.related_company_id))->0
      into matches,result
      from public.related_companies item
      where not item.is_inactive
        and exists(
          select 1
          from public.related_company_subsidiaries scope
          where scope.related_company_id=item.related_company_id
            and scope.subsidiary_id=sid
        )
        and case when uses_id
          then item.related_company_id=lookup_id
          else lower(item.name)=lower(lookup_value)
        end;

    else
      raise exception 'Tipo de referencia no permitido: %.',p_kind;
  end case;

  if matches<>1 then
    raise exception '%: "%" no existe, está inactivo, no pertenece a la subsidiaria o es ambiguo. Use el nombre exacto o ID:identificador.',p_kind,p_value;
  end if;
  if cache_enabled then
    perform set_config(
      'nexo.journal_csv_lookup_cache',
      (cached_values||jsonb_build_object(cache_key,result))::text,
      true
    );
  end if;
  return result;
end
$$;

comment on function public.journal_csv_lookup(text,text) is
  'Resolves an active CSV dimension in the selected subsidiary using typed, plan-cached queries.';

revoke all on function public.journal_csv_lookup(text,text)
  from public,anon,authenticated;

-- A journal normally rebuilds all of its GL impacts after every line insert.
-- For an 11/12-line imported journal this repeats the same work quadratically.
-- The import wrapper below defers only that derived projection and refreshes it
-- once per completed journal; normal UI writes keep the original behavior.
create or replace function public.sync_journal_gl_impacts_trigger()
returns trigger
language plpgsql
security definer
set search_path=public,pg_temp
as $$
begin
  if current_setting('nexo.defer_journal_gl_sync',true)='on' then
    return coalesce(new,old);
  end if;
  perform public.sync_journal_gl_impacts(coalesce(new.journal_id,old.journal_id));
  return coalesce(new,old);
end
$$;

revoke all on function public.sync_journal_gl_impacts_trigger()
  from public,anon,authenticated;

-- Limit memoization to one import RPC. Transaction-local settings are cleared
-- by PostgreSQL at commit/rollback, while the explicit off switch also keeps
-- direct helper calls in the same transaction fully current.
do $$
begin
  if to_regprocedure(
    'public.import_journal_csv_before_lookup_cache(jsonb,boolean,bigint)'
  ) is null then
    alter function public.import_journal_csv(jsonb,boolean,bigint)
      rename to import_journal_csv_before_lookup_cache;
  end if;
end
$$;

revoke all on function public.import_journal_csv_before_lookup_cache(
  jsonb,boolean,bigint
) from public,anon,authenticated;

create or replace function public.import_journal_csv(
  p_rows jsonb,
  p_preview boolean,
  p_subsidiary_id bigint
)
returns jsonb
language plpgsql
security definer
set search_path=public,pg_temp
as $$
declare
  result jsonb;
  saved_entry jsonb;
begin
  perform set_config('nexo.journal_csv_lookup_cache','{}',true);
  perform set_config(
    'nexo.journal_csv_subsidiary_id',
    coalesce(p_subsidiary_id::text,''),
    true
  );
  perform set_config('nexo.journal_csv_lookup_cache_enabled','on',true);
  perform set_config('nexo.defer_journal_gl_sync','on',true);

  begin
    result:=public.import_journal_csv_before_lookup_cache(
      p_rows,p_preview,p_subsidiary_id
    );
  exception when others then
    perform set_config('nexo.journal_csv_lookup_cache_enabled','off',true);
    perform set_config('nexo.defer_journal_gl_sync','off',true);
    raise;
  end;

  perform set_config('nexo.journal_csv_lookup_cache_enabled','off',true);
  perform set_config('nexo.defer_journal_gl_sync','off',true);

  if not p_preview
    and coalesce((result->>'valid')::boolean,false)
    and not coalesce((result->>'alreadyImported')::boolean,false)
  then
    for saved_entry in
      select value from jsonb_array_elements(coalesce(result->'entries','[]'::jsonb))
    loop
      perform public.sync_journal_gl_impacts((saved_entry->>'journalId')::bigint);
    end loop;
  end if;
  return result;
end
$$;

comment on function public.import_journal_csv(jsonb,boolean,bigint) is
  'Validates/imports journals with a request-scoped dimension cache and one GL projection refresh per saved journal; all business validation remains delegated to the current importer.';

revoke all on function public.import_journal_csv(jsonb,boolean,bigint)
  from public,anon;
grant execute on function public.import_journal_csv(jsonb,boolean,bigint)
  to authenticated;

notify pgrst,'reload schema';
