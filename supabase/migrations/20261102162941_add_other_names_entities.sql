-- Third parties that are separate from customer and supplier invoice masters.
set local lock_timeout = '5s';
set local statement_timeout = '60s';

create schema other_name_private;
revoke all on schema other_name_private from public, anon, authenticated, service_role;
grant usage on schema other_name_private to authenticated;

create function other_name_private.normalized_identification(value text)
returns text language sql immutable set search_path = pg_catalog
as $$ select upper(regexp_replace(btrim(value), '[[:space:]./_-]', '', 'g')) $$;

create table public.other_names (
  other_name_id bigint generated always as identity primary key,
  subsidiary_id bigint not null references public.subsidiaries(subsidiary_id),
  other_name_number varchar(32) not null,
  name varchar(250) not null check (btrim(name) <> ''),
  identification varchar(80) not null check (other_name_private.normalized_identification(identification) <> ''),
  email varchar(254),
  phone varchar(80),
  payment_beneficiary_name varchar(250),
  payment_bank_id bigint references public.banks(bank_id),
  payment_iban varchar(34),
  payment_account_number varchar(80),
  comments varchar(8000),
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (subsidiary_id, other_name_number),
  check (payment_bank_id is not null or (payment_iban is null and payment_account_number is null))
);
create unique index other_names_identification_subsidiary_idx
  on public.other_names (subsidiary_id, other_name_private.normalized_identification(identification));
create index other_names_subsidiary_name_idx on public.other_names (subsidiary_id, lower(name));
create index other_names_payment_bank_idx on public.other_names (payment_bank_id) where payment_bank_id is not null;

-- Calling the installer also works when the standard new-table event trigger
-- already installed it. It recreates, rather than duplicates, the triggers.
select public.install_actor_audit('public.other_names'::regclass);

create table other_name_private.number_counters (
  subsidiary_id bigint primary key references public.subsidiaries(subsidiary_id),
  last_value bigint not null check (last_value > 0)
);
alter table other_name_private.number_counters enable row level security;
revoke all on table other_name_private.number_counters from public, anon, authenticated, service_role;

create function other_name_private.allowed(action text)
returns boolean language plpgsql stable security definer
set search_path = pg_catalog, public, pg_temp
as $$
begin
  perform entity_master_private.identity();
  return exists (
    select 1 from public.role_access_matrix m
    where m.role_id = public.app_active_role_id()
      and m.resource_key = 'entities:other-names'
      and case action when 'view' then m.can_view when 'create' then m.can_create
        when 'edit' then m.can_edit when 'delete' then m.can_delete else false end
  );
exception when insufficient_privilege then return false;
end $$;

create function other_name_private.access(action text)
returns bigint language plpgsql stable security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare sid bigint := entity_master_private.identity();
begin
  if not other_name_private.allowed(action) then
    raise exception using errcode = '42501', message = 'Requiere permiso explícito para Otros Nombres.';
  end if;
  return sid;
end $$;

create function other_name_private.visible(sid bigint)
returns boolean language plpgsql stable security definer
set search_path = pg_catalog, public, pg_temp
as $$
begin
  return sid = entity_master_private.identity() and other_name_private.allowed('view');
exception when insufficient_privilege then return false;
end $$;

create function other_name_private.valid_iban(value text)
returns boolean language plpgsql immutable set search_path = pg_catalog
as $$
declare rearranged text; symbol text; remainder integer := 0; cursor_index integer; code integer;
begin
  if value is null then return true; end if;
  if value !~ '^[A-Z]{2}[0-9]{2}[A-Z0-9]{11,30}$' then return false; end if;
  rearranged := substr(value, 5) || substr(value, 1, 4);
  for cursor_index in 1..length(rearranged) loop
    symbol := substr(rearranged, cursor_index, 1);
    code := ascii(symbol);
    if code between 48 and 57 then remainder := (remainder * 10 + code - 48) % 97;
    else remainder := (remainder * 100 + code - 55) % 97; end if;
  end loop;
  return remainder = 1;
end $$;

