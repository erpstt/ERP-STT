-- Restore one support validation boundary around every pending-invoice reversal.
-- The wrapper preserves the complete accounting/FX/reclassification chain and
-- also repairs databases where an older delegated function did not save files.

create or replace function public.validate_pending_reversal_supports(
  p_payload jsonb
) returns jsonb
language plpgsql
security invoker
set search_path=public,pg_temp
as $$
declare
  kind text:=p_payload->>'type';
  supports jsonb:=coalesce(p_payload->'supports','[]'::jsonb);
  support jsonb;
  declared_size bigint;
  decoded_size bigint;
begin
  if jsonb_typeof(supports)<>'array' then
    raise exception 'Los archivos de respaldo no son válidos.';
  end if;

  if jsonb_array_length(supports)>0
    and kind is distinct from 'ERROR_CORRECCION' then
    raise exception 'Solo las reversiones por error / corrección permiten archivos de respaldo.';
  end if;

  for support in select value from jsonb_array_elements(supports) loop
    if support->>'support_type'='Enlace' then
      if nullif(btrim(support->>'display_name'),'') is null
        or coalesce(support->>'support_url','')
          !~* '^https?://[^[:space:]/?#]+[^[:space:]]*$' then
        raise exception 'Ingrese un enlace de respaldo válido que comience con http:// o https://';
      end if;
    elsif support->>'support_type'='Archivo' then
      begin
        declared_size:=nullif(support->>'file_size','')::bigint;
      exception when invalid_text_representation or numeric_value_out_of_range then
        raise exception 'Archivo de respaldo inválido o superior a 5 MB.';
      end;

      if nullif(btrim(support->>'file_name'),'') is null
        or nullif(btrim(support->>'display_name'),'') is null
        or support->>'file_data' is null
        or coalesce(declared_size,-1) not between 0 and 5242880 then
        raise exception 'Archivo de respaldo inválido o superior a 5 MB.';
      end if;

      if length(support->>'file_data')>7100000
        or (support->>'file_data') !~ '^data:[^,]*;base64,' then
        raise exception 'El contenido del archivo de respaldo no es válido.';
      end if;

      begin
        decoded_size:=octet_length(
          decode(split_part(support->>'file_data',',',2),'base64')
        );
      exception when others then
        raise exception 'El contenido del archivo de respaldo no es Base64 válido.';
      end;
      if decoded_size<>declared_size then
        raise exception 'El tamaño del archivo de respaldo no coincide con su contenido.';
      end if;
    else
      raise exception 'Tipo de respaldo no válido.';
    end if;
  end loop;

  return supports;
end
$$;

revoke all on function public.validate_pending_reversal_supports(jsonb)
  from public,anon,authenticated;

do $$
begin
  if to_regprocedure(
    'public.reverse_pending_invoice_journal_before_support_integrity(bigint,jsonb)'
  ) is null then
    alter function public.reverse_pending_invoice_journal(bigint,jsonb)
      rename to reverse_pending_invoice_journal_before_support_integrity;
  elsif to_regprocedure(
    'public.reverse_pending_invoice_journal(bigint,jsonb)'
  ) is not null and position(
    'reverse_pending_invoice_journal_before_support_integrity' in
    pg_get_functiondef(
      'public.reverse_pending_invoice_journal(bigint,jsonb)'::regprocedure
    )
  )=0 then
    raise exception
      'La función pública de reversión cambió después de instalar el límite de respaldos. Revise la cadena antes de reaplicar esta migración.';
  end if;

  if to_regprocedure(
    'public.reverse_opening_pending_invoice_before_support_integrity(bigint,jsonb)'
  ) is null then
    alter function public.reverse_opening_pending_invoice(bigint,jsonb)
      rename to reverse_opening_pending_invoice_before_support_integrity;
  elsif to_regprocedure(
    'public.reverse_opening_pending_invoice(bigint,jsonb)'
  ) is not null and position(
    'reverse_opening_pending_invoice_before_support_integrity' in
    pg_get_functiondef(
      'public.reverse_opening_pending_invoice(bigint,jsonb)'::regprocedure
    )
  )=0 then
    raise exception
      'La función pública de reversión de apertura cambió después de instalar el límite de respaldos. Revise la cadena antes de reaplicar esta migración.';
  end if;
