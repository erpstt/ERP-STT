-- C-04: supplier invoice entry, historical writers, budgets and related reads.
set local lock_timeout='5s';set local statement_timeout='60s';
create schema supplier_invoice_private;
revoke all on schema supplier_invoice_private from public,anon,authenticated,service_role;
grant usage on schema supplier_invoice_private to authenticated;
create function supplier_invoice_private.assert_write(p_id bigint) returns bigint language plpgsql stable security definer set search_path=pg_catalog,public,pg_temp as $$
declare sid bigint:=asset_posting_private.access('purchasing:supplier-invoices',case when p_id is null then 'create' else 'edit' end);permission_code text:=case when p_id is null then 'purchasing:supplier-invoice:create' else 'purchasing:supplier-invoice:update' end;begin
 if not exists(select 1 from public.role_permissions rp join public.permissions p using(permission_id) where rp.role_id=public.app_active_role_id() and p.code=permission_code) then raise exception using errcode='42501',message='El rol activo no tiene el permiso técnico para contabilizar esta factura.';end if;return sid;
end$$;
create function supplier_invoice_private.period(p_id bigint,p_date date) returns void language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$begin
 perform 1 from public.fiscal_periods where fiscal_period_id=p_id and subsidiary_id=asset_posting_private.identity() and p_date between start_date and end_date and not is_closed and not coalesce(gl_closed,false) and not coalesce(ap_closed,false) and not coalesce(is_inactive,false) for share;
 if not found then raise exception using errcode='55000',message='La fecha requiere un período de Compras y GL abierto.';end if;
end$$;
create function supplier_invoice_private.editable(p_id bigint) returns void language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$
declare r public.supplier_invoice;sid bigint:=asset_posting_private.identity();begin
 select * into r from public.supplier_invoice where invoice_id=p_id and subsidiary_id=sid;
 if not found then raise exception using errcode='42501',message='Factura no disponible en la subsidiaria activa.';end if;
 perform 1 from public."transaction" where transaction_id=r.transaction_id for update;
 perform 1 from public.journal where journal_id=r.journal_id for update;
 perform 1 from public.supplier_invoice where invoice_id=p_id and subsidiary_id=sid for update;
 select * into r from public.supplier_invoice where invoice_id=p_id and subsidiary_id=sid;
 if not found then raise exception using errcode='42501',message='Factura no disponible.';end if;
 if r.is_opening_balance or r.opening_run_id is not null or r.opening_balance_line_id is not null or r.purchase_receipt_document_id is not null
 or exists(select 1 from public.supplier_payment_application where invoice_id=p_id)
 or exists(select 1 from public.supplier_credit_note where invoice_id=p_id)
 or exists(select 1 from public.supplier_debit_note where invoice_id=p_id)
 or exists(select 1 from public.supplier_payment_withholding where invoice_id=p_id)
 or exists(select 1 from public.solicitudes_pago_lineas where id_factura_proveedor=p_id)
 or exists(select 1 from public.treasury_schedule where supplier_invoice_id=p_id)
 or exists(select 1 from public.activos_fijos_propuestas where transaction_id=r.transaction_id and status<>'PENDIENTE')
 then raise exception using errcode='55000',message='La factura tiene apertura, pagos, notas, recepción o procesos relacionados; conserva su historial.';end if;
 if not exists(select 1 from public.journal j join public."transaction" t on t.transaction_id=r.transaction_id join public.transaction_types tt using(transaction_type_id) where j.journal_id=r.journal_id and j.transaction_id=t.transaction_id and j.subsidiary_id=sid and t.subsidiary_id=sid and tt.abbreviation='FAC_PRO' and j.journal_type='Factura de proveedor' and j.status='CONTABILIZADO' and j.currency_id=r.currency_id and t.currency_id=r.currency_id and j.fiscal_period_id=r.fiscal_period_id and t.fiscal_period_id=r.fiscal_period_id and j.journal_date=r.invoice_date and t.tran_date=r.invoice_date and j.exchange_rate=r.exchange_rate and t.exchange_rate=r.exchange_rate)
 or exists(select 1 from public.journal where reversed_from_journal_id=r.journal_id) then raise exception using errcode='55000',message='El origen contable de la factura requiere revisión.';end if;
 perform supplier_invoice_private.period(r.fiscal_period_id,r.invoice_date);
