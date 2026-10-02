alter table public.journal_line
  add column if not exists service_country_id bigint
  references public.countries(country_id) on delete restrict;

create index if not exists journal_line_service_country_idx
  on public.journal_line(service_country_id);

-- Existing pending entries predate this dimension. Use the subsidiary country
-- as their initial value so historical lines remain usable and editable.
update public.journal_line line
set service_country_id=subsidiary.country_id
from public.journal entry
join public.subsidiaries subsidiary
  on subsidiary.subsidiary_id=entry.subsidiary_id
where line.journal_id=entry.journal_id
  and (entry.journal_type='Asientos Pendientes de Facturar'
       or entry.journal_number like 'ASI_PEN-%')
  and line.service_country_id is null
  and subsidiary.country_id is not null;

alter function public.create_journal_entry(jsonb)
  rename to create_journal_entry_without_service_country;

revoke all on function public.create_journal_entry_without_service_country(jsonb)
  from public,anon,authenticated;

create function public.create_journal_entry(payload jsonb)
returns bigint
language plpgsql
security definer
set search_path=public,pg_temp
as $$
declare
  jid bigint;
  pending_type text;
begin
  select name into pending_type
  from public.transaction_types
  where abbreviation='ASI_PEN'
  limit 1;

  if payload->>'journal_type'=pending_type and exists(
    select 1
    from jsonb_array_elements(coalesce(payload->'lines','[]'::jsonb)) item
    where nullif(btrim(item->>'service_country_id'),'') is null
       or coalesce(item->>'service_country_id','') !~ '^[0-9]+$'
       or not exists(
         select 1
         from public.countries country
         where country.country_id=case
           when coalesce(item->>'service_country_id','') ~ '^[0-9]+$'
           then (item->>'service_country_id')::bigint
         end
       )
  ) then
    raise exception 'Seleccione un País de servicio válido en cada línea del pendiente de facturar.';
  end if;

  jid:=public.create_journal_entry_without_service_country(payload);

  with supplied as (
    select ordinality,
      case when payload->>'journal_type'=pending_type
        then nullif(btrim(value->>'service_country_id'),'')::bigint
      end service_country_id
    from jsonb_array_elements(payload->'lines') with ordinality
  ), stored as (
    select journal_line_id,row_number() over(order by journal_line_id) ordinality
    from public.journal_line
    where journal_id=jid
  )
  update public.journal_line line
  set service_country_id=supplied.service_country_id
  from supplied join stored using(ordinality)
  where line.journal_line_id=stored.journal_line_id;

  return jid;
end$$;

revoke all on function public.create_journal_entry(jsonb) from public,anon;
grant execute on function public.create_journal_entry(jsonb) to authenticated;

alter function public.update_journal_entry(bigint,jsonb)
  rename to update_journal_entry_without_service_country;

revoke all on function public.update_journal_entry_without_service_country(bigint,jsonb)
  from public,anon,authenticated;

create function public.update_journal_entry(target_journal_id bigint,payload jsonb)
returns bigint
language plpgsql
security definer
set search_path=public,pg_temp
as $$
declare
  jid bigint;
  pending_type text;
begin
  select name into pending_type
  from public.transaction_types
  where abbreviation='ASI_PEN'
  limit 1;

  if payload->>'journal_type'=pending_type and exists(
    select 1
    from jsonb_array_elements(coalesce(payload->'lines','[]'::jsonb)) item
    where nullif(btrim(item->>'service_country_id'),'') is null
       or coalesce(item->>'service_country_id','') !~ '^[0-9]+$'
       or not exists(
         select 1
         from public.countries country
         where country.country_id=case
           when coalesce(item->>'service_country_id','') ~ '^[0-9]+$'
           then (item->>'service_country_id')::bigint
         end
       )
  ) then
    raise exception 'Seleccione un País de servicio válido en cada línea del pendiente de facturar.';
  end if;

  jid:=public.update_journal_entry_without_service_country(target_journal_id,payload);

  with supplied as (
    select ordinality,
      case when payload->>'journal_type'=pending_type
        then nullif(btrim(value->>'service_country_id'),'')::bigint
      end service_country_id
    from jsonb_array_elements(payload->'lines') with ordinality
  ), stored as (
    select journal_line_id,row_number() over(order by journal_line_id) ordinality
    from public.journal_line
    where journal_id=jid
  )
  update public.journal_line line
  set service_country_id=supplied.service_country_id
  from supplied join stored using(ordinality)
  where line.journal_line_id=stored.journal_line_id;

  return jid;
end$$;

revoke all on function public.update_journal_entry(bigint,jsonb) from public,anon;
grant execute on function public.update_journal_entry(bigint,jsonb) to authenticated;

