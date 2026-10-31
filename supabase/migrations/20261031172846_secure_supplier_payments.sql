-- C-04 supplier payments: guarded API, original engines and Treasury entry.
set local lock_timeout='5s';set local statement_timeout='60s';
create schema supplier_payment_private;
revoke all on schema supplier_payment_private from public,anon,authenticated,service_role;
grant usage on schema supplier_payment_private to authenticated;
create function supplier_payment_private.access(a text) returns bigint language plpgsql stable security definer set search_path=pg_catalog,public,pg_temp as $$begin return asset_posting_private.access('purchasing:supplier-payments',a);end$$;
create function supplier_payment_private.context() returns jsonb language plpgsql stable security definer set search_path=pg_catalog,public,pg_temp as $$
declare v boolean;c boolean;e boolean;d boolean;begin perform asset_posting_private.identity();v:=asset_posting_private.allowed('purchasing:supplier-payments','view');c:=asset_posting_private.allowed('purchasing:supplier-payments','create');e:=asset_posting_private.allowed('purchasing:supplier-payments','edit');d:=asset_posting_private.allowed('purchasing:supplier-payments','delete');
 if not(v or c or e) then raise exception using errcode='42501',message='No tiene acceso a pagos de proveedores.';end if;return jsonb_build_object('canView',v,'canCreate',c,'canEdit',e,'canDelete',d);end$$;
do $$declare f regprocedure;n text;body text;begin
 for f in select p.oid::regprocedure from pg_proc p join pg_namespace ns on ns.oid=p.pronamespace where ns.nspname='public' and p.proname=any(array['supplier_payment_options','supplier_payment_report','supplier_payment_detail','supplier_payment_request_locks','supplier_payment_advance_summary','supplier_payment_advance_detail','supplier_available_advances','save_supplier_payment_with_advances_base','save_supplier_payment_before_payable_routing','save_supplier_payment_with_advances_before_payable_routing','save_supplier_payment_without_withholding','apply_supplier_payment_payable_accounts','save_supplier_payment','save_supplier_payment_with_advances','delete_supplier_payment','payment_email_history','payment_email_resend']) loop execute format('alter function %s set schema supplier_payment_private',f);end loop;
 for f in select p.oid::regprocedure from pg_proc p join pg_namespace ns on ns.oid=p.pronamespace where ns.nspname='supplier_payment_private' and p.proname not in('access','context') loop
  execute format('alter function %s set search_path=pg_catalog,public,pg_temp',f);body:=pg_get_functiondef(f);
  foreach n in array array['save_supplier_payment_with_advances_before_payable_routing','save_supplier_payment_before_payable_routing','save_supplier_payment_without_withholding','save_supplier_payment_with_advances_base','save_supplier_payment_with_advances','save_supplier_payment','apply_supplier_payment_payable_accounts','payment_email_history'] loop
   body:=replace(body,'public.'||n||'(','supplier_payment_private.'||n||'(');body:=regexp_replace(body,'(?<![a-zA-Z0-9_.])'||n||'\(','supplier_payment_private.'||n||'(','g');
  end loop;
  if f::text like 'supplier_payment_private.supplier_payment_report(%' then body:=replace(body,'where t.subsidiary_id=','where ba.subsidiary_id=active_subsidiary_id() and t.subsidiary_id=');end if;
  if f::text like 'supplier_payment_private.supplier_payment_detail(%' then body:=replace(body,'where a.payment_id=p.payment_id','where i.subsidiary_id=active_subsidiary_id() and i.supplier_id=p.supplier_id and i.currency_id=p.currency_id and a.payment_id=p.payment_id');end if;
  if f::text like 'supplier_payment_private.supplier_payment_advance_detail(%' then body:=replace(body,'where a.payment_id=p_payment_id','where j.subsidiary_id=active_subsidiary_id() and a.payment_id=p_payment_id');end if;
  if f::text like 'supplier_payment_private.supplier_available_advances(%' then body:=replace(body,'and a.account_group_id in','and j.subsidiary_id=active_subsidiary_id() and a.account_group_id in');end if;
  execute body;
 end loop;