end$$;

-- Preserve existing engines and route their internal calls explicitly.
alter function public.save_supplier_invoice(jsonb,bigint) set schema supplier_invoice_private;
alter function public.save_supplier_invoice_without_budget(jsonb,bigint) set schema supplier_invoice_private;
alter function public.save_supplier_invoice_without_budget_before_payable_routing(jsonb,bigint) set schema supplier_invoice_private;
alter function public.save_supplier_invoice_without_withholding(jsonb,bigint) set schema supplier_invoice_private;
alter function public.normalize_supplier_invoice_quantities(jsonb) set schema supplier_invoice_private;
alter function public.run_purchase_transaction_report(jsonb) set schema supplier_invoice_private;
alter function public.purchase_transaction_support(bigint) set schema supplier_invoice_private;
alter function public.settled_supplier_invoice_report_options() set schema supplier_invoice_private;
alter function public.run_settled_supplier_invoice_report(jsonb) set schema supplier_invoice_private;
do $$declare f regprocedure;body text;name text;begin
 for f in select p.oid::regprocedure from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='supplier_invoice_private' loop
  execute format('alter function %s set search_path=pg_catalog,public,pg_temp',f);body:=pg_get_functiondef(f);
  foreach name in array array['save_supplier_invoice_without_budget_before_payable_routing','save_supplier_invoice_without_withholding','save_supplier_invoice_without_budget','normalize_supplier_invoice_quantities','settled_supplier_invoice_report_options'] loop
   body:=replace(body,'public.'||name||'(','supplier_invoice_private.'||name||'(');body:=regexp_replace(body,'(?<![a-zA-Z0-9_.])'||name||'\(','supplier_invoice_private.'||name||'(','g');
  end loop;execute body;
 end loop;
