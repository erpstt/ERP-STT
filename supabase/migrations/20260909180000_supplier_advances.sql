create table if not exists public.supplier_advance_application(
  application_id bigint generated always as identity primary key,
  payment_id bigint not null references supplier_payment(payment_id) on delete cascade,
  source_journal_line_id bigint not null references journal_line(journal_line_id),
  amount numeric(24,6) not null check(amount>0),
  applied_by bigint references users(user_id),
  applied_at timestamptz not null default now(),
  unique(payment_id,source_journal_line_id)
);
create index if not exists supplier_advance_source_idx on supplier_advance_application(source_journal_line_id);
alter table supplier_advance_application enable row level security;
drop policy if exists supplier_advance_application_read on supplier_advance_application;
create policy supplier_advance_application_read on supplier_advance_application for select to authenticated using(
  exists(select 1 from supplier_payment p join "transaction" t using(transaction_id)
    where p.payment_id=supplier_advance_application.payment_id and t.subsidiary_id=active_subsidiary_id())
);
revoke all on supplier_advance_application from public,anon,authenticated;
grant select on supplier_advance_application to authenticated;

create or replace function supplier_available_advances() returns jsonb
language sql stable security definer set search_path=public,pg_temp as $$
  with recursive advance_groups as(
    select group_id from account_group where lower(trim(group_name))='gastos pagados por anticipado'
    union all select g.group_id from account_group g join advance_groups p on g.parent_id=p.group_id
  ), rows as(
    select jl.journal_line_id id,jl.supplier_id,"transaction".currency_id,c.currency_code,j.journal_number,j.journal_date,
      a.account_id,a.account_number,a.account_name,(jl.debit-jl.credit) original,
      coalesce((select sum(x.amount) from supplier_advance_application x where x.source_journal_line_id=jl.journal_line_id),0) used
    from journal_line jl join journal j using(journal_id) join "transaction" using(transaction_id)
    join chart_accounts a using(account_id) join account_subsidiaries s using(account_id) join currencies c on c.currency_id="transaction".currency_id
    where s.subsidiary_id=active_subsidiary_id() and s.is_active and "transaction".subsidiary_id=active_subsidiary_id()
      and a.account_group_id in(select group_id from advance_groups) and jl.supplier_id is not null
      and jl.debit-jl.credit>0 and j.status='CONTABILIZADO'
  )
  select coalesce(jsonb_agg(jsonb_build_object('id',id,'supplierId',supplier_id,'currencyId',currency_id,
    'number',journal_number,'date',journal_date,'accountId',account_id,'account',account_number||' · '||account_name,
    'currencyCode',currency_code,'original',original,'used',used,'available',greatest(original-used,0)) order by journal_date,id),'[]')
  from rows where original-used>0
$$;

create or replace function save_supplier_payment_with_advances(p_payload jsonb,p_payment_id bigint default null) returns jsonb
language plpgsql security definer set search_path=public,pg_temp as $$
declare sid bigint:=active_subsidiary_id();item jsonb;source journal_line%rowtype;source_journal journal%rowtype;
  advance_total numeric:=0;gross_total numeric:=0;available numeric;result jsonb;pid bigint;jid bigint;bank_key bigint;