end$$;
create function supplier_payment_private.visible(pid bigint) returns boolean language plpgsql stable security definer set search_path=pg_catalog,public,pg_temp as $$begin return asset_posting_private.allowed('purchasing:supplier-payments','view') and exists(select 1 from public.supplier_payment p join public."transaction" t using(transaction_id) join public.bank_account b using(bank_account_id) where p.payment_id=pid and t.subsidiary_id=asset_posting_private.identity() and b.subsidiary_id=t.subsidiary_id);end$$;
create function supplier_payment_private.available(iid bigint,excluded bigint default null) returns numeric language sql stable security definer set search_path=pg_catalog,public,pg_temp as $$
 select greatest(least(i.total_amount,
 case when i.payable_amount=0 and exists(select 1 from public.supplier_invoice_withholding where invoice_id=i.invoice_id and recognized_at_invoice and withholding_amount>0) then 0 else coalesce(nullif(i.payable_amount,0),i.total_amount) end,
 case when i.payable_amount=0 and exists(select 1 from public.supplier_invoice_withholding where invoice_id=i.invoice_id and recognized_at_invoice and withholding_amount>0) then 0 else coalesce(nullif(i.payable_amount,0),i.total_amount) end
 +coalesce((select sum(amount) from public.supplier_debit_note where invoice_id=i.invoice_id),0)
 -coalesce((select sum(amount) from public.supplier_credit_note where invoice_id=i.invoice_id),0))
 -coalesce((select sum(amount) from public.supplier_payment_application where invoice_id=i.invoice_id and payment_id is distinct from excluded),0),0)
 from public.supplier_invoice i where i.invoice_id=iid and i.subsidiary_id=asset_posting_private.identity()
$$;
create function supplier_payment_private.bank_window(bid bigint,d date) returns void language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$begin
 if exists(select 1 from public.bank_reconciliation where bank_account_id=bid and status='CERRADA' and reconciliation_date>=d)
 or exists(select 1 from public.quadratic_bank_reconciliations where bank_account_id=bid and status='CERRADA' and (period_year,period_month)>=(extract(year from d)::integer,extract(month from d)::integer)) then raise exception using errcode='55000',message='El movimiento pertenece a un período bancario conciliado.';end if;
