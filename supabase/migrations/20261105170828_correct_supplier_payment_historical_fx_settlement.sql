-- Future supplier settlements only. Reconstruct each identified component at
-- its historical carrying value; never repair old journals or account balances.
set local lock_timeout='5s';
set local statement_timeout='60s';

create function supplier_payment_private.invoice_basis(iid bigint,excluded bigint)
returns jsonb language plpgsql stable set search_path=pg_catalog,public,pg_temp as $$
declare i public.supplier_invoice;j public.journal;t public."transaction";n record;g record;sid bigint:=public.active_subsidiary_id();native numeric;local_value numeric;rate numeric;first_payment bigint;
begin
 select * into i from public.supplier_invoice where invoice_id=iid and subsidiary_id=sid;
 if not found or i.payable_account_id is null or not asset_posting_private.finite(i.exchange_rate)or i.exchange_rate<=0 then raise exception using errcode='55000',message='La factura requiere revisión de su origen histórico antes de pagar.';end if;
 select * into j from public.journal where journal_id=i.journal_id;select * into t from public."transaction" where transaction_id=i.transaction_id;
 if coalesce(i.is_opening_balance,false)then
  if i.opening_balance_line_id is null or i.opening_run_id is null or not coalesce(j.is_opening_balance,false)or j.transaction_id is distinct from i.transaction_id or j.subsidiary_id is distinct from sid or t.subsidiary_id is distinct from sid or j.status is distinct from'CONTABILIZADO'or exists(select 1 from public.journal where reversed_from_journal_id=i.journal_id)then raise exception using errcode='55000',message='La factura inicial necesita su vínculo exacto con el mayor de apertura.';end if;
 elsif j.transaction_id is distinct from i.transaction_id or j.subsidiary_id is distinct from sid or t.subsidiary_id is distinct from sid or j.status is distinct from'CONTABILIZADO' or j.currency_id is distinct from i.currency_id or t.currency_id is distinct from i.currency_id or j.exchange_rate is distinct from i.exchange_rate or t.exchange_rate is distinct from i.exchange_rate
 or(select abbreviation from public.transaction_types where transaction_type_id=t.transaction_type_id)is distinct from'FAC_PRO'
 or exists(select 1 from public.journal where reversed_from_journal_id=i.journal_id)
 or(select count(*)from public.supplier_invoice where journal_id=i.journal_id)<>1 then raise exception using errcode='55000',message='El asiento de la factura no permite atribuir su valor histórico.';end if;
 native:=case when i.payable_amount=0 and exists(select 1 from public.supplier_invoice_withholding where invoice_id=iid and recognized_at_invoice and withholding_amount>0)then 0 else coalesce(nullif(i.payable_amount,0),i.total_amount)end;
 select count(*)n,sum(credit_amount-debit_amount)l,sum(credit_fx-debit_fx)f,bool_and(case when coalesce(i.is_opening_balance,false)then original_currency_id=i.currency_id else coalesce(original_currency_id,i.currency_id)=i.currency_id end)currency_ok into g from public.gl_impact where transaction_id=i.transaction_id and account_id=i.payable_account_id and subsidiary_id=sid and(not coalesce(i.is_opening_balance,false)or opening_balance_line_id=i.opening_balance_line_id);
 if not asset_posting_private.finite(native)or native<0 or g.n>1 or coalesce(g.f,0)is distinct from native or coalesce(g.l,0)is distinct from round(native*i.exchange_rate,6)or(native>0 and(g.n<>1 or not coalesce(g.currency_ok,false)))then raise exception using errcode='55000',message='El mayor de la factura no coincide con su obligación histórica.';end if;
 if coalesce(i.is_opening_balance,false)and(select count(*)from public.journal_line l where l.journal_id=i.journal_id and l.opening_balance_line_id=i.opening_balance_line_id and l.account_id=i.payable_account_id and l.supplier_id=i.supplier_id and l.original_currency_id=i.currency_id and l.historical_exchange_rate=i.exchange_rate and l.credit-l.debit=g.l and l.credit_fx-l.debit_fx=native)<>1 then raise exception using errcode='55000',message='La factura inicial no conserva una línea única con proveedor, moneda e importe históricos.';end if;
 local_value:=coalesce(g.l,0);rate:=i.exchange_rate;
 select min(p.transaction_id)into first_payment from public.supplier_payment_application a join public.supplier_payment p using(payment_id)where a.invoice_id=iid and a.payment_id is distinct from excluded;
 for n in select 'CREDIT'kind,cn_id id,amount,supplier_id,currency_id,exchange_rate,journal_id,transaction_id from public.supplier_credit_note where invoice_id=iid union all select 'DEBIT',dn_id,amount,supplier_id,currency_id,exchange_rate,journal_id,transaction_id from public.supplier_debit_note where invoice_id=iid loop
 select * into j from public.journal where journal_id=n.journal_id;select * into t from public."transaction" where transaction_id=n.transaction_id;
  if n.supplier_id is distinct from i.supplier_id or n.currency_id is distinct from i.currency_id or not asset_posting_private.finite(n.amount)or n.amount<=0 or not asset_posting_private.finite(n.exchange_rate)or n.exchange_rate<=0
  or j.transaction_id is distinct from n.transaction_id or j.subsidiary_id is distinct from sid or t.subsidiary_id is distinct from sid or j.status is distinct from'CONTABILIZADO' or j.currency_id is distinct from i.currency_id or t.currency_id is distinct from i.currency_id or j.exchange_rate is distinct from n.exchange_rate or t.exchange_rate is distinct from n.exchange_rate
  or(select abbreviation from public.transaction_types where transaction_type_id=t.transaction_type_id)is distinct from(case n.kind when'CREDIT'then'NC_PRO'else'ND_PRO'end)
  or exists(select 1 from public.journal where reversed_from_journal_id=n.journal_id)
  or(n.exchange_rate<>i.exchange_rate and first_payment is not null and n.transaction_id>first_payment)then raise exception using errcode='55000',message='Las notas posteriores o su origen histórico requieren revisión antes de liquidar esta factura.';end if;
  select count(*)n,sum(case n.kind when'CREDIT'then debit_amount-credit_amount else credit_amount-debit_amount end)l,sum(case n.kind when'CREDIT'then debit_fx-credit_fx else credit_fx-debit_fx end)f,bool_and(coalesce(original_currency_id,i.currency_id)=i.currency_id)currency_ok into g from public.gl_impact where transaction_id=n.transaction_id and account_id=i.payable_account_id and subsidiary_id=sid;
  if g.n<>1 or g.f is distinct from n.amount or g.l is distinct from round(n.amount*n.exchange_rate,6)or not coalesce(g.currency_ok,false)then raise exception using errcode='55000',message='La nota no conserva un impacto histórico único de la factura.';end if;
  native:=native+case n.kind when'CREDIT'then -n.amount else n.amount end;local_value:=local_value+case n.kind when'CREDIT'then -g.l else g.l end;
  if n.exchange_rate<>i.exchange_rate then rate:=null;end if;
 end loop;
 if native<=0 or local_value<=0 then raise exception using errcode='55000',message='La obligación histórica pendiente no permite esta aplicación.';end if;
 if i.currency_id<>(select currency_id from public.subsidiaries where subsidiary_id=sid)and exists(select 1 from public.gl_impact x join public.journal r on r.transaction_id=x.transaction_id where x.subsidiary_id=sid and x.account_id=i.payable_account_id and r.fx_revaluation_run_id is not null)then raise exception using errcode='55000',message='La cuenta tiene revaluaciones sin atribución por factura; revise su valor histórico antes de pagar.';end if;
 return jsonb_build_object('account',i.payable_account_id,'currency',i.currency_id,'supplier',i.supplier_id,'native',native,'local',local_value,'rate',coalesce(rate,local_value/native));
