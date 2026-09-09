create table if not exists public.fx_revaluation_settings(
  subsidiary_id bigint primary key references subsidiaries,
  gain_account_id bigint not null references chart_accounts,
  loss_account_id bigint not null references chart_accounts,
  gain_taxable boolean not null default false,
  loss_deductible boolean not null default false,
  tax_note text,
  updated_by bigint references users,
  updated_at timestamptz not null default now()
);
create table if not exists public.fx_revaluation_runs(
  run_id bigint generated always as identity primary key,
  subsidiary_id bigint not null references subsidiaries,
  fiscal_period_id bigint not null references fiscal_periods,
  currency_id bigint not null references currencies,
  closing_date date not null,closing_rate numeric(24,10) not null check(closing_rate>0),
  rate_source text not null,rate_reason text,
  auto_reverse boolean not null default true,reversal_date date,
  status text not null default 'PENDIENTE' check(status in('PENDIENTE','CONTABILIZADO','REVERSADO')),
  snapshot jsonb not null default '[]',fingerprint text,
  gain_account_id bigint not null references chart_accounts,loss_account_id bigint not null references chart_accounts,
  gain_taxable boolean not null,loss_deductible boolean not null,tax_note text,
  journal_id bigint references journal,reversal_journal_id bigint references journal,
  cancellation_journal_id bigint references journal,cancellation_reversal_id bigint references journal,
  created_by bigint references users,created_at timestamptz not null default now(),posted_at timestamptz,
  cancelled_by bigint references users,cancelled_at timestamptz,cancellation_reason text
);
create unique index if not exists fx_revaluation_posted_unique on fx_revaluation_runs(subsidiary_id,fiscal_period_id,currency_id) where status='CONTABILIZADO';
create index if not exists fx_revaluation_history on fx_revaluation_runs(subsidiary_id,closing_date desc,currency_id);
alter table journal add column if not exists fx_revaluation_run_id bigint references fx_revaluation_runs;
alter table journal_line add column if not exists fx_source_key text;
create index if not exists fx_journal_run on journal(fx_revaluation_run_id,journal_date);
create index if not exists fx_ledger_scope on gl_impact(subsidiary_id,accounting_book_id,posting_date,account_id,transaction_id);
create index if not exists fx_transaction_scope on "transaction"(subsidiary_id,currency_id,status_id,tran_date);
create index if not exists fx_ar_scope on invoice(subsidiary_id,currency_id,invoice_date);
create index if not exists fx_ap_scope on supplier_invoice(subsidiary_id,currency_id,invoice_date);
create index if not exists fx_ar_app_cutoff on customer_payment_application(invoice_id,application_date,payment_id);
create index if not exists fx_ap_app_cutoff on supplier_payment_application(invoice_id,application_date,payment_id);
alter table fx_revaluation_settings enable row level security;
alter table fx_revaluation_runs enable row level security;
drop policy if exists fx_settings_read on fx_revaluation_settings;
create policy fx_settings_read on fx_revaluation_settings for select to authenticated using(subsidiary_id=active_subsidiary_id());
drop policy if exists fx_runs_read on fx_revaluation_runs;
create policy fx_runs_read on fx_revaluation_runs for select to authenticated using(subsidiary_id=active_subsidiary_id());
revoke all on fx_revaluation_settings,fx_revaluation_runs from public,anon,authenticated;
grant select on fx_revaluation_settings,fx_revaluation_runs to authenticated;

insert into transaction_types(abbreviation,name,module_category,description)
values('DIF_CAM','Asiento Diferencial Cambiario','Contabilidad','Revaluación de partidas monetarias y reversión en moneda local.')
on conflict(abbreviation) do update set name=excluded.name;

-- Defend the local-only invariant even when another journal trigger resynchronizes GL.
create or replace function fx_local_only_gl() returns trigger language plpgsql set search_path=public,pg_temp as $$
begin
  if exists(select 1 from journal j where j.transaction_id=new.transaction_id and j.fx_revaluation_run_id is not null) then
    new.debit_fx:=0;new.credit_fx:=0;
  end if;
  return new;
end$$;
drop trigger if exists fx_local_only_gl on gl_impact;
create trigger fx_local_only_gl before insert or update on gl_impact for each row execute function fx_local_only_gl();

