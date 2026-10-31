-- C-04 supplier credit/debit notes. Preserve accounting engines behind guards.
set local lock_timeout='5s';set local statement_timeout='60s';
create schema supplier_note_private;
revoke all on schema supplier_note_private from public,anon,authenticated,service_role;
grant usage on schema supplier_note_private to authenticated;
create function supplier_note_private.resource(k text) returns text language plpgsql immutable set search_path=pg_catalog as $$begin
 if k is null or k not in('CREDIT','DEBIT') then raise exception using errcode='22023',message='Tipo de nota inválido.';end if;
 return case k when 'CREDIT' then 'purchasing:supplier-credit-notes' else 'purchasing:supplier-debit-notes' end;
end$$;
create function supplier_note_private.context(k text) returns jsonb language plpgsql stable security definer set search_path=pg_catalog,public,pg_temp as $$
declare r text:=supplier_note_private.resource(k);v boolean;c boolean;e boolean;begin
 perform asset_posting_private.identity();v:=asset_posting_private.allowed(r,'view');c:=asset_posting_private.allowed(r,'create');e:=asset_posting_private.allowed(r,'edit');
 if not(v or c or e) then raise exception using errcode='42501',message='No tiene acceso a este tipo de nota de proveedor.';end if;
 return jsonb_build_object('canView',v,'canCreate',c,'canEdit',e);
end$$;
alter function public.save_supplier_note(text,jsonb,bigint) set schema supplier_note_private;
alter function public.save_supplier_note_before_payable_routing(text,jsonb,bigint) set schema supplier_note_private;
alter function public.supplier_credit_note_available_balance(bigint,bigint) set schema supplier_note_private;
do $$declare body text;begin
 body:=pg_get_functiondef('supplier_note_private.save_supplier_note(text,jsonb,bigint)'::regprocedure);
 if position('public.save_supplier_note_before_payable_routing(' in body)=0 then raise exception 'Unexpected note writer';end if;
 execute replace(body,'public.save_supplier_note_before_payable_routing(','supplier_note_private.save_supplier_note_before_payable_routing(');
end$$;
create function supplier_note_private.visible(k text,nid bigint) returns boolean language plpgsql stable security definer set search_path=pg_catalog,public,pg_temp as $$begin
 if k not in('CREDIT','DEBIT') or k is null then return false;end if;
 return asset_posting_private.allowed(supplier_note_private.resource(k),'view') and exists(
 select 1 from (select invoice_id from public.supplier_credit_note where k='CREDIT' and cn_id=nid union all select invoice_id from public.supplier_debit_note where k='DEBIT' and dn_id=nid)n join public.supplier_invoice i using(invoice_id) where i.subsidiary_id=asset_posting_private.identity());