end$$;
create function supplier_payment_private.lock_source(pid bigint) returns public.supplier_payment language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$
declare p public.supplier_payment;sid bigint:=asset_posting_private.identity();gross numeric;begin
 select sp.* into p from public.supplier_payment sp join public.bank_account b using(bank_account_id) join public."transaction" t using(transaction_id) where sp.payment_id=pid and b.subsidiary_id=sid and t.subsidiary_id=sid;
 if not found then raise exception using errcode='42501',message='Pago no disponible en la subsidiaria activa.';end if;
 perform 1 from public.bank_account where bank_account_id=p.bank_account_id for update;
 perform 1 from public."transaction" where transaction_id=p.transaction_id for update;perform 1 from public.journal where journal_id=p.journal_id for update;
 select * into p from public.supplier_payment where payment_id=pid for update;
 if exists(select 1 from public.supplier_advance_application where payment_id=pid)
 or exists(select 1 from public.solicitudes_pago where payment_id=pid or journal_id=p.journal_id)
 or exists(select 1 from public.payment_batch_items where payment_id=pid or journal_id=p.journal_id)
 or exists(select 1 from public.activos_fijos_propuestas where transaction_id=p.transaction_id and status<>'PENDIENTE')
 or exists(select 1 from public.journal where reversed_from_journal_id=p.journal_id)
 or exists(select 1 from public.supplier_payment where payment_id<>pid and (journal_id=p.journal_id or transaction_id=p.transaction_id))
 then raise exception using errcode='55000',message='El pago tiene anticipos, solicitudes, lotes o historia protegida.';end if;
 select coalesce(sum(amount),0) into gross from public.supplier_payment_application where payment_id=pid;
 if p.status<>'APROBADO' or not asset_posting_private.finite(p.amount_paid) or p.amount_paid<0 or gross<=0
 or abs(gross-coalesce((select sum(withholding_amount) from public.supplier_payment_withholding where payment_id=pid),0)-p.amount_paid)>.000001
 or not exists(select 1 from public.journal j join public."transaction" t on t.transaction_id=p.transaction_id join public.transaction_types tt using(transaction_type_id) join public.bank_account b on b.bank_account_id=p.bank_account_id where j.journal_id=p.journal_id and j.transaction_id=t.transaction_id and tt.abbreviation='PAG_PRO' and j.journal_type='PAGO_PROVEEDOR' and j.status='CONTABILIZADO' and t.subsidiary_id=sid and j.subsidiary_id=sid and b.subsidiary_id=sid and b.currency_id=p.currency_id and t.currency_id=p.currency_id and j.currency_id=p.currency_id and j.journal_date=p.payment_date and t.tran_date=p.payment_date and j.fiscal_period_id=p.fiscal_period_id and t.fiscal_period_id=p.fiscal_period_id and j.exchange_rate=p.exchange_rate and t.exchange_rate=p.exchange_rate and t.total_amount=gross and j.journal_number=p.payment_number and t.tran_number=p.payment_number)
 then raise exception using errcode='55000',message='El origen contable del pago requiere revisión.';end if;
 perform supplier_invoice_private.period(p.fiscal_period_id,p.payment_date);perform supplier_payment_private.bank_window(p.bank_account_id,p.payment_date);
 perform 1 from public.bank_transaction where transaction_id=p.transaction_id for update;
 if (select count(*) from public.bank_transaction where transaction_id=p.transaction_id)<>1
 or exists(select 1 from public.bank_transaction bt where bt.transaction_id=p.transaction_id and (bt.bank_account_id is distinct from p.bank_account_id or bt.tran_type is distinct from 'PAGO_PROVEEDOR' or bt.amount is distinct from -p.amount_paid or bt.tran_date is distinct from p.payment_date or bt.reconciliation_status is distinct from 'PENDIENTE_EN_TRANSITO' or coalesce(bt.is_opening_balance,false) or bt.opening_bank_item_id is not null or bt.opening_balance_line_id is not null))
 or exists(select 1 from public.bank_transaction bt join public.bank_reconciliation_match m using(bank_tran_id) where bt.transaction_id=p.transaction_id)
 or exists(select 1 from public.bank_transaction bt join public.quadratic_reconciliation_matches m using(bank_tran_id) where bt.transaction_id=p.transaction_id)
 or exists(select 1 from public.bank_transaction bt join public.quadratic_reconciliation_items m using(bank_tran_id) where bt.transaction_id=p.transaction_id)
 then raise exception using errcode='55000',message='El movimiento bancario está conciliado, vinculado o requiere revisión.';end if;
 return p;
