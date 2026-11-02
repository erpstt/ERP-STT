-- Preserve existing payment columns as the primary account. All new fields
-- are nullable, without defaults or data backfills.
set local lock_timeout = '5s';
set local statement_timeout = '60s';

create schema entity_bank_private;
revoke all on schema entity_bank_private from public, anon, authenticated, service_role;

alter table public.suppliers
  add column payment_account_number varchar(80),
  add column payment_currency_id bigint references public.currencies(currency_id),
  add column secondary_payment_bank_id bigint references public.banks(bank_id),
  add column secondary_payment_iban varchar(34),
  add column secondary_payment_account_number varchar(80),
  add column secondary_payment_currency_id bigint references public.currencies(currency_id);
alter table public.employees
  add column payment_beneficiary_name varchar(250),
  add column payment_bank_id bigint references public.banks(bank_id),
  add column payment_iban varchar(34),
  add column payment_account_number varchar(80),
  add column payment_currency_id bigint references public.currencies(currency_id),
  add column secondary_payment_bank_id bigint references public.banks(bank_id),
  add column secondary_payment_iban varchar(34),
  add column secondary_payment_account_number varchar(80),
  add column secondary_payment_currency_id bigint references public.currencies(currency_id);
alter table public.other_names
  add column payment_currency_id bigint references public.currencies(currency_id),
  add column secondary_payment_bank_id bigint references public.banks(bank_id),
  add column secondary_payment_iban varchar(34),
  add column secondary_payment_account_number varchar(80),
  add column secondary_payment_currency_id bigint references public.currencies(currency_id);

create index suppliers_payment_currency_idx on public.suppliers(payment_currency_id) where payment_currency_id is not null;
create index suppliers_secondary_payment_bank_idx on public.suppliers(secondary_payment_bank_id) where secondary_payment_bank_id is not null;
create index suppliers_secondary_payment_currency_idx on public.suppliers(secondary_payment_currency_id) where secondary_payment_currency_id is not null;
create index employees_payment_bank_idx on public.employees(payment_bank_id) where payment_bank_id is not null;
create index employees_payment_currency_idx on public.employees(payment_currency_id) where payment_currency_id is not null;
create index employees_secondary_payment_bank_idx on public.employees(secondary_payment_bank_id) where secondary_payment_bank_id is not null;
create index employees_secondary_payment_currency_idx on public.employees(secondary_payment_currency_id) where secondary_payment_currency_id is not null;
create index other_names_payment_currency_idx on public.other_names(payment_currency_id) where payment_currency_id is not null;
create index other_names_secondary_payment_bank_idx on public.other_names(secondary_payment_bank_id) where secondary_payment_bank_id is not null;
create index other_names_secondary_payment_currency_idx on public.other_names(secondary_payment_currency_id) where secondary_payment_currency_id is not null;

create function entity_bank_private.valid_iban(value text)
returns boolean language plpgsql immutable set search_path = pg_catalog
as $$
declare rearranged text; character_value integer; remainder integer := 0; position integer;
begin
  if value is null then return true; end if;
  if value !~ '^[A-Z]{2}[0-9]{2}[A-Z0-9]{11,30}$' then return false; end if;
  rearranged := substr(value, 5) || substr(value, 1, 4);
  for position in 1..length(rearranged) loop
    character_value := ascii(substr(rearranged, position, 1));
    if character_value between 48 and 57 then remainder := (remainder * 10 + character_value - 48) % 97;
    else remainder := (remainder * 100 + character_value - 55) % 97; end if;
  end loop;
  return remainder = 1;
end $$;

