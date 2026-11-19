-- Atomic asset disposal accounting. ACTIVO/BAJA remain the asset lifecycle states.
set local lock_timeout='5s';
create table public.asset_disposal_settings(
 subsidiary_id bigint primary key references public.subsidiaries,
 loss_account_id bigint references public.chart_accounts,
 sale_loss_account_id bigint references public.chart_accounts,
 gain_account_id bigint references public.chart_accounts,
 impairment_account_id bigint references public.chart_accounts
);
alter table public.asset_disposal_settings enable row level security;
revoke all on public.asset_disposal_settings from public,anon,authenticated,service_role;
alter table public.asset_disposal add column journal_id bigint references public.journal,
 add column reversal_journal_id bigint references public.journal,
 add column reversed_at timestamptz,add column reversal_date date,add column reversal_note text,
 add column customer_id bigint references public.customers,add column currency_id bigint references public.currencies,
 add column exchange_rate numeric,add column tax_code_id bigint references public.tax_codes,
 add column tax_amount numeric not null default 0,add column impairment_amount numeric not null default 0,
 add column invoice_reference text,add column collection_account_id bigint references public.chart_accounts,
 add column request_id uuid,add column accounting_snapshot jsonb;
create unique index asset_disposal_request_idx on public.asset_disposal(request_id) where request_id is not null;
create unique index asset_disposal_live_idx on public.asset_disposal(asset_id) where reversed_at is null and journal_id is not null;
alter table public.asset_depreciation add column disposal_cut_monthly numeric;
create table asset_operation_private.disposal_journal_links(journal_id bigint primary key references public.journal,asset_id bigint not null references public.asset,kind text not null);
alter table asset_operation_private.disposal_journal_links enable row level security;
revoke all on asset_operation_private.disposal_journal_links from public,anon,authenticated,service_role;

create function asset_operation_private.post_disposal_journal(p_entry jsonb,p_sid bigint,p_asset bigint,p_kind text,p_reversed bigint default null) returns bigint
language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$
declare jid bigint;previous text:=coalesce(current_setting('app.asset_proposal_internal',true),'');begin
 perform journal_entry_private.validate_payload(p_entry,p_sid);
 -- Reversing the PPE credit must not create a new capitalization proposal.
 perform set_config('app.asset_proposal_internal','1',true);
 jid:=journal_entry_private.create_journal_entry(p_entry);
 if p_reversed is not null then update public.journal set reversed_from_journal_id=p_reversed where journal_id=jid;end if;
 perform public.sync_journal_gl_impacts(jid);
 if not exists(select 1 from public.journal j join public.gl_impact g using(transaction_id) where j.journal_id=jid) then raise exception using errcode='55000',message='El asiento no generó movimientos en el libro mayor.';end if;
 insert into asset_operation_private.disposal_journal_links values(jid,p_asset,p_kind);
 perform set_config('app.asset_proposal_internal',previous,true);
 return jid;
end$$;
revoke all on function asset_operation_private.post_disposal_journal(jsonb,bigint,bigint,text,bigint) from public,anon,authenticated,service_role;

create function asset_operation_private.disposal_line(p_account bigint,p_debit numeric,p_credit numeric,p_note text,a public.asset) returns jsonb
language sql immutable set search_path=pg_catalog,public,pg_temp as $$
 select jsonb_build_object('account_id',p_account,'debit',p_debit,'credit',p_credit,'note',p_note,
 'department_id',a.department_id,'cost_center_id',a.cost_center_id,'class_id',a.class_id,'location_id',a.location_id)
$$;

-- The current month's cut uses actual calendar days, including the disposal date.
-- All earlier calendar months must already be posted; opening balances establish the baseline.
create function asset_operation_private.disposal_values(p_asset bigint,p_date date) returns jsonb
language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$
declare a public.asset;c public.asset_category;acc numeric;imp numeric;months integer;monthly numeric;due numeric:=0;
 month_start date:=date_trunc('month',p_date)::date;baseline date;period_end date;row_cut record;
