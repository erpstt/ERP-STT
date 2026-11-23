CREATE OR REPLACE FUNCTION public.journal_csv_lookup(p_kind text, p_value text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
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
            or lower(item.code)=lower(lookup_value)
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
    raise exception '%: "%" no existe, está inactivo, no pertenece a la subsidiaria o es ambiguo. Use el nombre exacto o ID:identificador; para centro_costos también se acepta el código.',p_kind,p_value;
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
$function$
;