end$$;
create function supplier_payment_private.prepare(p jsonb,pid bigint,request_id bigint default null) returns jsonb language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$
declare sid bigint:=asset_posting_private.identity();b public.bank_account;old public.supplier_payment;i public.supplier_invoice;l public.journal_line;source_journal public.journal;item jsonb;key bigint;ids bigint[];amount numeric;gross numeric:=0;advance numeric:=0;rate numeric;h public.solicitudes_pago;w record;begin
 if request_id is null then perform supplier_payment_private.access(case when pid is null then 'create' else 'edit' end);
 else
  if pid is not null or not public.pr_can_execute() then raise exception using errcode='42501',message='La solicitud requiere un ejecutor autorizado.';end if;
  select * into h from public.solicitudes_pago where id=request_id and id_subsidiaria=sid for update;
  if not found or h.estado<>'APROBADO' or h.tipo_solicitud<>'CXP' or h.payment_id is not null or h.id_proveedor is distinct from (p->>'supplier_id')::bigint then raise exception using errcode='42501',message='Solicitud no disponible para este pago.';end if;
 end if;
 if p is null or jsonb_typeof(p)<>'object' or jsonb_typeof(p->'applications') is distinct from 'array' or jsonb_array_length(p->'applications') not between 1 and 1000 or (p?'advances' and (jsonb_typeof(p->'advances') is distinct from 'array' or jsonb_array_length(p->'advances')>1000)) then raise exception using errcode='22023',message='Seleccione entre 1 y 1000 facturas y hasta 1000 anticipos.';end if;
 if p ?| array['subsidiary_id','transaction_id','journal_id','payment_id','amount_paid','status','created_by','payment_request_id'] then raise exception using errcode='42501',message='No puede sustituir el origen del pago.';end if;
 if not exists(select 1 from public.suppliers s join public.entity_subsidiaries e using(supplier_id) where s.supplier_id=(p->>'supplier_id')::bigint and e.subsidiary_id=sid and not s.is_inactive) then raise exception using errcode='42501',message='Proveedor no disponible.';end if;
 if pid is not null then select sp.* into old from public.supplier_payment sp join public."transaction" t using(transaction_id) where payment_id=pid and t.subsidiary_id=sid;if not found then raise exception using errcode='42501',message='Pago no disponible.';end if;end if;
 -- Lock both bank accounts in a fixed order before parent invoice locks.
 perform 1 from public.bank_account where bank_account_id in ((p->>'account_id')::bigint,old.bank_account_id) and subsidiary_id=sid order by bank_account_id for update;
 select * into b from public.bank_account where bank_account_id=(p->>'account_id')::bigint and subsidiary_id=sid and not coalesce(is_credit_card,false);
 if not found or not exists(select 1 from public.subsidiary_currencies where subsidiary_id=sid and currency_id=b.currency_id) then raise exception using errcode='42501',message='Banco o moneda no disponible.';end if;
 perform asset_posting_private.account(b.account_id);
 if not asset_posting_private.finite(b.balance) then raise exception using errcode='55000',message='Saldo bancario inválido.';end if;
 rate:=(p->>'rate')::numeric;if not asset_posting_private.finite(rate) or rate<=0 or (b.currency_id=(select currency_id from public.subsidiaries where subsidiary_id=sid) and rate<>1) then raise exception using errcode='22023',message='Tipo de cambio inválido.';end if;
 if nullif(trim(p->>'reference'),'') is null then raise exception using errcode='22023',message='Indique la referencia bancaria.';end if;
 if nullif(p->>'location_id','') is not null and not exists(select 1 from public.locations x left join public.location_subsidiaries s using(location_id) where x.location_id=(p->>'location_id')::bigint and (x.subsidiary_id=sid or s.subsidiary_id=sid)) then raise exception using errcode='42501',message='Ubicación no disponible.';end if;
 perform supplier_invoice_private.period((p->>'period_id')::bigint,(p->>'date')::date);perform supplier_payment_private.bank_window(b.bank_account_id,(p->>'date')::date);
 if (select count(*)<>count(distinct (x->>'invoice_id')::bigint) from jsonb_array_elements(p->'applications')x)
 or (select count(*)<>count(distinct (x->>'advanceLineId')::bigint) from jsonb_array_elements(coalesce(p->'advances','[]'))x) then raise exception using errcode='22023',message='No repita facturas ni anticipos.';end if;
 if request_id is not null and (jsonb_array_length(coalesce(p->'advances','[]'))<>0 or h.id_moneda is distinct from b.currency_id
 or (select count(*) from public.solicitudes_pago_lineas where id_solicitud=request_id)<>jsonb_array_length(p->'applications')
 or exists(select 1 from jsonb_array_elements(p->'applications')x where not exists(select 1 from public.solicitudes_pago_lineas s where s.id_solicitud=request_id and s.id_factura_proveedor=(x->>'invoice_id')::bigint and s.monto=(x->>'amount')::numeric))) then raise exception using errcode='42501',message='El pago debe coincidir con las líneas aprobadas de la solicitud.';end if;
 select array_agg(distinct id order by id) into ids from (select (x->>'invoice_id')::bigint id from jsonb_array_elements(p->'applications')x union select invoice_id from public.supplier_payment_application where payment_id=pid)x;
 foreach key in array ids loop
  select * into i from public.supplier_invoice where invoice_id=key and subsidiary_id=sid;
  if not found then raise exception using errcode='42501',message='Factura no disponible en la subsidiaria activa.';end if;
  perform 1 from public."transaction" where transaction_id=i.transaction_id for update;perform 1 from public.journal where journal_id=i.journal_id for update;perform 1 from public.supplier_invoice where invoice_id=key for update;
 end loop;
 if pid is not null then old:=supplier_payment_private.lock_source(pid);if old.supplier_id is distinct from (p->>'supplier_id')::bigint or old.currency_id is distinct from b.currency_id then raise exception using errcode='42501',message='El pago conserva proveedor y moneda originales.';end if;end if;
 for item in select value from jsonb_array_elements(p->'applications') loop
  amount:=(item->>'amount')::numeric;
  if jsonb_typeof(item)<>'object' or not asset_posting_private.finite(amount) or amount<=0 then raise exception using errcode='22023',message='Importe de aplicación inválido.';end if;
  select * into i from public.supplier_invoice where invoice_id=(item->>'invoice_id')::bigint and subsidiary_id=sid and supplier_id=(p->>'supplier_id')::bigint and currency_id=b.currency_id;
  if not found then raise exception using errcode='42501',message='La factura no corresponde al proveedor o moneda.';end if;
  if not asset_posting_private.finite(i.total_amount) or not asset_posting_private.finite(coalesce(i.payable_amount,i.total_amount))
  or (not coalesce(i.is_opening_balance,false) and not exists(select 1 from public.journal ij join public."transaction" it on it.transaction_id=i.transaction_id join public.transaction_types tt using(transaction_type_id) where ij.journal_id=i.journal_id and ij.transaction_id=it.transaction_id and ij.subsidiary_id=sid and it.subsidiary_id=sid and tt.abbreviation='FAC_PRO' and ij.status='CONTABILIZADO' and ij.currency_id=i.currency_id and it.currency_id=i.currency_id))
  or exists(select 1 from public.journal where reversed_from_journal_id=i.journal_id) then raise exception using errcode='55000',message='El origen de la factura requiere revisión.';end if;
  if exists(select 1 from public.solicitudes_pago req join public.solicitudes_pago_lineas s on s.id_solicitud=req.id where s.id_factura_proveedor=i.invoice_id and req.estado in('PENDIENTE_APROBACION','APROBADO') and req.id is distinct from request_id) then raise exception using errcode='55000',message='La factura está reservada por una solicitud de Tesorería.';end if;
  if amount>supplier_payment_private.available(i.invoice_id,pid)+.000001 then raise exception using errcode='55000',message='El pago supera el saldo de la factura, incluidas notas y retenciones.';end if;
  for w in select * from public.supplier_invoice_withholding where invoice_id=i.invoice_id and application_moment='Al aplicar el pago' loop
   if not asset_posting_private.finite(w.withholding_amount) or w.withholding_amount<0 or not asset_posting_private.finite(w.rate_percentage) or w.rate_percentage not between 0 and 100 then raise exception using errcode='55000',message='La retención histórica requiere revisión.';end if;
   perform asset_posting_private.account(w.liability_account_id);
  end loop;
  perform asset_posting_private.account(public.ensure_supplier_invoice_payable_account(i.invoice_id));gross:=gross+amount;
 end loop;
 for key in select (x->>'advanceLineId')::bigint from jsonb_array_elements(coalesce(p->'advances','[]'))x order by 1 loop
  select jl.* into l from public.journal_line jl join public.journal j using(journal_id) join public."transaction" t using(transaction_id) where jl.journal_line_id=key and j.subsidiary_id=sid and t.subsidiary_id=sid and j.status='CONTABILIZADO' and t.currency_id=b.currency_id and j.currency_id=b.currency_id and jl.supplier_id=(p->>'supplier_id')::bigint;
  if not found then raise exception using errcode='42501',message='Anticipo no disponible.';end if;
  select * into source_journal from public.journal where journal_id=l.journal_id;perform 1 from public."transaction" where transaction_id=source_journal.transaction_id for update;perform 1 from public.journal where journal_id=source_journal.journal_id for update;select * into l from public.journal_line where journal_line_id=key for update;
  if not asset_posting_private.finite(l.debit) or not asset_posting_private.finite(l.credit) or l.debit-l.credit<=0 or exists(select 1 from public.journal where reversed_from_journal_id=source_journal.journal_id)
  or not exists(with recursive g as(select group_id,parent_id,group_name from public.account_group where group_id=(select account_group_id from public.chart_accounts where account_id=l.account_id) union select p.group_id,p.parent_id,p.group_name from public.account_group p join g on p.group_id=g.parent_id) select 1 from g where lower(trim(group_name))='gastos pagados por anticipado') then raise exception using errcode='55000',message='Origen de anticipo no válido.';end if;
  perform asset_posting_private.account(l.account_id);
  select (x->>'amount')::numeric into amount from jsonb_array_elements(p->'advances')x where (x->>'advanceLineId')::bigint=key;
  if not asset_posting_private.finite(amount) or amount<=0 then raise exception using errcode='22023',message='Importe de anticipo inválido.';end if;
  if amount>l.debit-l.credit-coalesce((select sum(a.amount) from public.supplier_advance_application a where a.source_journal_line_id=key),0)+.000001 then raise exception using errcode='55000',message='El anticipo supera el disponible.';end if;advance:=advance+amount;
 end loop;
 if advance>gross then raise exception using errcode='22023',message='Los anticipos superan las aplicaciones.';end if;
 return p;