begin
 a:=asset_master_private.asset(p_asset);select * into c from public.asset_category where category_id=a.category_id for share;
 perform asset_operation_private.date(p_asset,p_date,'DISPOSAL');
 if a.status<>'ACTIVO' then raise exception using errcode='55000',message='El activo ya está en BAJA.';end if;
 if exists(select 1 from public.asset_revaluation where asset_id=p_asset) then raise exception using errcode='55000',message='El activo tiene revaluaciones: concilie su costo contable antes de la salida.';end if;
 if exists(select 1 from public.asset_impairment where asset_id=p_asset and (transaction_id is null or not asset_posting_private.finite(impairment_loss) or impairment_loss<0)) then raise exception using errcode='55000',message='El deterioro debe estar contabilizado antes de la salida.';end if;
 select coalesce(sum(depreciation_amount),0),coalesce(sum(depreciated_months),0)::integer into acc,months from public.asset_depreciation where asset_id=p_asset;
 select coalesce(sum(impairment_loss),0) into imp from public.asset_impairment where asset_id=p_asset and assessment_date<=p_date;
 if not asset_posting_private.finite(a.purchase_cost) or not asset_posting_private.finite(acc) or not asset_posting_private.finite(imp) or least(a.purchase_cost,acc,imp)<0 or acc+imp>a.purchase_cost then raise exception using errcode='55000',message='Los saldos del activo no son válidos.';end if;
 if a.exchange_rate<>1 or a.currency_id<>(select currency_id from public.subsidiaries where subsidiary_id=a.subsidiary_id) then raise exception using errcode='55000',message='Concilie el activo a moneda funcional antes de contabilizar su salida.';end if;
 baseline:=a.in_service_date;
 if a.is_opening_balance then select greatest(baseline,opening_date+1) into baseline from public.opening_balance_runs where id=a.opening_run_id;end if;
 if c.depreciation_method<>'No Depreciable' and acc<greatest(a.purchase_cost-a.purchase_cost*coalesce(c.residual_value_percentage,0)/100-imp,0) then
  if exists(select 1 from generate_series(date_trunc('month',baseline)::date,month_start-interval '1 month',interval '1 month') m
   where not exists(select 1 from public.asset_depreciation d where d.asset_id=p_asset and not d.is_opening_balance and date_trunc('month',d.depreciation_date)=m and d.depreciation_date>=(m+interval '1 month -1 day')::date)) then
   raise exception using errcode='55000',message='Hay meses pendientes: contabilice la depreciación hasta el mes anterior a la operación.';
  end if;
  select * into row_cut from public.asset_depreciation where asset_id=p_asset and not is_opening_balance and depreciation_date>=month_start order by depreciation_date desc limit 1;
  if row_cut.depreciation_id is not null then
   if row_cut.disposal_cut_monthly is not null then
    monthly:=row_cut.disposal_cut_monthly;
    due:=greatest(round(monthly*(p_date-greatest(month_start,baseline)+1)::numeric/extract(day from (month_start+interval '1 month -1 day')),6)-row_cut.depreciation_amount,0);
   elsif row_cut.depreciation_date<>p_date then raise exception using errcode='55000',message='La depreciación del mes no corresponde al corte solicitado.';
   end if;
  elsif p_date>=baseline then
   monthly:=least(public.fixed_asset_period_depreciation(a.purchase_cost,c.residual_value_percentage,c.useful_life_months,c.depreciation_method,months,acc),greatest(a.purchase_cost-acc-imp-a.purchase_cost*coalesce(c.residual_value_percentage,0)/100,0));
   due:=greatest(round(monthly*(p_date-greatest(month_start,baseline)+1)::numeric/extract(day from (month_start+interval '1 month -1 day')),6),0);
  end if;
 end if;
 return jsonb_build_object('cost',a.purchase_cost,'accumulated',acc,'impairment',imp,'bookValue',a.purchase_cost-acc-imp,'cutDue',due,'monthly',coalesce(monthly,0));
end$$;

create function public.fixed_asset_disposal_accounting(p_action text,p_payload jsonb default '{}') returns jsonb
language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$
declare sid bigint;aid bigint;dt date;pid bigint;a public.asset;c public.asset_category;cfg public.asset_disposal_settings;
 v jsonb;lines jsonb:='[]';entry jsonb;result jsonb;item jsonb;amount numeric;rate numeric:=1;tax numeric:=0;tax_rate numeric:=0;
 net numeric;gain numeric;acc numeric;imp numeric;cost numeric;book numeric;due numeric;cur bigint;base_cur bigint;
 collection bigint;customer bigint;tax_code bigint;tax_account bigint;jid bigint;tid bigint;did bigint;request uuid;old public.asset_disposal;
 reverse_dt date;line record;cut record;impact bigint;number text;key text;account_key bigint;