create function other_name_private.dto(row_value public.other_names)
returns jsonb language sql stable security definer
set search_path = pg_catalog, public, pg_temp
as $$
  select to_jsonb(row_value) || jsonb_build_object(
    '_revision', md5(to_jsonb(row_value)::text),
    '_actions', jsonb_build_object('canEdit', other_name_private.allowed('edit'),
      'canDelete', other_name_private.allowed('delete')))
$$;

create function other_name_private.list()
returns jsonb language plpgsql stable security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare sid bigint := other_name_private.access('view');
begin
  return coalesce((select jsonb_agg(other_name_private.dto(n) order by n.other_name_id)
    from public.other_names n where n.subsidiary_id = sid), '[]'::jsonb);
end $$;

create function other_name_private.options()
returns jsonb language plpgsql stable security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare sid bigint := other_name_private.access('view');
begin
  return jsonb_build_object('canView', true,
    'canCreate', other_name_private.allowed('create'), 'canEdit', other_name_private.allowed('edit'),
    'canDelete', other_name_private.allowed('delete'),
    'references', jsonb_build_object(
      'organization/subsidiaries', coalesce((select jsonb_agg(jsonb_build_object(
        'subsidiary_id', s.subsidiary_id, 'name', s.name)) from public.subsidiaries s where s.subsidiary_id = sid), '[]'::jsonb),
      'banking/banks', coalesce((select jsonb_agg(jsonb_build_object('bank_id', b.bank_id,
        'bank_name', b.bank_name, 'bank_code', b.bank_code, 'country_id', b.country_id) order by b.bank_name)
        from public.banks b), '[]'::jsonb)));
end $$;

create function other_name_private.save(p jsonb, id bigint)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  sid bigint := other_name_private.access(case when id is null then 'create' else 'edit' end);
  previous public.other_names; entry public.other_names; data jsonb; key text; raw text; number_value bigint;
  fields text[] := array['name', 'identification', 'email', 'phone', 'payment_beneficiary_name',
    'payment_bank_id', 'payment_iban', 'payment_account_number', 'comments', 'is_active', 'subsidiary_id'];