begin
  if p_payment_id is not null and exists(select 1 from supplier_advance_application where payment_id=p_payment_id) then
    raise exception 'Un pago que aplicó anticipos no puede editarse. Consulte su detalle y reversión contable.';
  end if;
  select coalesce(sum((x->>'amount')::numeric),0) into gross_total from jsonb_array_elements(coalesce(p_payload->'applications','[]')) x;
  if gross_total<=0 then raise exception 'Seleccione al menos una factura e indique el importe a pagar.';end if;
  for item in select value from jsonb_array_elements(coalesce(p_payload->'advances','[]')) loop
    if coalesce((item->>'amount')::numeric,0)<=0 then continue;end if;
    select jl.* into source from journal_line jl where jl.journal_line_id=(item->>'advanceLineId')::bigint for update;
    select j.* into source_journal from journal j join "transaction" t using(transaction_id)
      where j.journal_id=source.journal_id and t.subsidiary_id=sid;
    if source.journal_line_id is null or source.supplier_id<>(p_payload->>'supplier_id')::bigint
      or source_journal.currency_id<>(select currency_id from bank_account where bank_account_id=(p_payload->>'account_id')::bigint and subsidiary_id=sid)
      or not exists(with recursive g as(select group_id,parent_id,group_name from account_group where group_id=(select account_group_id from chart_accounts where account_id=source.account_id)
        union all select p.group_id,p.parent_id,p.group_name from account_group p join g on p.group_id=g.parent_id)
        select 1 from g where lower(trim(group_name))='gastos pagados por anticipado') then
      raise exception 'El anticipo no corresponde al proveedor, moneda o grupo contable permitido.';
    end if;
    available:=source.debit-source.credit-coalesce((select sum(a.amount) from supplier_advance_application a where a.source_journal_line_id=source.journal_line_id),0);
    if (item->>'amount')::numeric>available then raise exception 'El anticipo % solo tiene % disponible.',source_journal.journal_number,round(greatest(available,0),2);end if;
    advance_total:=advance_total+(item->>'amount')::numeric;
  end loop;
  if advance_total>gross_total then raise exception 'Los anticipos no pueden superar el total aplicado a facturas.';end if;
  bank_key:=(p_payload->>'account_id')::bigint;
  perform 1 from bank_account where bank_account_id=bank_key and subsidiary_id=sid and balance>=gross_total-advance_total for update;
  if not found then raise exception 'Saldo bancario insuficiente para el desembolso neto de %.',round(gross_total-advance_total,2);end if;
  -- The existing routine validates invoices and creates the complete payable application.
  -- Temporarily fund the advance portion so it only withdraws the net cash amount.
  if advance_total>0 then update bank_account set balance=balance+advance_total where bank_account_id=bank_key;end if;
  result:=save_supplier_payment(p_payload,p_payment_id);pid:=(result->>'id')::bigint;jid:=(result->>'journalId')::bigint;
  if advance_total>0 then
    update bank_transaction set amount=amount+advance_total where transaction_id=(select transaction_id from supplier_payment where payment_id=pid);
    delete from bank_transaction where transaction_id=(select transaction_id from supplier_payment where payment_id=pid) and abs(amount)<0.000001;
    if gross_total=advance_total then
      delete from journal_line where journal_id=jid and account_id=(select account_id from bank_account where bank_account_id=bank_key);
    else
      update journal_line set credit=credit-advance_total,credit_fx=greatest(credit_fx-advance_total*(p_payload->>'rate')::numeric,0)
        where journal_id=jid and account_id=(select account_id from bank_account where bank_account_id=bank_key);
    end if;
    for item in select value from jsonb_array_elements(coalesce(p_payload->'advances','[]')) loop
      if coalesce((item->>'amount')::numeric,0)<=0 then continue;end if;
      select * into source from journal_line where journal_line_id=(item->>'advanceLineId')::bigint;
      insert into journal_line(journal_id,account_id,debit,credit,debit_fx,credit_fx,note,entity_type,supplier_id)
      values(jid,source.account_id,0,(item->>'amount')::numeric,0,(item->>'amount')::numeric*(p_payload->>'rate')::numeric,
        'Aplicación de anticipo de proveedor','Proveedor',(p_payload->>'supplier_id')::bigint);
      insert into supplier_advance_application(payment_id,source_journal_line_id,amount,applied_by)
      values(pid,source.journal_line_id,(item->>'amount')::numeric,app_user_id());
    end loop;
  end if;
  return result||jsonb_build_object('grossTotal',gross_total,'advanceTotal',advance_total,'cashTotal',gross_total-advance_total);
end$$;

create or replace function supplier_payment_advance_summary() returns jsonb language sql stable security definer set search_path=public,pg_temp as $$
 select coalesce(jsonb_agg(jsonb_build_object('paymentId',p.payment_id,'advanceTotal',p.total)),'[]') from(
  select a.payment_id,sum(a.amount) total from supplier_advance_application a join supplier_payment sp using(payment_id)
  join "transaction" t using(transaction_id) where t.subsidiary_id=active_subsidiary_id() group by a.payment_id)p
$$;
create or replace function supplier_payment_advance_detail(p_payment_id bigint) returns jsonb language sql stable security definer set search_path=public,pg_temp as $$
 select coalesce(jsonb_agg(jsonb_build_object('id',a.application_id,'sourceLineId',a.source_journal_line_id,'number',j.journal_number,
  'date',j.journal_date,'account',c.account_number||' · '||c.account_name,'amount',a.amount) order by a.application_id),'[]')
 from supplier_advance_application a join supplier_payment p on p.payment_id=a.payment_id join "transaction" t on t.transaction_id=p.transaction_id
 join journal_line l on l.journal_line_id=a.source_journal_line_id join journal j on j.journal_id=l.journal_id join chart_accounts c on c.account_id=l.account_id
 where a.payment_id=p_payment_id and t.subsidiary_id=active_subsidiary_id()
$$;
create or replace function protect_applied_supplier_advance() returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
begin
 if exists(select 1 from supplier_advance_application where payment_id=old.payment_id) then
  raise exception 'El pago aplicó anticipos y no puede modificarse ni eliminarse directamente.';
 end if;return case when tg_op='DELETE' then old else new end;
end$$;
drop trigger if exists protect_applied_supplier_advance on supplier_payment;
create trigger protect_applied_supplier_advance before update or delete on supplier_payment for each row execute function protect_applied_supplier_advance();

revoke all on function supplier_available_advances(),save_supplier_payment_with_advances(jsonb,bigint),supplier_payment_advance_summary(),supplier_payment_advance_detail(bigint),protect_applied_supplier_advance() from public,anon;
grant execute on function supplier_available_advances(),save_supplier_payment_with_advances(jsonb,bigint),supplier_payment_advance_summary(),supplier_payment_advance_detail(bigint) to authenticated;
notify pgrst,'reload schema';