create function entity_bank_private.normalize_accounts(data jsonb, subsidiary_ids bigint[])
returns jsonb language plpgsql stable security invoker set search_path = pg_catalog, public, pg_temp
as $$
declare result jsonb := data; prefix text; key text; raw text; normalized text; reference_id bigint;
begin
  if coalesce(cardinality(subsidiary_ids), 0) = 0 then
    raise exception using errcode = '42501', message = 'Seleccione una subsidiaria autorizada para los datos bancarios.';
  end if;
  foreach prefix in array array['payment_', 'secondary_payment_'] loop
    foreach key in array array[prefix || 'bank_id', prefix || 'currency_id'] loop
      raw := result ->> key;
      if raw = '' then result := jsonb_set(result, array[key], 'null'::jsonb); raw := null; end if;
      if raw is not null then
        if jsonb_typeof(result -> key) not in ('number', 'string')
          or raw !~ '^[1-9][0-9]{0,15}$' then
          raise exception using errcode = '22023', message = 'Banco o moneda bancaria inválidos.';
        end if;
        if raw::numeric > 9007199254740991 then
          raise exception using errcode = '22023', message = 'Banco o moneda bancaria inválidos.';
        end if;
        reference_id := raw::bigint;
        if key = prefix || 'bank_id' then
          if not exists(select 1 from public.banks where bank_id = reference_id) then
            raise exception using errcode = '42501', message = 'Banco del beneficiario no disponible.';
          end if;
        elsif not exists(select 1 from unnest(subsidiary_ids) sid
          where entity_master_private.currency_ok(reference_id, sid)) then
          raise exception using errcode = '42501', message = 'Moneda bancaria no disponible para las subsidiarias de la entidad.';
        end if;
      end if;
    end loop;
    foreach key in array array[prefix || 'iban', prefix || 'account_number'] loop
      if result ? key and jsonb_typeof(result -> key) not in ('string', 'null') then
        raise exception using errcode = '22023', message = 'IBAN y número de cuenta deben ser texto.';
      end if;
      raw := nullif(btrim(result ->> key), '');
      if key = prefix || 'iban' and raw is not null then
        normalized := upper(regexp_replace(raw, '[[:space:]]', '', 'g'));
        if not entity_bank_private.valid_iban(normalized) then
          raise exception using errcode = '22023', message = 'IBAN inválido. Revise el formato y los dígitos de control.';
        end if;
        raw := normalized;
      elsif length(coalesce(raw, '')) > 80 then
        raise exception using errcode = '22023', message = 'El número de cuenta supera el tamaño permitido.';
      end if;
      if result ? key then result := jsonb_set(result, array[key], coalesce(to_jsonb(raw), 'null'::jsonb)); end if;
    end loop;
    if (result ->> (prefix || 'iban') is not null or result ->> (prefix || 'account_number') is not null)
      and result ->> (prefix || 'bank_id') is null then
      raise exception using errcode = '22023', message = 'Seleccione un banco para la cuenta o el IBAN.';
    end if;
  end loop;
  if result ? 'payment_beneficiary_name' and jsonb_typeof(result -> 'payment_beneficiary_name') not in ('string', 'null') then
    raise exception using errcode = '22023', message = 'El beneficiario bancario debe ser texto.';
  end if;
  if result ->> 'payment_beneficiary_name' is not null then
    raw := nullif(btrim(result ->> 'payment_beneficiary_name'), '');
    if length(coalesce(raw, '')) > 250 then
      raise exception using errcode = '22023', message = 'El beneficiario bancario supera el tamaño permitido.';
    end if;
    result := jsonb_set(result, array['payment_beneficiary_name'], coalesce(to_jsonb(raw), 'null'::jsonb));
  end if;
  return result;
end $$;

create function entity_bank_private.references(sid bigint)
returns jsonb language sql stable security invoker set search_path = pg_catalog, public, pg_temp
as $$
  select jsonb_build_object(
    'banking/banks', coalesce((select jsonb_agg(jsonb_build_object('bank_id', b.bank_id,
      'bank_name', b.bank_name, 'bank_code', b.bank_code, 'country_id', b.country_id) order by b.bank_name)
      from public.banks b), '[]'::jsonb),
    'core/currencies', coalesce((select jsonb_agg(jsonb_build_object('currency_id', c.currency_id,
      'currency_code', c.currency_code, 'name', coalesce(to_jsonb(c)->>'name', c.currency_code)) order by c.currency_code)
      from public.currencies c where entity_master_private.currency_ok(c.currency_id, sid)), '[]'::jsonb))
$$;

-- Update only reviewed fragments of the existing functions. Their identity,
-- permission, scope, revision, auditing and grant boundaries are preserved.
create function entity_bank_private.patch(signature regprocedure, original text, replacement text)
returns void language plpgsql security invoker set search_path = pg_catalog
as $$
declare definition text := pg_get_functiondef(signature); occurrences integer;
begin
  occurrences := (length(definition) - length(replace(definition, original, ''))) / length(original);
  if occurrences <> 1 then
    raise exception using errcode = '55000', message = 'La función bancaria cambió; revise el fragmento antes de actualizar: ' || signature::text;
  end if;
  execute replace(definition, original, replacement);
end $$;

select entity_bank_private.patch('entity_master_private.meta(text)'::regprocedure,
  $old$'payment_bank_id','payment_iban','email'$old$,
  $new$'payment_bank_id','payment_iban','payment_account_number','payment_currency_id','secondary_payment_bank_id','secondary_payment_iban','secondary_payment_account_number','secondary_payment_currency_id','email'$new$);
select entity_bank_private.patch('entity_master_private.save_entity_master(text,jsonb,bigint)'::regprocedure,
  $old$if p_catalog='suppliers'and data->>'payment_iban'is not null then$old$,
  $new$if p_catalog='suppliers' then data:=entity_bank_private.normalize_accounts(data,subs);end if;
 if p_catalog='suppliers'and data->>'payment_iban'is not null then$new$);
select entity_bank_private.patch('entity_master_private.entity_master_options(text)'::regprocedure,
  $old$jsonb_agg(to_jsonb(x))from public.banks x$old$,
  $new$jsonb_agg(jsonb_build_object('bank_id',x.bank_id,'bank_name',x.bank_name,'bank_code',x.bank_code,'country_id',x.country_id))from public.banks x$new$);
