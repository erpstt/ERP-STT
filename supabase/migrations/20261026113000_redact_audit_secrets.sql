-- Evita que credenciales, tokens e identificadores de autenticacion queden
-- almacenados en texto claro dentro de la bitacora central.

create or replace function public.audit_field_is_sensitive(p_field text)
returns boolean
language sql
immutable
set search_path=pg_catalog
as $$
  select regexp_replace(lower(coalesce(p_field,'')),'[^a-z0-9]+','_','g')
    ~ '(password|passwd|passphrase|token|secret|credential|authorization|cookie|api_?key|private_?key|auth_user_id|hash|smtp)'
$$;

create or replace function public.audit_redact_jsonb(p_value jsonb)
returns jsonb
language plpgsql
immutable
set search_path=pg_catalog,public
as $$
declare
  redacted jsonb;
begin
  if p_value is null then
    return null;
  end if;

  if jsonb_typeof(p_value)='object' then
    select coalesce(
      jsonb_object_agg(
        item.key,
        case
          when public.audit_field_is_sensitive(item.key)
            then to_jsonb('[REDACTADO]'::text)
          else public.audit_redact_jsonb(item.value)
        end
      ),
      '{}'::jsonb
    )
    into redacted
    from jsonb_each(p_value) item;
    return redacted;
  end if;

  if jsonb_typeof(p_value)='array' then
    select coalesce(
      jsonb_agg(public.audit_redact_jsonb(item.value) order by item.ordinality),
      '[]'::jsonb
    )
    into redacted
    from jsonb_array_elements(p_value) with ordinality item(value,ordinality);
    return redacted;
  end if;

  return p_value;
end;
$$;

create or replace function public.audit_redact_json_text(p_value text)
returns text
language plpgsql
immutable
set search_path=pg_catalog,public
as $$
begin
  if p_value is null then
    return null;
  end if;
  return public.audit_redact_jsonb(p_value::jsonb)::text;
exception when others then
  -- Un snapshot historico corrupto no debe abortar la migracion ni conservar
  -- fragmentos que pudieran contener una credencial.
  return jsonb_build_object(
    '_snapshot','[REDACTADO]',
    '_reason','FORMATO_HISTORICO_INVALIDO'
  )::text;
end;
$$;

revoke all on function public.audit_field_is_sensitive(text) from public,anon,authenticated,service_role;
revoke all on function public.audit_redact_jsonb(jsonb) from public,anon,authenticated,service_role;
revoke all on function public.audit_redact_json_text(text) from public,anon,authenticated,service_role;

create or replace function public.capture_row_audit()
returns trigger
language plpgsql
security definer
set search_path=public,pg_temp
as $$
declare
  before_row jsonb:=case when tg_op in('UPDATE','DELETE') then to_jsonb(old) end;
  after_row jsonb:=case when tg_op in('INSERT','UPDATE') then to_jsonb(new) end;
  row_data jsonb:=coalesce(after_row,before_row);
  actor bigint:=public.app_user_id();
  audit_id bigint;
  entity_key text;
  numeric_id bigint;
  field record;
  action_name text:=case tg_op when 'INSERT' then 'CREACION' when 'UPDATE' then 'MODIFICACION' else 'ELIMINACION' end;
