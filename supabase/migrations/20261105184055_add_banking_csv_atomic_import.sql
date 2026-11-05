-- Bank CSV import adds no alternate posting engine. Preview resolves and
-- validates; confirmation calls the existing protected financial writers.
set local lock_timeout='5s';
set local statement_timeout='60s';
create schema banking_csv_private;
revoke all on schema banking_csv_private from public,anon,authenticated,service_role;
create table banking_csv_private.imports(
 id uuid primary key default gen_random_uuid(),subsidiary_id bigint not null,kind text not null check(kind in('CHECKS','DEPOSITS')),
 fingerprint text not null check(fingerprint~'^[0-9a-f]{64}$'),user_id bigint not null,session_id text not null,role_id bigint not null,
 result jsonb,created_at timestamptz not null default clock_timestamp(),unique(subsidiary_id,kind,fingerprint)
);
create table banking_csv_private.documents(
 subsidiary_id bigint not null,kind text not null,reference text not null,receipt_id uuid not null references banking_csv_private.imports,
 signature text not null,result jsonb not null,primary key(subsidiary_id,kind,reference)
);
alter table banking_csv_private.imports enable row level security;
alter table banking_csv_private.documents enable row level security;
revoke all on all tables in schema banking_csv_private from public,anon,authenticated,service_role;

create function banking_csv_private.sha(value text)returns text language sql immutable set search_path=pg_catalog,pg_temp as $$select encode(sha256(convert_to(value,'UTF8')),'hex')$$;
create function banking_csv_private.context(kind text,sid bigint)returns jsonb language plpgsql stable security definer set search_path=pg_catalog,public,pg_temp as $$
declare current_sid bigint;u bigint;r bigint;s text;revision text;
begin
 if kind='CHECKS'then current_sid:=bank_check_private.assert_access('view');perform bank_check_private.assert_access('create');
 elsif kind='DEPOSITS'then current_sid:=bank_deposit_private.assert_access('view');perform bank_deposit_private.assert_access('create');
 else raise exception using errcode='22023',message='Tipo de archivo no admitido.';end if;
 if sid is null or current_sid is distinct from sid then raise exception using errcode='42501',message='La empresa activa no coincide con la validación.';end if;
 u:=public.app_user_id();r:=public.app_active_role_id();s:=auth.jwt()->>'session_id';
 if u is null or r is null or nullif(s,'')is null then raise exception using errcode='42501',message='Seleccione una sesión y un rol autorizados.';end if;
 select md5(coalesce((select to_jsonb(x)::text from public.user_role_sessions x where x.session_id=s and x.user_id=u),'')||':'||coalesce((select to_jsonb(x)::text from public.user_company_sessions x where x.session_id=s and x.user_id=u),''))into revision;
 return jsonb_build_object('userId',u,'roleId',r,'subsidiaryId',sid,'sessionId',s,'revision',revision);
end$$;
create function banking_csv_private.number_value(value text,scale integer,label text)returns numeric language plpgsql immutable set search_path=pg_catalog,pg_temp as $$
declare result numeric;
begin
 if coalesce(value,'')!~('^[0-9]{1,12}([.,][0-9]{1,'||scale||'})?$')then raise exception using errcode='22023',message=label||': use un número sin separadores de miles y con hasta '||scale||' decimales.';end if;
 result:=replace(value,',','.')::numeric;if result<=0 then raise exception using errcode='22023',message=label||': el importe debe ser mayor que cero.';end if;return result;