begin
 if p_action not in ('OPTIONS','SETTINGS','PREVIEW','POST','CUT','REVERSE') then raise exception using errcode='22023',message='Acción inválida.';end if;
 sid:=asset_operation_private.access('DISPOSAL',case when p_action='REVERSE' then 'delete' when p_action in ('POST','CUT') then 'create' else 'view' end);
 select currency_id into base_cur from public.subsidiaries where subsidiary_id=sid;
 select * into cfg from public.asset_disposal_settings where subsidiary_id=sid;
 if p_action='SETTINGS' then
  perform asset_posting_private.access('fixed-assets:asset-categories','edit');
  foreach key in array array['loss_account_id','sale_loss_account_id','gain_account_id','impairment_account_id'] loop
   account_key:=nullif(p_payload->>key,'')::bigint;if account_key is not null then
    perform asset_posting_private.account(account_key);
    if not exists(select 1 from public.chart_accounts where account_id=account_key and category=case key when 'gain_account_id' then 'Ingreso' when 'impairment_account_id' then 'Activo' else 'Gasto' end) then raise exception using errcode='22023',message='Las cuentas de salida deben corresponder a gasto, ingreso o deterioro acumulado según su uso.';end if;
   end if;
  end loop;
  insert into public.asset_disposal_settings values(sid,nullif(p_payload->>'loss_account_id','')::bigint,nullif(p_payload->>'sale_loss_account_id','')::bigint,nullif(p_payload->>'gain_account_id','')::bigint,nullif(p_payload->>'impairment_account_id','')::bigint)
  on conflict(subsidiary_id) do update set loss_account_id=excluded.loss_account_id,sale_loss_account_id=excluded.sale_loss_account_id,gain_account_id=excluded.gain_account_id,impairment_account_id=excluded.impairment_account_id;
  return jsonb_build_object('message','Cuentas de salida guardadas para la subsidiaria.');
 end if;
 if p_action='OPTIONS' then
  return jsonb_build_object('settings',to_jsonb(cfg),'canConfigure',asset_posting_private.allowed('fixed-assets:asset-categories','edit'),
   'accounts',coalesce((select jsonb_agg(jsonb_build_object('id',x.account_id,'name',x.account_number||' · '||x.account_name) order by x.account_number) from public.chart_accounts x join public.account_subsidiaries s using(account_id) where s.subsidiary_id=sid and s.is_active and x.accepts_entries and not x.is_inactive),'[]'),
   'customers',coalesce((select jsonb_agg(jsonb_build_object('id',x.customer_id,'name',x.company_name) order by x.company_name) from public.customers x where x.primary_subsidiary_id=sid or exists(select 1 from public.entity_subsidiaries s where s.customer_id=x.customer_id and s.subsidiary_id=sid)),'[]'),
   'currencies',coalesce((select jsonb_agg(jsonb_build_object('id',x.currency_id,'name',x.currency_code)) from public.currencies x join public.subsidiary_currencies s using(currency_id) where s.subsidiary_id=sid),'[]'),
   'taxes',coalesce((select jsonb_agg(jsonb_build_object('id',x.tax_code_id,'name',x.code_name,'rate',x.rate_percentage)) from public.tax_codes x where x.subsidiary_id=sid and not x.is_withholding and not coalesce(x.is_import_tax,false)),'[]'),'currencyId',base_cur);
 end if;
 if p_action='REVERSE' then
  did:=(p_payload->>'id')::bigint;v:=asset_operation_private.record('DISPOSAL',did);select * into old from public.asset_disposal where disposal_id=did;
  if old.reversed_at is not null then return jsonb_build_object('id',did,'journalId',old.reversal_journal_id,'message','La operación ya fue reversada.');end if;
  if old.journal_id is null then raise exception using errcode='55000',message='La operación histórica no tiene asiento automático; revise su contabilidad antes de revertirla.';end if;
  aid:=old.asset_id;a:=asset_master_private.asset(aid);reverse_dt:=(p_payload->>'date')::date;
  if reverse_dt<old.disposal_date or nullif(trim(p_payload->>'note'),'') is null then raise exception using errcode='22023',message='Indique fecha posterior o igual a la salida y motivo de reversión.';end if;
  pid:=asset_posting_private.period(reverse_dt);perform asset_operation_private.date(aid,reverse_dt,'DISPOSAL',did);
  if a.status<>'BAJA' then raise exception using errcode='55000',message='El estado del activo cambió.';end if;
  if exists(select 1 from public.journal where reversed_from_journal_id=old.journal_id) then raise exception using errcode='55000',message='El asiento tiene otra reversión; revise su historial.';end if;
  for line in select * from public.journal_line where journal_id=old.journal_id order by journal_line_id loop
   perform asset_posting_private.account(line.account_id);
   lines:=lines||jsonb_build_array(asset_operation_private.disposal_line(line.account_id,line.credit,line.debit,'Reversión '||old.disposal_number,a)||jsonb_build_object('entity_type',line.entity_type,'entity_id',line.customer_id,'customer_id',line.customer_id));
  end loop;
  entry:=jsonb_build_object('journal_date',reverse_dt,'currency_id',base_cur,'fiscal_period_id',pid,'exchange_rate',1,'journal_type',(select name from public.transaction_types where abbreviation='ASI_DIA' limit 1),'memo','Reversión '||old.disposal_number||' · '||(p_payload->>'note'),'lines',lines);
  jid:=asset_operation_private.post_disposal_journal(entry,sid,aid,'REVERSE',old.journal_id);
  update public.asset_disposal set reversed_at=now(),reversal_journal_id=jid,reversal_date=reverse_dt,reversal_note=p_payload->>'note' where disposal_id=did;
  update public.asset set status='ACTIVO' where asset_id=aid;
  return jsonb_build_object('id',did,'journalId',jid,'number',old.disposal_number,'message','Salida reversada; activo reactivado.');
 end if;
 aid:=(p_payload->>'asset_id')::bigint;dt:=(p_payload->>'date')::date;a:=asset_master_private.asset(aid);pid:=asset_posting_private.period(dt);
 if p_action='POST' then
  request:=nullif(p_payload->>'request_id','')::uuid;if request is null then raise exception using errcode='22023',message='Falta la clave de la operación.';end if;
  select * into old from public.asset_disposal where request_id=request;
  if found then
   if old.asset_id<>aid or old.accounting_snapshot->'request' is distinct from p_payload then raise exception using errcode='22023',message='La clave ya corresponde a otra operación.';end if;
   return jsonb_build_object('id',old.disposal_id,'number',old.disposal_number,'journalId',old.journal_id,'message','Operación ya contabilizada.');
  end if;
 end if;
 v:=asset_operation_private.disposal_values(aid,dt);select * into c from public.asset_category where category_id=a.category_id;
 cost:=(v->>'cost')::numeric;acc:=(v->>'accumulated')::numeric;imp:=(v->>'impairment')::numeric;book:=(v->>'bookValue')::numeric;due:=(v->>'cutDue')::numeric;
 if p_action='CUT' then
  perform asset_posting_private.access('fixed-assets:asset-depreciations','create');
  if due=0 then return jsonb_build_object('message','La depreciación ya está al corte.');end if;
  perform asset_posting_private.account(c.depreciation_account_id);perform asset_posting_private.account(c.depreciation_expense_account_id);
  lines:=jsonb_build_array(asset_operation_private.disposal_line(c.depreciation_expense_account_id,due,0,'Depreciación al corte '||a.asset_number,a),asset_operation_private.disposal_line(c.depreciation_account_id,0,due,'Depreciación acumulada al corte '||a.asset_number,a));
  entry:=jsonb_build_object('journal_date',dt,'currency_id',base_cur,'fiscal_period_id',pid,'exchange_rate',1,'journal_type',(select name from public.transaction_types where abbreviation='ASI_DIA' limit 1),'memo','Depreciación al corte '||a.asset_number,'lines',lines);
  jid:=asset_operation_private.post_disposal_journal(entry,sid,aid,'CUT');
  select min(g.gl_impact_id) into impact from public.journal j join public.gl_impact g using(transaction_id) where j.journal_id=jid;
  select * into cut from public.asset_depreciation where asset_id=aid and fiscal_period_id=pid and not is_opening_balance for update;
  if cut.depreciation_id is not null then
   -- Preserve every posted cut as a separate journal while the auxiliary stores the cumulative month.
   update public.asset_depreciation set depreciation_date=dt,depreciation_amount=depreciation_amount+due,accumulated_depreciation=acc+due where depreciation_id=cut.depreciation_id;
  else
   insert into public.asset_depreciation(asset_id,depreciation_date,fiscal_period_id,gl_impact_id,depreciation_amount,accumulated_depreciation,depreciated_months,is_opening_balance,disposal_cut_monthly)
   values(aid,dt,pid,impact,due,acc+due,0,false,(v->>'monthly')::numeric);
  end if;
  return jsonb_build_object('journalId',jid,'message','Depreciación proporcional al corte contabilizada.');
 end if;
 if p_payload->>'disposal_type' is null or p_payload->>'disposal_type' not in ('BAJA','VENTA','DONACION','PERDIDA') or nullif(trim(p_payload->>'note'),'') is null then raise exception using errcode='22023',message='Complete tipo y motivo de salida.';end if;
 if exists(select 1 from public.asset_disposal where asset_id=aid and reversed_at is null) or exists(select 1 from public.asset_maintenance where asset_id=aid and status in ('PROGRAMADO','EN PROCESO')) then raise exception using errcode='55000',message='El activo tiene otra salida o un mantenimiento pendiente.';end if;
 amount:=coalesce(nullif(p_payload->>'sale_amount','')::numeric,0);if not asset_posting_private.finite(amount) or amount<0 or(p_payload->>'disposal_type'<>'VENTA' and amount<>0) then raise exception using errcode='22023',message='Monto de venta inválido.';end if;
 cur:=case when p_payload->>'disposal_type'='VENTA' then coalesce(nullif(p_payload->>'currency_id','')::bigint,base_cur) else base_cur end;
 if not exists(select 1 from public.subsidiary_currencies where subsidiary_id=sid and currency_id=cur) then raise exception using errcode='42501',message='Moneda no autorizada.';end if;
 if cur<>base_cur then select spot_rate into rate from public.exchange_rates where from_currency_id=cur and to_currency_id=base_cur and effective_date=dt order by exchange_rate_id desc limit 1;if rate is null or not asset_posting_private.finite(rate) or rate<=0 then raise exception using errcode='55000',message='Configure el tipo de cambio de la fecha de venta.';end if;end if;
 if p_payload->>'disposal_type'='VENTA' then
  customer:=nullif(p_payload->>'customer_id','')::bigint;collection:=nullif(p_payload->>'collection_account_id','')::bigint;tax_code:=nullif(p_payload->>'tax_code_id','')::bigint;
  if customer is null or not exists(select 1 from public.customers x where x.customer_id=customer and(x.primary_subsidiary_id=sid or exists(select 1 from public.entity_subsidiaries s where s.customer_id=x.customer_id and s.subsidiary_id=sid))) then raise exception using errcode='42501',message='Seleccione un cliente de la subsidiaria.';end if;
  if nullif(trim(p_payload->>'invoice_reference'),'') is null then raise exception using errcode='22023',message='Indique la referencia de la factura externa.';end if;
  if exists(select 1 from public.invoice where subsidiary_id=sid and invoice_number=trim(p_payload->>'invoice_reference')) or exists(select 1 from public.asset_disposal d join public.asset x using(asset_id) where x.subsidiary_id=sid and d.invoice_reference=trim(p_payload->>'invoice_reference') and d.reversed_at is null) then raise exception using errcode='55000',message='La factura ya está registrada: evite duplicar el ingreso y el impuesto.';end if;
  perform asset_posting_private.account(collection);
  if not exists(select 1 from public.chart_accounts where account_id=collection and category='Activo') then raise exception using errcode='22023',message='La cuenta de cobro o CxC debe ser una cuenta de activo.';end if;
  if tax_code is not null then
   select x.rate_percentage,t.liability_account_id into tax_rate,tax_account from public.tax_codes x join public.tax_types t using(tax_type_id) where x.tax_code_id=tax_code and x.subsidiary_id=sid and not x.is_withholding and not coalesce(x.is_import_tax,false);
   if tax_rate is null or not asset_posting_private.finite(tax_rate) or tax_rate<0 then raise exception using errcode='22023',message='Código de impuesto inválido.';end if;
  elsif coalesce(p_payload->>'tax_exempt_reason','')='' then raise exception using errcode='22023',message='Seleccione impuesto o indique el motivo de exención.';end if;
  tax:=round(amount*tax_rate/100,6);
 end if;
 net:=round(amount*rate,6);tax:=round(tax*rate,6);gain:=net-book;
 perform asset_posting_private.account(c.asset_account_id);perform asset_posting_private.account(c.depreciation_account_id);
 if acc>0 then lines:=lines||jsonb_build_array(asset_operation_private.disposal_line(c.depreciation_account_id,acc,0,'Retiro depreciación acumulada',a));end if;
 if imp>0 then perform asset_posting_private.account(cfg.impairment_account_id);lines:=lines||jsonb_build_array(asset_operation_private.disposal_line(cfg.impairment_account_id,imp,0,'Retiro deterioro acumulado',a));end if;
 if net+tax>0 then lines:=lines||jsonb_build_array(asset_operation_private.disposal_line(collection,net+tax,0,'Cobro / CxC '||trim(p_payload->>'invoice_reference'),a)||jsonb_build_object('entity_type','Cliente','entity_id',customer,'customer_id',customer));end if;
 if gain<0 then account_key:=case when p_payload->>'disposal_type'='VENTA' then cfg.sale_loss_account_id else cfg.loss_account_id end;perform asset_posting_private.account(account_key);lines:=lines||jsonb_build_array(asset_operation_private.disposal_line(account_key,-gain,0,'Pérdida por salida',a));end if;
 if cost>0 then lines:=lines||jsonb_build_array(asset_operation_private.disposal_line(c.asset_account_id,0,cost,'Retiro costo del activo',a));end if;
 if tax>0 then perform asset_posting_private.account(tax_account);lines:=lines||jsonb_build_array(asset_operation_private.disposal_line(tax_account,0,tax,'Impuesto por pagar',a));end if;
 if gain>0 then perform asset_posting_private.account(cfg.gain_account_id);lines:=lines||jsonb_build_array(asset_operation_private.disposal_line(cfg.gain_account_id,0,gain,'Utilidad en venta',a));end if;
 entry:=jsonb_build_object('journal_date',dt,'currency_id',base_cur,'fiscal_period_id',pid,'exchange_rate',1,'journal_type',(select name from public.transaction_types where abbreviation='ASI_DIA' limit 1),'memo',(p_payload->>'disposal_type')||' '||a.asset_number||' · '||(p_payload->>'note'),'lines',lines);
 perform journal_entry_private.validate_payload(entry,sid);
 result:=v||jsonb_build_object('lines',lines,'saleLocal',net,'taxAmount',tax,'gainLoss',gain,'exchangeRate',rate,'canPost',due=0,'message',case when due>0 then 'Contabilice la depreciación al corte antes de confirmar.' else 'Asiento listo para contabilizar.' end);
 if p_action='PREVIEW' then return result;end if;
 if due>0 then raise exception using errcode='55000',message='Debe contabilizar la depreciación al corte antes de la salida.';end if;
 jid:=asset_operation_private.post_disposal_journal(entry,sid,aid,'DISPOSAL');
 select transaction_id into tid from public.journal where journal_id=jid;
 if tid is null or not exists(select 1 from public.gl_impact where transaction_id=tid) then raise exception using errcode='55000',message='El asiento no generó movimientos en el libro mayor.';end if;
 number:=asset_operation_private.asset_operation_number('BAJ-ACT','asset_disposal','disposal_number');
 insert into public.asset_disposal(disposal_date,asset_id,transaction_id,disposal_type,sale_amount,gain_loss_amount,disposal_number,book_value,accumulated_depreciation,note,journal_id,customer_id,currency_id,exchange_rate,tax_code_id,tax_amount,impairment_amount,invoice_reference,collection_account_id,request_id,accounting_snapshot)
 values(dt,aid,tid,p_payload->>'disposal_type',amount,gain,number,book,acc,p_payload->>'note',jid,customer,cur,rate,tax_code,tax,imp,nullif(trim(p_payload->>'invoice_reference'),''),collection,request,result||jsonb_build_object('request',p_payload)) returning disposal_id into did;
 update public.asset set status='BAJA' where asset_id=aid;
 return jsonb_build_object('id',did,'number',number,'journalId',jid,'message','Salida y asiento contabilizados correctamente.');