end$$;
create function supplier_invoice_private.prepare(p jsonb,p_id bigint) returns jsonb language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$
declare sid bigint:=supplier_invoice_private.assert_write(p_id);line jsonb;normalized jsonb;field text;rate numeric;tax_rate numeric;tax_id bigint;tax_account bigint;receipt public.purchase_document;receipt_number text;rule record;payable bigint;
begin
 if p is null or jsonb_typeof(p)<>'object' or jsonb_typeof(p->'lines') is distinct from 'array' or jsonb_array_length(p->'lines') not between 1 and 1000 then raise exception using errcode='22023',message='La factura requiere entre 1 y 1000 líneas.';end if;
 if p?'subsidiary_id' and(p->>'subsidiary_id')::bigint is distinct from sid or p ?| array['is_opening_balance','opening_run_id','opening_balance_line_id','journal_id','transaction_id','payable_account_id'] then raise exception using errcode='42501',message='No puede sustituir la subsidiaria ni el origen contable.';end if;
 if p_id is not null then perform supplier_invoice_private.editable(p_id);end if;
 perform supplier_invoice_private.period((p->>'fiscal_period_id')::bigint,(p->>'invoice_date')::date);
 if not exists(select 1 from public.suppliers s join public.entity_subsidiaries e using(supplier_id) where s.supplier_id=(p->>'supplier_id')::bigint and e.subsidiary_id=sid and not s.is_inactive) then raise exception using errcode='42501',message='Proveedor no disponible en la subsidiaria activa.';end if;
 if not exists(select 1 from public.subsidiary_currencies where subsidiary_id=sid and currency_id=(p->>'currency_id')::bigint) then raise exception using errcode='42501',message='Moneda no habilitada.';end if;
 rate:=coalesce(nullif(p->>'exchange_rate','')::numeric,1);
 if not asset_posting_private.finite(rate) or rate<=0 or((p->>'currency_id')::bigint=(select currency_id from public.subsidiaries where subsidiary_id=sid) and rate<>1) then raise exception using errcode='22023',message='Tipo de cambio inválido.';end if;
 if nullif(trim(p->>'invoice_number'),'') is null or p->>'invoice_type' is null or p->>'invoice_type' not in('Factura estándar','Factura Expense','Factura Tarjeta','Factura Caja Chica','Factura Activos Fijos') or not exists(select 1 from public.payment_terms where term_id=(p->>'payment_term_id')::bigint) then raise exception using errcode='22023',message='Revise número, tipo y términos de pago.';end if;
 for line in select value from jsonb_array_elements(p->'lines') loop
  if jsonb_typeof(line)<>'object' then raise exception using errcode='22023',message='Línea inválida.';end if;
  foreach field in array array['quantity','unit_price','amount','tax_rate','tax_amount','gross_amount'] loop if line?field and not asset_posting_private.finite((line->>field)::numeric) then raise exception using errcode='22023',message='Los importes deben ser finitos.';end if;end loop;
 end loop;
 p:=supplier_invoice_private.normalize_supplier_invoice_quantities(p);normalized:='[]';
 for line in select value from jsonb_array_elements(p->'lines') loop
  perform asset_posting_private.account((line->>'account_id')::bigint);
  perform asset_posting_private.dimensions(nullif(line->>'department_id','')::bigint,nullif(line->>'cost_center_id','')::bigint,nullif(line->>'class_id','')::bigint);
  if nullif(line->>'financial_creditor_id','') is not null and not exists(select 1 from public.financial_creditors f join public.financial_creditor_subsidiaries s using(financial_creditor_id) where f.financial_creditor_id=(line->>'financial_creditor_id')::bigint and s.subsidiary_id=sid and not f.is_inactive) then raise exception using errcode='42501',message='Acreedor no disponible.';end if;
  if nullif(line->>'related_company_id','') is not null and not exists(select 1 from public.related_companies r join public.related_company_subsidiaries s using(related_company_id) where r.related_company_id=(line->>'related_company_id')::bigint and s.subsidiary_id=sid and not r.is_inactive) then raise exception using errcode='42501',message='Compañía relacionada no disponible.';end if;
  tax_id:=nullif(line->>'tax_code_id','')::bigint;tax_rate:=0;
  if tax_id is not null then
   select tc.rate_percentage,tt.asset_account_id into tax_rate,tax_account from public.tax_codes tc join public.tax_types tt using(tax_type_id) where tc.tax_code_id=tax_id and not tc.is_withholding and tt.applies_to in('Compras','Ambos') and exists(select 1 from public.tax_code_subsidiaries s where s.tax_code_id=tc.tax_code_id and s.subsidiary_id=sid);
   if not found then raise exception using errcode='42501',message='Impuesto de compra no autorizado.';end if;
   if not asset_posting_private.finite(tax_rate) or tax_rate not between 0 and 100 then raise exception using errcode='22023',message='Porcentaje de impuesto inválido.';end if;
   if tax_rate>0 then perform asset_posting_private.account(tax_account);end if;
  end if;
  if line?'tax_rate' and(line->>'tax_rate')::numeric is distinct from tax_rate then raise exception using errcode='22023',message='La tasa debe coincidir con el impuesto configurado.';end if;
  normalized:=normalized||jsonb_build_array(line||jsonb_build_object('tax_rate',tax_rate));
 end loop;
 for rule in select tc.rate_percentage,tt.liability_account_id from public.entity_withholding_rules r join public.tax_codes tc using(tax_code_id) join public.tax_types tt using(tax_type_id) where r.supplier_id=(p->>'supplier_id')::bigint and r.subsidiary_id=sid and tc.is_withholding and tt.applies_to in('Compras','Ambos') loop
  if not asset_posting_private.finite(rule.rate_percentage) or rule.rate_percentage not between 0 and 100 then raise exception using errcode='22023',message='Retención configurada con porcentaje inválido.';end if;perform asset_posting_private.account(rule.liability_account_id);
 end loop;
 receipt_number:=substring(coalesce(p->>'memo','') from '(REC_INV-[A-Za-z0-9_-]+)');
 if receipt_number is not null then
  select * into receipt from public.purchase_document where document_number=receipt_number and document_type='RECEIPT' and subsidiary_id=sid for update;
  if not found or receipt.supplier_id is distinct from(p->>'supplier_id')::bigint then raise exception using errcode='42501',message='Recepción no disponible para este proveedor y subsidiaria.';end if;
  if exists(select 1 from public.supplier_invoice where purchase_receipt_document_id=receipt.document_id) then raise exception using errcode='55000',message='La recepción ya está vinculada a una factura.';end if;
 end if;
 if p_id is not null then select payable_account_id into payable from public.supplier_invoice where invoice_id=p_id and supplier_id=(p->>'supplier_id')::bigint and invoice_type=p->>'invoice_type';end if;
 if payable is null then payable:=public.resolve_supplier_payable_account(sid,(p->>'supplier_id')::bigint,p->>'invoice_type');end if;perform asset_posting_private.account(payable);
 return p||jsonb_build_object('lines',normalized,'exchange_rate',rate);
