-- Migración delimitada autorizada por el usuario: ASI_UTI.
lock table public.transaction_types,public.number_sequences in access exclusive mode;
alter table public.transaction_types disable trigger transaction_type_boundary_guard;
insert into public.transaction_types(code,abbreviation,name,module_category,description)
select 'TT-'||lpad((coalesce(max(substring(code from '[0-9]+$')::bigint),0)+1)::text,8,'0'),'ASI_UTI','Asiento Utilidades','Contabilidad','Registro contable manual de utilidades.' from public.transaction_types
on conflict(abbreviation) do nothing;
alter table public.transaction_types enable trigger transaction_type_boundary_guard;
alter table public.number_sequences disable trigger sequence_boundary_guard;
insert into public.number_sequences(scope_type,transaction_type_id,subsidiary_id,prefix,current_number,padding_length,allow_manual_update)
select 'Transacción',t.transaction_type_id,s.subsidiary_id,'ASI_UTI-',0,8,false
from public.transaction_types t cross join public.subsidiaries s where t.abbreviation='ASI_UTI'
on conflict(transaction_type_id,subsidiary_id) where scope_type='Transacción' do nothing;
alter table public.number_sequences enable trigger sequence_boundary_guard;
CREATE OR REPLACE FUNCTION public.automatic_journal_service_month(p_journal_id bigint)
 RETURNS text
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  select case
    when type_by_name.abbreviation in('ASI_DIA','ASI_NOM','ASI_LIQ','ASI_UTI')
      or(
        type_by_name.abbreviation is null
        and entry.journal_number ~ '^ASI_(DIA|NOM|LIQ|UTI)-'
      )
    then to_char(entry.journal_date,'YYYY-MM')
  end
  from public.journal entry
  left join lateral(
    select configured_type.abbreviation
    from public.transaction_types configured_type
    where configured_type.name=entry.journal_type
    order by configured_type.transaction_type_id
    limit 1
  )type_by_name on true
  where entry.journal_id=p_journal_id
$function$
;

CREATE OR REPLACE FUNCTION public.import_journal_csv_before_automatic_service_month(p_rows jsonb, p_preview boolean, p_subsidiary_id bigint)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  sid bigint:=public.active_subsidiary_id();
  local_currency bigint;
  file_fingerprint text;
  resolved_digest text;
  previous jsonb;
  batch jsonb:='[]';
  summary jsonb:='[]';
  errors jsonb:='[]';
  grp record;
  first_row jsonb;
  item jsonb;
  row_number integer;
  lines jsonb;
  journal_type_name text;
  journal_date_value date;
  currency bigint;
  period bigint;
  rate numeric;
  aid bigint;
  matches integer;
  debit numeric;
  credit numeric;
  td numeric;
  tc numeric;
  jid bigint;
  saved_number text;
  entry jsonb;