-- A transaction-local flag is not an authorization mechanism. Internal routines run
-- as their owner; direct edits by authenticated users are always rejected.
create or replace function fx_protect_journals() returns trigger language plpgsql set search_path=public,pg_temp as $$
declare managed boolean;
begin
  if tg_table_name='journal' then
    managed:=coalesce((to_jsonb(new)->>'fx_revaluation_run_id')::bigint,(to_jsonb(old)->>'fx_revaluation_run_id')::bigint) is not null;
    if managed and current_user in('authenticated','anon') then raise exception 'Este asiento se administra desde Revaluación de moneda extranjera.';end if;
    if managed and current_setting('nexo.fx_posting',true) is distinct from 'on' then raise exception 'Anule el proceso desde Revaluación de moneda extranjera.';end if;
    if managed and tg_op<>'DELETE' then
      if new.exchange_rate<>1 or new.currency_id<>(select currency_id from subsidiaries where subsidiary_id=new.subsidiary_id) then raise exception 'La revaluación solo puede contabilizarse en moneda local con tasa 1.';end if;
    end if;
  else
    select exists(select 1 from journal where journal_id in(new.journal_id,old.journal_id) and fx_revaluation_run_id is not null) into managed;
    if managed then
      if current_user in('authenticated','anon') or current_setting('nexo.fx_posting',true) is distinct from 'on' then raise exception 'Las líneas de revaluación no pueden editarse manualmente.';end if;
      if tg_op<>'DELETE' then new.debit_fx:=0;new.credit_fx:=0;end if;
    end if;
  end if;
  return case when tg_op='DELETE' then old else new end;
end$$;
drop trigger if exists fx_protect_journal on journal;
create trigger fx_protect_journal before insert or update or delete on journal for each row execute function fx_protect_journals();
drop trigger if exists fx_protect_lines on journal_line;
create trigger fx_protect_lines before insert or update or delete on journal_line for each row execute function fx_protect_journals();

create or replace function fx_journal_type() returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
begin
  if new.fx_revaluation_run_id is not null then
    update "transaction" set transaction_type_id=(select transaction_type_id from transaction_types where abbreviation='DIF_CAM') where transaction_id=new.transaction_id;
  end if;
  return new;
end$$;
drop trigger if exists zz_fx_journal_type on journal;
create trigger zz_fx_journal_type after insert or update on journal for each row execute function fx_journal_type();

create or replace function fx_assert_access() returns bigint language plpgsql stable security definer set search_path=public,pg_temp as $$
declare sid bigint:=active_subsidiary_id();
begin
  if sid is null or app_user_id() is null or not exists(select 1 from user_subsidiaries where user_id=app_user_id() and subsidiary_id=sid) then raise exception 'Seleccione una subsidiaria autorizada.';end if;
  return sid;
end$$;
create or replace function fx_validate_accounts(p_gain bigint,p_loss bigint) returns void language plpgsql stable security definer set search_path=public,pg_temp as $$
declare sid bigint:=fx_assert_access();
begin
  if p_gain=p_loss or p_gain is null or p_loss is null then raise exception 'Seleccione cuentas distintas de ganancia y pérdida no realizadas.';end if;
  if not exists(select 1 from chart_accounts a join account_subsidiaries s using(account_id) where a.account_id=p_gain and s.subsidiary_id=sid and s.is_active and not a.is_inactive and a.accepts_entries and a.category='Ingreso') then raise exception 'Seleccione una cuenta de ingreso activa de la subsidiaria para la ganancia no realizada.';end if;
  if not exists(select 1 from chart_accounts a join account_subsidiaries s using(account_id) where a.account_id=p_loss and s.subsidiary_id=sid and s.is_active and not a.is_inactive and a.accepts_entries and a.category='Gasto') then raise exception 'Seleccione una cuenta de gasto activa de la subsidiaria para la pérdida no realizada.';end if;
end$$;
create or replace function fx_save_settings(p_payload jsonb) returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare sid bigint:=fx_assert_access();g bigint:=(p_payload->>'gain_account_id')::bigint;l bigint:=(p_payload->>'loss_account_id')::bigint;
begin
  perform pg_advisory_xact_lock(hashtextextended('fx-subsidiary:'||sid,0));
  perform fx_validate_accounts(g,l);
  insert into fx_revaluation_settings(subsidiary_id,gain_account_id,loss_account_id,gain_taxable,loss_deductible,tax_note,updated_by)
  values(sid,g,l,coalesce((p_payload->>'gain_taxable')::boolean,false),coalesce((p_payload->>'loss_deductible')::boolean,false),p_payload->>'tax_note',app_user_id())
  on conflict(subsidiary_id) do update set gain_account_id=g,loss_account_id=l,gain_taxable=excluded.gain_taxable,loss_deductible=excluded.loss_deductible,tax_note=excluded.tax_note,updated_by=app_user_id(),updated_at=now();
  return jsonb_build_object('saved',true);