end$$;
-- Guard the shared FAC_PRO dispatch before budget work, and validate inside its lock.
do $$declare body text;modified text;begin
 body:=pg_get_functiondef('public.budget_run(text,jsonb,bigint)'::regprocedure);
 modified:=replace(body,'declare sid bigint:=','declare invoice_payload jsonb;sid bigint:=');
 modified:=regexp_replace(modified,'\mbegin[[:space:]]*','begin'||chr(10)||' if p_type=''FAC_PRO'' then perform supplier_invoice_private.assert_write(p_id);end if;'||chr(10));
 modified:=replace(modified,'perform pg_advisory_xact_lock(hashtextextended(''budget:''||sid,0));','perform pg_advisory_xact_lock(hashtextextended(''budget:''||sid,0));if p_type=''FAC_PRO'' then invoice_payload:=supplier_invoice_private.prepare(p_payload,p_id);end if;');
 modified:=regexp_replace(modified,'(?<![a-zA-Z0-9_.])(?:public\.)?save_supplier_invoice_without_budget\(','supplier_invoice_private.save_supplier_invoice_without_budget(','g');
 modified:=replace(modified,'supplier_invoice_private.save_supplier_invoice_without_budget(p_payload,p_id)','supplier_invoice_private.save_supplier_invoice_without_budget(invoice_payload,p_id)');
 if modified=body or position('invoice_payload jsonb' in modified)=0 or position('supplier_invoice_private.prepare(p_payload,p_id)' in modified)=0 or position('supplier_invoice_private.assert_write(p_id)' in modified)=0 or position('save_supplier_invoice_without_budget(invoice_payload,p_id)' in modified)=0 then raise exception 'Unexpected invoice budget dispatcher';end if;execute modified;
end$$;
create function public.save_supplier_invoice(payload jsonb,target_invoice_id bigint default null) returns jsonb language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$begin perform supplier_invoice_private.assert_write(target_invoice_id);return public.budget_run('FAC_PRO',payload,target_invoice_id);end$$;
create function public.supplier_invoice_access() returns jsonb language plpgsql stable security definer set search_path=pg_catalog,public,pg_temp as $$
declare view_ok boolean;create_ok boolean:=false;edit_ok boolean:=false;begin perform asset_posting_private.identity();view_ok:=asset_posting_private.allowed('purchasing:supplier-invoices','view');
 begin perform supplier_invoice_private.assert_write(null);create_ok:=true;exception when insufficient_privilege then null;end;
 begin perform supplier_invoice_private.assert_write(0);edit_ok:=true;exception when insufficient_privilege then null;end;
 if not(view_ok or create_ok or edit_ok) then raise exception using errcode='42501',message='No tiene acceso a facturas de proveedores.';end if;return jsonb_build_object('canView',view_ok,'canCreate',create_ok,'canEdit',edit_ok);
