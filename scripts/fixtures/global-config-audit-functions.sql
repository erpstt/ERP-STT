-- Reviewed audit functions for isolated tests only.
CREATE OR REPLACE FUNCTION public.audit_field_is_sensitive(p_field text)
 RETURNS boolean
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'pg_catalog'
AS $function$
  select regexp_replace(lower(coalesce(p_field,'')),'[^a-z0-9]+','_','g')
    ~ '(password|passwd|passphrase|token|secret|credential|authorization|cookie|api_?key|private_?key|auth_user_id|hash|smtp)'
$function$;
CREATE OR REPLACE FUNCTION public.audit_redact_jsonb(p_value jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 IMMUTABLE
 SET search_path TO 'pg_catalog', 'public'
AS $function$
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
$function$;

CREATE OR REPLACE FUNCTION public.capture_row_audit()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
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
$function$;