end$$;

create function supplier_payment_private.invoice_values(pid bigint,excluded bigint)
returns table(account_id bigint,original_amount numeric,local_amount numeric)
language plpgsql stable set search_path=pg_catalog,public,pg_temp as $$
declare a record;b jsonb;paid numeric;native numeric;local_value numeric;rate numeric;
begin
 for a in select x.invoice_id,x.amount,p.transaction_id,p.currency_id,p.supplier_id from public.supplier_payment_application x join public.supplier_payment p using(payment_id)where x.payment_id=pid loop
  b:=supplier_payment_private.invoice_basis(a.invoice_id,excluded);native:=(b->>'native')::numeric;local_value:=(b->>'local')::numeric;rate:=(b->>'rate')::numeric;
  if(b->>'currency')::bigint is distinct from a.currency_id or(b->>'supplier')::bigint is distinct from a.supplier_id or not asset_posting_private.finite(a.amount)or a.amount<=0 then raise exception using errcode='55000',message='La aplicación no conserva proveedor, moneda e importe históricos.';end if;
  select coalesce(sum(x.amount),0)into paid from public.supplier_payment_application x join public.supplier_payment p using(payment_id)where x.invoice_id=a.invoice_id and x.payment_id<>pid and x.payment_id is distinct from excluded and p.transaction_id<a.transaction_id;
  if paid<0 or paid+a.amount>native then raise exception using errcode='55000',message='Las aplicaciones exceden la obligación histórica de la factura.';end if;
  account_id:=(b->>'account')::bigint;original_amount:=a.amount;
  local_amount:=(case when paid+a.amount=native then local_value else round((paid+a.amount)*rate,6)end)-(case when paid=0 then 0 else round(paid*rate,6)end);
  if local_amount<=0 then raise exception using errcode='55000',message='La aplicación no admite una valoración histórica positiva a seis decimales.';end if;return next;
 end loop;