begin
  if sid is null or p_subsidiary_id is distinct from sid then
    raise exception 'La subsidiaria activa cambió. Vuelva a abrir la importación.';
  end if;
  if p_preview is null or jsonb_typeof(p_rows) is distinct from 'array' then
    raise exception 'El lote no es válido.';
  end if;
  if jsonb_array_length(p_rows) not between 1 and 2000 then
    raise exception 'El archivo debe contener entre 1 y 2000 líneas.';
  end if;
  if exists(
    select 1
    from jsonb_array_elements(p_rows) row_value
    where coalesce(btrim(row_value->>'asiento_referencia'),'')=''
  ) then
    raise exception 'Todas las líneas requieren asiento_referencia.';
  end if;
  if (
    select count(distinct row_value->>'asiento_referencia')
    from jsonb_array_elements(p_rows) row_value
  )>200 then
    raise exception 'Se admiten hasta 200 asientos por archivo.';
  end if;

  file_fingerprint:=md5(p_rows::text);
  perform pg_advisory_xact_lock(hashtextextended('journal_csv:'||sid||':'||file_fingerprint,0));
  select import_log.result
  into previous
  from public.journal_csv_imports import_log
  where import_log.subsidiary_id=sid
    and import_log.fingerprint=file_fingerprint;
  if previous is not null then
    return previous||jsonb_build_object('alreadyImported',true);
  end if;

  select subsidiary.currency_id
  into local_currency
  from public.subsidiaries subsidiary
  where subsidiary.subsidiary_id=sid;

  for grp in
    select row_value->>'asiento_referencia' reference,
      jsonb_agg(row_value order by ordinal) rows,
      min(ordinal) first_number
    from jsonb_array_elements(p_rows) with ordinality source(row_value,ordinal)
    group by row_value->>'asiento_referencia'
    order by min(ordinal)
  loop
    row_number:=grp.first_number+1;
    begin
      first_row:=grp.rows->0;
      lines:='[]';
      td:=0;
      tc:=0;

      if jsonb_array_length(grp.rows)<2 then
        raise exception 'El asiento requiere al menos dos líneas.';
      end if;
      if coalesce(first_row->>'tipo_asiento','') not in ('ASI_DIA','ASI_PEN','ASI_NOM','ASI_LIQ','ASI_UTI') then
        raise exception 'Tipo de asiento no permitido.';
      end if;
      select transaction_type.name
      into journal_type_name
      from public.transaction_types transaction_type
      where transaction_type.abbreviation=first_row->>'tipo_asiento';
      if journal_type_name is null then
        raise exception 'El tipo de asiento no está configurado.';
      end if;

      if coalesce(first_row->>'fecha','') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then
        raise exception 'La fecha debe tener formato AAAA-MM-DD.';
      end if;
      journal_date_value:=(first_row->>'fecha')::date;
      select fiscal_period.fiscal_period_id
      into period
      from public.fiscal_periods fiscal_period
      where fiscal_period.subsidiary_id=sid
        and journal_date_value between fiscal_period.start_date and fiscal_period.end_date
        and not coalesce(fiscal_period.is_inactive,false)
      order by fiscal_period.start_date desc
      limit 1;
      if period is null then
        raise exception 'No existe un período contable activo para la fecha.';
      end if;

      select currency_catalog.currency_id
      into currency
      from public.currencies currency_catalog
      where currency_catalog.currency_code=first_row->>'moneda'
        and (
          currency_catalog.currency_id=local_currency
          or exists(
            select 1
            from public.subsidiary_currencies allowed_currency
            where allowed_currency.subsidiary_id=sid
              and allowed_currency.currency_id=currency_catalog.currency_id
          )
        );
      if currency is null then
        raise exception 'La moneda no está permitida para la subsidiaria.';
      end if;

      if coalesce(first_row->>'tipo_cambio','') !~ '^[0-9]{1,12}(\.[0-9]{1,10})?$' then
        raise exception 'La tasa automática no puede representarse con diez decimales. Revise el catálogo.';
      end if;
      rate:=(first_row->>'tipo_cambio')::numeric;
      if rate<=0 then
        raise exception 'Tipo de cambio inválido: debe ser mayor que cero.';
      end if;

      for item,row_number in
        select row_value,ordinal::integer+1
        from jsonb_array_elements(p_rows) with ordinality source(row_value,ordinal)
        where row_value->>'asiento_referencia'=grp.reference
        order by ordinal
      loop
        if exists(
          select 1
          from unnest(array['tipo_asiento','fecha','moneda','tipo_cambio','nota_asiento']) header_key
          where item->>header_key is distinct from first_row->>header_key
        ) then
          raise exception 'Los datos de encabezado deben coincidir en todas las líneas del asiento.';
        end if;

        select count(*),min(account.account_id)
        into matches,aid
        from public.chart_accounts account
        where account.account_number=item->>'numero_cuenta'
          and not coalesce(account.is_inactive,false)
          and coalesce(account.accepts_entries,true)
          and exists(
            select 1
            from public.account_subsidiaries account_scope
            where account_scope.account_id=account.account_id
              and account_scope.subsidiary_id=sid
              and account_scope.is_active
          );
        if matches<>1 then
          raise exception 'Cuenta % inexistente, ambigua, inactiva o no habilitada para la subsidiaria.',item->>'numero_cuenta';
        end if;

        if coalesce(nullif(item->>'debito',''),'0') !~ '^[0-9]{1,12}(\.[0-9]{1,6})?$'
          or coalesce(nullif(item->>'credito',''),'0') !~ '^[0-9]{1,12}(\.[0-9]{1,6})?$' then
          raise exception 'Débito/crédito inválido: use importes positivos con punto decimal y hasta seis decimales.';
        end if;
        debit:=coalesce(nullif(item->>'debito',''),'0')::numeric;
        credit:=coalesce(nullif(item->>'credito',''),'0')::numeric;
        if (debit>0)=(credit>0) then
          raise exception 'Complete solo débito o crédito, con un importe mayor que cero.';
        end if;
        if coalesce(item->>'mes_servicio','')<>'' and (
          first_row->>'tipo_asiento'<>'ASI_PEN'
          or item->>'mes_servicio' !~ '^[0-9]{4}-(0[1-9]|1[0-2])$'
        ) then
          raise exception 'Mes de servicio: use AAAA-MM únicamente para ASI_PEN.';
        end if;

        td:=td+debit;
        tc:=tc+credit;
        lines:=lines||jsonb_build_array(
          jsonb_build_object(
            'account_id',aid,
            'debit',debit,
            'credit',credit,
            'note',item->>'nota_linea',
            'service_month',nullif(item->>'mes_servicio','')
          ) || public.journal_csv_dimensions(item)
        );
      end loop;

      if td<>tc then
        raise exception 'Asiento desbalanceado: débitos %, créditos %.',td,tc;
      end if;
      batch:=batch||jsonb_build_array(jsonb_build_object(
        'reference',grp.reference,
        'payload',jsonb_build_object(
          'journal_type',journal_type_name,
          'journal_date',journal_date_value,
          'currency_id',currency,
          'fiscal_period_id',period,
          'exchange_rate',rate,
          'memo',first_row->>'nota_asiento',
          'lines',lines
        )
      ));
      perform journal_entry_private.validate_payload(batch->(jsonb_array_length(batch)-1)->'payload',sid);
      summary:=summary||jsonb_build_array(jsonb_build_object(
        'reference',grp.reference,
        'date',journal_date_value,
        'currency',first_row->>'moneda',
        'exchangeRate',rate,
        'lines',jsonb_array_length(lines),
        'debit',td,
        'credit',tc
      ));
    exception when others then
      errors:=errors||jsonb_build_array(jsonb_build_object(
        'reference',grp.reference,
        'row',row_number,
        'message',sqlerrm
      ));
    end;
  end loop;

  if jsonb_array_length(errors)>0 then
    return jsonb_build_object('valid',false,'created',0,'errors',errors,'entries',summary);
  end if;
  resolved_digest:=encode(sha256(convert_to(jsonb_build_object(
    'batch',batch,'localAmounts',(select jsonb_agg(jsonb_build_object('reference',b->>'reference','lines',
      (select jsonb_agg(jsonb_build_array(round((l->>'debit')::numeric*(b->'payload'->>'exchange_rate')::numeric,6),round((l->>'credit')::numeric*(b->'payload'->>'exchange_rate')::numeric,6))order by ln)
       from jsonb_array_elements(b->'payload'->'lines')with ordinality z(l,ln)))order by bn)
      from jsonb_array_elements(batch)with ordinality z(b,bn)))::text,'UTF8')),'hex');
  if p_preview then
    return jsonb_build_object('valid',true,'created',0,'entries',summary,'errors','[]'::jsonb,'resolvedDigest',resolved_digest);
  end if;
  if nullif(current_setting('nexo.journal_csv_expected_digest',true),'')is distinct from resolved_digest then
    raise exception using errcode='55000',message='La validación del asiento cambió. Valide nuevamente antes de importar.';
  end if;

  summary:='[]';
  for entry in select value from jsonb_array_elements(batch)
  loop
    begin
      jid:=public.create_journal_entry(entry->'payload');
    exception when others then
      raise exception 'Asiento %: %. No se guardó ningún asiento del lote.',entry->>'reference',sqlerrm;
    end;
    select journal_entry.journal_number
    into saved_number
    from public.journal journal_entry
    where journal_entry.journal_id=jid;
    summary:=summary||jsonb_build_array(jsonb_build_object(
      'reference',entry->>'reference',
      'journalId',jid,
      'journalNumber',saved_number
    ));
  end loop;

  previous:=jsonb_build_object(
    'valid',true,
    'created',jsonb_array_length(summary),
    'entries',summary,
    'errors','[]'::jsonb,
    'alreadyImported',false
  );
  insert into public.journal_csv_imports(subsidiary_id,fingerprint,result)
  values(sid,file_fingerprint,previous);
  return previous;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.import_journal_csv_before_lookup_cache(p_rows jsonb, p_preview boolean, p_subsidiary_id bigint)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  normalized_rows jsonb:=p_rows;
begin
  if jsonb_typeof(p_rows)='array' then
    select coalesce(jsonb_agg(
      case
        when row_value->>'tipo_asiento' in('ASI_DIA','ASI_NOM','ASI_LIQ','ASI_UTI')
        then (row_value-'pais_servicio')
          ||jsonb_build_object('mes_servicio','')
        else row_value
      end
      order by ordinal
    ),'[]'::jsonb)
    into normalized_rows
    from jsonb_array_elements(p_rows) with ordinality source(row_value,ordinal);
  end if;

  return public.import_journal_csv_before_automatic_service_month(
    normalized_rows,p_preview,p_subsidiary_id
  );
end
$function$
;

