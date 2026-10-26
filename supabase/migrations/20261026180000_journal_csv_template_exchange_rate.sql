-- The exchange rate supplied in the journal CSV is historical source data.
-- Validate its format and positivity, but do not replace it or compare it with
-- the operational exchange-rate catalog for the journal date.
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
  sid bigint:=public.active_subsidiary_id();
  local_currency bigint;
  file_fingerprint text;
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
      if coalesce(first_row->>'tipo_asiento','') not in ('ASI_DIA','ASI_PEN','ASI_NOM','ASI_LIQ') then
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

      if coalesce(first_row->>'tipo_cambio','') !~ '^[0-9]{1,12}(\.[0-9]{1,6})?$' then
        raise exception 'Tipo de cambio inválido: use punto decimal y hasta seis decimales.';
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
  if p_preview then
    return jsonb_build_object('valid',true,'created',0,'entries',summary,'errors','[]'::jsonb);
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
$$;

comment on function public.import_journal_csv(jsonb,boolean,bigint) is
  'Imports manual journals using the positive exchange rate supplied by the CSV as historical source data.';

revoke all on function public.import_journal_csv(jsonb,boolean,bigint)
  from public,anon;
grant execute on function public.import_journal_csv(jsonb,boolean,bigint)
  to authenticated;

notify pgrst,'reload schema';