end$$;
create function supplier_note_private.prepare(k text,p jsonb,nid bigint) returns jsonb language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$
declare sid bigint:=asset_posting_private.access(supplier_note_private.resource(k),case when nid is null then 'create' else 'edit' end);i public.supplier_invoice;n record;l jsonb;field text;tax_id bigint;tax_rate numeric;tax_account bigint;rate numeric;total numeric:=0;normalized jsonb:='[]';begin
 if p is null or jsonb_typeof(p)<>'object' or jsonb_typeof(p->'lines') is distinct from 'array' or jsonb_array_length(p->'lines') not between 1 and 1000 then raise exception using errcode='22023',message='La nota requiere entre 1 y 1000 líneas.';end if;
 if p ?| array['subsidiary_id','supplier_id','transaction_id','journal_id','location_id','amount','payable_account_id','is_opening_balance','opening_run_id'] then raise exception using errcode='42501',message='No puede sustituir el origen de la nota.';end if;
 select * into i from public.supplier_invoice where invoice_id=(p->>'invoice_id')::bigint and subsidiary_id=sid;
 if not found then raise exception using errcode='42501',message='Factura no disponible en la subsidiaria activa.';end if;
 -- Same parent lock order as invoice editing; serializes balance and payable snapshot.
 perform 1 from public."transaction" where transaction_id=i.transaction_id for update;
 perform 1 from public.journal where journal_id=i.journal_id for update;
 select * into i from public.supplier_invoice where invoice_id=i.invoice_id and subsidiary_id=sid for update;
 if not found then raise exception using errcode='42501',message='Factura no disponible.';end if;
 if not coalesce(i.is_opening_balance,false) and not exists(select 1 from public.journal j join public."transaction" t on t.transaction_id=i.transaction_id join public.transaction_types tt using(transaction_type_id) where j.journal_id=i.journal_id and j.transaction_id=t.transaction_id and tt.abbreviation='FAC_PRO' and j.status='CONTABILIZADO' and j.subsidiary_id=sid and t.subsidiary_id=sid and j.currency_id=i.currency_id and t.currency_id=i.currency_id)
 or exists(select 1 from public.journal where reversed_from_journal_id=i.journal_id) then raise exception using errcode='55000',message='El origen de la factura requiere revisión.';end if;
 if not exists(select 1 from public.suppliers s join public.entity_subsidiaries e using(supplier_id) where s.supplier_id=i.supplier_id and e.subsidiary_id=sid and not s.is_inactive) then raise exception using errcode='42501',message='Proveedor no disponible.';end if;
 if i.location_id is not null and not exists(select 1 from public.locations l join public.location_subsidiaries ls using(location_id) where l.location_id=i.location_id and ls.subsidiary_id=sid) then raise exception using errcode='42501',message='Ubicación no disponible.';end if;
 if (p->>'currency_id')::bigint is distinct from i.currency_id or not exists(select 1 from public.subsidiary_currencies where subsidiary_id=sid and currency_id=i.currency_id) then raise exception using errcode='42501',message='La nota debe conservar la moneda de la factura.';end if;
 rate:=(p->>'exchange_rate')::numeric;if not asset_posting_private.finite(rate) or rate<=0 or (i.currency_id=(select currency_id from public.subsidiaries where subsidiary_id=sid) and rate<>1) then raise exception using errcode='22023',message='Tipo de cambio inválido.';end if;
 if nullif(trim(p->>'note_number'),'') is null then raise exception using errcode='22023',message='Indique el número de nota.';end if;
 perform supplier_invoice_private.period((p->>'fiscal_period_id')::bigint,(p->>'note_date')::date);
 if nid is not null then
  select * into n from (select cn_id id,invoice_id,transaction_id,journal_id,supplier_id,currency_id,fiscal_period_id,note_date,exchange_rate from public.supplier_credit_note where k='CREDIT' and cn_id=nid union all select dn_id,invoice_id,transaction_id,journal_id,supplier_id,currency_id,fiscal_period_id,note_date,exchange_rate from public.supplier_debit_note where k='DEBIT' and dn_id=nid)x;
  if not found or n.invoice_id is distinct from i.invoice_id or n.supplier_id is distinct from i.supplier_id then raise exception using errcode='42501',message='Nota no disponible para esta factura.';end if;
  perform 1 from public."transaction" where transaction_id=n.transaction_id for update;perform 1 from public.journal where journal_id=n.journal_id for update;
  if k='CREDIT' then perform 1 from public.supplier_credit_note where cn_id=nid for update;else perform 1 from public.supplier_debit_note where dn_id=nid for update;end if;
  if not exists(select 1 from public.journal j join public."transaction" t on t.transaction_id=n.transaction_id join public.transaction_types tt using(transaction_type_id) where j.journal_id=n.journal_id and j.transaction_id=t.transaction_id and j.subsidiary_id=sid and t.subsidiary_id=sid and tt.abbreviation=case k when 'CREDIT' then 'NC_PRO' else 'ND_PRO' end and j.status='CONTABILIZADO' and j.currency_id=n.currency_id and t.currency_id=n.currency_id and n.currency_id=i.currency_id and j.fiscal_period_id=n.fiscal_period_id and t.fiscal_period_id=n.fiscal_period_id and j.journal_date=n.note_date and t.tran_date=n.note_date and j.exchange_rate=n.exchange_rate and t.exchange_rate=n.exchange_rate)
  or exists(select 1 from public.journal where reversed_from_journal_id=n.journal_id)
  or exists(select 1 from public.supplier_payment_application where invoice_id=i.invoice_id)
  or exists(select 1 from public.supplier_payment_withholding where invoice_id=i.invoice_id)
  or exists(select 1 from public.solicitudes_pago_lineas where id_factura_proveedor=i.invoice_id)
  or exists(select 1 from public.treasury_schedule where supplier_invoice_id=i.invoice_id)
  or exists(select 1 from public.supplier_credit_note where invoice_id=i.invoice_id and (k<>'CREDIT' or cn_id<>nid))
  or exists(select 1 from public.supplier_debit_note where invoice_id=i.invoice_id and (k<>'DEBIT' or dn_id<>nid))
  or exists(select 1 from public.activos_fijos_propuestas where transaction_id=n.transaction_id and status<>'PENDIENTE')
  then raise exception using errcode='55000',message='La nota tiene origen protegido, pagos u otros procesos; conserva su historial.';end if;
  perform supplier_invoice_private.period(n.fiscal_period_id,n.note_date);
 end if;
 for l in select value from jsonb_array_elements(p->'lines') loop
  if jsonb_typeof(l)<>'object' then raise exception using errcode='22023',message='Línea inválida.';end if;
  foreach field in array array['amount','tax_rate','tax_amount','gross_amount'] loop if l?field and not asset_posting_private.finite((l->>field)::numeric) then raise exception using errcode='22023',message='Los importes deben ser finitos.';end if;end loop;
  if not asset_posting_private.finite((l->>'amount')::numeric) or (l->>'amount')::numeric<=0 then raise exception using errcode='22023',message='Importe inválido.';end if;
  perform asset_posting_private.account((l->>'account_id')::bigint);perform asset_posting_private.dimensions(nullif(l->>'department_id','')::bigint,nullif(l->>'cost_center_id','')::bigint,nullif(l->>'class_id','')::bigint);
  if nullif(l->>'financial_creditor_id','') is not null and not exists(select 1 from public.financial_creditors f join public.financial_creditor_subsidiaries s using(financial_creditor_id) where f.financial_creditor_id=(l->>'financial_creditor_id')::bigint and s.subsidiary_id=sid and not f.is_inactive) then raise exception using errcode='42501',message='Acreedor no disponible.';end if;
  if nullif(l->>'related_company_id','') is not null and not exists(select 1 from public.related_companies r join public.related_company_subsidiaries s using(related_company_id) where r.related_company_id=(l->>'related_company_id')::bigint and s.subsidiary_id=sid and not r.is_inactive) then raise exception using errcode='42501',message='Compañía relacionada no disponible.';end if;
  tax_id:=nullif(l->>'tax_code_id','')::bigint;tax_rate:=0;
  if tax_id is not null then select tc.rate_percentage,tt.asset_account_id into tax_rate,tax_account from public.tax_codes tc join public.tax_types tt using(tax_type_id) where tc.tax_code_id=tax_id and not tc.is_withholding and tt.applies_to in('Compras','Ambos') and exists(select 1 from public.tax_code_subsidiaries s where s.tax_code_id=tc.tax_code_id and s.subsidiary_id=sid);
   if not found then raise exception using errcode='42501',message='Impuesto de compra no autorizado.';end if;
   if not asset_posting_private.finite(tax_rate) or tax_rate not between 0 and 100 then raise exception using errcode='22023',message='Tasa inválida.';end if;if tax_rate>0 then perform asset_posting_private.account(tax_account);end if;
  end if;
  if l?'tax_rate' and (l->>'tax_rate')::numeric is distinct from tax_rate then raise exception using errcode='22023',message='La tasa debe coincidir con el impuesto configurado.';end if;
  total:=total+(l->>'amount')::numeric+round((l->>'amount')::numeric*tax_rate/100,6);normalized:=normalized||jsonb_build_array(l||jsonb_build_object('tax_rate',tax_rate));
 end loop;
 if k='CREDIT' and total>supplier_note_private.supplier_credit_note_available_balance(i.invoice_id,nid)+0.000001 then raise exception using errcode='55000',message='La nota supera el saldo pendiente de la factura.';end if;
 perform asset_posting_private.account(public.ensure_supplier_invoice_payable_account(i.invoice_id));
 return p||jsonb_build_object('lines',normalized);