end$$;

create or replace function fx_options() returns jsonb language plpgsql stable security definer set search_path=public,pg_temp as $$
declare sid bigint:=fx_assert_access();result jsonb;
begin
  select jsonb_build_object('subsidiary',jsonb_build_object('id',s.subsidiary_id,'name',s.name,'currencyId',s.currency_id,'currency',c.currency_code),
    'settings',(select to_jsonb(x) from fx_revaluation_settings x where subsidiary_id=sid),
    'currencies',coalesce((select jsonb_agg(jsonb_build_object('id',cu.currency_id,'code',cu.currency_code,'name',cu.name) order by cu.currency_code) from currencies cu where cu.currency_id<>s.currency_id and (exists(select 1 from subsidiary_currencies sc where sc.subsidiary_id=sid and sc.currency_id=cu.currency_id) or exists(select 1 from "transaction" t where t.subsidiary_id=sid and t.currency_id=cu.currency_id))),'[]'),
    'periods',coalesce((select jsonb_agg(jsonb_build_object('id',fiscal_period_id,'name',period_name,'start',start_date,'end',end_date,'closed',is_closed or coalesce(gl_closed,false) or coalesce(is_inactive,false)) order by start_date desc) from fiscal_periods where subsidiary_id=sid),'[]'),
    'rates',coalesce((select jsonb_agg(jsonb_build_object('currencyId',from_currency_id,'date',effective_date,'rate',spot_rate) order by effective_date desc) from exchange_rates where to_currency_id=s.currency_id),'[]'),
    'accounts',coalesce((select jsonb_agg(jsonb_build_object('id',a.account_id,'number',a.account_number,'name',a.account_name,'category',a.category,'eligible',a.pending_fx_revaluation) order by a.account_number) from chart_accounts a join account_subsidiaries sc using(account_id) where sc.subsidiary_id=sid and sc.is_active and a.accepts_entries and not a.is_inactive),'[]')) into result
  from subsidiaries s join currencies c using(currency_id) where s.subsidiary_id=sid;
  return result;
end$$;