CREATE OR REPLACE FUNCTION public.reverse_journal_entry(target_journal_id bigint)
 RETURNS bigint
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
declare sid bigint;r public.journal;
begin
 sid:=journal_entry_private.assert_access('edit');
 if not exists(select 1 from public.user_roles ur join public.role_permissions rp using(role_id)
   join public.permissions p using(permission_id) where ur.user_id=public.app_user_id()
   and ur.role_id=public.app_active_role_id() and p.code='accounting:journal:reverse') then
  raise exception using errcode='42501',message='El rol activo no tiene permiso técnico para reversar asientos.';
 end if;
 select * into r from public.journal where journal_id=target_journal_id and subsidiary_id=sid for update;
 if not found then raise exception using errcode='42501',message='El asiento no está disponible en la subsidiaria activa.';end if;
 if r.status is distinct from 'CONTABILIZADO' or not exists(select 1 from public.transaction_types t
   where t.name=r.journal_type and t.abbreviation in('ASI_DIA','ASI_NOM','ASI_LIQ','ASI_UTI')) then
  raise exception using errcode='55000',message='Utilice el proceso de origen para reversar pendientes, asientos automáticos o tipos históricos no identificados.';
 end if;
 if not exists(select 1 from public.fiscal_periods f where f.fiscal_period_id=r.fiscal_period_id and f.subsidiary_id=sid
   and not coalesce(f.is_closed,false) and not coalesce(f.gl_closed,false) and not coalesce(f.is_inactive,false)) then
  raise exception using errcode='55000',message='El período original del asiento está cerrado o inactivo.';
 end if;
 return journal_entry_private.reverse_journal_entry(target_journal_id);
end$function$
;

CREATE OR REPLACE FUNCTION public.sync_journal_transaction()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  tt bigint;
  st bigint;
  tid bigint;
  type_abbreviation text;
begin
  if tg_op='UPDATE'
    and current_user='postgres'
    and coalesce(current_setting('app.pending_reclassification_internal',true),'')='1'
    and(old.pending_period_type is distinct from new.pending_period_type
      or old.pending_origin_journal_id is distinct from new.pending_origin_journal_id)
    and(to_jsonb(new)-array['pending_period_type','pending_origin_journal_id'])
      =(to_jsonb(old)-array['pending_period_type','pending_origin_journal_id']) then
    return new;
  end if;

  -- A controlled pending reversal only updates the operational balance of
  -- its source.  Do not rewrite the historical transaction behind it.
  if tg_op='UPDATE'
    and coalesce(current_setting('app.pending_reversal_write',true),'')='1'
    and(old.pending_initial_local is distinct from new.pending_initial_local
      or old.pending_initial_foreign is distinct from new.pending_initial_foreign
      or old.pending_reversed_local is distinct from new.pending_reversed_local
      or old.pending_reversed_foreign is distinct from new.pending_reversed_foreign
      or old.pending_balance_local is distinct from new.pending_balance_local
      or old.pending_balance_foreign is distinct from new.pending_balance_foreign
      or old.reversal_status is distinct from new.reversal_status)
    and(to_jsonb(new)-array[
      'pending_initial_local','pending_initial_foreign',
      'pending_reversed_local','pending_reversed_foreign',
      'pending_balance_local','pending_balance_foreign','reversal_status'
    ])=(to_jsonb(old)-array[
      'pending_initial_local','pending_initial_foreign',
      'pending_reversed_local','pending_reversed_foreign',
      'pending_balance_local','pending_balance_foreign','reversal_status'
    ]) then
    return new;
  end if;

  type_abbreviation:=case new.journal_type
    when 'Asientos Pendientes de Facturar' then 'ASI_PEN'
    when 'Asiento de Nóminas' then 'ASI_NOM'
    when 'Asiento de Liquidación' then 'ASI_LIQ'
 when 'Asiento Utilidades' then 'ASI_UTI'
    when 'Reclasificación Anual de Pendientes de Facturar' then 'ASI_RECL_PEN'
    else 'ASI_DIA'
  end;

  select transaction_type_id into tt
  from public.transaction_types
  where abbreviation=type_abbreviation
  limit 1;

  select status_id into st
  from public.status
  where code='APROBADO' and module='Transacciones'
  limit 1;

  if tt is null then raise exception 'No existe el tipo de transacción %.',type_abbreviation;end if;
  if st is null then select status_id into st from public.status order by status_id limit 1;end if;

  if new.transaction_id is null then
    insert into public."transaction"(
      tran_number,tran_date,transaction_type_id,subsidiary_id,currency_id,
      exchange_rate,fiscal_period_id,total_amount,status_id
    )values(
      new.journal_number,new.journal_date,tt,new.subsidiary_id,new.currency_id,
      new.exchange_rate,new.fiscal_period_id,
      greatest(coalesce(new.total_debit,0),coalesce(new.total_credit,0)),st
    )
    on conflict(tran_number)do update set
      tran_date=excluded.tran_date,
      transaction_type_id=excluded.transaction_type_id,
      subsidiary_id=excluded.subsidiary_id,
      currency_id=excluded.currency_id,
      exchange_rate=excluded.exchange_rate,
      fiscal_period_id=excluded.fiscal_period_id,
      total_amount=excluded.total_amount,
      status_id=excluded.status_id
    returning transaction_id into tid;
    new.transaction_id:=tid;
  else
    update public."transaction" set
      tran_date=new.journal_date,
      subsidiary_id=new.subsidiary_id,
      currency_id=new.currency_id,
      exchange_rate=new.exchange_rate,
      fiscal_period_id=new.fiscal_period_id,
      total_amount=greatest(coalesce(new.total_debit,0),coalesce(new.total_credit,0)),
      status_id=st
    where transaction_id=new.transaction_id;
  end if;
  return new;
end
$function$
;

CREATE OR REPLACE FUNCTION public.update_journal_entry(target_journal_id bigint, payload jsonb)
 RETURNS bigint
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
declare sid bigint;r public.journal;
begin
 sid:=journal_entry_private.assert_access('edit');
 select * into r from public.journal where journal_id=target_journal_id and subsidiary_id=sid for update;
 if not found then raise exception using errcode='42501',message='El asiento no está disponible en la subsidiaria activa.';end if;
 if r.status is null or r.status not in('CONTABILIZADO','BORRADOR') or not exists(
   select 1 from public.transaction_types t where t.name=r.journal_type and t.abbreviation in('ASI_DIA','ASI_PEN','ASI_NOM','ASI_LIQ','ASI_UTI')) then
  raise exception using errcode='55000',message='Utilice el proceso de origen para modificar asientos automáticos, anulados o tipos históricos no identificados.';
 end if;
 if not exists(select 1 from public.fiscal_periods f where f.fiscal_period_id=r.fiscal_period_id and f.subsidiary_id=sid
   and not coalesce(f.is_closed,false) and not coalesce(f.gl_closed,false) and not coalesce(f.is_inactive,false)) then
  raise exception using errcode='55000',message='El período original del asiento está cerrado o inactivo.';
 end if;
 perform journal_entry_private.validate_payload(payload,sid);
 return journal_entry_private.update_journal_entry(target_journal_id,payload);