end$$;

-- The former registration-only path must not bypass accounting.
alter function public.save_fixed_asset_operation(jsonb,bigint) rename to save_fixed_asset_operation_before_accounting;
create function public.save_fixed_asset_operation(p_payload jsonb,p_operation_id bigint default null) returns jsonb language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$begin
 if p_payload->>'type'='DISPOSAL' then
  if p_operation_id is not null then raise exception using errcode='55000',message='Las salidas conservan su historial. Revierta y registre una nueva operación.';end if;
  return public.fixed_asset_disposal_accounting('POST',p_payload);
 end if;
 return public.save_fixed_asset_operation_before_accounting(p_payload,p_operation_id);
end$$;
alter function public.delete_fixed_asset_operation(text,bigint) rename to delete_fixed_asset_operation_before_accounting;
create function public.delete_fixed_asset_operation(p_type text,p_operation_id bigint) returns boolean language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$begin
 if p_type='DISPOSAL' then raise exception using errcode='55000',message='Utilice Reversar para conservar el historial contable.';end if;
 return public.delete_fixed_asset_operation_before_accounting(p_type,p_operation_id);
end$$;

-- Enrich reports without changing the stored ACTIVO/BAJA states.
create function asset_operation_private.exit_label(p_asset bigint) returns text language sql stable security definer set search_path=pg_catalog,public,pg_temp as $$
 select case when disposal_type='VENTA' then 'Venta' else 'Baja' end from public.asset_disposal where asset_id=p_asset and reversed_at is null order by disposal_date desc,disposal_id desc limit 1