end
$$;

revoke all on function
  public.reverse_pending_invoice_journal_before_support_integrity(bigint,jsonb)
from public,anon,authenticated;

revoke all on function
  public.reverse_opening_pending_invoice_before_support_integrity(bigint,jsonb)
from public,anon,authenticated;

create or replace function public.save_pending_reversal_supports(
  p_journal_id bigint,
  p_supports jsonb
) returns void
language plpgsql
security definer
set search_path=public,pg_temp
as $$
declare
  support jsonb;
begin
  if jsonb_array_length(p_supports)=0 then
    return;
  end if;
  if exists(
    select 1 from public.journal_support where journal_id=p_journal_id
  ) then
    raise exception
      'La reversión delegada guardó respaldos inesperados; se canceló para evitar duplicados.';
  end if;

  for support in select value from jsonb_array_elements(p_supports) loop
    if support->>'support_type'='Enlace' then
      insert into public.journal_support(
        journal_id,support_type,display_name,support_url
      ) values(
        p_journal_id,'Enlace',support->>'display_name',support->>'support_url'
      );
    else
      insert into public.journal_support(
        journal_id,support_type,display_name,file_name,mime_type,file_size,file_data
      ) values(
        p_journal_id,'Archivo',support->>'display_name',support->>'file_name',
        coalesce(nullif(support->>'mime_type',''),'application/octet-stream'),
        (support->>'file_size')::bigint,support->>'file_data'
      );
    end if;
  end loop;
end
$$;

revoke all on function public.save_pending_reversal_supports(bigint,jsonb)
  from public,anon,authenticated;

create or replace function public.reverse_pending_invoice_journal(
  p_journal_id bigint,
  p_payload jsonb
) returns jsonb
language plpgsql
security definer
set search_path=public,pg_temp
as $$
declare
  supports jsonb;
  result jsonb;
  reversal_key bigint;
begin
  if not exists(
    select 1
    from public.user_roles ur
    join public.role_permissions rp using(role_id)
    join public.permissions p using(permission_id)
    where ur.user_id=public.app_user_id()
      and p.code='accounting:journal:reverse'
  ) then
    raise exception using
      errcode='42501',
      message='No tiene permiso para reversar asientos.';
  end if;

  supports:=public.validate_pending_reversal_supports(p_payload);
  result:=public.reverse_pending_invoice_journal_before_support_integrity(
    p_journal_id,p_payload-'supports'
  );
  reversal_key:=nullif(result->>'journalId','')::bigint;
  if reversal_key is null then
    raise exception 'La reversión no devolvió el asiento contable generado.';
  end if;

  perform public.save_pending_reversal_supports(reversal_key,supports);

  return result;
end
$$;

create or replace function public.reverse_opening_pending_invoice(
  p_item_id bigint,
  p_payload jsonb
) returns jsonb
language plpgsql
security definer
set search_path=public,pg_temp
as $$
declare
  supports jsonb;
  result jsonb;
  reversal_key bigint;
begin
  if not exists(
    select 1
    from public.user_roles ur
    join public.role_permissions rp using(role_id)
    join public.permissions p using(permission_id)
    where ur.user_id=public.app_user_id()
      and p.code='accounting:journal:reverse'
  ) then
    raise exception using
      errcode='42501',
      message='No tiene permiso para reversar asientos.';
  end if;

  supports:=public.validate_pending_reversal_supports(p_payload);
  result:=public.reverse_opening_pending_invoice_before_support_integrity(
    p_item_id,p_payload-'supports'
  );
  reversal_key:=nullif(result->>'journalId','')::bigint;
  if reversal_key is null then
    raise exception 'La reversión no devolvió el asiento contable generado.';
  end if;

  perform public.save_pending_reversal_supports(reversal_key,supports);
  return result;
end
$$;

revoke all on function public.reverse_pending_invoice_journal(bigint,jsonb)
  from public,anon;
grant execute on function public.reverse_pending_invoice_journal(bigint,jsonb)
  to authenticated;

revoke all on function public.reverse_opening_pending_invoice(bigint,jsonb)
  from public,anon;
grant execute on function public.reverse_opening_pending_invoice(bigint,jsonb)
  to authenticated;

notify pgrst,'reload schema';