end$function$
;

CREATE OR REPLACE FUNCTION sequence_security_private.runtime_manual_journal_next(journal_kind text, sid bigint)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare abbreviation_value text:=case journal_kind
 when 'Asientos Pendientes de Facturar' then 'ASI_PEN'
 when 'Asiento de Nóminas' then 'ASI_NOM'
 when 'Asiento de Liquidación' then 'ASI_LIQ'
 when 'Asiento Utilidades' then 'ASI_UTI'
 else 'ASI_DIA' end; tt bigint; result text; last_used bigint;
begin
 perform pg_advisory_xact_lock(hashtextextended('manual-journal-number:'||abbreviation_value,0));
 select transaction_type_id into tt from transaction_types where abbreviation=abbreviation_value;
 if tt is null then raise exception 'No existe el tipo de asiento %.',abbreviation_value; end if;
 select coalesce(max(substring(n from '[0-9]+$')::bigint),0) into last_used
 from (select journal_number n from journal union all select tran_number from "transaction") numbers
 where n ~ ('^'||abbreviation_value||'-[0-9]+$');
 insert into number_sequences(scope_type,transaction_type_id,subsidiary_id,prefix,current_number,padding_length)
 values('Transacción',tt,sid,abbreviation_value||'-',last_used,8)
 on conflict(transaction_type_id,subsidiary_id) where scope_type='Transacción' do nothing;
 loop
   result:=next_transaction_number(tt,sid);
   exit when not exists(select 1 from journal where journal_number=result)
     and not exists(select 1 from "transaction" where tran_number=result);
 end loop;
 return result;
end $function$
;

CREATE OR REPLACE FUNCTION journal_entry_private.form_context(p_journal_id bigint)
 RETURNS bigint
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
declare sid bigint;
begin
 sid:=journal_entry_private.assert_access(case when p_journal_id is null then 'create' else 'edit' end);
 if p_journal_id is not null then
  if p_journal_id<=0 then raise exception using errcode='22023',message='Seleccione un asiento válido.';end if;
  if not exists(select 1 from public.journal j where j.journal_id=p_journal_id and j.subsidiary_id=sid
    and j.status in('CONTABILIZADO','BORRADOR') and exists(select 1 from public.transaction_types t
      where t.name=j.journal_type and t.abbreviation in('ASI_DIA','ASI_PEN','ASI_NOM','ASI_LIQ','ASI_UTI'))) then
   raise exception using errcode='42501',message='El asiento manual no está disponible en la subsidiaria activa.';
  end if;
 end if;
 return sid;
end$function$
;