end$$;

create function supplier_payment_private.advance_values(pid bigint,excluded bigint)
returns table(account_id bigint,original_amount numeric,local_amount numeric)
language plpgsql stable set search_path=pg_catalog,public,pg_temp as $$
declare a record;l public.journal_line;j public.journal;g record;expected record;paid numeric;native numeric;basis numeric;sid bigint:=public.active_subsidiary_id();
begin
 for a in select x.*,p.transaction_id,p.currency_id,p.supplier_id from public.supplier_advance_application x join public.supplier_payment p using(payment_id)where x.payment_id=pid loop
  select * into l from public.journal_line where journal_line_id=a.source_journal_line_id;select * into j from public.journal where journal_id=l.journal_id;native:=l.debit-l.credit;
  if j.subsidiary_id is distinct from sid or j.currency_id is distinct from a.currency_id or j.status is distinct from'CONTABILIZADO'or l.supplier_id is distinct from a.supplier_id or j.fx_revaluation_run_id is not null or not asset_posting_private.finite(j.exchange_rate)or j.exchange_rate<=0 or not asset_posting_private.finite(native)or native<=0
  or(l.historical_exchange_rate is not null and l.historical_exchange_rate<>j.exchange_rate)or exists(select 1 from public.journal where reversed_from_journal_id=j.journal_id)then raise exception using errcode='55000',message='El anticipo no tiene un valor histórico atribuible.';end if;
  select sum(debit-credit)f,sum(debit-credit)*j.exchange_rate v into expected from public.journal_line where journal_id=j.journal_id and journal_line.account_id=l.account_id;
  select sum(debit_fx-credit_fx)f,sum(debit_amount-credit_amount)v,bool_and(coalesce(original_currency_id,a.currency_id)=a.currency_id)c into g from public.gl_impact where transaction_id=j.transaction_id and gl_impact.account_id=l.account_id and subsidiary_id=sid;
  if g.f is distinct from expected.f or g.v is distinct from round(expected.v,6)or not coalesce(g.c,false)then raise exception using errcode='55000',message='El mayor del anticipo no coincide con su origen histórico.';end if;
  if a.currency_id<>(select currency_id from public.subsidiaries where subsidiary_id=sid)and exists(select 1 from public.gl_impact x join public.journal r on r.transaction_id=x.transaction_id where x.subsidiary_id=sid and x.account_id=l.account_id and r.fx_revaluation_run_id is not null)then raise exception using errcode='55000',message='El anticipo tiene revaluaciones sin atribución a su fuente; revise su valor histórico antes de aplicarlo.';end if;
  select coalesce(sum(x.amount),0)into paid from public.supplier_advance_application x join public.supplier_payment p using(payment_id)where x.source_journal_line_id=l.journal_line_id and x.payment_id<>pid and x.payment_id is distinct from excluded and p.transaction_id<a.transaction_id;
  if not asset_posting_private.finite(a.amount)or a.amount<=0 or paid+a.amount>native then raise exception using errcode='55000',message='El anticipo excede el saldo histórico disponible.';end if;
  basis:=round(native*j.exchange_rate,6);account_id:=l.account_id;original_amount:=a.amount;
  local_amount:=(case when paid+a.amount=native then basis else round((paid+a.amount)*j.exchange_rate,6)end)-round(paid*j.exchange_rate,6);return next;
 end loop;