select entity_bank_private.patch('entity_master_private.entity_master_options(text)'::regprocedure,
  $old$jsonb_agg(to_jsonb(c))from public.currencies c$old$,
  $new$jsonb_agg(jsonb_build_object('currency_id',c.currency_id,'currency_code',c.currency_code,'name',coalesce(to_jsonb(c)->>'name',c.currency_code)))from public.currencies c$new$);

select entity_bank_private.patch('employee_master_private.options()'::regprocedure,
  $old$'references',jsonb_build_object($old$,
  $new$'references',entity_bank_private.references(sid)||jsonb_build_object($new$);
select entity_bank_private.patch('employee_master_private.save(jsonb,bigint)'::regprocedure,
  $old$'user_id','is_active','is_sales_representative'];$old$,
  $new$'user_id','is_active','is_sales_representative','payment_beneficiary_name','payment_bank_id','payment_iban','payment_account_number','payment_currency_id','secondary_payment_bank_id','secondary_payment_iban','secondary_payment_account_number','secondary_payment_currency_id'];$new$);
select entity_bank_private.patch('employee_master_private.save(jsonb,bigint)'::regprocedure,
  $old$elsif k in('subsidiary_id','department_id','location_id','user_id')then$old$,
  $new$elsif k in('subsidiary_id','department_id','location_id','user_id','payment_bank_id','payment_currency_id','secondary_payment_bank_id','secondary_payment_currency_id')then$new$);
select entity_bank_private.patch('employee_master_private.save(jsonb,bigint)'::regprocedure,
  $old$e:=jsonb_populate_record(null::public.employees,data);$old$,
  $new$data:=entity_bank_private.normalize_accounts(data,array[sid]);
 e:=jsonb_populate_record(null::public.employees,data);$new$);

select entity_bank_private.patch('other_name_private.options()'::regprocedure,
  $old$'references', jsonb_build_object($old$,
  $new$'references', entity_bank_private.references(sid) || jsonb_build_object($new$);
select entity_bank_private.patch('other_name_private.save(jsonb,bigint)'::regprocedure,
  $old$'payment_bank_id', 'payment_iban', 'payment_account_number', 'comments', 'is_active', 'subsidiary_id'];$old$,
  $new$'payment_bank_id', 'payment_iban', 'payment_account_number', 'payment_currency_id', 'secondary_payment_bank_id',
    'secondary_payment_iban', 'secondary_payment_account_number', 'secondary_payment_currency_id', 'comments', 'is_active', 'subsidiary_id'];$new$);
select entity_bank_private.patch('other_name_private.save(jsonb,bigint)'::regprocedure,
  $old$elsif key in ('subsidiary_id', 'payment_bank_id') then$old$,
  $new$elsif key in ('subsidiary_id', 'payment_bank_id', 'payment_currency_id', 'secondary_payment_bank_id', 'secondary_payment_currency_id') then$new$);
select entity_bank_private.patch('other_name_private.save(jsonb,bigint)'::regprocedure,
  $old$foreach key in array fields loop$old$,
  $new$data := entity_bank_private.normalize_accounts(data, array[sid]);
  foreach key in array fields loop$new$);
select entity_bank_private.patch('other_name_private.save(jsonb,bigint)'::regprocedure,
  $old$payment_beneficiary_name, payment_bank_id, payment_iban, payment_account_number, comments, is_active)$old$,
  $new$payment_beneficiary_name, payment_bank_id, payment_iban, payment_account_number, payment_currency_id,
      secondary_payment_bank_id, secondary_payment_iban, secondary_payment_account_number, secondary_payment_currency_id, comments, is_active)$new$);
select entity_bank_private.patch('other_name_private.save(jsonb,bigint)'::regprocedure,
  $old$entry.payment_iban, entry.payment_account_number, entry.comments, entry.is_active) returning * into entry;$old$,
  $new$entry.payment_iban, entry.payment_account_number, entry.payment_currency_id, entry.secondary_payment_bank_id,
      entry.secondary_payment_iban, entry.secondary_payment_account_number, entry.secondary_payment_currency_id, entry.comments, entry.is_active) returning * into entry;$new$);
select entity_bank_private.patch('other_name_private.save(jsonb,bigint)'::regprocedure,
  $old$payment_iban = entry.payment_iban, payment_account_number = entry.payment_account_number, comments = entry.comments,$old$,
  $new$payment_iban = entry.payment_iban, payment_account_number = entry.payment_account_number, payment_currency_id = entry.payment_currency_id,
      secondary_payment_bank_id = entry.secondary_payment_bank_id, secondary_payment_iban = entry.secondary_payment_iban,
      secondary_payment_account_number = entry.secondary_payment_account_number, secondary_payment_currency_id = entry.secondary_payment_currency_id, comments = entry.comments,$new$);

drop function entity_bank_private.patch(regprocedure,text,text);
revoke all on all functions in schema entity_bank_private from public, anon, authenticated, service_role;
notify pgrst, 'reload schema';