end$$;
create function banking_csv_private.lookup(kind text,value text,sid bigint)returns bigint language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$
declare n integer;key bigint;v text:=nullif(btrim(value),'');item jsonb;
begin
 if v is null then return null;end if;
 if v~*'^ID:'then raise exception using errcode='22023',message='Use el código o identificación de la plantilla, no identificadores internos.';end if;
 if kind='bank'then select count(*),min(bank_account_id)into n,key from public.bank_account where subsidiary_id=sid and account_number=v and not coalesce(is_credit_card,false);
 elsif kind='account'then select count(*),min(a.account_id)into n,key from public.chart_accounts a join public.account_subsidiaries s using(account_id)where s.subsidiary_id=sid and s.is_active and a.account_number=v and not coalesce(a.is_inactive,false)and not coalesce(a.is_summary,false)and coalesce(a.accepts_entries,true);
 elsif kind='currency'then select count(*),min(c.currency_id)into n,key from public.currencies c where c.currency_code=upper(v)and(c.currency_id=(select currency_id from public.subsidiaries where subsidiary_id=sid)or exists(select 1 from public.subsidiary_currencies s where s.currency_id=c.currency_id and s.subsidiary_id=sid));
 elsif kind='location'then select count(*),min(l.location_id)into n,key from public.locations l where lower(btrim(l.name))=lower(v)and(l.subsidiary_id=sid or exists(select 1 from public.location_subsidiaries s where s.location_id=l.location_id and s.subsidiary_id=sid));
 elsif kind='method'then select count(*),min(payment_method_id)into n,key from public.payment_methods m where m.method_code=v and coalesce((to_jsonb(m)->>'is_active')::boolean,true)and not coalesce((to_jsonb(m)->>'is_inactive')::boolean,false);
 elsif kind='CLIENTE'then select count(*),min(c.customer_id)into n,key from public.customers c where btrim(c.tax_id)=v and not coalesce(c.is_inactive,false)and exists(select 1 from public.entity_subsidiaries s where s.customer_id=c.customer_id and s.subsidiary_id=sid);
 elsif kind='PROVEEDOR'then select count(*),min(c.supplier_id)into n,key from public.suppliers c where btrim(c.tax_id)=v and not coalesce(c.is_inactive,false)and exists(select 1 from public.entity_subsidiaries s where s.supplier_id=c.supplier_id and s.subsidiary_id=sid);
 elsif kind='EMPLEADO'then select count(*),min(employee_id)into n,key from public.employees where employee_number=v and subsidiary_id=sid and is_active;
 elsif kind='AGENCIA_TRIBUTARIA'then select count(*),min(a.tax_agency_id)into n,key from public.tax_agencies a join public.tax_agency_subsidiaries s using(tax_agency_id)join public.subsidiaries sub on sub.subsidiary_id=s.subsidiary_id where s.subsidiary_id=sid and a.country_id=sub.country_id and nullif(btrim(a.tax_id),'')=v;
 else raise exception using errcode='22023',message='Tipo de referencia no admitido.';
 end if;
 if n<>1 then raise exception using errcode='22023',message=kind||': no existe una coincidencia única y activa en la empresa.';end if;return key;
end$$;