end$$;

create function supplier_payment_private.validate_historical_payment(pid bigint,excluded bigint)
returns void language plpgsql stable set search_path=pg_catalog,public,pg_temp as $$
declare p public.supplier_payment;t public."transaction";j public.journal;a record;g record;sid bigint:=public.active_subsidiary_id();
begin
 select * into p from public.supplier_payment where payment_id=pid;select * into t from public."transaction" where transaction_id=p.transaction_id;select * into j from public.journal where journal_id=p.journal_id;
 if t.subsidiary_id is distinct from sid or j.subsidiary_id is distinct from sid or j.transaction_id is distinct from p.transaction_id or j.currency_id is distinct from p.currency_id or t.currency_id is distinct from p.currency_id or j.exchange_rate is distinct from p.exchange_rate or t.exchange_rate is distinct from p.exchange_rate or p.status is distinct from'APROBADO'or j.status is distinct from'CONTABILIZADO'or exists(select 1 from public.journal where reversed_from_journal_id=p.journal_id)then raise exception using errcode='55000',message='Un pago anterior requiere revisión de su origen histórico.';end if;
 for a in select account_id,sum(original_amount)n,sum(local_amount)v from supplier_payment_private.invoice_values(pid,excluded)group by account_id loop
  select count(*)n,sum(debit_amount-credit_amount)v,sum(debit_fx-credit_fx)f into g from public.gl_impact where transaction_id=p.transaction_id and gl_impact.account_id=a.account_id and subsidiary_id=sid and coalesce(original_currency_id,p.currency_id)=p.currency_id;
  if g.n<>1 or g.v is distinct from a.v or g.f is distinct from a.n then raise exception using errcode='55000',message='Un pago anterior no coincide con el valor histórico atribuible a sus facturas; no se reescribirá su contabilidad.';end if;
 end loop;
 for a in select account_id,sum(original_amount)n,sum(local_amount)v from supplier_payment_private.advance_values(pid,excluded)group by account_id loop
  select count(*)n,sum(credit_amount-debit_amount)v,sum(credit_fx-debit_fx)f into g from public.gl_impact where transaction_id=p.transaction_id and gl_impact.account_id=a.account_id and subsidiary_id=sid and coalesce(original_currency_id,p.currency_id)=p.currency_id;
  if g.n<>1 or g.v is distinct from a.v or g.f is distinct from a.n then raise exception using errcode='55000',message='Un pago anterior no conserva la baja histórica del anticipo.';end if;
 end loop;
end$$;