-- All balances are reconstructed at cutoff, never from current bank/invoice balances.
create or replace function fx_exposures(p_date date,p_currency bigint) returns jsonb
language plpgsql stable security definer set search_path=public,pg_temp as $$
declare sid bigint:=fx_assert_access();book bigint;result jsonb;
begin
  select accounting_book_id into book from accounting_books where subsidiary_id=sid and is_primary and is_active order by accounting_book_id limit 1;
  if book is null then raise exception 'Configure un libro contable principal activo.';end if;
  if (select count(*) from accounting_books where subsidiary_id=sid and is_primary and is_active)<>1 then raise exception 'Debe existir un unico libro principal activo.';end if;
  if p_currency=(select currency_id from subsidiaries where subsidiary_id=sid) then raise exception 'Seleccione una moneda extranjera.';end if;
  with eligible as (
    select a.* from chart_accounts a join account_subsidiaries s using(account_id)
    where s.subsidiary_id=sid and s.is_active and a.pending_fx_revaluation and a.category in('Activo','Pasivo') and not a.is_inactive and a.accepts_entries
  ), ledger as (
    select g.*,t.currency_id from gl_impact g join "transaction" t using(transaction_id) join eligible a using(account_id)
    where g.subsidiary_id=sid and t.subsidiary_id=sid and g.accounting_book_id=book and g.posting_date<=p_date and t.currency_id=p_currency
      and not exists(select 1 from journal j where j.transaction_id=t.transaction_id and j.fx_revaluation_run_id is not null)
  ), documents as (
    select 'AR:'||i.invoice_id source_key,'CxC' source_type,i.invoice_id,i.invoice_number document,i.customer_id entity_id,c.company_name party,i.transaction_id,i.currency_id,'Activo' category
    from invoice i join customers c using(customer_id) where i.subsidiary_id=sid and i.currency_id=p_currency and i.invoice_date<=p_date
    union all
    select 'AP:'||i.invoice_id,'CxP',i.invoice_id,i.invoice_number,i.supplier_id,s.company_name,i.transaction_id,i.currency_id,'Pasivo'
    from supplier_invoice i join suppliers s using(supplier_id) where i.subsidiary_id=sid and i.currency_id=p_currency and i.invoice_date<=p_date
  ), mapping as (
    select d.source_key,d.transaction_id,1::numeric weight from documents d
    union all select d.source_key,n.transaction_id,1 from documents d join credit_note n on n.invoice_id=d.invoice_id and d.source_type='CxC' where n.note_date<=p_date
    union all select d.source_key,n.transaction_id,1 from documents d join debit_note n on n.invoice_id=d.invoice_id and d.source_type='CxC' where n.note_date<=p_date
    union all select d.source_key,n.transaction_id,1 from documents d join supplier_credit_note n on n.invoice_id=d.invoice_id and d.source_type='CxP' where n.note_date<=p_date
    union all select d.source_key,n.transaction_id,1 from documents d join supplier_debit_note n on n.invoice_id=d.invoice_id and d.source_type='CxP' where n.note_date<=p_date
    union all select d.source_key,p.transaction_id,a.amount/nullif((select sum(x.amount) from customer_payment_application x where x.payment_id=p.payment_id),0)
      from documents d join customer_payment_application a on a.invoice_id=d.invoice_id and d.source_type='CxC' join customer_payment p using(payment_id)
      where a.application_date<=p_date and p.payment_date<=p_date
    union all select d.source_key,p.transaction_id,a.amount/nullif((select sum(x.amount) from supplier_payment_application x where x.payment_id=p.payment_id),0)
      from documents d join supplier_payment_application a on a.invoice_id=d.invoice_id and d.source_type='CxP' join supplier_payment p using(payment_id)
      where a.application_date<=p_date and p.payment_date<=p_date
  ), doc_balances as (
    select d.source_key,d.source_type,d.document,d.party,d.entity_id,g.account_id,
      sum((g.debit_fx-g.credit_fx)*m.weight) fc,sum((g.debit_amount-g.credit_amount)*m.weight) local
    from documents d join mapping m using(source_key) join ledger g on g.transaction_id=m.transaction_id join eligible a on a.account_id=g.account_id and a.category=d.category
    where exists(select 1 from ledger original where original.transaction_id=d.transaction_id and original.account_id=g.account_id)
    group by d.source_key,d.source_type,d.document,d.party,d.entity_id,g.account_id
  ), other_balances as (
    select 'GL:'||g.account_id source_key,'Mayor' source_type,''::text document,''::text party,null::bigint entity_id,g.account_id,
      sum(g.debit_fx-g.credit_fx)-coalesce((select sum(d.fc) from doc_balances d where d.account_id=g.account_id),0) fc,
      sum(g.debit_amount-g.credit_amount)-coalesce((select sum(d.local) from doc_balances d where d.account_id=g.account_id),0) local
    from ledger g group by g.account_id
  ), prior_adjustments as (
    select l.fx_source_key source_key,l.account_id,sum(l.debit-l.credit) local
    from journal_line l join journal j using(journal_id) join fx_revaluation_runs r on r.run_id=j.fx_revaluation_run_id
    where r.subsidiary_id=sid and r.currency_id=p_currency and j.journal_date<=p_date and l.fx_source_key is not null
    group by l.fx_source_key,l.account_id
  ), balances as (select * from doc_balances union all select * from other_balances)
  select coalesce(jsonb_agg(jsonb_build_object('sourceKey',b.source_key,'sourceType',b.source_type,'document',b.document,'party',b.party,'entityId',b.entity_id,
    'accountId',a.account_id,'accountNumber',a.account_number,'accountName',a.account_name,'category',a.category,
    'foreignBalance',round(b.fc*case when a.category='Pasivo' then -1 else 1 end,6),
    'bookValue',round((b.local+coalesce(p.local,0))*case when a.category='Pasivo' then -1 else 1 end,6)) order by a.account_number,b.source_key),'[]') into result
  from balances b join eligible a using(account_id) left join prior_adjustments p on p.source_key=b.source_key and p.account_id=b.account_id
  where abs(b.fc)>0.000001;
  -- The current payment workflow does not define cross-currency invoice allocation.
  -- Fail explicitly rather than valuing an invoice using the bank currency's units.
  if exists(select 1 from customer_payment_application a join customer_payment p using(payment_id) join invoice i using(invoice_id) where i.subsidiary_id=sid and i.currency_id=p_currency and p.currency_id<>i.currency_id and a.application_date<=p_date and p.payment_date<=p_date)
    or exists(select 1 from supplier_payment_application a join supplier_payment p using(payment_id) join supplier_invoice i using(invoice_id) where i.subsidiary_id=sid and i.currency_id=p_currency and p.currency_id<>i.currency_id and a.application_date<=p_date and p.payment_date<=p_date) then
    raise exception 'Existen aplicaciones de pago en otra moneda. Concilie su importe en la moneda de la factura antes de revaluar.';
  end if;
  return result;