CREATE OR REPLACE FUNCTION journal_entry_private.form_options(p_section text, p_journal_id bigint DEFAULT NULL::bigint)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
declare sid bigint;country bigint;local_currency bigint;result jsonb;
begin
 sid:=journal_entry_private.form_context(p_journal_id);
 if p_section is null or p_section not in('header','lines') then
  raise exception using errcode='22023',message='Seleccione una sección válida del formulario.';
 end if;
 select s.country_id,s.currency_id into country,local_currency from public.subsidiaries s where s.subsidiary_id=sid;
 if p_section='header' then
  select jsonb_build_object(
   'transactionTypes',coalesce((select jsonb_agg(jsonb_build_object('transaction_type_id',t.transaction_type_id,
     'abbreviation',t.abbreviation,'name',t.name) order by case t.abbreviation when 'ASI_DIA' then 1 when 'ASI_PEN' then 2 when 'ASI_NOM' then 3 else 4 end)
     from public.transaction_types t where t.abbreviation in('ASI_DIA','ASI_PEN','ASI_NOM','ASI_LIQ','ASI_UTI')),'[]'::jsonb),
   'subsidiaries',coalesce((select jsonb_agg(jsonb_build_object('subsidiary_id',s.subsidiary_id,'name',s.name,
     'country_id',s.country_id,'currency_id',s.currency_id,'allowed_currency_ids',coalesce((select jsonb_agg(sc.currency_id order by sc.currency_id)
       from public.subsidiary_currencies sc where sc.subsidiary_id=sid),'[]'::jsonb))) from public.subsidiaries s where s.subsidiary_id=sid),'[]'::jsonb),
   'locations',coalesce((select jsonb_agg(jsonb_build_object('location_id',l.location_id,'name',l.name,'subsidiary_ids',jsonb_build_array(sid)) order by l.name,l.location_id)
     from public.locations l where exists(select 1 from public.location_subsidiaries ls where ls.location_id=l.location_id and ls.subsidiary_id=sid)),'[]'::jsonb),
   'currencies',coalesce((select jsonb_agg(jsonb_build_object('currency_id',c.currency_id,'currency_code',c.currency_code,'name',c.name) order by c.currency_code,c.currency_id)
     from public.currencies c where c.currency_id=local_currency or exists(select 1 from public.subsidiary_currencies sc where sc.subsidiary_id=sid and sc.currency_id=c.currency_id)),'[]'::jsonb),
   'periods',coalesce((select jsonb_agg(jsonb_build_object('fiscal_period_id',f.fiscal_period_id,'period_name',f.period_name,
     'subsidiary_id',f.subsidiary_id,'start_date',f.start_date,'end_date',f.end_date,'is_inactive',f.is_inactive,'is_closed',f.is_closed,'gl_closed',f.gl_closed) order by f.start_date,f.fiscal_period_id)
     from public.fiscal_periods f where f.subsidiary_id=sid),'[]'::jsonb),
   'rates',coalesce((select jsonb_agg(jsonb_build_object('exchange_rate_id',r.exchange_rate_id,'from_currency_id',r.from_currency_id,
     'to_currency_id',r.to_currency_id,'effective_date',r.effective_date,'spot_rate',r.spot_rate) order by r.effective_date,r.exchange_rate_id)
     from public.exchange_rates r where r.to_currency_id=local_currency and (r.from_currency_id=local_currency or exists(
       select 1 from public.subsidiary_currencies sc where sc.subsidiary_id=sid and sc.currency_id=r.from_currency_id))),'[]'::jsonb)
  ) into result;
 else
  select jsonb_build_object(
   'accounts',coalesce((select jsonb_agg(jsonb_build_object('account_id',a.account_id,'account_number',a.account_number,
     'account_name',a.account_name,'is_inactive',a.is_inactive,'accepts_entries',a.accepts_entries,'subsidiary_ids',jsonb_build_array(sid)) order by a.account_number,a.account_id)
     from public.chart_accounts a where not coalesce(a.is_inactive,false) and not coalesce(a.is_summary,false) and coalesce(a.accepts_entries,true)
       and exists(select 1 from public.account_subsidiaries scope where scope.account_id=a.account_id and scope.subsidiary_id=sid and scope.is_active)),'[]'::jsonb),
   'taxes',coalesce((select jsonb_agg(jsonb_build_object('tax_code_id',t.tax_code_id,'code_name',t.code_name,'rate_percentage',t.rate_percentage,
     'tax_type_id',t.tax_type_id,'subsidiary_id',t.subsidiary_id) order by t.code_name,t.tax_code_id) from public.tax_codes t
     where t.subsidiary_id=sid or (t.subsidiary_id is null and (t.country_id is null or t.country_id=country))),'[]'::jsonb),
   'taxTypes',coalesce((select jsonb_agg(jsonb_build_object('tax_type_id',t.tax_type_id,'asset_account_id',t.asset_account_id,
     'liability_account_id',t.liability_account_id) order by t.tax_type_id) from public.tax_types t where exists(select 1 from public.tax_codes c
       where c.tax_type_id=t.tax_type_id and (c.subsidiary_id=sid or (c.subsidiary_id is null and (c.country_id is null or c.country_id=country))))),'[]'::jsonb),
   'departments',coalesce((select jsonb_agg(jsonb_build_object('department_id',d.department_id,'name',d.name,'type',d.type,'subsidiary_ids',jsonb_build_array(sid)) order by d.name,d.department_id)
     from public.departments d where not coalesce(d.is_inactive,false) and exists(select 1 from public.department_subsidiaries scope where scope.department_id=d.department_id and scope.subsidiary_id=sid)),'[]'::jsonb),
   'classes',coalesce((select jsonb_agg(jsonb_build_object('class_id',c.class_id,'name',c.name,'subsidiary_ids',jsonb_build_array(sid)) order by c.name,c.class_id)
     from public.classes c where not coalesce(c.is_inactive,false) and exists(select 1 from public.class_subsidiaries scope where scope.class_id=c.class_id and scope.subsidiary_id=sid)),'[]'::jsonb),
   'costs',coalesce((select jsonb_agg(jsonb_build_object('cost_center_id',c.cost_center_id,'name',c.name,'customer_id',c.customer_id,
     'class_id',c.class_id,'subsidiary_id',c.subsidiary_id) order by c.name,c.cost_center_id) from public.cost_centers c where c.subsidiary_id=sid and not coalesce(c.is_inactive,false)),'[]'::jsonb),
   'creditors',coalesce((select jsonb_agg(jsonb_build_object('financial_creditor_id',c.financial_creditor_id,'name',c.name,'subsidiary_ids',jsonb_build_array(sid)) order by c.name,c.financial_creditor_id)
     from public.financial_creditors c where not coalesce(c.is_inactive,false) and exists(select 1 from public.financial_creditor_subsidiaries scope where scope.financial_creditor_id=c.financial_creditor_id and scope.subsidiary_id=sid)),'[]'::jsonb),
   'related',coalesce((select jsonb_agg(jsonb_build_object('related_company_id',c.related_company_id,'name',c.name,'country_id',c.country_id,'subsidiary_ids',jsonb_build_array(sid)) order by c.name,c.related_company_id)
     from public.related_companies c where not coalesce(c.is_inactive,false) and exists(select 1 from public.related_company_subsidiaries scope where scope.related_company_id=c.related_company_id and scope.subsidiary_id=sid)),'[]'::jsonb),
   'customers',coalesce((select jsonb_agg(jsonb_build_object('customer_id',c.customer_id,'company_name',c.company_name,'department_id',c.department_id,'subsidiary_ids',jsonb_build_array(sid)) order by c.company_name,c.customer_id)
     from public.customers c where exists(select 1 from public.entity_subsidiaries scope where scope.customer_id=c.customer_id and scope.subsidiary_id=sid)),'[]'::jsonb),
   'suppliers',coalesce((select jsonb_agg(jsonb_build_object('supplier_id',s.supplier_id,'company_name',s.company_name,'subsidiary_ids',jsonb_build_array(sid)) order by s.company_name,s.supplier_id)
     from public.suppliers s where exists(select 1 from public.entity_subsidiaries scope where scope.supplier_id=s.supplier_id and scope.subsidiary_id=sid)),'[]'::jsonb),
   'employees',coalesce((select jsonb_agg(jsonb_build_object('employee_id',e.employee_id,'first_name',e.first_name,'last_name',e.last_name,'subsidiary_id',e.subsidiary_id) order by e.first_name,e.last_name,e.employee_id)
     from public.employees e where e.subsidiary_id=sid and e.is_active),'[]'::jsonb),
   'countries',coalesce((select jsonb_agg(jsonb_build_object('country_id',c.country_id,'name',c.name) order by c.name,c.country_id) from public.countries c),'[]'::jsonb)
  ) into result;
 end if;
 return result;
end$function$
;