create function banking_csv_private.build_batch(kind text,rows jsonb,sid bigint)returns jsonb language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$
declare ctx jsonb:=banking_csv_private.context(kind,sid);fingerprint text;grp record;first_row jsonb;item jsonb;line jsonb;lines jsonb;line_values jsonb[];batch jsonb:='[]';entries jsonb:='[]';errors jsonb:='[]';totals jsonb;payload jsonb;summary jsonb;dims jsonb;header_keys text[];field text;row_number integer;header_row integer;errors_before integer;matches integer;bank bigint;currency bigint;period bigint;location bigint;account bigint;entity_id bigint;method bigint;entity_kind text;entity_label text;d date;rate numeric;amount numeric;total numeric;local_lines numeric;bank_balances jsonb;locked_bank bigint;
begin
 if jsonb_typeof(rows)is distinct from'array'or jsonb_array_length(rows)not between 1 and 2000 then raise exception using errcode='22023',message='El archivo debe contener entre 1 y 2000 filas.';end if;
 fingerprint:=banking_csv_private.sha(rows::text);
 if exists(select 1 from jsonb_array_elements(rows)x where jsonb_typeof(x)<>'object')then raise exception using errcode='22023',message='Cada fila debe tener el formato de la plantilla.';end if;
 select coalesce(jsonb_agg(jsonb_build_object('row',n+1,'reference','','field','documento_referencia','code','22023','message','Complete documento_referencia para agrupar las líneas del documento.')),'[]')into errors from jsonb_array_elements(rows)with ordinality z(x,n)where coalesce(btrim(x->>'documento_referencia'),'')='';
 if(select count(distinct x->>'documento_referencia')from jsonb_array_elements(rows)x)>200 then raise exception using errcode='22023',message='El archivo admite hasta 200 documentos.';end if;
 -- The existing pure validators lock bank rows. Acquire the entire set in the
 -- same order for preview and import, without changing balances or sequences.
 for locked_bank in select b.bank_account_id from public.bank_account b where b.subsidiary_id=sid and b.account_number in(select x->>'cuenta_bancaria'from jsonb_array_elements(rows)x)order by b.bank_account_id for update loop null;end loop;
 header_keys:=array['fecha','cuenta_bancaria','moneda','tipo_cambio','referencia_bancaria','ubicacion','nota_documento'];if kind='CHECKS'then header_keys:=header_keys||array['tipo_movimiento','beneficiario'];end if;
 for grp in select x->>'documento_referencia'reference,jsonb_agg(x order by n)items,min(n)::integer+1 first_row from jsonb_array_elements(rows)with ordinality z(x,n)where coalesce(btrim(x->>'documento_referencia'),'')<>''group by x->>'documento_referencia'order by min(n)loop
  first_row:=grp.items->0;row_number:=grp.first_row;header_row:=row_number;field:='documento_referencia';errors_before:=jsonb_array_length(errors);
  begin
   if length(grp.reference)>200 then raise exception using errcode='22023',message='La referencia admite hasta 200 caracteres.';end if;
   if exists(select 1 from banking_csv_private.documents where subsidiary_id=sid and documents.kind=build_batch.kind and reference=grp.reference)then raise exception using errcode='22023',message='La referencia ya fue importada. Use su comprobante o una referencia nueva para un documento diferente.';end if;
   for item,row_number in select x,n::integer+1 from jsonb_array_elements(rows)with ordinality z(x,n)where x->>'documento_referencia'=grp.reference loop
    if exists(select 1 from unnest(header_keys)k where item->>k is distinct from first_row->>k)then raise exception using errcode='22023',message='Los datos de encabezado deben coincidir en todas las filas del documento.';end if;
   end loop;
   row_number:=header_row;field:='fecha';if coalesce(first_row->>'fecha','')!~'^[0-9]{4}-[0-9]{2}-[0-9]{2}$'then raise exception using errcode='22023',message='La fecha debe tener formato AAAA-MM-DD.';end if;d:=(first_row->>'fecha')::date;
   select count(*),min(fiscal_period_id)into matches,period from public.fiscal_periods where subsidiary_id=sid and d between start_date and end_date and not coalesce(is_closed,false)and not coalesce(gl_closed,false)and not coalesce(is_inactive,false);
   if matches<>1 then raise exception using errcode='22023',message='La fecha requiere un único período contable abierto de la empresa.';end if;
   field:='cuenta_bancaria';bank:=banking_csv_private.lookup('bank',first_row->>'cuenta_bancaria',sid);if bank is null then raise exception using errcode='22023',message='Complete la cuenta bancaria.';end if;
   field:='moneda';currency:=banking_csv_private.lookup('currency',first_row->>'moneda',sid);if currency is null then raise exception using errcode='22023',message='Complete la moneda.';end if;
   field:='tipo_cambio';rate:=banking_csv_private.number_value(first_row->>'tipo_cambio',10,'Tipo de cambio');if currency=(select currency_id from public.subsidiaries where subsidiary_id=sid)and rate<>1 then raise exception using errcode='22023',message='La moneda local requiere tipo de cambio 1.';end if;
   field:='ubicacion';location:=banking_csv_private.lookup('location',first_row->>'ubicacion',sid);
   if kind='CHECKS'and coalesce(first_row->>'tipo_movimiento','')not in('CHEQUE','TRANSFERENCIA')then field:='tipo_movimiento';raise exception using errcode='22023',message='Tipo de movimiento: use CHEQUE o TRANSFERENCIA.';end if;
   if nullif(btrim(first_row->>'referencia_bancaria'),'')is null then field:='referencia_bancaria';raise exception using errcode='22023',message='Complete la referencia bancaria.';end if;
   line_values:=array[]::jsonb[];total:=0;
   for item,row_number in select x,n::integer+1 from jsonb_array_elements(rows)with ordinality z(x,n)where x->>'documento_referencia'=grp.reference order by n loop
    begin
     field:='numero_cuenta';account:=banking_csv_private.lookup('account',item->>'numero_cuenta',sid);if account is null then raise exception using errcode='22023',message='Complete la cuenta contable de contrapartida.';end if;
     field:='importe';amount:=banking_csv_private.number_value(item->>'importe',6,'Importe');
     field:='tipo_entidad';entity_kind:=nullif(item->>'tipo_entidad','');entity_id:=null;entity_label:=null;
     if entity_kind is not null then
      if entity_kind not in('CLIENTE','PROVEEDOR','EMPLEADO','AGENCIA_TRIBUTARIA')or(kind='DEPOSITS'and entity_kind='AGENCIA_TRIBUTARIA')then raise exception using errcode='22023',message='Seleccione un tipo de entidad admitido por este documento.';end if;
      field:='identificacion_entidad';entity_id:=banking_csv_private.lookup(entity_kind,item->>'identificacion_entidad',sid);if entity_id is null then raise exception using errcode='22023',message='Complete la identificación de la entidad.';end if;
      entity_label:=case entity_kind when'CLIENTE'then'Cliente'when'PROVEEDOR'then'Proveedor'when'EMPLEADO'then'Empleado'else'Agencia Tributaria'end;
     elsif nullif(item->>'identificacion_entidad','')is not null then raise exception using errcode='22023',message='Indique el tipo de entidad.';end if;
     field:='dimensiones';if exists(select 1 from unnest(array['departamento','centro_costos','clase','acreedor_financiero','compania_relacionada'])k where coalesce(item->>k,'')~*'^ID:')then raise exception using errcode='22023',message='Use nombres exactos para las dimensiones, no identificadores internos.';end if;
     -- With no dimensions or entity there is nothing to resolve. Avoid repeated
     -- empty lookups; every nonempty reference still uses the protected helper.
     if entity_kind in('CLIENTE','PROVEEDOR','EMPLEADO')or exists(select 1 from unnest(array['departamento','centro_costos','clase','acreedor_financiero','compania_relacionada'])k where nullif(item->>k,'')is not null)then
      dims:=public.journal_csv_dimensions(item||jsonb_build_object('entidad',case when entity_kind='AGENCIA_TRIBUTARIA'then null else entity_label end,'nombre',case when entity_label is null or entity_kind='AGENCIA_TRIBUTARIA'then null else'ID:'||entity_id end));
     else dims:='{}';end if;
     method:=null;if kind='DEPOSITS'then field:='metodo_pago';method:=banking_csv_private.lookup('method',item->>'metodo_pago',sid);end if;
     line:=dims||jsonb_build_object('account_id',account,'amount',amount,'note',item->>'nota_linea','entity_type',entity_label,'entity_id',entity_id,'payment_method_id',method);line_values:=array_append(line_values,line);total:=total+amount;
    exception when others then errors:=errors||jsonb_build_array(jsonb_build_object('row',row_number,'reference',grp.reference,'field',field,'code',case when sqlstate in('22023','22007','22008','42501','55000','P0001')then sqlstate else'INTERNAL'end,'message',case when sqlstate in('22023','22007','22008','55000')then sqlerrm when sqlstate in('42501','P0001')then'La entidad o dimensión no existe, está inactiva o no está habilitada de forma única en esta empresa.'else'No fue posible validar la fila. Revise la configuración.'end));end;
   end loop;
   if jsonb_array_length(errors)>errors_before then continue;end if;
   lines:=to_jsonb(line_values);
   -- Published writers store six local decimals per GL line and for the bank
   -- total. Reject an incompatible distribution; never alter native amounts,
   -- rates or history to conceal a rounding difference.
   field:='tipo_cambio';row_number:=header_row;
   if abs(round(total*rate,6))>=1000000000000000000 or exists(select 1 from jsonb_array_elements(lines)x where abs(round((x->>'amount')::numeric*rate,6))>=1000000000000000000)then raise exception using errcode='22023',message='El importe local excede la precisión contable admitida para este documento.';end if;
   select sum(round((x->>'amount')::numeric*rate,6))into local_lines from jsonb_array_elements(lines)x;
   if local_lines<>round(total*rate,6)then raise exception using errcode='22023',message='El redondeo local de las líneas difiere del total bancario por '||round(local_lines-round(total*rate,6),6)::text||'. Revise la configuración y el desglose del documento antes de importar.';end if;
   payload:=jsonb_build_object('bank_account_id',bank,'currency_id',currency,'exchange_rate',rate,'fiscal_period_id',period,'location_id',location,'bank_reference',first_row->>'referencia_bancaria','memo',first_row->>'nota_documento','lines',lines);
   if kind='CHECKS'then payload:=payload||jsonb_build_object('payment_date',d,'payment_type',first_row->>'tipo_movimiento','beneficiary',first_row->>'beneficiario');perform bank_check_private.validate_payload(payload,sid,null);
   else payload:=payload||jsonb_build_object('deposit_date',d);perform bank_deposit_private.validate_payload(payload,sid,null);end if;
   summary:=jsonb_build_object('reference',grp.reference,'type',case when kind='CHECKS'then first_row->>'tipo_movimiento'else'DEPOSITO'end,'date',d,'bankAccount',first_row->>'cuenta_bancaria','currency',upper(first_row->>'moneda'),'amount',round(total,6)::text,'localAmount',round(total*rate,6)::text,'lineCount',jsonb_array_length(lines),'bankReference',first_row->>'referencia_bancaria');
   batch:=batch||jsonb_build_array(jsonb_build_object('reference',grp.reference,'row',header_row,'payload',payload,'summary',summary,'signature',banking_csv_private.sha(payload::text)));entries:=entries||jsonb_build_array(summary);
  exception when others then errors:=errors||jsonb_build_array(jsonb_build_object('row',row_number,'reference',grp.reference,'field',field,'code',case when sqlstate in('22023','22007','22008','42501','55000','P0001')then sqlstate else'INTERNAL'end,'message',case when sqlstate in('22023','22007','22008','55000')then sqlerrm when sqlstate in('42501','P0001')then'La cuenta, entidad, ubicación o dimensión no está habilitada en esta empresa.'else'No fue posible validar el documento. Revise la configuración.'end));end;
 end loop;
 -- Cumulative funds are checked without calling any writer or sequence.
 if kind='CHECKS'then
  for grp in select(x->'payload'->>'bank_account_id')::bigint bank,sum((x->'summary'->>'amount')::numeric)amount,min((x->>'row')::integer)row from jsonb_array_elements(batch)x group by(x->'payload'->>'bank_account_id')::bigint loop
   if grp.amount>(select balance from public.bank_account where bank_account_id=grp.bank and subsidiary_id=sid)then errors:=errors||jsonb_build_array(jsonb_build_object('row',grp.row,'reference','','field','cuenta_bancaria','code','55000','message','Los egresos acumulados del archivo superan el saldo disponible de esta cuenta bancaria.'));end if;
  end loop;
 end if;
 select coalesce(jsonb_agg(to_jsonb(x)order by x.currency),'[]')into totals from(select x->>'currency'currency,round(sum((x->>'amount')::numeric),6)::text amount,round(sum((x->>'localAmount')::numeric),6)::text "localAmount",count(*)documents,sum((x->>'lineCount')::integer)lines from jsonb_array_elements(entries)x group by x->>'currency')x;
 select coalesce(jsonb_agg(jsonb_build_object('id',b.bank_account_id,'balance',b.balance)order by b.bank_account_id),'[]')into bank_balances from public.bank_account b where b.subsidiary_id=sid and b.bank_account_id in(select(x->'payload'->>'bank_account_id')::bigint from jsonb_array_elements(batch)x);
 return jsonb_build_object('valid',jsonb_array_length(errors)=0,'created',0,'alreadyImported',false,'entries',entries,'errors',errors,'totals',totals,'context',ctx,'fingerprint',fingerprint,'validationDigest',banking_csv_private.sha(jsonb_build_object('batch',batch,'banks',bank_balances,'context',ctx)::text),'batch',batch);
