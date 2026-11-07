-- Automatic journal CSV quotes with a confirmation proof and conservative
-- reference reservation. Manual journal writers and historical rows are intact.
set local lock_timeout='5s';set local statement_timeout='60s';
create schema journal_csv_private;
revoke all on schema journal_csv_private from public,anon,authenticated,service_role;
create table journal_csv_private.imports(
 id uuid primary key default gen_random_uuid(),subsidiary_id bigint not null,
 fingerprint text not null check(fingerprint~'^[0-9a-f]{64}$'),
 user_id bigint not null,role_id bigint not null,session_id text not null,
 result jsonb not null,created_at timestamptz not null default clock_timestamp(),
 unique(subsidiary_id,fingerprint)
);
create table journal_csv_private.documents(
 subsidiary_id bigint not null,reference text not null,
 reference_hash text generated always as(banking_csv_private.sha(reference))stored,
 receipt_id uuid not null references journal_csv_private.imports,
 primary key(subsidiary_id,reference_hash)
);
alter table journal_csv_private.imports enable row level security;
alter table journal_csv_private.imports force row level security;
alter table journal_csv_private.documents enable row level security;
alter table journal_csv_private.documents force row level security;
revoke all on all tables in schema journal_csv_private from public,anon,authenticated,service_role;

create function journal_csv_private.context(p_sid bigint,p_action text)returns jsonb
language plpgsql stable security definer set search_path=pg_catalog,public,pg_temp as $$
declare sid bigint;u bigint;r bigint;s text;revision text;begin
 sid:=journal_entry_private.assert_access('view');
 if p_action='create'then perform journal_entry_private.assert_access('create');
 elsif p_action is distinct from 'view'then raise exception using errcode='22023',message='Acción de importación no válida.';end if;
 if sid is null or sid is distinct from p_sid then raise exception using errcode='42501',message='La importación debe usar la subsidiaria activa.';end if;
 u:=public.app_user_id();r:=public.app_active_role_id();s:=auth.jwt()->>'session_id';
 if u is null or r is null or nullif(s,'')is null then raise exception using errcode='42501',message='Seleccione una sesión y un rol autorizados.';end if;
 select md5(coalesce((select to_jsonb(x)::text from public.user_role_sessions x where x.session_id=s and x.user_id=u),'')||':'||coalesce((select to_jsonb(x)::text from public.user_company_sessions x where x.session_id=s and x.user_id=u),''))into revision;
 return jsonb_build_object('userId',u,'roleId',r,'subsidiaryId',sid,'sessionId',s,'revision',revision);
end$$;
create function journal_csv_private.canonical_rows(p_rows jsonb)returns jsonb
language plpgsql immutable security invoker set search_path=pg_catalog as $$
begin
 if jsonb_typeof(p_rows)is distinct from 'array'or jsonb_array_length(p_rows)not between 1 and 2000 then raise exception using errcode='22023',message='El archivo debe contener entre 1 y 2000 líneas.';end if;
 if exists(select 1 from jsonb_array_elements(p_rows)x where jsonb_typeof(x)is distinct from 'object')then raise exception using errcode='22023',message='Cada línea debe tener el formato de la plantilla.';end if;
 return(select jsonb_agg(case when x->>'tipo_asiento'in('ASI_DIA','ASI_NOM','ASI_LIQ')then (x-'tipo_cambio'-'pais_servicio')||jsonb_build_object('mes_servicio','')else x-'tipo_cambio'end order by n)from jsonb_array_elements(p_rows)with ordinality z(x,n));