end$$;
create function supplier_payment_private.check_result(result jsonb) returns jsonb language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$
declare p public.supplier_payment;d numeric;c numeric;begin select * into p from public.supplier_payment where payment_id=(result->>'id')::bigint;
 select coalesce(sum(debit),0),coalesce(sum(credit),0) into d,c from public.journal_line where journal_id=p.journal_id;
 if p.payment_id is null or not asset_posting_private.finite(p.amount_paid) or p.amount_paid<0 or not asset_posting_private.finite(d) or not asset_posting_private.finite(c) or d<=0 or abs(d-c)>.000001 then raise exception using errcode='55000',message='El pago no genera un asiento balanceado.';end if;
 select coalesce(sum(debit_amount),0),coalesce(sum(credit_amount),0) into d,c from public.gl_impact where transaction_id=p.transaction_id;
 if d<=0 or not asset_posting_private.finite(d) or not asset_posting_private.finite(c) or abs(d-c)>.000001 then raise exception using errcode='55000',message='El mayor del pago no está balanceado.';end if;
 if (p.amount_paid>0 and (select count(*) from public.bank_transaction where transaction_id=p.transaction_id)<>1) or exists(select 1 from public.bank_transaction where transaction_id=p.transaction_id and (bank_account_id is distinct from p.bank_account_id or amount is distinct from -p.amount_paid)) then raise exception using errcode='55000',message='El desembolso no coincide con el movimiento bancario.';end if;
 return result;