begin
  if id <= 0 or id > 9007199254740991 or jsonb_typeof(p) is distinct from 'object'
    or pg_column_size(p) > 32000
    or exists(select 1 from jsonb_object_keys(p) supplied where not supplied = any(fields || array['_revision'])) then
    raise exception using errcode = '22023', message = 'Campos de Otros Nombres inválidos.';
  end if;
  if id is not null then
    select * into previous from public.other_names where other_name_id = id for update;
    if not found or previous.subsidiary_id <> sid then
      raise exception using errcode = '42501', message = 'Tercero fuera de la subsidiaria activa.';
    end if;
    if p->>'_revision' is distinct from md5(to_jsonb(previous)::text) then
      raise exception using errcode = '55000', message = 'El tercero cambió. Consúltelo nuevamente.';
    end if;
  end if;
  data := case when id is null then jsonb_build_object('subsidiary_id', sid, 'is_active', true)
    else to_jsonb(previous) end || (p - '_revision');
  foreach key in array fields loop
    if key = 'is_active' then
      if jsonb_typeof(data->key) is distinct from 'boolean' then
        raise exception using errcode = '22023', message = 'La opción Activo debe ser booleana.';
      end if;
    elsif key in ('subsidiary_id', 'payment_bank_id') then
      raw := data->>key;
      if raw is not null and (jsonb_typeof(data->key) not in ('number', 'string')
        or raw !~ '^[1-9][0-9]{0,15}$') then
        raise exception using errcode = '22023', message = 'Referencia bancaria o de subsidiaria inválida.';
      end if;
      if raw is not null and raw::numeric > 9007199254740991 then
        raise exception using errcode = '22023', message = 'Referencia bancaria o de subsidiaria inválida.';
      end if;
    else
      if data ? key and jsonb_typeof(data->key) not in ('string', 'null') then
        raise exception using errcode = '22023', message = 'Los datos del tercero deben ser texto.';
      end if;
      if data->>key is not null then data := jsonb_set(data, array[key], to_jsonb(btrim(data->>key))); end if;
      if data->>key = '' then data := jsonb_set(data, array[key], 'null'::jsonb); end if;
    end if;
  end loop;
  if data->>'subsidiary_id' is null or (data->>'subsidiary_id')::bigint <> sid then
    raise exception using errcode = '42501', message = 'La subsidiaria del tercero debe ser la activa y es inmutable.';
  end if;
  if nullif(data->>'name', '') is null or length(data->>'name') > 250
    or nullif(data->>'identification', '') is null or length(data->>'identification') > 80
    or other_name_private.normalized_identification(data->>'identification') = '' then
    raise exception using errcode = '22023', message = 'Complete nombre e identificación válidos.';
  end if;
  if data->>'email' is not null and (length(data->>'email') > 254
    or data->>'email' !~ '^[^[:space:]@,;<>]+@[^[:space:]@,;<>]+\.[^[:space:]@,;<>]+$') then
    raise exception using errcode = '22023', message = 'Correo electrónico inválido.';
  end if;
  if length(coalesce(data->>'phone', '')) > 80 or length(coalesce(data->>'payment_beneficiary_name', '')) > 250
    or length(coalesce(data->>'payment_account_number', '')) > 80 or length(coalesce(data->>'comments', '')) > 8000 then
    raise exception using errcode = '22023', message = 'Los datos del tercero exceden el tamaño permitido.';
  end if;
  if data->>'payment_iban' is not null then
    raw := upper(regexp_replace(data->>'payment_iban', '[[:space:]]', '', 'g'));
    if not other_name_private.valid_iban(raw) then
      raise exception using errcode = '22023', message = 'IBAN inválido. Revise su formato y dígitos de control.';
    end if;
    data := data || jsonb_build_object('payment_iban', raw);
  end if;
  if (data->>'payment_iban' is not null or data->>'payment_account_number' is not null)
    and data->>'payment_bank_id' is null then
    raise exception using errcode = '22023', message = 'Seleccione el banco del beneficiario para registrar su cuenta o IBAN.';
  end if;
  if data->>'payment_bank_id' is not null and not exists (
    select 1 from public.banks where bank_id = (data->>'payment_bank_id')::bigint) then
    raise exception using errcode = '42501', message = 'Banco del beneficiario no disponible.';
  end if;
  if exists(select 1 from public.other_names n where n.subsidiary_id = sid and n.other_name_id is distinct from id
    and other_name_private.normalized_identification(n.identification) = other_name_private.normalized_identification(data->>'identification')) then
    raise exception using errcode = '23505', message = 'La identificación ya existe en Otros Nombres de esta subsidiaria.';
  end if;
  entry := jsonb_populate_record(null::public.other_names, data);
  if id is null then
    insert into other_name_private.number_counters as counters (subsidiary_id, last_value) values (sid, 1)
    on conflict (subsidiary_id) do update set last_value = counters.last_value + 1 returning last_value into number_value;
    insert into public.other_names(subsidiary_id, other_name_number, name, identification, email, phone,
      payment_beneficiary_name, payment_bank_id, payment_iban, payment_account_number, comments, is_active)
    values(sid, 'ON-' || lpad(number_value::text, greatest(6, length(number_value::text)), '0'), entry.name,
      entry.identification, entry.email, entry.phone, entry.payment_beneficiary_name, entry.payment_bank_id,
      entry.payment_iban, entry.payment_account_number, entry.comments, entry.is_active) returning * into entry;
  else
    update public.other_names set name = entry.name, identification = entry.identification, email = entry.email,
      phone = entry.phone, payment_beneficiary_name = entry.payment_beneficiary_name, payment_bank_id = entry.payment_bank_id,
      payment_iban = entry.payment_iban, payment_account_number = entry.payment_account_number, comments = entry.comments,
      is_active = entry.is_active, updated_at = clock_timestamp()
      where other_name_id = id returning * into entry;
  end if;
  return other_name_private.dto(entry);
end $$;