end$$;

create or replace function fx_calculate(p_date date,p_currency bigint,p_rate numeric) returns jsonb language plpgsql stable security definer set search_path=public,pg_temp as $$
declare rows jsonb;result jsonb;
begin
  if p_rate is null or p_rate<=0 or p_rate>1000000000 then raise exception 'Indique un tipo de cambio de cierre positivo y valido.';end if;
  rows:=fx_exposures(p_date,p_currency);
  select coalesce(jsonb_agg(x||jsonb_build_object('historicalRate',case when (x->>'foreignBalance')::numeric<>0 then (x->>'bookValue')::numeric/(x->>'foreignBalance')::numeric else null end,
    'revaluedBalance',round((x->>'foreignBalance')::numeric*p_rate,2),
    'adjustment',round(round((x->>'foreignBalance')::numeric*p_rate,2)-(x->>'bookValue')::numeric,2),
    'signedAdjustment',round(round((x->>'foreignBalance')::numeric*p_rate,2)-(x->>'bookValue')::numeric,2)*case when x->>'category'='Pasivo' then -1 else 1 end,
    'impact',case when round(round((x->>'foreignBalance')::numeric*p_rate,2)-(x->>'bookValue')::numeric,2)=0 then 'SIN AJUSTE'
      when (round((x->>'foreignBalance')::numeric*p_rate,2)-(x->>'bookValue')::numeric)*case when x->>'category'='Pasivo' then -1 else 1 end>0 then 'GANANCIA NO REALIZADA' else 'PERDIDA NO REALIZADA' end)),'[]') into result
  from jsonb_array_elements(rows)x;
  return result;
end$$;

create or replace function fx_prepare(p_payload jsonb) returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare sid bigint:=fx_assert_access();d date:=(p_payload->>'date')::date;cur bigint:=(p_payload->>'currencyId')::bigint;rate numeric;official numeric;
  per fiscal_periods%rowtype;settings fx_revaluation_settings%rowtype;data jsonb;rid bigint;automatic boolean:=coalesce((p_payload->>'autoReverse')::boolean,true);reason text:=nullif(trim(p_payload->>'rateReason'),'');revdate date;