end$$;
create function supplier_payment_private.protect_advance_source() returns trigger language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$begin
 if tg_table_name='journal_line' then
  if exists(select 1 from public.supplier_advance_application where source_journal_line_id=old.journal_line_id) then raise exception using errcode='55000',message='El origen del anticipo aplicado conserva su historial.';end if;
 else
  if (tg_op<>'INSERT' and exists(select 1 from public.supplier_advance_application a join public.journal_line l on l.journal_line_id=a.source_journal_line_id where l.journal_id=old.journal_id))
  or (tg_op<>'DELETE' and exists(select 1 from public.supplier_advance_application a join public.journal_line l on l.journal_line_id=a.source_journal_line_id where l.journal_id=new.reversed_from_journal_id)) then raise exception using errcode='55000',message='No se reescribe ni revierte un anticipo ya aplicado.';end if;
 end if;
 return case when tg_op='DELETE' then old else new end;
end$$;
create trigger supplier_advance_source_line before update or delete on public.journal_line for each row execute function supplier_payment_private.protect_advance_source();
create trigger supplier_advance_source_header before insert or update or delete on public.journal for each row execute function supplier_payment_private.protect_advance_source();
create function public.save_supplier_payment_with_advances(p_payload jsonb,p_payment_id bigint default null) returns jsonb language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$begin return supplier_payment_private.check_result(supplier_payment_private.save_supplier_payment_with_advances(supplier_payment_private.prepare(p_payload,p_payment_id),p_payment_id));end$$;
create function public.save_supplier_payment(p_payload jsonb,p_payment_id bigint default null) returns jsonb language sql security definer set search_path=pg_catalog,public,pg_temp as $$select public.save_supplier_payment_with_advances(p_payload,p_payment_id)$$;
create function supplier_payment_private.request_save(p jsonb) returns jsonb language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$
declare rid bigint:=nullif(current_setting('nexo.payment_request_id',true),'')::bigint;begin
 if rid is null then raise exception using errcode='42501',message='No hay solicitud aprobada en ejecución.';end if;
 return supplier_payment_private.check_result(supplier_payment_private.save_supplier_payment(supplier_payment_private.prepare(p,null,rid),null));end$$;