end$$;
create function public.save_supplier_note(p_kind text,p_payload jsonb,p_target_id bigint default null) returns jsonb language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$begin return supplier_note_private.save_supplier_note(p_kind,supplier_note_private.prepare(p_kind,p_payload,p_target_id),p_target_id);end$$;
create function public.supplier_note_access(p_kind text) returns jsonb language sql stable security definer set search_path=pg_catalog,public,pg_temp as $$select supplier_note_private.context(p_kind)$$;
create function public.supplier_credit_note_available_balance(p_invoice_id bigint,p_exclude_cn_id bigint default null) returns numeric language plpgsql stable security definer set search_path=pg_catalog,public,pg_temp as $$
declare ctx jsonb:=supplier_note_private.context('CREDIT');begin
 if not exists(select 1 from public.supplier_invoice where invoice_id=p_invoice_id and subsidiary_id=asset_posting_private.identity()) or (p_exclude_cn_id is not null and not exists(select 1 from public.supplier_credit_note where cn_id=p_exclude_cn_id and invoice_id=p_invoice_id)) then raise exception using errcode='42501',message='Factura o nota no disponible.';end if;
 if not((ctx->>'canCreate')::boolean or (ctx->>'canEdit')::boolean) and not exists(select 1 from public.supplier_credit_note where invoice_id=p_invoice_id) then raise exception using errcode='42501',message='La factura no corresponde a una nota consultable.';end if;
 return supplier_note_private.supplier_credit_note_available_balance(p_invoice_id,p_exclude_cn_id);