end$$;

create function public.banking_csv_preview(p_kind text,p_rows jsonb,p_subsidiary_id bigint)returns jsonb language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$
declare ctx jsonb:=banking_csv_private.context(p_kind,p_subsidiary_id);previous jsonb;
begin
 select result into previous from banking_csv_private.imports where subsidiary_id=p_subsidiary_id and kind=p_kind and fingerprint=banking_csv_private.sha(p_rows::text);
 if previous is not null then return previous||jsonb_build_object('created',0,'alreadyImported',true,'context',ctx);end if;
 return banking_csv_private.build_batch(p_kind,p_rows,p_subsidiary_id)-'batch';
end$$;
create function public.banking_csv_import(p_kind text,p_rows jsonb,p_subsidiary_id bigint,p_expected_context jsonb,p_fingerprint text,p_validation_digest text)returns jsonb language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$
declare ctx jsonb:=banking_csv_private.context(p_kind,p_subsidiary_id);previous jsonb;validated jsonb;entry jsonb;saved jsonb;v_result jsonb;entries jsonb:='[]';receipt uuid;ref text;bank bigint;previous_defer text;
begin
 if ctx is distinct from p_expected_context or p_fingerprint is distinct from banking_csv_private.sha(p_rows::text)then raise exception using errcode='55000',message='El archivo o contexto cambió. Vuelva a validar.';end if;
 perform pg_advisory_xact_lock(hashtextextended('banking_csv:'||p_subsidiary_id||':'||p_kind||':'||p_fingerprint,0));
 select i.result into previous from banking_csv_private.imports i where i.subsidiary_id=p_subsidiary_id and i.kind=p_kind and i.fingerprint=p_fingerprint;
 if previous is not null then return previous||jsonb_build_object('created',0,'alreadyImported',true,'context',ctx);end if;
 -- Serialize all banks and document references in fixed order before validation.
 for ref in select distinct x->>'documento_referencia'from jsonb_array_elements(p_rows)x order by 1 loop perform pg_advisory_xact_lock(hashtextextended('banking_csv_reference:'||p_subsidiary_id||':'||p_kind||':'||ref,0));end loop;
 for bank in select b.bank_account_id from public.bank_account b where b.subsidiary_id=p_subsidiary_id and b.account_number in(select x->>'cuenta_bancaria'from jsonb_array_elements(p_rows)x)order by b.bank_account_id for update loop null;end loop;
 validated:=banking_csv_private.build_batch(p_kind,p_rows,p_subsidiary_id);
 if not(validated->>'valid')::boolean then return validated-'batch';end if;
 if validated->>'validationDigest' is distinct from p_validation_digest then raise exception using errcode='55000',message='La validación o los datos maestros cambiaron. Vuelva a validar.';end if;
 insert into banking_csv_private.imports(subsidiary_id,kind,fingerprint,user_id,session_id,role_id)values(p_subsidiary_id,p_kind,p_fingerprint,(ctx->>'userId')::bigint,ctx->>'sessionId',(ctx->>'roleId')::bigint)returning id into receipt;
 for entry in select value from jsonb_array_elements(validated->'batch')loop
  -- Reuse the published journal-CSV batching contract. Writers keep all their
  -- guards and explicit final synchronization; only redundant row-trigger
  -- rebuilds are deferred for this new document, within this transaction.
  previous_defer:=current_setting('nexo.defer_journal_gl_sync',true);
  perform set_config('nexo.defer_journal_gl_sync','on',true);
  begin
   if p_kind='CHECKS'then saved:=public.save_bank_check_transfer(entry->'payload',null);else saved:=public.save_bank_deposit(entry->'payload');end if;
  exception when others then
   perform set_config('nexo.defer_journal_gl_sync',coalesce(previous_defer,''),true);raise;
  end;
  perform set_config('nexo.defer_journal_gl_sync',coalesce(previous_defer,''),true);
  v_result:=entry->'summary'||jsonb_build_object('documentId',coalesce(saved->'checkId',saved->'depositId'),'journalId',saved->'journalId','number',saved->'transactionNumber');
  if v_result->>'documentId'is null or v_result->>'journalId'is null then raise exception using errcode='55000',message='El motor bancario no confirmó el documento. No se importó ningún documento.';end if;
  perform public.sync_journal_gl_impacts((v_result->>'journalId')::bigint);
  insert into banking_csv_private.documents(subsidiary_id,kind,reference,receipt_id,signature,result)values(p_subsidiary_id,p_kind,entry->>'reference',receipt,entry->>'signature',v_result);entries:=entries||jsonb_build_array(v_result);
 end loop;
 v_result:=jsonb_build_object('valid',true,'created',jsonb_array_length(entries),'alreadyImported',false,'entries',entries,'errors','[]'::jsonb,'totals',validated->'totals','context',ctx,'receiptId',receipt,'fingerprint',p_fingerprint);
 update banking_csv_private.imports set result=v_result where id=receipt;return v_result;
end$$;
revoke all on all functions in schema banking_csv_private from public,anon,authenticated,service_role;
revoke all on function public.banking_csv_preview(text,jsonb,bigint),public.banking_csv_import(text,jsonb,bigint,jsonb,text,text)from public,anon,authenticated,service_role;
grant execute on function public.banking_csv_preview(text,jsonb,bigint),public.banking_csv_import(text,jsonb,bigint,jsonb,text,text)to authenticated;
notify pgrst,'reload schema';