end$$;
create function public.run_purchase_transaction_report(p_filters jsonb default '{}') returns jsonb language plpgsql stable security definer set search_path=pg_catalog,public,pg_temp as $$
declare sid bigint:=asset_posting_private.access('reports:accounting-reports','view');begin
 if p_filters?'subsidiaryIds' and p_filters->'subsidiaryIds'<>jsonb_build_array(sid) then raise exception using errcode='42501',message='El reporte corresponde a la subsidiaria activa.';end if;return supplier_invoice_private.run_purchase_transaction_report(p_filters||jsonb_build_object('subsidiaryIds',jsonb_build_array(sid)));
end$$;
create function public.purchase_transaction_support(p_support_id bigint) returns jsonb language plpgsql stable security definer set search_path=pg_catalog,public,pg_temp as $$begin perform asset_posting_private.access('reports:accounting-reports','view');if not exists(select 1 from public.journal_support s join public.journal j using(journal_id) where s.support_id=p_support_id and j.subsidiary_id=asset_posting_private.identity()) then raise exception using errcode='42501',message='Respaldo no disponible.';end if;return supplier_invoice_private.purchase_transaction_support(p_support_id);end$$;
create function public.settled_supplier_invoice_report_options() returns jsonb language plpgsql stable security definer set search_path=pg_catalog,public,pg_temp as $$begin perform asset_posting_private.access('reports:accounting-reports','view');return supplier_invoice_private.settled_supplier_invoice_report_options();end$$;
create function public.run_settled_supplier_invoice_report(p_filters jsonb default '{}') returns jsonb language plpgsql stable security definer set search_path=pg_catalog,public,pg_temp as $$begin perform asset_posting_private.access('reports:accounting-reports','view');return supplier_invoice_private.run_settled_supplier_invoice_report(p_filters);end$$;
create function supplier_invoice_private.visible(p_id bigint) returns boolean language plpgsql stable security definer set search_path=pg_catalog,public,pg_temp as $$begin return asset_posting_private.allowed('purchasing:supplier-invoices','view') and exists(select 1 from public.supplier_invoice where invoice_id=p_id and subsidiary_id=asset_posting_private.identity());end$$;
do $$declare t text;p record;begin foreach t in array array['supplier_invoice','supplier_invoice_line','supplier_invoice_withholding'] loop
 execute format('alter table public.%I enable row level security',t);for p in select policyname from pg_policies where schemaname='public' and tablename=t loop execute format('drop policy %I on public.%I',p.policyname,t);end loop;execute format('revoke all on public.%I from public,anon,authenticated,service_role',t);execute format('grant select on public.%I to authenticated',t);
end loop;end$$;
create policy supplier_invoice_read on public.supplier_invoice for select to authenticated using(subsidiary_id=asset_posting_private.identity() and asset_posting_private.allowed('purchasing:supplier-invoices','view'));
create policy supplier_invoice_line_read on public.supplier_invoice_line for select to authenticated using(supplier_invoice_private.visible(invoice_id));
create policy supplier_invoice_withholding_read on public.supplier_invoice_withholding for select to authenticated using(supplier_invoice_private.visible(invoice_id));
revoke all on all functions in schema supplier_invoice_private from public,anon,authenticated,service_role;
grant execute on function supplier_invoice_private.visible(bigint) to authenticated;
revoke all on function public.ensure_supplier_invoice_payable_account(bigint) from public,anon,authenticated,service_role;
revoke all on function public.save_supplier_invoice(jsonb,bigint),public.supplier_invoice_access(),public.run_purchase_transaction_report(jsonb),public.purchase_transaction_support(bigint),public.settled_supplier_invoice_report_options(),public.run_settled_supplier_invoice_report(jsonb) from public,anon,authenticated,service_role;
grant execute on function public.save_supplier_invoice(jsonb,bigint),public.supplier_invoice_access(),public.run_purchase_transaction_report(jsonb),public.purchase_transaction_support(bigint),public.settled_supplier_invoice_report_options(),public.run_settled_supplier_invoice_report(jsonb) to authenticated;
notify pgrst,'reload schema';