end$$;
create function public.supplier_note_options(p_kind text) returns jsonb language plpgsql stable security definer set search_path=pg_catalog,public,pg_temp as $$
declare ctx jsonb:=supplier_note_private.context(p_kind);sid bigint:=asset_posting_private.identity();ids bigint[];begin
 select array_agg(i.invoice_id) into ids from public.supplier_invoice i where i.subsidiary_id=sid and ((ctx->>'canCreate')::boolean or (ctx->>'canEdit')::boolean or exists(select 1 from public.supplier_credit_note where p_kind='CREDIT' and invoice_id=i.invoice_id) or exists(select 1 from public.supplier_debit_note where p_kind='DEBIT' and invoice_id=i.invoice_id));
 return jsonb_build_object('invoices',coalesce((select jsonb_agg(jsonb_build_object('invoice_id',i.invoice_id,'invoice_number',i.invoice_number,'supplier_id',i.supplier_id,'subsidiary_id',i.subsidiary_id,'location_id',i.location_id,'currency_id',i.currency_id,'exchange_rate',i.exchange_rate,'memo',i.memo,'invoice_type',i.invoice_type,'payable_account_id',i.payable_account_id,'pending',supplier_note_private.supplier_credit_note_available_balance(i.invoice_id,null))) from public.supplier_invoice i where i.invoice_id=any(ids)),'[]'::jsonb),'invoiceLines',coalesce((select jsonb_agg(jsonb_build_object('invoice_id',l.invoice_id,'account_id',l.account_id,'amount',l.amount,'tax_code_id',l.tax_code_id,'tax_rate',l.tax_rate,'tax_amount',l.tax_amount,'gross_amount',l.gross_amount,'note',l.note,'department_id',l.department_id,'cost_center_id',l.cost_center_id,'class_id',l.class_id,'financial_creditor_id',l.financial_creditor_id,'related_company_id',l.related_company_id)) from public.supplier_invoice_line l where l.invoice_id=any(ids)),'[]'::jsonb));
end$$;
do $$declare t text;p record;c record;begin foreach t in array array['supplier_credit_note','supplier_debit_note','supplier_note_line'] loop
 execute format('alter table public.%I enable row level security',t);for p in select policyname from pg_policies where schemaname='public' and tablename=t loop execute format('drop policy %I on public.%I',p.policyname,t);end loop;
 execute format('revoke all on public.%I from public,anon,authenticated,service_role',t);
 for c in select column_name from information_schema.columns where table_schema='public' and table_name=t loop execute format('revoke all (%I) on public.%I from public,anon,authenticated,service_role',c.column_name,t);end loop;
 execute format('grant select on public.%I to authenticated',t);
end loop;end$$;
create policy supplier_credit_note_read on public.supplier_credit_note for select to authenticated using(supplier_note_private.visible('CREDIT',cn_id));
create policy supplier_debit_note_read on public.supplier_debit_note for select to authenticated using(supplier_note_private.visible('DEBIT',dn_id));
create policy supplier_note_line_read on public.supplier_note_line for select to authenticated using(supplier_note_private.visible(note_kind,note_id));
revoke all on all functions in schema supplier_note_private from public,anon,authenticated,service_role;
grant execute on function supplier_note_private.visible(text,bigint) to authenticated;
revoke all on function public.save_supplier_note(text,jsonb,bigint),public.supplier_note_access(text),public.supplier_note_options(text),public.supplier_credit_note_available_balance(bigint,bigint),public.validate_supplier_credit_note_balance() from public,anon,authenticated,service_role;
grant execute on function public.save_supplier_note(text,jsonb,bigint),public.supplier_note_access(text),public.supplier_note_options(text),public.supplier_credit_note_available_balance(bigint,bigint) to authenticated;
notify pgrst,'reload schema';
