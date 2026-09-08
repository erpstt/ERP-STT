-- One transaction per file; receipts make retries safe, including concurrent requests.
create table if not exists public.journal_csv_imports (
  subsidiary_id bigint not null references public.subsidiaries(subsidiary_id),
  fingerprint text not null,
  result jsonb not null,
  created_at timestamptz not null default now(),
  primary key (subsidiary_id, fingerprint)
);
alter table public.journal_csv_imports enable row level security;
revoke all on public.journal_csv_imports from public, anon, authenticated;

create or replace function public.import_journal_csv(p_rows jsonb, p_preview boolean, p_subsidiary_id bigint)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare
  sid bigint:=active_subsidiary_id(); local_currency bigint; file_fingerprint text;
  previous jsonb; batch jsonb:='[]'; summary jsonb:='[]'; errors jsonb:='[]';
  grp record; first_row jsonb; item jsonb; row_number integer; lines jsonb;
  journal_type_name text; journal_date_value date; currency bigint; period bigint;
  rate numeric; expected_rate numeric; aid bigint; matches integer; debit numeric; credit numeric;
  td numeric; tc numeric; jid bigint; saved_number text; entry jsonb;
begin
  if sid is null or p_subsidiary_id is distinct from sid then raise exception 'La subsidiaria activa cambió. Vuelva a abrir la importación.'; end if;
  if p_preview is null or jsonb_typeof(p_rows) is distinct from 'array' then raise exception 'El lote no es válido.'; end if;
  if jsonb_array_length(p_rows) not between 1 and 2000 then raise exception 'El archivo debe contener entre 1 y 2000 líneas.'; end if;
  if exists(select 1 from jsonb_array_elements(p_rows) r where coalesce(btrim(r->>'asiento_referencia'),'')='') then raise exception 'Todas las líneas requieren asiento_referencia.'; end if;
  if (select count(distinct r->>'asiento_referencia') from jsonb_array_elements(p_rows) r)>200 then raise exception 'Se admiten hasta 200 asientos por archivo.'; end if;
  file_fingerprint:=md5(p_rows::text);
  perform pg_advisory_xact_lock(hashtextextended('journal_csv:'||sid||':'||file_fingerprint,0));
  select i.result into previous from journal_csv_imports i where i.subsidiary_id=sid and i.fingerprint=file_fingerprint;
  if previous is not null then return previous||jsonb_build_object('alreadyImported',true); end if;
  select s.currency_id into local_currency from subsidiaries s where s.subsidiary_id=sid;
  for grp in select r->>'asiento_referencia' reference,jsonb_agg(r order by n) rows,min(n) first_number
    from jsonb_array_elements(p_rows) with ordinality t(r,n) group by r->>'asiento_referencia' order by min(n)
  loop
    row_number:=grp.first_number+1;
    begin
      first_row:=grp.rows->0; lines:='[]'; td:=0; tc:=0;
      if jsonb_array_length(grp.rows)<2 then raise exception 'El asiento requiere al menos dos líneas.'; end if;
      if coalesce(first_row->>'tipo_asiento','') not in ('ASI_DIA','ASI_PEN','ASI_NOM','ASI_LIQ') then raise exception 'Tipo de asiento no permitido.'; end if;
      select name into journal_type_name from transaction_types where abbreviation=first_row->>'tipo_asiento';
      if journal_type_name is null then raise exception 'El tipo de asiento no está configurado.'; end if;
      if coalesce(first_row->>'fecha','') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then raise exception 'La fecha debe tener formato AAAA-MM-DD.'; end if;
      journal_date_value:=(first_row->>'fecha')::date;
      select fiscal_period_id into period from fiscal_periods where subsidiary_id=sid and journal_date_value between start_date and end_date and not coalesce(is_inactive,false) order by start_date desc limit 1;
      if period is null then raise exception 'No existe un período contable activo para la fecha.'; end if;
      select c.currency_id into currency from currencies c where c.currency_code=first_row->>'moneda' and (c.currency_id=local_currency or exists(select 1 from subsidiary_currencies sc where sc.subsidiary_id=sid and sc.currency_id=c.currency_id));
      if currency is null then raise exception 'La moneda no está permitida para la subsidiaria.'; end if;
      if coalesce(first_row->>'tipo_cambio','') !~ '^[0-9]{1,12}(\.[0-9]{1,6})?$' then raise exception 'Tipo de cambio inválido: use punto decimal y hasta seis decimales.'; end if;
      rate:=(first_row->>'tipo_cambio')::numeric;
      expected_rate:=null;
      if currency=local_currency then expected_rate:=1;
      else select spot_rate into expected_rate from exchange_rates where from_currency_id=currency and to_currency_id=local_currency and effective_date<=journal_date_value order by effective_date desc,exchange_rate_id desc limit 1; end if;
      if rate<=0 or expected_rate is null or rate<>expected_rate then raise exception 'El tipo de cambio no coincide con la tasa configurada para la fecha y moneda.'; end if;
      for item,row_number in select r,n::integer+1 from jsonb_array_elements(p_rows) with ordinality t(r,n) where r->>'asiento_referencia'=grp.reference order by n loop
        if exists(select 1 from unnest(array['tipo_asiento','fecha','moneda','tipo_cambio','nota_asiento']) k where item->>k is distinct from first_row->>k) then raise exception 'Los datos de encabezado deben coincidir en todas las líneas del asiento.'; end if;
        select count(*),min(a.account_id) into matches,aid from chart_accounts a where a.account_number=item->>'numero_cuenta' and not coalesce(a.is_inactive,false) and coalesce(a.accepts_entries,true) and exists(select 1 from account_subsidiaries s where s.account_id=a.account_id and s.subsidiary_id=sid and s.is_active);
        if matches<>1 then raise exception 'Cuenta % inexistente, ambigua, inactiva o no habilitada para la subsidiaria.',item->>'numero_cuenta'; end if;
        if coalesce(nullif(item->>'debito',''),'0') !~ '^[0-9]{1,12}(\.[0-9]{1,6})?$' or coalesce(nullif(item->>'credito',''),'0') !~ '^[0-9]{1,12}(\.[0-9]{1,6})?$' then raise exception 'Débito/crédito inválido: use importes positivos con punto decimal y hasta seis decimales.'; end if;
        debit:=coalesce(nullif(item->>'debito',''),'0')::numeric; credit:=coalesce(nullif(item->>'credito',''),'0')::numeric;
        if (debit>0)=(credit>0) then raise exception 'Complete solo débito o crédito, con un importe mayor que cero.'; end if;
        if coalesce(item->>'mes_servicio','')<>'' and (first_row->>'tipo_asiento'<>'ASI_PEN' or item->>'mes_servicio' !~ '^[0-9]{4}-(0[1-9]|1[0-2])$') then raise exception 'Mes de servicio: use AAAA-MM únicamente para ASI_PEN.'; end if;
        td:=td+debit; tc:=tc+credit;
        lines:=lines||jsonb_build_array(jsonb_build_object('account_id',aid,'debit',debit,'credit',credit,'note',item->>'nota_linea','service_month',nullif(item->>'mes_servicio','')));
      end loop;
      if td<>tc then raise exception 'Asiento desbalanceado: débitos %, créditos %.',td,tc; end if;
      batch:=batch||jsonb_build_array(jsonb_build_object('reference',grp.reference,'payload',jsonb_build_object('journal_type',journal_type_name,'journal_date',journal_date_value,'currency_id',currency,'fiscal_period_id',period,'exchange_rate',rate,'memo',first_row->>'nota_asiento','lines',lines)));
      summary:=summary||jsonb_build_array(jsonb_build_object('reference',grp.reference,'date',journal_date_value,'currency',first_row->>'moneda','lines',jsonb_array_length(lines),'debit',td,'credit',tc));
    exception when others then
      errors:=errors||jsonb_build_array(jsonb_build_object('reference',grp.reference,'row',row_number,'message',sqlerrm));
    end;
  end loop;
  if jsonb_array_length(errors)>0 then return jsonb_build_object('valid',false,'created',0,'errors',errors,'entries',summary); end if;
  if p_preview then return jsonb_build_object('valid',true,'created',0,'entries',summary,'errors','[]'::jsonb); end if;
  summary:='[]';
  for entry in select value from jsonb_array_elements(batch) loop
    begin
      jid:=create_journal_entry(entry->'payload');
    exception when others then raise exception 'Asiento %: %. No se guardó ningún asiento del lote.',entry->>'reference',sqlerrm; end;
    select journal_number into saved_number from journal where journal_id=jid;
    summary:=summary||jsonb_build_array(jsonb_build_object('reference',entry->>'reference','journalId',jid,'journalNumber',saved_number));
  end loop;
  previous:=jsonb_build_object('valid',true,'created',jsonb_array_length(summary),'entries',summary,'errors','[]'::jsonb,'alreadyImported',false);
  insert into journal_csv_imports(subsidiary_id,fingerprint,result) values(sid,file_fingerprint,previous);
  return previous;
end$$;
revoke all on function public.import_journal_csv(jsonb,boolean,bigint) from public, anon;
grant execute on function public.import_journal_csv(jsonb,boolean,bigint) to authenticated;
notify pgrst, 'reload schema';