CREATE OR REPLACE FUNCTION journal_entry_private.view_detail(p_journal_id bigint)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
declare sid bigint;j public.journal;result jsonb;
begin
 sid:=asset_posting_private.access('accounting:journals','view');
 if p_journal_id is null or p_journal_id<=0 then raise exception using errcode='22023',message='Seleccione un asiento vÃ¡lido.';end if;
 select * into j from public.journal where journal_id=p_journal_id and subsidiary_id=sid;
 if not found then raise exception using errcode='42501',message='Asiento no disponible en la empresa activa.';end if;
 result:=jsonb_build_object('journals',jsonb_build_array(to_jsonb(j)),
 'access',jsonb_build_object('canEdit',asset_posting_private.allowed('accounting:journals','edit') and exists(select 1 from public.transaction_types t where t.name=j.journal_type and t.abbreviation in('ASI_DIA','ASI_PEN','ASI_NOM','ASI_LIQ','ASI_UTI'))),
 'lines',(select coalesce(jsonb_agg(to_jsonb(l) order by l.journal_line_id),'[]') from public.journal_line l where l.journal_id=j.journal_id),
 'impacts',(select coalesce(jsonb_agg(jsonb_build_object('transaction_id',g.transaction_id,'account_id',g.account_id,'debit_amount',g.debit_amount,'credit_amount',g.credit_amount,'posting_date',g.posting_date) order by g.gl_impact_id),'[]') from public.gl_impact g where g.transaction_id=j.transaction_id and g.subsidiary_id=sid));
 result:=result||jsonb_build_object('accounts',(select coalesce(jsonb_agg(jsonb_build_object('account_id',t.account_id,'account_number',t.account_number,'account_name',t.account_name) order by t.account_id),'[]') from public.chart_accounts t where t.account_id in(select account_id from public.journal_line where journal_id=j.journal_id union select account_id from public.gl_impact where transaction_id=j.transaction_id and subsidiary_id=sid)));
 result:=result||jsonb_build_object('currencies',(select coalesce(jsonb_agg(jsonb_build_object('currency_id',t.currency_id,'name',t.currency_code) order by t.currency_id),'[]') from public.currencies t where t.currency_id=j.currency_id));
 result:=result||jsonb_build_object('periods',(select coalesce(jsonb_agg(jsonb_build_object('fiscal_period_id',t.fiscal_period_id,'period_name',t.period_name) order by t.fiscal_period_id),'[]') from public.fiscal_periods t where t.fiscal_period_id=j.fiscal_period_id));
 result:=result||jsonb_build_object('subsidiaries',(select coalesce(jsonb_agg(jsonb_build_object('subsidiary_id',t.subsidiary_id,'name',t.name) order by t.subsidiary_id),'[]') from public.subsidiaries t where t.subsidiary_id=sid));
 result:=result||jsonb_build_object('locations',(select coalesce(jsonb_agg(jsonb_build_object('location_id',t.location_id,'name',t.name) order by t.location_id),'[]') from public.locations t where t.location_id=j.location_id));
 result:=result||jsonb_build_object('departments',(select coalesce(jsonb_agg(jsonb_build_object('department_id',t.department_id,'name',t.name) order by t.department_id),'[]') from public.departments t where exists(select 1 from public.journal_line l where l.journal_id=j.journal_id and l.department_id=t.department_id)));
 result:=result||jsonb_build_object('classes',(select coalesce(jsonb_agg(jsonb_build_object('class_id',t.class_id,'name',t.name) order by t.class_id),'[]') from public.classes t where exists(select 1 from public.journal_line l where l.journal_id=j.journal_id and l.class_id=t.class_id)));
 result:=result||jsonb_build_object('costs',(select coalesce(jsonb_agg(jsonb_build_object('cost_center_id',t.cost_center_id,'name',t.name) order by t.cost_center_id),'[]') from public.cost_centers t where exists(select 1 from public.journal_line l where l.journal_id=j.journal_id and l.cost_center_id=t.cost_center_id)));
 result:=result||jsonb_build_object('taxes',(select coalesce(jsonb_agg(jsonb_build_object('tax_code_id',t.tax_code_id,'code_name',t.code_name) order by t.tax_code_id),'[]') from public.tax_codes t where exists(select 1 from public.journal_line l where l.journal_id=j.journal_id and l.tax_code_id=t.tax_code_id)));
 result:=result||jsonb_build_object('countries',(select coalesce(jsonb_agg(jsonb_build_object('country_id',t.country_id,'name',coalesce(to_jsonb(t)->>'name',to_jsonb(t)->>'country_name')) order by t.country_id),'[]') from public.countries t where exists(select 1 from public.journal_line l where l.journal_id=j.journal_id and l.service_country_id=t.country_id)));
 result:=result||jsonb_build_object('customers',(select coalesce(jsonb_agg(jsonb_build_object('customer_id',t.customer_id,'company_name',t.company_name) order by t.customer_id),'[]') from public.customers t where exists(select 1 from public.journal_line l where l.journal_id=j.journal_id and l.customer_id=t.customer_id)));
 result:=result||jsonb_build_object('suppliers',(select coalesce(jsonb_agg(jsonb_build_object('supplier_id',t.supplier_id,'company_name',t.company_name) order by t.supplier_id),'[]') from public.suppliers t where exists(select 1 from public.journal_line l where l.journal_id=j.journal_id and l.supplier_id=t.supplier_id)));
 result:=result||jsonb_build_object('employees',(select coalesce(jsonb_agg(jsonb_build_object('employee_id',t.employee_id,'first_name',t.first_name,'last_name',t.last_name) order by t.employee_id),'[]') from public.employees t where exists(select 1 from public.journal_line l where l.journal_id=j.journal_id and l.employee_id=t.employee_id)));
 result:=result||jsonb_build_object('otherNames',(select coalesce(jsonb_agg(jsonb_build_object('other_name_id',t.other_name_id,'name',coalesce(to_jsonb(t)->>'name',to_jsonb(t)->>'company_name')) order by t.other_name_id),'[]') from public.other_names t where exists(select 1 from public.journal_line l where l.journal_id=j.journal_id and l.other_name_id=t.other_name_id)));
 if asset_posting_private.allowed('accounting:journal-supports','view') then result:=result||jsonb_build_object('supports',(select coalesce(jsonb_agg(to_jsonb(s) order by s.support_id),'[]') from public.journal_support s where s.journal_id=j.journal_id));else result:=result||jsonb_build_object('supports','[]'::jsonb);end if;
 return result;
end$function$
;