create function supplier_payment_private.rebuild_historical_fx(pid bigint,expected_total numeric)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$
declare p public.supplier_payment;b public.bank_account;sid bigint:=public.active_subsidiary_id();base_currency bigint;book bigint;key bigint;a record;g record;ap jsonb;adv jsonb;withheld jsonb;native numeric;advance_total numeric;withholding_total numeric;ap_local numeric;counter_local numeric;equivalent_debit numeric:=0;equivalent_credit numeric:=0;loss numeric;fx_account bigint;line_amount numeric;accounts jsonb;
begin
 select sp.* into p from public.supplier_payment sp join public."transaction" t using(transaction_id)where sp.payment_id=pid and t.subsidiary_id=sid for update of sp;
 select * into b from public.bank_account where bank_account_id=p.bank_account_id and subsidiary_id=sid;
 select currency_id into base_currency from public.subsidiaries where subsidiary_id=sid;
 if p.payment_id is null or b.bank_account_id is null or b.currency_id is distinct from p.currency_id or not asset_posting_private.finite(p.exchange_rate)or p.exchange_rate<=0 then raise exception using errcode='55000',message='El pago no conserva una cuenta bancaria y tasa válidas.';end if;
 for key in select distinct invoice_id from public.supplier_payment_application where payment_id=pid order by invoice_id loop perform public.ensure_supplier_invoice_payable_account(key);end loop;
 for key in select distinct old.payment_id from public.supplier_payment_application old where old.payment_id<>pid and old.invoice_id in(select invoice_id from public.supplier_payment_application where payment_id=pid)union select distinct old.payment_id from public.supplier_advance_application old where old.payment_id<>pid and old.source_journal_line_id in(select source_journal_line_id from public.supplier_advance_application where payment_id=pid)loop perform supplier_payment_private.validate_historical_payment(key,pid);end loop;
 select coalesce(jsonb_agg(to_jsonb(x)),'[]'),coalesce(sum(x.n),0),coalesce(sum(x.v),0)into ap,native,ap_local from(select account_id,sum(original_amount)n,sum(local_amount)v from supplier_payment_private.invoice_values(pid,pid)group by account_id)x;
 if native<=0 or native is distinct from expected_total then raise exception using errcode='55000',message='Las aplicaciones no coinciden con el importe aprobado de la liquidación.';end if;
 select coalesce(jsonb_agg(to_jsonb(x)),'[]'),coalesce(sum(x.n),0)into adv,advance_total from(select account_id,sum(original_amount)n,sum(local_amount)v from supplier_payment_private.advance_values(pid,pid)group by account_id)x;
 select coalesce(jsonb_agg(to_jsonb(x)),'[]'),coalesce(sum(x.n),0)into withheld,withholding_total from(select liability_account_id account_id,sum(withholding_amount)n from public.supplier_payment_withholding where payment_id=pid group by liability_account_id)x;
 if p.amount_paid is distinct from native-advance_total-withholding_total or p.amount_paid<0 then raise exception using errcode='55000',message='Banco, anticipos y retenciones no coinciden con la obligación aplicada.';end if;
 -- Accept only the exact components produced by the existing protected engines.
 if exists(select 1 from public.journal_line l where l.journal_id=p.journal_id and(l.supplier_id is distinct from p.supplier_id or l.entity_type is distinct from'Proveedor'or not(
 (l.debit>0 and l.credit=0 and l.account_id in(select(x->>'account_id')::bigint from jsonb_array_elements(ap)x))
 or(l.credit>0 and l.debit=0 and(l.account_id=b.account_id or l.note='Retención aplicada durante el pago'or l.note='Aplicación de anticipo de proveedor'))
 or(l.account_id=b.account_id and l.debit=0 and l.credit=0 and p.amount_paid=0)
 or l.note='Diferencia cambiaria realizada de pago de proveedor')))then raise exception using errcode='55000',message='El asiento contiene componentes no atribuibles; no se ajustará un descuadre desconocido.';end if;
 for a in select * from jsonb_to_recordset(ap)as x(account_id bigint,n numeric,v numeric)loop
  if a.account_id=b.account_id or exists(select 1 from jsonb_array_elements(adv||withheld)x where(x->>'account_id')::bigint=a.account_id)then raise exception using errcode='55000',message='Las cuentas de liquidación deben distinguir CxP, banco, retenciones y anticipos.';end if;
 end loop;
 if exists(select 1 from jsonb_array_elements(adv||withheld)x where(x->>'account_id')::bigint=b.account_id)or exists(select 1 from jsonb_array_elements(adv)x join jsonb_array_elements(withheld)y on(x->>'account_id')::bigint=(y->>'account_id')::bigint)then raise exception using errcode='55000',message='Las cuentas de contrapartida del pago requieren una configuración distinta.';end if;
 select count(*)n,sum(credit)v into g from public.journal_line where journal_id=p.journal_id and account_id=b.account_id;
 if(p.amount_paid=0 and(g.n>1 or coalesce(g.v,0)<>0))or(p.amount_paid>0 and(g.n<>1 or g.v is distinct from p.amount_paid))then raise exception using errcode='55000',message='La línea bancaria no coincide con el desembolso del pago.';end if;
 for a in select * from jsonb_to_recordset(withheld)as x(account_id bigint,n numeric)loop
  select sum(credit)v into g from public.journal_line where journal_id=p.journal_id and account_id=a.account_id and note='Retención aplicada durante el pago';if g.v is distinct from a.n then raise exception using errcode='55000',message='La contrapartida de retención no coincide con el cálculo guardado.';end if;
 end loop;
 for a in select * from jsonb_to_recordset(adv)as x(account_id bigint,n numeric,v numeric)loop
  select sum(credit)v into g from public.journal_line where journal_id=p.journal_id and account_id=a.account_id and note='Aplicación de anticipo de proveedor';if g.v is distinct from a.n then raise exception using errcode='55000',message='La contrapartida de anticipo no coincide con la aplicación guardada.';end if;
 end loop;
 -- Rebuild only this newly saved payment. JL retains payment-rate equivalents;
 -- GL below receives exact historical local/native values, including round6.
 delete from public.journal_line where journal_id=p.journal_id and(debit>0 or note in('Aplicación de anticipo de proveedor','Diferencia cambiaria realizada de pago de proveedor')or(account_id=b.account_id and debit=0 and credit=0));
 for a in select * from jsonb_to_recordset(ap)as x(account_id bigint,n numeric,v numeric)loop
  line_amount:=round(a.v/p.exchange_rate,6);equivalent_debit:=equivalent_debit+line_amount;
  insert into public.journal_line(journal_id,account_id,debit,credit,debit_fx,credit_fx,location_id,note,entity_type,supplier_id,historical_exchange_rate,original_currency_id)values(p.journal_id,a.account_id,line_amount,0,a.v,0,p.location_id,'Liquidación CxP histórica por factura','Proveedor',p.supplier_id,a.v/a.n,p.currency_id);
 end loop;
 equivalent_credit:=p.amount_paid+withholding_total;counter_local:=round(p.amount_paid*p.exchange_rate,6);
 for a in select * from jsonb_to_recordset(withheld)as x(account_id bigint,n numeric)loop counter_local:=counter_local+round(a.n*p.exchange_rate,6);end loop;
 for a in select * from jsonb_to_recordset(adv)as x(account_id bigint,n numeric,v numeric)loop
  line_amount:=round(a.v/p.exchange_rate,6);equivalent_credit:=equivalent_credit+line_amount;counter_local:=counter_local+a.v;
  insert into public.journal_line(journal_id,account_id,debit,credit,debit_fx,credit_fx,location_id,note,entity_type,supplier_id,historical_exchange_rate,original_currency_id)values(p.journal_id,a.account_id,0,line_amount,0,a.v,p.location_id,'Aplicación de anticipo de proveedor','Proveedor',p.supplier_id,a.v/a.n,p.currency_id);
 end loop;
 loss:=round(counter_local-ap_local,6);
 if loss<>0 then
  select ca.account_id into fx_account from public.chart_accounts ca join public.account_subsidiaries s using(account_id)where s.subsidiary_id=sid and s.is_active and ca.accepts_entries and not ca.is_inactive and ca.account_number=case when loss>0 then'632001'else'422001'end order by ca.account_id limit 1;
  if fx_account is null then raise exception using errcode='55000',message='Configure la cuenta activa de ganancia o pérdida cambiaria realizada de la empresa.';end if;
  if fx_account=b.account_id or exists(select 1 from jsonb_array_elements(ap||adv||withheld)x where(x->>'account_id')::bigint=fx_account)then raise exception using errcode='55000',message='La cuenta de diferencia cambiaria no puede ser una cuenta de liquidación.';end if;
  line_amount:=round(equivalent_credit-equivalent_debit,6);
  if(loss>0 and line_amount<0)or(loss<0 and line_amount>0)then raise exception using errcode='55000',message='La precisión de la liquidación requiere revisión antes de reconocer la diferencia cambiaria.';end if;
  insert into public.journal_line(journal_id,account_id,debit,credit,debit_fx,credit_fx,location_id,note,entity_type,supplier_id,historical_exchange_rate,original_currency_id)values(p.journal_id,fx_account,greatest(line_amount,0),greatest(-line_amount,0),greatest(loss,0),greatest(-loss,0),p.location_id,'Diferencia cambiaria realizada de pago de proveedor','Proveedor',p.supplier_id,1,base_currency);
 elsif abs(equivalent_credit-equivalent_debit)>.000001 then raise exception using errcode='55000',message='La precisión de las aplicaciones no permite conservar un asiento balanceado a seis decimales.';
 end if;
 update public.journal set total_debit=(select sum(debit)from public.journal_line where journal_id=p.journal_id),total_credit=(select sum(credit)from public.journal_line where journal_id=p.journal_id)where journal_id=p.journal_id;
 perform public.sync_journal_gl_impacts(p.journal_id);
 select accounting_book_id into book from public.accounting_books where subsidiary_id=sid and is_active order by coalesce(is_primary,false)desc,accounting_book_id limit 1;
 if book is null then raise exception using errcode='55000',message='Configure el libro contable activo de la empresa.';end if;
 delete from public.gl_impact where transaction_id=p.transaction_id;
 insert into public.gl_impact(transaction_id,account_id,subsidiary_id,fiscal_period_id,accounting_book_id,debit_amount,credit_amount,debit_fx,credit_fx,posting_date,original_currency_id)
 select p.transaction_id,x.account_id,sid,p.fiscal_period_id,book,x.v,0,x.n,0,p.payment_date,p.currency_id from jsonb_to_recordset(ap)as x(account_id bigint,n numeric,v numeric)
 union all select p.transaction_id,b.account_id,sid,p.fiscal_period_id,book,0,round(p.amount_paid*p.exchange_rate,6),0,p.amount_paid,p.payment_date,p.currency_id where p.amount_paid>0
 union all select p.transaction_id,x.account_id,sid,p.fiscal_period_id,book,0,round(x.n*p.exchange_rate,6),0,x.n,p.payment_date,p.currency_id from jsonb_to_recordset(withheld)as x(account_id bigint,n numeric)
 union all select p.transaction_id,x.account_id,sid,p.fiscal_period_id,book,0,x.v,0,x.n,p.payment_date,p.currency_id from jsonb_to_recordset(adv)as x(account_id bigint,n numeric,v numeric)
 union all select p.transaction_id,fx_account,sid,p.fiscal_period_id,book,greatest(loss,0),greatest(-loss,0),greatest(loss,0),greatest(-loss,0),p.payment_date,base_currency where loss<>0;
 select sum(debit_amount)d,sum(credit_amount)c into g from public.gl_impact where transaction_id=p.transaction_id;
 if g.d is distinct from g.c then raise exception using errcode='55000',message='Los componentes históricos del pago no producen un mayor balanceado.';end if;
 select jsonb_agg((x->>'account_id')::bigint order by(x->>'account_id')::bigint)into accounts from jsonb_array_elements(ap)x;return accounts;