create function other_name_private.remove(id bigint, revision text)
returns boolean language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare sid bigint := other_name_private.access('delete'); entry public.other_names;
begin
  if id is null or id <= 0 or id > 9007199254740991 then
    raise exception using errcode = '22023', message = 'Identificador de tercero inválido.';
  end if;
  select * into entry from public.other_names where other_name_id = id for update;
  if not found or entry.subsidiary_id <> sid then
    raise exception using errcode = '42501', message = 'Tercero fuera de la subsidiaria activa.';
  end if;
  if revision is distinct from md5(to_jsonb(entry)::text) then
    raise exception using errcode = '55000', message = 'El tercero cambió. Consúltelo nuevamente.';
  end if;
  delete from public.other_names where other_name_id = id;
  return true;
end $$;

create function public.other_name_list()
returns jsonb language sql stable security invoker set search_path = pg_catalog
as $$ select other_name_private.list() $$;
create function public.other_name_options()
returns jsonb language sql stable security invoker set search_path = pg_catalog
as $$ select other_name_private.options() $$;
create function public.save_other_name(p_payload jsonb, p_id bigint default null)
returns jsonb language sql security invoker set search_path = pg_catalog
as $$ select other_name_private.save(p_payload, p_id) $$;
create function public.delete_other_name(p_id bigint, p_revision text)
returns boolean language sql security invoker set search_path = pg_catalog
as $$ select other_name_private.remove(p_id, p_revision) $$;

alter table public.other_names enable row level security;
revoke all on table public.other_names from public, anon, authenticated, service_role;
revoke all on sequence public.other_names_other_name_id_seq from public, anon, authenticated, service_role;
create policy other_names_read on public.other_names for select to authenticated
using (other_name_private.visible(subsidiary_id));
grant select on table public.other_names to authenticated;

revoke all on all functions in schema other_name_private from public, anon, authenticated, service_role;
grant execute on function other_name_private.normalized_identification(text), other_name_private.visible(bigint),
  other_name_private.list(), other_name_private.options(), other_name_private.save(jsonb, bigint),
  other_name_private.remove(bigint, text) to authenticated;
revoke all on function public.other_name_list(), public.other_name_options(), public.save_other_name(jsonb, bigint),
  public.delete_other_name(bigint, text) from public, anon, authenticated, service_role;
grant execute on function public.other_name_list(), public.other_name_options(), public.save_other_name(jsonb, bigint),
  public.delete_other_name(bigint, text) to authenticated;

insert into public.role_access_matrix(role_id, resource_key, can_view, can_create, can_edit, can_delete)
select role_id, 'entities:other-names', true, true, true, true from public.roles
where is_system_role and lower(btrim(role_name)) in ('administrador', 'administrator', 'admin')
on conflict (role_id, resource_key) do nothing;

-- Extend only the new entity's audit classification; preserve all existing
-- branches, function attributes, ownership and execute privileges.
do $audit_metadata$
declare
  definition text := pg_get_functiondef('public.audit_change_entity_meta(text,text)'::regprocedure);
  module_branch text := $branch$when entity_name~'^(customers|suppliers|entity_)' then 'entities'$branch$;
  label_branch text := $branch$when 'suppliers' then 'Proveedores'$branch$;
begin
  if (length(definition) - length(replace(definition, module_branch, ''))) / length(module_branch) <> 1
    or (length(definition) - length(replace(definition, label_branch, ''))) / length(label_branch) <> 1 then
    raise exception using errcode = '55000', message = 'La clasificación de auditoría cambió; revise las ramas antes de ampliar Otros Nombres.';
  end if;
  definition := replace(definition, module_branch,
    $branch$when entity_name = 'other_names' then 'entities'
    when entity_name~'^(customers|suppliers|entity_)' then 'entities'$branch$);
  definition := replace(definition, label_branch,
    $branch$when 'other_names' then 'Otros Nombres'
    when 'suppliers' then 'Proveedores'$branch$);
  execute definition;
end $audit_metadata$;

comment on table public.other_names is 'Terceros de una única subsidiaria, separados de clientes y proveedores de facturas.';
notify pgrst, 'reload schema';