CREATE OR REPLACE FUNCTION dashboard_private.events(p_sid bigint, p_start date, p_end date)
 RETURNS TABLE(source text, row_id bigint, day date, kind text, amount numeric, currency_id bigint, actor_id text, legacy_user_id bigint, actor_type text, transaction_id bigint, journal_id bigint, priority integer, opening boolean)
 LANGUAGE sql
 STABLE
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
select 'invoice'::text,a.invoice_id,a.invoice_date,'sales'::text,a.total_amount,a.currency_id,nullif(a.created_by_id::text,''),nullif(to_jsonb(a)->>'created_by','')::bigint,a.actor_type::text,a.transaction_id,a.journal_id,10,coalesce((to_jsonb(a)->>'is_opening_balance')::boolean,false) from public.invoice a  where a.subsidiary_id=p_sid and a.invoice_date>=p_start and a.invoice_date<p_end and lower(coalesce(to_jsonb(a)->>'status','')) not in('anulado','anulada','cancelado','cancelada','void','voided','cancelled','reversed')
union all
select 'supplier_invoice'::text,a.invoice_id,a.invoice_date,'purchases'::text,a.total_amount,a.currency_id,nullif(a.created_by_id::text,''),nullif(to_jsonb(a)->>'created_by','')::bigint,a.actor_type::text,a.transaction_id,a.journal_id,10,coalesce((to_jsonb(a)->>'is_opening_balance')::boolean,false) from public.supplier_invoice a  where a.subsidiary_id=p_sid and a.invoice_date>=p_start and a.invoice_date<p_end and lower(coalesce(to_jsonb(a)->>'status','')) not in('anulado','anulada','cancelado','cancelada','void','voided','cancelled','reversed')
union all
select 'credit_note'::text,a.cn_id,a.note_date,'other'::text,a.amount,a.currency_id,nullif(a.created_by_id::text,''),nullif(to_jsonb(a)->>'created_by','')::bigint,a.actor_type::text,a.transaction_id,a.journal_id,20,coalesce((to_jsonb(a)->>'is_opening_balance')::boolean,false) from public.credit_note a join public.invoice i on i.invoice_id=a.invoice_id where i.subsidiary_id=p_sid and a.note_date>=p_start and a.note_date<p_end and lower(coalesce(to_jsonb(a)->>'status','')) not in('anulado','anulada','cancelado','cancelada','void','voided','cancelled','reversed')
union all
select 'debit_note'::text,a.dn_id,a.note_date,'other'::text,a.amount,a.currency_id,nullif(a.created_by_id::text,''),nullif(to_jsonb(a)->>'created_by','')::bigint,a.actor_type::text,a.transaction_id,a.journal_id,20,coalesce((to_jsonb(a)->>'is_opening_balance')::boolean,false) from public.debit_note a join public.invoice i on i.invoice_id=a.invoice_id where i.subsidiary_id=p_sid and a.note_date>=p_start and a.note_date<p_end and lower(coalesce(to_jsonb(a)->>'status','')) not in('anulado','anulada','cancelado','cancelada','void','voided','cancelled','reversed')
union all
select 'supplier_credit_note'::text,a.cn_id,a.note_date,'other'::text,a.amount,a.currency_id,nullif(a.created_by_id::text,''),nullif(to_jsonb(a)->>'created_by','')::bigint,a.actor_type::text,a.transaction_id,a.journal_id,20,coalesce((to_jsonb(a)->>'is_opening_balance')::boolean,false) from public.supplier_credit_note a join public.supplier_invoice i on i.invoice_id=a.invoice_id where i.subsidiary_id=p_sid and a.note_date>=p_start and a.note_date<p_end and lower(coalesce(to_jsonb(a)->>'status','')) not in('anulado','anulada','cancelado','cancelada','void','voided','cancelled','reversed')
union all
select 'supplier_debit_note'::text,a.dn_id,a.note_date,'other'::text,a.amount,a.currency_id,nullif(a.created_by_id::text,''),nullif(to_jsonb(a)->>'created_by','')::bigint,a.actor_type::text,a.transaction_id,a.journal_id,20,coalesce((to_jsonb(a)->>'is_opening_balance')::boolean,false) from public.supplier_debit_note a join public.supplier_invoice i on i.invoice_id=a.invoice_id where i.subsidiary_id=p_sid and a.note_date>=p_start and a.note_date<p_end and lower(coalesce(to_jsonb(a)->>'status','')) not in('anulado','anulada','cancelado','cancelada','void','voided','cancelled','reversed')
union all
select 'customer_payment'::text,a.payment_id,a.payment_date,'collections'::text,a.amount_received,a.currency_id,nullif(a.created_by_id::text,''),nullif(to_jsonb(a)->>'created_by','')::bigint,a.actor_type::text,a.transaction_id,a.journal_id,30,coalesce((to_jsonb(a)->>'is_opening_balance')::boolean,false) from public.customer_payment a join public.journal j on j.journal_id=a.journal_id where j.subsidiary_id=p_sid and a.payment_date>=p_start and a.payment_date<p_end and lower(coalesce(to_jsonb(a)->>'status','')) not in('anulado','anulada','cancelado','cancelada','void','voided','cancelled','reversed')
union all
select 'supplier_payment'::text,a.payment_id,a.payment_date,'payments'::text,a.amount_paid,a.currency_id,nullif(a.created_by_id::text,''),nullif(to_jsonb(a)->>'created_by','')::bigint,a.actor_type::text,a.transaction_id,a.journal_id,30,coalesce((to_jsonb(a)->>'is_opening_balance')::boolean,false) from public.supplier_payment a join public.journal j on j.journal_id=a.journal_id where j.subsidiary_id=p_sid and a.payment_date>=p_start and a.payment_date<p_end and lower(coalesce(to_jsonb(a)->>'status','')) not in('anulado','anulada','cancelado','cancelada','void','voided','cancelled','reversed')
union all
select 'bank_transfer'::text,a.transfer_id,a.transfer_date,'transfers'::text,coalesce(a.source_amount,a.amount),ba.currency_id,nullif(a.created_by_id::text,''),nullif(to_jsonb(a)->>'created_by','')::bigint,a.actor_type::text,a.transaction_id,a.journal_id,40,coalesce((to_jsonb(a)->>'is_opening_balance')::boolean,false) from public.bank_transfer a left join public.bank_account ba on ba.bank_account_id=a.from_account_id where a.subsidiary_id=p_sid and a.transfer_date>=p_start and a.transfer_date<p_end and lower(coalesce(to_jsonb(a)->>'status','')) not in('anulado','anulada','cancelado','cancelada','void','voided','cancelled','reversed')
union all
select 'bank_check'::text,a.check_id,a.payment_date,'payments'::text,a.amount,a.currency_id,nullif(a.created_by_id::text,''),nullif(to_jsonb(a)->>'created_by','')::bigint,a.actor_type::text,a.transaction_id,a.journal_id,50,coalesce((to_jsonb(a)->>'is_opening_balance')::boolean,false) from public.bank_check a  where a.subsidiary_id=p_sid and a.payment_date>=p_start and a.payment_date<p_end and lower(coalesce(to_jsonb(a)->>'status','')) not in('anulado','anulada','cancelado','cancelada','void','voided','cancelled','reversed')
union all
select 'bank_deposit'::text,a.deposit_id,a.deposit_date,'collections'::text,a.total_amount,a.currency_id,nullif(a.created_by_id::text,''),nullif(to_jsonb(a)->>'created_by','')::bigint,a.actor_type::text,null::bigint,a.journal_id,50,coalesce((to_jsonb(a)->>'is_opening_balance')::boolean,false) from public.bank_deposit a  where a.subsidiary_id=p_sid and a.deposit_date>=p_start and a.deposit_date<p_end and lower(coalesce(to_jsonb(a)->>'status','')) not in('anulado','anulada','cancelado','cancelada','void','voided','cancelled','reversed')
union all
select 'bank_fee'::text,a.fee_id,a.fee_date,'other'::text,a.amount,a.currency_id,nullif(a.created_by_id::text,''),nullif(to_jsonb(a)->>'created_by','')::bigint,a.actor_type::text,a.transaction_id,a.journal_id,50,coalesce((to_jsonb(a)->>'is_opening_balance')::boolean,false) from public.bank_fee a  where a.subsidiary_id=p_sid and a.fee_date>=p_start and a.fee_date<p_end and lower(coalesce(to_jsonb(a)->>'status','')) not in('anulado','anulada','cancelado','cancelada','void','voided','cancelled','reversed')
union all
select 'journal'::text,a.journal_id,a.journal_date,case when tt.abbreviation in('ASI_DIA','ASI_PEN','ASI_NOM','ASI_LIQ','ASI_UTI') then 'manual' else 'automatic' end,null::numeric,a.currency_id,nullif(a.created_by_id::text,''),nullif(to_jsonb(a)->>'created_by','')::bigint,a.actor_type::text,a.transaction_id,a.journal_id,90,coalesce((to_jsonb(a)->>'is_opening_balance')::boolean,false) from public.journal a left join public.transaction_types tt on tt.name=a.journal_type where a.subsidiary_id=p_sid and a.journal_date>=p_start and a.journal_date<p_end and lower(coalesce(to_jsonb(a)->>'status','')) not in('anulado','anulada','cancelado','cancelada','void','voided','cancelled','reversed')
union all
select 'solicitudes_pago'::text,a.id,a.fecha_solicitud,'requests'::text,a.total,a.id_moneda,nullif(a.created_by_id::text,''),a.id_solicitante,a.actor_type::text,null::bigint,null::bigint,100,false
from public.solicitudes_pago a where a.id_subsidiaria=p_sid and a.fecha_solicitud>=p_start and a.fecha_solicitud<p_end
union all
select 'wf_step_decisions'::text,a.id,(case when valid_tz.name is not null then a.fecha_hora at time zone valid_tz.name else a.fecha_hora at time zone offset_timezone.value end)::date,'approvals'::text,null::numeric,null::bigint,null::text,a.usuario_id,a.actor_type::text,null::bigint,null::bigint,100,false
from public.wf_step_decisions a join public.wf_instance_steps st on st.id=a.step_id join public.wf_instances wi on wi.id=st.instance_id join public.subsidiaries s on s.subsidiary_id=wi.subsidiaria_id left join public.timezones tz on tz.timezone_id=s.timezone_id left join pg_catalog.pg_timezone_names valid_tz on valid_tz.name=tz.name left join lateral(select case when tz.utc_offset~'^UTC[+-]([01][0-9]|2[0-3]):[0-5][0-9]$'then substring(tz.utc_offset from 4)::interval else interval '0' end as value)offset_timezone on true
where wi.subsidiaria_id=p_sid and a.accion='APROBAR' and a.fecha_hora>=(case when valid_tz.name is not null then p_start::timestamp at time zone valid_tz.name else p_start::timestamp at time zone offset_timezone.value end)and a.fecha_hora<(case when valid_tz.name is not null then p_end::timestamp at time zone valid_tz.name else p_end::timestamp at time zone offset_timezone.value end)
;
$function$
;