end$$;
create function journal_csv_private.build_batch(p_rows jsonb,p_sid bigint)returns jsonb
language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$
declare rows jsonb:=journal_csv_private.canonical_rows(p_rows);priced jsonb:='[]';quotes jsonb:='[]';errors jsonb:='[]';core jsonb;entries jsonb;grp record;first_row jsonb;currency bigint;local_currency bigint;matches integer;quote jsonb;d date;digest text;
begin
 if exists(select 1 from jsonb_array_elements(rows)x where coalesce(btrim(x->>'asiento_referencia'),'')='')then raise exception using errcode='22023',message='Todas las líneas requieren asiento_referencia.';end if;
 if(select count(distinct x->>'asiento_referencia')from jsonb_array_elements(rows)x)>200 then raise exception using errcode='22023',message='Se admiten hasta 200 asientos por archivo.';end if;
 select currency_id into local_currency from public.subsidiaries where subsidiary_id=p_sid;
 for grp in select x->>'asiento_referencia' reference,jsonb_agg(x order by n)items,min(n)::integer+1 first_number from jsonb_array_elements(rows)with ordinality z(x,n)group by x->>'asiento_referencia'order by min(n)loop
  begin
   if exists(select 1 from journal_csv_private.documents where subsidiary_id=p_sid and reference_hash=banking_csv_private.sha(grp.reference)and reference<>grp.reference)then
    raise exception using errcode='22023',message='Existe un conflicto con la identidad de la referencia. No se importó el asiento.';end if;
   if exists(select 1 from journal_csv_private.documents where subsidiary_id=p_sid and reference_hash=banking_csv_private.sha(grp.reference)and reference=grp.reference)
    or exists(select 1 from public.journal_csv_imports h cross join lateral jsonb_array_elements(coalesce(h.result->'entries','[]'::jsonb))e where h.subsidiary_id=p_sid and e->>'reference'=grp.reference)then
    raise exception using errcode='22023',message='La referencia del asiento ya fue importada. Consulte su comprobante o use una referencia nueva para una operación nueva.';end if;
   first_row:=grp.items->0;
   if coalesce(first_row->>'fecha','')!~'^[0-9]{4}-[0-9]{2}-[0-9]{2}$'then raise exception using errcode='22023',message='La fecha debe tener formato AAAA-MM-DD.';end if;
   d:=(first_row->>'fecha')::date;
   select count(*),min(c.currency_id)into matches,currency from public.currencies c where c.currency_code=first_row->>'moneda'and(c.currency_id=local_currency or exists(select 1 from public.subsidiary_currencies a where a.subsidiary_id=p_sid and a.currency_id=c.currency_id));
   if matches<>1 then raise exception using errcode='22023',message='La moneda no está permitida de forma única para la subsidiaria.';end if;
   quote:=banking_csv_private.check_rate(currency,local_currency,d);
   quotes:=quotes||jsonb_build_array(jsonb_build_object('reference',grp.reference,'metadata',quote));
   priced:=priced||(select jsonb_agg(x||jsonb_build_object('tipo_cambio',quote->>'exchangeRate')order by n)from jsonb_array_elements(grp.items)with ordinality z(x,n));
  exception when others then
   errors:=errors||jsonb_build_array(jsonb_build_object('reference',grp.reference,'row',grp.first_number,'field','moneda','code',case when sqlstate in('22023','22007','22008')then sqlstate else 'INTERNAL'end,'message',case when sqlstate in('22023','22007','22008')then sqlerrm else 'No fue posible resolver la tasa automática. Revise moneda, fecha y catálogo.'end));
  end;
 end loop;
 if jsonb_array_length(errors)>0 then return jsonb_build_object('valid',false,'created',0,'errors',errors,'entries','[]'::jsonb,'pricedRows',priced,'quotes',quotes);end if;
 -- Preserve original row ordinals, including interleaved journal groups.
 select jsonb_agg(x||jsonb_build_object('tipo_cambio',(select q->'metadata'->>'exchangeRate'from jsonb_array_elements(quotes)q where q->>'reference'=x->>'asiento_referencia'))order by n)into priced from jsonb_array_elements(rows)with ordinality z(x,n);
 core:=journal_entry_private.import_journal_csv(priced,true,p_sid);
 select coalesce(jsonb_agg(e||(select (q->'metadata')-'rateId'-'sourceRate'from jsonb_array_elements(quotes)q where q->>'reference'=e->>'reference')order by n),'[]'::jsonb)into entries from jsonb_array_elements(core->'entries')with ordinality z(e,n);
 digest:=banking_csv_private.sha(jsonb_build_object('resolvedDigest',core->'resolvedDigest','quotes',quotes)::text);
 return (core-'resolvedDigest')||jsonb_build_object('entries',entries,'pricedRows',priced,'quotes',quotes,'coreDigest',core->'resolvedDigest','validationDigest',digest);
end$$;