end$$;

revoke all on function supplier_payment_private.invoice_basis(bigint,bigint),supplier_payment_private.invoice_values(bigint,bigint),supplier_payment_private.advance_values(bigint,bigint),supplier_payment_private.validate_historical_payment(bigint,bigint),supplier_payment_private.rebuild_historical_fx(bigint,numeric)from public,anon,authenticated,service_role;

do $patch$
declare target regprocedure;definition text;needle text;replacement text;
begin
 target:='supplier_payment_private.apply_supplier_payment_payable_accounts(bigint,numeric)'::regprocedure;
 if md5((select prosrc from pg_proc where oid=target))is distinct from'f8f5c0bf6e5216fee6a067ba93b261fe'then raise exception 'Reviewed supplier payment routing changed.';end if;
 definition:=pg_get_functiondef(target);needle:=(select prosrc from pg_proc where oid=target);replacement:=$body$
begin return supplier_payment_private.rebuild_historical_fx(p_payment_id,p_expected_total);end
$body$;execute replace(definition,needle,replacement);
 target:='supplier_payment_private.available(bigint,bigint)'::regprocedure;
 if md5((select prosrc from pg_proc where oid=target))is distinct from'b4c8e1e0247f1a96e2872b664cc72a14'then raise exception 'Reviewed supplier payment availability changed.';end if;
 definition:=pg_get_functiondef(target);needle:='least(i.total_amount,';
 if(length(definition)-length(replace(definition,needle,'')))/length(needle)<>1 then raise exception 'Unexpected invoice outstanding cap.';end if;
 -- The historical cap also used the pre-note payable amount as a second cap.
 definition:=replace(definition,needle,'(');needle:=$old$case when i.payable_amount=0 and exists(select 1 from public.supplier_invoice_withholding where invoice_id=i.invoice_id and recognized_at_invoice and withholding_amount>0) then 0 else coalesce(nullif(i.payable_amount,0),i.total_amount) end,$old$;
 if(length(definition)-length(replace(definition,needle,'')))/length(needle)<>1 then raise exception 'Unexpected payable outstanding cap.';end if;
 execute replace(definition,needle,'');
 target:='supplier_payment_private.save_supplier_payment_without_withholding(jsonb,bigint)'::regprocedure;
 if md5((select prosrc from pg_proc where oid=target))is distinct from'98ecc7a910bb817d33e1d7ecf52340e1'then raise exception 'Reviewed supplier payment application engine changed.';end if;
 definition:=pg_get_functiondef(target);
 needle:=$old$greatest(i.total_amount-coalesce((select sum(a.amount)from supplier_payment_application a where a.invoice_id=i.invoice_id and(p_payment_id is null or a.payment_id<>p_payment_id)),0),0)$old$;
 if(length(definition)-length(replace(definition,needle,'')))/length(needle)<>1 then raise exception 'Unexpected original supplier invoice capacity.';end if;
 execute replace(definition,needle,'supplier_payment_private.available(i.invoice_id,p_payment_id)');
 target:='public.validate_supplier_payment_application_payable()'::regprocedure;
 if md5((select prosrc from pg_proc where oid=target))is distinct from'a3c165891c1e8de945aab1ce0396d7d5'then raise exception 'Reviewed supplier application capacity trigger changed.';end if;
 definition:=pg_get_functiondef(target);
 needle:=$old$select coalesce(nullif(payable_amount,0),total_amount) into allowed from supplier_invoice where invoice_id=new.invoice_id;$old$;
 replacement:=$new$allowed:=supplier_payment_private.available(new.invoice_id,new.payment_id);
  if allowed is null then raise exception using errcode='42501',message='Factura no disponible en la empresa activa.';end if;$new$;
 if(length(definition)-length(replace(definition,needle,'')))/length(needle)<>1 then raise exception 'Unexpected application capacity calculation.';end if;
 definition:=replace(definition,needle,replacement);
 needle:='where invoice_id=new.invoice_id and application_id<>coalesce(new.application_id,-1)';
 if(length(definition)-length(replace(definition,needle,'')))/length(needle)<>1 then raise exception 'Unexpected same-payment capacity guard.';end if;
 execute replace(definition,needle,needle||' and payment_id=new.payment_id');
 target:='supplier_payment_private.supplier_payment_options()'::regprocedure;
 if md5((select prosrc from pg_proc where oid=target))is distinct from'2aa324099b1f50618502df0f77262ab3'then raise exception 'Reviewed supplier payment options changed.';end if;
 definition:=pg_get_functiondef(target);needle:='and coalesce(nullif(i.payable_amount,0),i.total_amount)>coalesce(a.paid,0)';
 if(length(definition)-length(replace(definition,needle,'')))/length(needle)<>1 then raise exception 'Unexpected supplier invoice options capacity.';end if;
 execute replace(definition,needle,'and supplier_payment_private.available(i.invoice_id)>0');
 target:='supplier_payment_private.lock_source(bigint)'::regprocedure;
 if md5((select prosrc from pg_proc where oid=target))is distinct from'd435eae86b8b9af8f9e8438b73ff6e41'then raise exception 'Reviewed supplier payment history guard changed.';end if;
 definition:=pg_get_functiondef(target);needle:='perform supplier_invoice_private.period(p.fiscal_period_id,p.payment_date);';
 replacement:=$guard$if p.currency_id<>(select currency_id from public.subsidiaries where subsidiary_id=sid)and exists(
  select 1 from public.supplier_payment_application a where a.payment_id=pid and(
   exists(select 1 from public.supplier_payment_application later join public.supplier_payment lp using(payment_id)where later.invoice_id=a.invoice_id and lp.transaction_id>p.transaction_id)
   or exists(select 1 from public.supplier_credit_note where invoice_id=a.invoice_id and transaction_id>p.transaction_id)
   or exists(select 1 from public.supplier_debit_note where invoice_id=a.invoice_id and transaction_id>p.transaction_id)))then raise exception using errcode='55000',message='El pago extranjero tiene aplicaciones o notas posteriores; conserva su valoración histórica.';end if;
 perform supplier_invoice_private.period(p.fiscal_period_id,p.payment_date);$guard$;
 if(length(definition)-length(replace(definition,needle,'')))/length(needle)<>1 then raise exception 'Unexpected supplier payment history insertion.';end if;
 execute replace(definition,needle,replacement);
end$patch$;