CREATE OR REPLACE FUNCTION journal_entry_private.validate_payload(payload jsonb, p_sid bigint)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
declare line jsonb;debit numeric;credit numeric;rate numeric;kind text;field text;reference_kind text;entity_kind text;
begin
 if payload is null or jsonb_typeof(payload)<>'object' or jsonb_typeof(payload->'lines') is distinct from 'array' then
  raise exception using errcode='22023',message='El asiento requiere un encabezado y líneas válidas.';
 end if;
 kind:=payload->>'journal_type';
 if not exists(select 1 from public.transaction_types t where t.name=kind and t.abbreviation in('ASI_DIA','ASI_PEN','ASI_NOM','ASI_LIQ','ASI_UTI')) then
  raise exception using errcode='22023',message='Seleccione un tipo de asiento manual configurado.';
 end if;
 if not exists(select 1 from public.fiscal_periods f where f.fiscal_period_id=(payload->>'fiscal_period_id')::bigint
   and f.subsidiary_id=p_sid and (payload->>'journal_date')::date between f.start_date and f.end_date
   and not coalesce(f.is_closed,false) and not coalesce(f.gl_closed,false) and not coalesce(f.is_inactive,false)) then
  raise exception using errcode='55000',message='El período debe estar abierto y pertenecer a la subsidiaria y fecha del asiento.';
 end if;
 if not exists(select 1 from public.currencies c where c.currency_id=(payload->>'currency_id')::bigint and (
   exists(select 1 from public.subsidiaries s where s.subsidiary_id=p_sid and s.currency_id=c.currency_id)
   or exists(select 1 from public.subsidiary_currencies s where s.subsidiary_id=p_sid and s.currency_id=c.currency_id))) then
  raise exception using errcode='42501',message='La moneda no está habilitada para la subsidiaria.';
 end if;
 rate:=(payload->>'exchange_rate')::numeric;
 if rate is null or rate<=0 or rate::text in('NaN','Infinity','-Infinity') then
  raise exception using errcode='22023',message='El tipo de cambio debe ser positivo y finito.';
 end if;
 for line in select value from jsonb_array_elements(payload->'lines') loop
  debit:=coalesce((line->>'debit')::numeric,0);credit:=coalesce((line->>'credit')::numeric,0);
  if debit<0 or credit<0 or debit::text in('NaN','Infinity','-Infinity') or credit::text in('NaN','Infinity','-Infinity')
    or (debit>0)=(credit>0) then
   raise exception using errcode='22023',message='Cada línea requiere solo un débito o crédito positivo y finito.';
  end if;
  if not exists(select 1 from public.chart_accounts a join public.account_subsidiaries s using(account_id)
    where a.account_id=(line->>'account_id')::bigint and s.subsidiary_id=p_sid and s.is_active
      and not coalesce(a.is_inactive,false) and not coalesce(a.is_summary,false) and coalesce(a.accepts_entries,true)) then
   raise exception using errcode='42501',message='La cuenta no está habilitada para la subsidiaria activa.';
  end if;
  entity_kind:=nullif(line->>'entity_type','');
  if entity_kind is not null and entity_kind<>'Ninguna' then
   if entity_kind not in('Cliente','Proveedor','Empleado') or nullif(line->>'entity_id','') is null then
    raise exception using errcode='22023',message='Seleccione una entidad válida.';
   end if;
   perform public.journal_csv_lookup(entity_kind,'ID:'||(line->>'entity_id'));
  end if;
  for field,reference_kind in select * from (values('department_id','departamento'),('class_id','clase'),
    ('cost_center_id','centro_costos'),('financial_creditor_id','acreedor_financiero'),('related_company_id','compania_relacionada')) refs(field,kind) loop
   if nullif(line->>field,'') is not null then perform public.journal_csv_lookup(reference_kind,'ID:'||(line->>field));end if;
  end loop;
 end loop;
exception when raise_exception then
 raise exception using errcode='42501',message='Una entidad o dimensión no está disponible en la subsidiaria activa.';
end$function$
;

CREATE OR REPLACE FUNCTION journal_csv_private.canonical_rows(p_rows jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 IMMUTABLE
 SET search_path TO 'pg_catalog'
AS $function$
begin
 if jsonb_typeof(p_rows)is distinct from 'array'or jsonb_array_length(p_rows)not between 1 and 2000 then raise exception using errcode='22023',message='El archivo debe contener entre 1 y 2000 líneas.';end if;
 if exists(select 1 from jsonb_array_elements(p_rows)x where jsonb_typeof(x)is distinct from 'object')then raise exception using errcode='22023',message='Cada línea debe tener el formato de la plantilla.';end if;
 return(select jsonb_agg(case when x->>'tipo_asiento'in('ASI_DIA','ASI_NOM','ASI_LIQ','ASI_UTI')then (x-'tipo_cambio'-'pais_servicio')||jsonb_build_object('mes_servicio','')else x-'tipo_cambio'end order by n)from jsonb_array_elements(p_rows)with ordinality z(x,n));
end$function$
;

notify pgrst,'reload schema';