$$;
do $$declare body text;begin
 body:=pg_get_functiondef('asset_master_private.fixed_asset_report(jsonb)'::regprocedure);
 body:=replace(body,'''status'',a.status','''status'',a.status,''exitType'',case when a.status=''BAJA'' then asset_operation_private.exit_label(a.asset_id) end');execute body;
 body:=pg_get_functiondef('asset_master_private.fixed_asset_analytics(jsonb)'::regprocedure);
 body:=replace(body,'''status'',a.status','''status'',a.status,''exitType'',case when a.status=''BAJA'' then asset_operation_private.exit_label(a.asset_id) end');
 body:=replace(body,'''type'',''BAJA''','''type'',case when d.reversed_at is not null then ''SALIDA REVERSADA'' when d.disposal_type=''VENTA'' then ''VENTA'' else ''BAJA'' end');
 body:=replace(body,'''type'',d.disposal_type','''type'',d.disposal_type,''reversed'',d.reversed_at is not null');execute body;
 body:=pg_get_functiondef('asset_operation_private.fixed_asset_operation_report(jsonb)'::regprocedure);
 body:=replace(body,'''type'',d.disposal_type','''type'',d.disposal_type,''journalId'',d.journal_id,''currency'',(select currency_code from public.currencies where currency_id=d.currency_id),''exchangeRate'',d.exchange_rate,''taxAmount'',d.tax_amount,''invoiceReference'',d.invoice_reference,''reversalJournalId'',d.reversal_journal_id,''reversed'',d.reversed_at is not null,''accountingStatus'',case when d.reversed_at is not null then ''REVERSADA'' when d.journal_id is not null then ''CONTABILIZADA'' else ''HISTÓRICA'' end');execute body;
end$$;

create function asset_operation_private.protect_disposal_status() returns trigger language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$begin
 if new.status<>'BAJA' and exists(select 1 from public.asset_disposal where asset_id=new.asset_id and reversed_at is null and journal_id is not null) then raise exception using errcode='55000',message='Revierta la salida contabilizada antes de reactivar el activo.';end if;
 return new;
end$$;
create trigger disposal_asset_status before update of status on public.asset for each row execute function asset_operation_private.protect_disposal_status();
revoke all on function asset_operation_private.protect_disposal_status() from public,anon,authenticated,service_role;

-- Complete a partial cut after a reversal before the regular monthly runner continues.
alter function public.run_fixed_asset_depreciation(date,jsonb) rename to run_fixed_asset_depreciation_before_disposal;
create function public.run_fixed_asset_depreciation(p_date date,p_asset_ids jsonb) returns jsonb language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$
declare sid bigint;aid bigint;a public.asset;c public.asset_category;d record;due numeric;entry jsonb;jid bigint;pid bigint;cur bigint;result jsonb;extra integer:=0;
begin
 sid:=asset_posting_private.access('fixed-assets:asset-depreciations','create');
 for aid in select unnest(asset_posting_private.ids(p_asset_ids)) order by 1 loop
  a:=asset_master_private.asset(aid);if a.status<>'ACTIVO' then continue;end if;
  for d in select * from public.asset_depreciation where asset_id=aid and disposal_cut_monthly is not null and depreciation_date<=p_date order by depreciation_date for update loop
   if p_date<(date_trunc('month',d.depreciation_date)+interval '1 month -1 day')::date then raise exception using errcode='55000',message='Complete el mes de depreciación después de reversar la salida.';end if;
   perform asset_posting_private.period(d.depreciation_date);pid:=asset_posting_private.period(p_date);
   due:=greatest(d.disposal_cut_monthly-d.depreciation_amount,0);select * into c from public.asset_category where category_id=a.category_id;
   if due>0 then
    perform asset_posting_private.account(c.depreciation_account_id);perform asset_posting_private.account(c.depreciation_expense_account_id);
    select currency_id into cur from public.subsidiaries where subsidiary_id=sid;
    entry:=jsonb_build_object('journal_date',p_date,'currency_id',cur,'fiscal_period_id',pid,'exchange_rate',1,'journal_type',(select name from public.transaction_types where abbreviation='ASI_DIA' limit 1),'memo','Complemento depreciación '||a.asset_number,'lines',jsonb_build_array(asset_operation_private.disposal_line(c.depreciation_expense_account_id,due,0,'Complemento al corte',a),asset_operation_private.disposal_line(c.depreciation_account_id,0,due,'Depreciación acumulada',a)));
    jid:=asset_operation_private.post_disposal_journal(entry,sid,aid,'CUT_COMPLETION');
   end if;
   update public.asset_depreciation set depreciation_amount=disposal_cut_monthly,accumulated_depreciation=accumulated_depreciation+due,depreciated_months=1,disposal_cut_monthly=null,depreciation_date=(date_trunc('month',d.depreciation_date)+interval '1 month -1 day')::date where depreciation_id=d.depreciation_id;
   extra:=extra+1;
  end loop;
 end loop;
 result:=public.run_fixed_asset_depreciation_before_disposal(p_date,p_asset_ids);
 return result||jsonb_build_object('cutCompleted',extra,'message',(result->>'message')||case when extra>0 then ' Cortes completados: '||extra||'.' else '' end);
end$$;
revoke all on function public.run_fixed_asset_depreciation_before_disposal(date,jsonb),public.run_fixed_asset_depreciation(date,jsonb) from public,anon,authenticated,service_role;
grant execute on function public.run_fixed_asset_depreciation(date,jsonb) to authenticated;

create function asset_operation_private.protect_disposal_journal() returns trigger language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$
begin
 if exists(select 1 from asset_operation_private.disposal_journal_links where (tg_op<>'INSERT' and journal_id=old.journal_id) or (tg_op<>'DELETE' and journal_id=new.journal_id)) then raise exception using errcode='55000',message='El asiento de salida es inmutable; utilice la reversión de Activos Fijos.';end if;
 if tg_op='DELETE' then return old;end if;return new;
end$$;
create trigger disposal_journal_immutable before update or delete on public.journal for each row execute function asset_operation_private.protect_disposal_journal();
create trigger disposal_lines_immutable before insert or update or delete on public.journal_line for each row execute function asset_operation_private.protect_disposal_journal();
revoke all on function asset_operation_private.protect_disposal_journal() from public,anon,authenticated,service_role;
revoke all on function public.save_fixed_asset_operation_before_accounting(jsonb,bigint),public.delete_fixed_asset_operation_before_accounting(text,bigint) from public,anon,authenticated,service_role;
revoke all on function public.fixed_asset_disposal_accounting(text,jsonb),public.save_fixed_asset_operation(jsonb,bigint),public.delete_fixed_asset_operation(text,bigint) from public,anon,authenticated,service_role;
grant execute on function public.fixed_asset_disposal_accounting(text,jsonb),public.save_fixed_asset_operation(jsonb,bigint),public.delete_fixed_asset_operation(text,bigint) to authenticated;
revoke all on function asset_operation_private.disposal_line(bigint,numeric,numeric,text,public.asset),asset_operation_private.disposal_values(bigint,date),asset_operation_private.exit_label(bigint) from public,anon,authenticated,service_role;
notify pgrst,'reload schema';