do $$declare body text;begin body:=pg_get_functiondef('public.pr_execute_without_budget(jsonb)'::regprocedure);
 if position('result:=public.save_supplier_payment(' in body)=0 then raise exception 'Unexpected Treasury payment caller';end if;
 execute replace(body,'result:=public.save_supplier_payment(','result:=supplier_payment_private.request_save(');
end$$;
create function public.delete_supplier_payment(p_payment_id bigint) returns jsonb language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$declare p public.supplier_payment;begin perform supplier_payment_private.access('delete');p:=supplier_payment_private.lock_source(p_payment_id);return supplier_payment_private.delete_supplier_payment(p_payment_id);end$$;
create function public.supplier_payment_access() returns jsonb language sql stable security definer set search_path=pg_catalog,public,pg_temp as $$select supplier_payment_private.context()$$;
create function public.supplier_payment_options() returns jsonb language plpgsql stable security definer set search_path=pg_catalog,public,pg_temp as $$declare result jsonb;begin
 perform supplier_payment_private.context();result:=supplier_payment_private.supplier_payment_options();
 return result||jsonb_build_object('invoices',coalesce((select jsonb_agg(x||jsonb_build_object('balance',supplier_payment_private.available((x->>'id')::bigint))) from jsonb_array_elements(result->'invoices')x where supplier_payment_private.available((x->>'id')::bigint)>0),'[]'::jsonb),'periods',coalesce((select jsonb_agg(x) from jsonb_array_elements(result->'periods')x join public.fiscal_periods f on f.fiscal_period_id=(x->>'id')::bigint where not coalesce(f.gl_closed,false) and not coalesce(f.ap_closed,false) and not coalesce(f.is_inactive,false)),'[]'::jsonb));end$$;