-- Patch only the reviewed CSV core: ten-decimal generated quotes, complete
-- resolved-batch digest and its pre-writer comparison. No posting body changes.
do $journal_automatic_rate_core$
declare target regprocedure;definition text;needle text;replacement text;item record;begin
 for item in select *from(values
  ('journal_entry_private.import_journal_csv(jsonb,boolean,bigint)','c27ac3fb19a965abb92da097d4441708'),
  ('public.import_journal_csv_before_lookup_cache(jsonb,boolean,bigint)','fbd63e3ce135cf6c85811ef92fbcf88c'),
  ('banking_csv_private.check_rate(bigint,bigint,date)','e961ad308b21323a571108ab37fdc9a2')
 )v(signature,source_md5)loop
  if md5((select prosrc from pg_proc where oid=item.signature::regprocedure))is distinct from item.source_md5 then raise exception 'Reviewed journal CSV dependency changed: %',item.signature;end if;
 end loop;
 target:='public.import_journal_csv_before_automatic_service_month(jsonb,boolean,bigint)'::regprocedure;
 if md5((select prosrc from pg_proc where oid=target))is distinct from '8f99c51b059838ee5b426eb09b9d61e1'then raise exception 'Reviewed journal CSV core changed';end if;
 definition:=pg_get_functiondef(target);
 needle:='  file_fingerprint text;';replacement:='  file_fingerprint text;'||chr(10)||'  resolved_digest text;';
 if (length(definition)-length(replace(definition,needle,'')))/length(needle)<>1 then raise exception 'Reviewed journal digest declaration changed';end if;definition:=replace(definition,needle,replacement);
 needle:=$old$if coalesce(first_row->>'tipo_cambio','') !~ '^[0-9]{1,12}(\.[0-9]{1,6})?$' then
        raise exception 'Tipo de cambio inválido: use punto decimal y hasta seis decimales.';$old$;
 replacement:=$new$if coalesce(first_row->>'tipo_cambio','') !~ '^[0-9]{1,12}(\.[0-9]{1,10})?$' then
        raise exception 'La tasa automática no puede representarse con diez decimales. Revise el catálogo.';$new$;
 if (length(definition)-length(replace(definition,needle,'')))/length(needle)<>1 then raise exception 'Reviewed journal rate precision changed';end if;definition:=replace(definition,needle,replacement);
 needle:=$old$      summary:=summary||jsonb_build_array(jsonb_build_object(
        'reference',grp.reference,$old$;
 replacement:=$new$      perform journal_entry_private.validate_payload(batch->(jsonb_array_length(batch)-1)->'payload',sid);
      summary:=summary||jsonb_build_array(jsonb_build_object(
        'reference',grp.reference,$new$;
 if (length(definition)-length(replace(definition,needle,'')))/length(needle)<>1 then raise exception 'Reviewed journal validation boundary changed';end if;definition:=replace(definition,needle,replacement);
 needle:=$old$  if p_preview then
    return jsonb_build_object('valid',true,'created',0,'entries',summary,'errors','[]'::jsonb);
  end if;

  summary:='[]';$old$;
 replacement:=$new$  resolved_digest:=encode(sha256(convert_to(jsonb_build_object(
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

  summary:='[]';$new$;
 if (length(definition)-length(replace(definition,needle,'')))/length(needle)<>1 then raise exception 'Reviewed journal pre-post boundary changed';end if;definition:=replace(definition,needle,replacement);
 execute definition;
end$journal_automatic_rate_core$;

create function public.journal_csv_preview(p_rows jsonb,p_subsidiary_id bigint)returns jsonb
language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$
declare ctx jsonb:=journal_csv_private.context(p_subsidiary_id,'view');rows jsonb:=journal_csv_private.canonical_rows(p_rows);fp text:=banking_csv_private.sha(rows::text);previous jsonb;built jsonb;begin
 select result into previous from journal_csv_private.imports where subsidiary_id=p_subsidiary_id and fingerprint=fp;
 if previous is not null then return previous||jsonb_build_object('created',0,'alreadyImported',true,'context',ctx,'fingerprint',fp);end if;
 built:=journal_csv_private.build_batch(rows,p_subsidiary_id);
 return (built-'pricedRows'-'quotes'-'coreDigest')||jsonb_build_object('context',ctx,'fingerprint',fp,'alreadyImported',false,'validationDigest',banking_csv_private.sha(jsonb_build_object('batch',built->'validationDigest','context',ctx,'fingerprint',fp)::text));
end$$;
create function public.journal_csv_import(p_rows jsonb,p_subsidiary_id bigint,p_expected_context jsonb,p_fingerprint text,p_validation_digest text)returns jsonb
language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$
declare ctx jsonb:=journal_csv_private.context(p_subsidiary_id,'create');rows jsonb:=journal_csv_private.canonical_rows(p_rows);fp text:=banking_csv_private.sha(rows::text);previous jsonb;built jsonb;result jsonb;expected text;ref text;receipt uuid:=gen_random_uuid();old_digest text:=current_setting('nexo.journal_csv_expected_digest',true);begin
 if ctx is distinct from p_expected_context then raise exception using errcode='42501',message='La sesión, rol o empresa cambió. Valide nuevamente.';end if;
 if fp is distinct from p_fingerprint then raise exception using errcode='22023',message='El archivo cambió. Valide nuevamente.';end if;
 perform pg_advisory_xact_lock(hashtextextended('journal_csv_v2:'||p_subsidiary_id||':'||fp,0));
 select i.result into previous from journal_csv_private.imports i where i.subsidiary_id=p_subsidiary_id and i.fingerprint=fp;
 if previous is not null then return previous||jsonb_build_object('created',0,'alreadyImported',true,'context',ctx);end if;
 for ref in select distinct x->>'asiento_referencia'from jsonb_array_elements(rows)x order by 1 loop
  perform pg_advisory_xact_lock(hashtextextended('journal_csv_reference:'||p_subsidiary_id||':'||banking_csv_private.sha(coalesce(ref,'')),0));
 end loop;
 built:=journal_csv_private.build_batch(rows,p_subsidiary_id);
 if not coalesce((built->>'valid')::boolean,false)then raise exception using errcode='55000',message='La validación dejó de ser válida. Valide nuevamente antes de importar.';end if;
 expected:=banking_csv_private.sha(jsonb_build_object('batch',built->'validationDigest','context',ctx,'fingerprint',fp)::text);
 if expected is distinct from p_validation_digest then raise exception using errcode='55000',message='La tasa, cuenta, dimensión o período cambió. Valide nuevamente antes de importar.';end if;
 begin
  perform set_config('nexo.journal_csv_expected_digest',built->>'coreDigest',true);
  result:=journal_entry_private.import_journal_csv(built->'pricedRows',false,p_subsidiary_id);
  perform set_config('nexo.journal_csv_expected_digest',coalesce(old_digest,''),true);
 exception when others then
  perform set_config('nexo.journal_csv_expected_digest',coalesce(old_digest,''),true);raise;
 end;
 if not coalesce((result->>'valid')::boolean,false)or coalesce((result->>'alreadyImported')::boolean,false)then raise exception using errcode='55000',message='El lote cambió o ya fue importado. Valide nuevamente.';end if;
 result:=result||jsonb_build_object('entries',(select jsonb_agg(e||s order by n)from jsonb_array_elements(result->'entries')with ordinality z(e,n)cross join lateral(select x from jsonb_array_elements(built->'entries')x where x->>'reference'=e->>'reference')y(s)),'receiptId',receipt,'fingerprint',fp,'context',ctx,'validationDigest',expected);
 insert into journal_csv_private.imports(id,subsidiary_id,fingerprint,user_id,role_id,session_id,result)values(receipt,p_subsidiary_id,fp,(ctx->>'userId')::bigint,(ctx->>'roleId')::bigint,ctx->>'sessionId',result);
 insert into journal_csv_private.documents(subsidiary_id,reference,receipt_id)select p_subsidiary_id,x->>'asiento_referencia',receipt from jsonb_array_elements(rows)x group by x->>'asiento_referencia';
 return result;
end$$;

-- Preserve the public OID/ACL/owner/config; old clients cannot bypass proof.
do $journal_automatic_rate_public$
declare target regprocedure:='public.import_journal_csv(jsonb,boolean,bigint)'::regprocedure;definition text;needle text;begin
 if md5((select prosrc from pg_proc where oid=target))is distinct from '32ea01bcbeee829c128c49148321c455'then raise exception 'Reviewed public journal CSV guard changed';end if;
 definition:=pg_get_functiondef(target);
 needle:=' return journal_entry_private.import_journal_csv(p_rows,p_preview,p_subsidiary_id);';
 if (length(definition)-length(replace(definition,needle,'')))/length(needle)<>1 then raise exception 'Reviewed public journal CSV delegation changed';end if;
 execute replace(definition,needle,$new$ if p_preview is distinct from true then raise exception using errcode='55000',message='Actualice el importador y valide el archivo antes de confirmar la importación.';end if;
 return public.journal_csv_preview(p_rows,p_subsidiary_id);$new$);
end$journal_automatic_rate_public$;
revoke all on all functions in schema journal_csv_private from public,anon,authenticated,service_role;
revoke all on function public.journal_csv_preview(jsonb,bigint),public.journal_csv_import(jsonb,bigint,jsonb,text,text)from public,anon,authenticated,service_role;
grant execute on function public.journal_csv_preview(jsonb,bigint),public.journal_csv_import(jsonb,bigint,jsonb,text,text)to authenticated;
notify pgrst,'reload schema';