begin
  entity_key:=public.audit_primary_key(tg_relid,row_data);
  begin
    numeric_id:=split_part(split_part(entity_key,'=',2),',',1)::bigint;
  exception when others then
    numeric_id:=null;
  end;

  insert into public.audit_log(
    user_id,action,module,entity_type,entity_id,entity_key,description,
    result,ip_address,session_id
  ) values(
    actor,action_name,tg_table_schema,tg_table_name,numeric_id,entity_key,
    format('%s sobre %I.%I (%s)',action_name,tg_table_schema,tg_table_name,coalesce(entity_key,'sin clave primaria')),
    'EXITOSA',public.audit_request_ip(),public.app_session_id()
  ) returning log_id into audit_id;

  if tg_op='UPDATE' then
    for field in
      select old_item.key,old_item.value old_value,new_item.value new_value
      from jsonb_each(before_row) old_item
      join jsonb_each(after_row) new_item using(key)
      where old_item.value is distinct from new_item.value
    loop
      insert into public.change_log(
        audit_log_id,field_name,old_value,new_value,change_type
      ) values(
        audit_id,
        field.key,
        case
          when public.audit_field_is_sensitive(field.key) then '[REDACTADO]'
          else public.audit_redact_jsonb(field.old_value)#>>'{}'
        end,
        case
          when public.audit_field_is_sensitive(field.key) then '[REDACTADO]'
          else public.audit_redact_jsonb(field.new_value)#>>'{}'
        end,
        'MODIFICACION'
      );
    end loop;
  elsif tg_op='DELETE' then
    insert into public.deleted_records(
      original_table_name,original_record_id,deleted_by_user_id,
      record_data_json,module,audit_log_id
    ) values(
      tg_table_name,coalesce(numeric_id,0),actor,
      public.audit_redact_jsonb(before_row)::text,tg_table_schema,audit_id
    );
  end if;

  if actor is not null then
    insert into public.activity_log(user_id,activity_type,path_accessed)
    values(
      actor,action_name,
      format('%I.%I/%s',tg_table_schema,tg_table_name,coalesce(entity_key,''))
    );
  end if;

  if tg_op='DELETE' then return old; else return new; end if;
end;
$$;

-- Los eventos manuales tambien pueden recibir estructuras JSON arbitrarias.
create or replace function public.record_system_event(
  event_type text,
  source_component text,
  description text,
  result text default 'EXITOSA',
  details jsonb default null
) returns bigint
language plpgsql
security definer
set search_path=public,pg_temp
as $$
declare
  new_id bigint;
begin
  insert into public.event_log(
    event_type,source_component,description,result,details
  ) values(
    event_type,source_component,description,result,
    public.audit_redact_jsonb(details)
  ) returning event_id into new_id;
  return new_id;
end;
$$;

-- Sanea entradas historicas creadas antes de instalar la redaccion. Las
-- bitacoras se desbloquean solo dentro de esta migracion transaccional.
alter table public.change_log disable trigger actor_log_immutable;
alter table public.change_log disable trigger zzzz_actor_stamp;
alter table public.deleted_records disable trigger actor_log_immutable;
alter table public.deleted_records disable trigger zzzz_actor_stamp;
alter table public.event_log disable trigger actor_log_immutable;
alter table public.event_log disable trigger zzzz_actor_stamp;

update public.change_log
set old_value=case when old_value is null then null else '[REDACTADO]' end,
    new_value=case when new_value is null then null else '[REDACTADO]' end
where public.audit_field_is_sensitive(field_name)
  and(old_value is distinct from '[REDACTADO]' or new_value is distinct from '[REDACTADO]');

with sanitized as(
  select deleted_id,public.audit_redact_json_text(record_data_json) redacted_value
  from public.deleted_records
)
update public.deleted_records target
set record_data_json=sanitized.redacted_value
from sanitized
where target.deleted_id=sanitized.deleted_id
  and target.record_data_json is distinct from sanitized.redacted_value;

update public.event_log
set details=public.audit_redact_jsonb(details)
where details is not null
  and details::text~*'(password|passwd|passphrase|token|secret|credential|authorization|cookie|api[_-]?key|private[_-]?key|auth_user_id|hash|smtp)';

alter table public.change_log enable trigger zzzz_actor_stamp;
alter table public.change_log enable trigger actor_log_immutable;
alter table public.deleted_records enable trigger zzzz_actor_stamp;
alter table public.deleted_records enable trigger actor_log_immutable;
alter table public.event_log enable trigger zzzz_actor_stamp;
alter table public.event_log enable trigger actor_log_immutable;

-- El marcador heredado deja de contener hashes locales. Esta escritura ocurre
-- despues de instalar la redaccion, por lo que la bitacora conserva evidencia
-- del cambio sin revelar el valor anterior ni el nuevo.
update public.users
set password_hash='auth:'||auth_user_id::text
where auth_user_id is not null
  and password_hash is distinct from 'auth:'||auth_user_id::text;

notify pgrst,'reload schema';