begin
  perform pg_advisory_xact_lock(hashtextextended('fx-subsidiary:'||sid,0));
  select * into per from fiscal_periods where subsidiary_id=sid and end_date=d and not coalesce(is_inactive,false) order by start_date desc limit 1 for update;
  if per.fiscal_period_id is null or per.is_closed or coalesce(per.gl_closed,false) then raise exception 'Seleccione la fecha final de un periodo contable abierto.';end if;
  if not exists(select 1 from currencies c where c.currency_id=cur and c.currency_id<>(select currency_id from subsidiaries where subsidiary_id=sid)) then raise exception 'Seleccione una moneda extranjera valida.';end if;
  perform pg_advisory_xact_lock(hashtextextended('fx:'||sid||':'||per.fiscal_period_id||':'||cur,0));
  if exists(select 1 from fx_revaluation_runs where subsidiary_id=sid and fiscal_period_id=per.fiscal_period_id and currency_id=cur and status='CONTABILIZADO') then raise exception 'Este periodo y moneda ya fueron revaluados. Anule el proceso anterior para repetirlo.';end if;
  select * into settings from fx_revaluation_settings where subsidiary_id=sid;
  perform fx_validate_accounts(settings.gain_account_id,settings.loss_account_id);
  select spot_rate into official from exchange_rates where from_currency_id=cur and to_currency_id=(select currency_id from subsidiaries where subsidiary_id=sid) and effective_date=d order by exchange_rate_id desc limit 1;
  rate:=coalesce(nullif(p_payload->>'rate','')::numeric,official);
  if rate is distinct from official and reason is null then raise exception 'Indique el motivo y referencia de la tasa manual de cierre.';end if;
  if automatic then
    select start_date into revdate from fiscal_periods where subsidiary_id=sid and start_date=d+1 and not coalesce(is_inactive,false) and not is_closed and not coalesce(gl_closed,false) order by fiscal_period_id limit 1;
    if revdate is null then raise exception 'Abra el periodo siguiente, con inicio al dia siguiente del cierre, para generar la reversion.';end if;
  end if;
  data:=fx_calculate(d,cur,rate);
  select run_id into rid from fx_revaluation_runs where subsidiary_id=sid and fiscal_period_id=per.fiscal_period_id and currency_id=cur and status='PENDIENTE' order by run_id desc limit 1;
  if rid is null then
    insert into fx_revaluation_runs(subsidiary_id,fiscal_period_id,currency_id,closing_date,closing_rate,rate_source,rate_reason,auto_reverse,reversal_date,snapshot,fingerprint,gain_account_id,loss_account_id,gain_taxable,loss_deductible,tax_note,created_by)
    values(sid,per.fiscal_period_id,cur,d,rate,case when rate=official then 'CATALOGO' else 'MANUAL' end,reason,automatic,revdate,data,md5(jsonb_build_array(data,rate,automatic,revdate,settings.gain_account_id,settings.loss_account_id,settings.gain_taxable,settings.loss_deductible,settings.tax_note,reason)::text),settings.gain_account_id,settings.loss_account_id,settings.gain_taxable,settings.loss_deductible,settings.tax_note,app_user_id()) returning run_id into rid;
  else
    update fx_revaluation_runs set closing_rate=rate,rate_source=case when rate=official then 'CATALOGO' else 'MANUAL' end,rate_reason=reason,auto_reverse=automatic,reversal_date=revdate,snapshot=data,fingerprint=md5(jsonb_build_array(data,rate,automatic,revdate,settings.gain_account_id,settings.loss_account_id,settings.gain_taxable,settings.loss_deductible,settings.tax_note,reason)::text),gain_account_id=settings.gain_account_id,loss_account_id=settings.loss_account_id,gain_taxable=settings.gain_taxable,loss_deductible=settings.loss_deductible,tax_note=settings.tax_note,created_by=app_user_id(),created_at=now() where run_id=rid;
  end if;
  return (select to_jsonb(r) from fx_revaluation_runs r where run_id=rid);
end$$;

create or replace function fx_post_journal(p_run bigint,p_date date,p_sign integer,p_note text) returns bigint
language plpgsql security definer set search_path=public,pg_temp as $$
declare r fx_revaluation_runs%rowtype;per bigint;cur bigint;tt bigint;jid bigint;num text;item jsonb;amount numeric;total numeric;contra bigint;
begin
  if p_sign not in(-1,1) then raise exception 'Sentido de asiento invalido.';end if;
  select * into r from fx_revaluation_runs where run_id=p_run and subsidiary_id=fx_assert_access();
  if not found then raise exception 'Proceso no encontrado.';end if;
  select fiscal_period_id into per from fiscal_periods where subsidiary_id=r.subsidiary_id and p_date between start_date and end_date and not is_closed and not coalesce(gl_closed,false) and not coalesce(is_inactive,false) order by start_date desc limit 1 for update;
  if per is null then raise exception 'El periodo de % debe estar abierto.',p_date;end if;
  select currency_id into cur from subsidiaries where subsidiary_id=r.subsidiary_id;
  select transaction_type_id into tt from transaction_types where abbreviation='DIF_CAM';
  num:=next_transaction_number(tt,r.subsidiary_id);
  select sum(abs((x->>'signedAdjustment')::numeric)) into total from jsonb_array_elements(r.snapshot)x;
  if coalesce(total,0)<=0 then raise exception 'No hay ajustes por contabilizar.';end if;
  perform set_config('nexo.fx_posting','on',true);
  insert into journal(journal_number,journal_date,subsidiary_id,currency_id,fiscal_period_id,exchange_rate,memo,journal_type,total_debit,total_credit,status,created_by,fx_revaluation_run_id)
  values(num,p_date,r.subsidiary_id,cur,per,1,p_note||' / Proceso '||r.run_id,'Asiento Diferencial Cambiario',total,total,'CONTABILIZADO',app_user_id(),r.run_id) returning journal_id into jid;
  for item in select value from jsonb_array_elements(r.snapshot) loop
    amount:=(item->>'signedAdjustment')::numeric;
    if amount=0 then continue;end if;
    contra:=case when amount>0 then r.gain_account_id else r.loss_account_id end;
    amount:=amount*p_sign;
    insert into journal_line(journal_id,account_id,debit,credit,debit_fx,credit_fx,note,entity_type,customer_id,supplier_id,fx_source_key)
    values(jid,(item->>'accountId')::bigint,greatest(amount,0),greatest(-amount,0),0,0,p_note||' '||coalesce(item->>'document',''),
      case item->>'sourceType' when 'CxC' then 'Cliente' when 'CxP' then 'Proveedor' end,
      case when item->>'sourceType'='CxC' then (item->>'entityId')::bigint end,
      case when item->>'sourceType'='CxP' then (item->>'entityId')::bigint end,item->>'sourceKey');
    insert into journal_line(journal_id,account_id,debit,credit,debit_fx,credit_fx,note)
    values(jid,contra,greatest(-amount,0),greatest(amount,0),0,0,p_note||' - diferencial no realizado');
  end loop;
  perform set_config('nexo.fx_posting','off',true);
  return jid;