create function public.supplier_payment_report(p_filters jsonb) returns jsonb language plpgsql stable security definer set search_path=pg_catalog,public,pg_temp as $$begin perform supplier_payment_private.access('view');return supplier_payment_private.supplier_payment_report(p_filters);end$$;
create function public.supplier_payment_detail(p_payment_id bigint) returns jsonb language plpgsql stable security definer set search_path=pg_catalog,public,pg_temp as $$begin perform supplier_payment_private.access('view');if not supplier_payment_private.visible(p_payment_id) then raise exception using errcode='42501',message='Pago no disponible.';end if;return supplier_payment_private.supplier_payment_detail(p_payment_id);end$$;
create function public.supplier_payment_request_locks() returns jsonb language plpgsql stable security definer set search_path=pg_catalog,public,pg_temp as $$begin perform supplier_payment_private.context();return supplier_payment_private.supplier_payment_request_locks();end$$;
create function public.supplier_available_advances() returns jsonb language plpgsql stable security definer set search_path=pg_catalog,public,pg_temp as $$begin perform supplier_payment_private.context();return supplier_payment_private.supplier_available_advances();end$$;
create function public.supplier_payment_advance_summary() returns jsonb language plpgsql stable security definer set search_path=pg_catalog,public,pg_temp as $$begin perform supplier_payment_private.access('view');return supplier_payment_private.supplier_payment_advance_summary();end$$;
create function public.supplier_payment_advance_detail(p_payment_id bigint) returns jsonb language plpgsql stable security definer set search_path=pg_catalog,public,pg_temp as $$begin perform supplier_payment_private.access('view');if not supplier_payment_private.visible(p_payment_id) then raise exception using errcode='42501',message='Pago no disponible.';end if;return supplier_payment_private.supplier_payment_advance_detail(p_payment_id);end$$;
create function public.payment_email_history(p_id bigint) returns jsonb language plpgsql stable security definer set search_path=pg_catalog,public,pg_temp as $$begin perform supplier_payment_private.access('view');if not supplier_payment_private.visible(p_id) then raise exception using errcode='42501',message='Pago no disponible.';end if;return supplier_payment_private.payment_email_history(p_id);end$$;
create function public.payment_email_resend(p_id bigint,p_email text default null) returns jsonb language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$begin perform supplier_payment_private.access('edit');perform supplier_payment_private.access('view');if not supplier_payment_private.visible(p_id) then raise exception using errcode='42501',message='Pago no disponible.';end if;return supplier_payment_private.payment_email_resend(p_id,p_email);end$$;
do $$declare t text;p record;c record;begin foreach t in array array['supplier_payment','supplier_payment_application','supplier_advance_application','supplier_payment_withholding'] loop
 execute format('alter table public.%I enable row level security',t);for p in select policyname from pg_policies where schemaname='public' and tablename=t loop execute format('drop policy %I on public.%I',p.policyname,t);end loop;execute format('revoke all on public.%I from public,anon,authenticated,service_role',t);
 for c in select column_name from information_schema.columns where table_schema='public' and table_name=t loop execute format('revoke all (%I) on public.%I from public,anon,authenticated,service_role',c.column_name,t);end loop;
 execute format('grant select on public.%I to authenticated',t);execute format('create policy supplier_payment_read on public.%I for select to authenticated using(supplier_payment_private.visible(payment_id))',t);
end loop;end$$;
revoke all on all functions in schema supplier_payment_private from public,anon,authenticated,service_role;
grant execute on function supplier_payment_private.visible(bigint) to authenticated;
revoke all on function public.supplier_payment_access(),public.supplier_payment_options(),public.supplier_payment_report(jsonb),public.supplier_payment_detail(bigint),public.supplier_payment_request_locks(),public.supplier_available_advances(),public.supplier_payment_advance_summary(),public.supplier_payment_advance_detail(bigint),public.save_supplier_payment(jsonb,bigint),public.save_supplier_payment_with_advances(jsonb,bigint),public.delete_supplier_payment(bigint),public.payment_email_history(bigint),public.payment_email_resend(bigint,text),public.protect_applied_supplier_advance(),public.validate_supplier_payment_application_payable() from public,anon,authenticated,service_role;
grant execute on function public.supplier_payment_access(),public.supplier_payment_options(),public.supplier_payment_report(jsonb),public.supplier_payment_detail(bigint),public.supplier_payment_request_locks(),public.supplier_available_advances(),public.supplier_payment_advance_summary(),public.supplier_payment_advance_detail(bigint),public.save_supplier_payment(jsonb,bigint),public.save_supplier_payment_with_advances(jsonb,bigint),public.delete_supplier_payment(bigint),public.payment_email_history(bigint),public.payment_email_resend(bigint,text) to authenticated;
notify pgrst,'reload schema';