-- Resolve the optional CSV column against the shared CORE catalog. It becomes
-- mandatory only for ASI_PEN and is rejected for the other journal types.
create or replace function public.journal_csv_dimensions(p_line jsonb)
returns jsonb
language plpgsql
security definer
set search_path=public,pg_temp
as $$
declare
  kind text:=nullif(btrim(p_line->>'entidad'),'');
  entity jsonb;
  dept jsonb;
  center jsonb;
  cls jsonb;
  creditor jsonb;
  related jsonb;
  owner jsonb;
  eid bigint;
  did bigint;
  country_key bigint;
  country_matches integer;
  country_value text:=nullif(btrim(p_line->>'pais_servicio'),'');
begin
  if p_line->>'tipo_asiento'='ASI_PEN' then
    if country_value is null then
      raise exception 'País de servicio es obligatorio para cada línea ASI_PEN.';
    end if;

    if upper(country_value) ~ '^ID:[0-9]+$' then
      select count(*),min(country_id)
      into country_matches,country_key
      from public.countries
      where country_id=substring(country_value from 4)::bigint;
    else
      select count(distinct country_id),min(country_id)
      into country_matches,country_key
      from public.countries
      where lower(name)=lower(country_value)
         or upper(coalesce(country_code_iso2,''))=upper(country_value)
         or upper(coalesce(country_code_iso3,''))=upper(country_value);
    end if;

    if country_matches<>1 then
      raise exception 'País de servicio "%" no existe o es ambiguo en el catálogo CORE.',country_value;
    end if;
  elsif country_value is not null then
    raise exception 'País de servicio se utiliza únicamente para asientos ASI_PEN.';
  end if;

  if kind='Ninguna' then kind:=null; end if;
  if kind is not null and kind not in ('Cliente','Proveedor','Empleado') then
    raise exception 'Entidad debe ser Cliente, Proveedor, Empleado o Ninguna.';
  end if;
  if kind is null and nullif(btrim(p_line->>'nombre'),'') is not null then
    raise exception 'Indique la entidad para completar nombre.';
  end if;
  if kind is not null then
    if nullif(btrim(p_line->>'nombre'),'') is null then
      raise exception 'Complete nombre para la entidad %.',kind;
    end if;
    entity:=public.journal_csv_lookup(kind,p_line->>'nombre');
    eid:=coalesce(entity->>'customer_id',entity->>'supplier_id',entity->>'employee_id')::bigint;
  end if;

  dept:=public.journal_csv_lookup('departamento',p_line->>'departamento');
  if kind='Cliente' then
    did:=nullif(entity->>'department_id','')::bigint;
    if dept is not null and (dept->>'department_id')::bigint is distinct from did then
      raise exception 'El departamento no corresponde al cliente.';
    end if;
    if did is not null then dept:=public.journal_csv_lookup('departamento','ID:'||did); end if;
  end if;
  if kind='Empleado' and dept is not null and dept->>'type' is distinct from 'Interno' then
    raise exception 'Para empleados seleccione un departamento Interno.';
  end if;

  center:=public.journal_csv_lookup('centro_costos',p_line->>'centro_costos');
  cls:=public.journal_csv_lookup('clase',p_line->>'clase');
  if center is not null then
    owner:=public.journal_csv_lookup('Cliente','ID:'||(center->>'customer_id'));
    if dept is null or owner is null or owner->>'department_id' is distinct from dept->>'department_id' then
      raise exception 'El centro de costos no corresponde al departamento.';
    end if;
    if kind='Cliente' and center->>'customer_id' is distinct from entity->>'customer_id' then
      raise exception 'El centro de costos no corresponde al cliente.';
    end if;
    if cls is not null and cls->>'class_id' is distinct from center->>'class_id' then
      raise exception 'La clase no corresponde al centro de costos.';
    end if;
    if nullif(center->>'class_id','') is not null then
      cls:=public.journal_csv_lookup('clase','ID:'||(center->>'class_id'));
    end if;
  elsif cls is not null then
    raise exception 'Indique un centro de costos para asignar la clase.';
  end if;

  creditor:=public.journal_csv_lookup('acreedor_financiero',p_line->>'acreedor_financiero');
  related:=public.journal_csv_lookup('compania_relacionada',p_line->>'compania_relacionada');

  return jsonb_build_object(
    'entity_type',kind,
    'entity_id',eid,
    'department_id',dept->>'department_id',
    'cost_center_id',center->>'cost_center_id',
    'class_id',cls->>'class_id',
    'financial_creditor_id',creditor->>'financial_creditor_id',
    'related_company_id',related->>'related_company_id',
    'service_country_id',country_key
  );
end$$;

revoke all on function public.journal_csv_dimensions(jsonb)
  from public,anon,authenticated;

notify pgrst,'reload schema';