end$$;

create or replace function fx_execute(p_payload jsonb) returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare sid bigint:=fx_assert_access();r fx_revaluation_runs%rowtype;data jsonb;jid bigint;rev bigint;official numeric;
begin
  perform pg_advisory_xact_lock(hashtextextended('fx-subsidiary:'||sid,0));
  select * into r from fx_revaluation_runs where run_id=(p_payload->>'runId')::bigint and subsidiary_id=sid for update;
  if not found then raise exception 'Proceso no encontrado.';end if;
  perform pg_advisory_xact_lock(hashtextextended('fx:'||sid||':'||r.fiscal_period_id||':'||r.currency_id,0));
  if r.status='CONTABILIZADO' then return to_jsonb(r);end if;
  if r.status<>'PENDIENTE' then raise exception 'Genere una nueva vista previa.';end if;
  if p_payload->>'fingerprint' is distinct from r.fingerprint then raise exception 'La vista previa cambio. Vuelva a visualizar el asiento.';end if;
  if exists(select 1 from fx_revaluation_runs where subsidiary_id=sid and fiscal_period_id=r.fiscal_period_id and currency_id=r.currency_id and status='CONTABILIZADO') then raise exception 'El periodo y moneda ya estan contabilizados.';end if;
  perform fx_validate_accounts(r.gain_account_id,r.loss_account_id);
  if r.rate_source='CATALOGO' then
    select spot_rate into official from exchange_rates where from_currency_id=r.currency_id and to_currency_id=(select currency_id from subsidiaries where subsidiary_id=sid) and effective_date=r.closing_date order by exchange_rate_id desc limit 1;
    if official is distinct from r.closing_rate then raise exception 'El tipo de cambio fue modificado. Genere una nueva vista previa.';end if;
  end if;
  lock table gl_impact,customer_payment_application,supplier_payment_application in share row exclusive mode;
  data:=fx_calculate(r.closing_date,r.currency_id,r.closing_rate);
  if data is distinct from r.snapshot then raise exception 'Los saldos cambiaron desde la vista previa. Vuelva a visualizar el asiento.';end if;
  jid:=fx_post_journal(r.run_id,r.closing_date,1,'Revaluacion de cierre');
  if r.auto_reverse then rev:=fx_post_journal(r.run_id,r.reversal_date,-1,'Reversion automatica de revaluacion');end if;
  update fx_revaluation_runs set status='CONTABILIZADO',journal_id=jid,reversal_journal_id=rev,posted_at=now() where run_id=r.run_id returning * into r;
  return to_jsonb(r);
end$$;

create or replace function fx_cancel(p_payload jsonb) returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare sid bigint:=fx_assert_access();r fx_revaluation_runs%rowtype;jid bigint;rev bigint;reason text:=nullif(trim(p_payload->>'reason'),'');
begin
  perform pg_advisory_xact_lock(hashtextextended('fx-subsidiary:'||sid,0));
  if reason is null then raise exception 'Indique el motivo de anulacion.';end if;
  select * into r from fx_revaluation_runs where run_id=(p_payload->>'runId')::bigint and subsidiary_id=sid for update;
  if not found then raise exception 'Proceso no encontrado.';end if;
  perform pg_advisory_xact_lock(hashtextextended('fx:'||sid||':'||r.fiscal_period_id||':'||r.currency_id,0));
  if r.status='REVERSADO' then return to_jsonb(r);end if;
  if r.status<>'CONTABILIZADO' then raise exception 'Solo puede anular un proceso contabilizado.';end if;
  if exists(select 1 from fx_revaluation_runs where subsidiary_id=sid and currency_id=r.currency_id and closing_date>r.closing_date and status='CONTABILIZADO') then raise exception 'Anule primero las revaluaciones posteriores de esta moneda.';end if;
  jid:=fx_post_journal(r.run_id,r.closing_date,-1,'Anulacion de revaluacion: '||reason);
  if r.reversal_journal_id is not null then rev:=fx_post_journal(r.run_id,r.reversal_date,1,'Anulacion de reversion programada: '||reason);end if;
  update fx_revaluation_runs set status='REVERSADO',cancellation_journal_id=jid,cancellation_reversal_id=rev,cancelled_by=app_user_id(),cancelled_at=now(),cancellation_reason=reason where run_id=r.run_id returning * into r;
  return to_jsonb(r);
end$$;

create or replace function fx_report(p_payload jsonb) returns jsonb language plpgsql stable security definer set search_path=public,pg_temp as $$
declare sid bigint:=fx_assert_access();result jsonb;
begin
  select jsonb_build_object('runs',coalesce(jsonb_agg(to_jsonb(r)||jsonb_build_object('period',p.period_name,'currency',c.currency_code,
    'effective_status',case when r.status='CONTABILIZADO' and r.reversal_journal_id is not null and r.reversal_date<=(now() at time zone 'America/Costa_Rica')::date then 'REVERSADO' else r.status end,
    'journalNumber',j.journal_number,'reversalNumber',rev.journal_number,
    'accounts',(select coalesce(jsonb_agg(to_jsonb(a)),'[]') from(select x->>'accountNumber' number,x->>'accountName' name,sum((x->>'foreignBalance')::numeric) foreign_balance,sum((x->>'bookValue')::numeric) book_value,sum((x->>'revaluedBalance')::numeric) revalued_balance,sum((x->>'adjustment')::numeric) adjustment,sum(greatest((x->>'signedAdjustment')::numeric,0)) gain,sum(greatest(-(x->>'signedAdjustment')::numeric,0)) loss from jsonb_array_elements(r.snapshot)x group by x->>'accountNumber',x->>'accountName' order by x->>'accountNumber')a)) order by r.closing_date desc,r.run_id desc),'[]')) into result
  from fx_revaluation_runs r join fiscal_periods p using(fiscal_period_id) join currencies c using(currency_id) left join journal j on j.journal_id=r.journal_id left join journal rev on rev.journal_id=r.reversal_journal_id
  where r.subsidiary_id=sid and (nullif(p_payload->>'runId','') is null or r.run_id=(p_payload->>'runId')::bigint)
    and (nullif(p_payload->>'currencyId','') is null or r.currency_id=(p_payload->>'currencyId')::bigint)
    and r.closing_date between coalesce(nullif(p_payload->>'from','')::date,'1900-01-01') and coalesce(nullif(p_payload->>'to','')::date,'2999-12-31');
  return result;
end$$;

revoke all on function fx_local_only_gl(),fx_protect_journals(),fx_journal_type(),fx_assert_access(),fx_validate_accounts(bigint,bigint),fx_exposures(date,bigint),fx_calculate(date,bigint,numeric),fx_post_journal(bigint,date,integer,text) from public,anon,authenticated;
revoke all on function fx_save_settings(jsonb),fx_options(),fx_prepare(jsonb),fx_execute(jsonb),fx_cancel(jsonb),fx_report(jsonb) from public,anon;
grant execute on function fx_save_settings(jsonb),fx_options(),fx_prepare(jsonb),fx_execute(jsonb),fx_cancel(jsonb),fx_report(jsonb) to authenticated;
notify pgrst,'reload schema';
