-- Autorretencion de renta para subsidiarias colombianas.
-- La tasa se almacena como factor decimal: 0.0110 equivale a 1.10 %.

alter table public.subsidiaries
  add column if not exists applies_income_autorent boolean not null default false,
  add column if not exists autorent_active_account_id bigint references public.chart_accounts(account_id) on delete restrict,
  add column if not exists autorent_passive_account_id bigint references public.chart_accounts(account_id) on delete restrict,
  add column if not exists autorent_percentage numeric(5,4);

alter table public.subsidiaries
  drop constraint if exists subsidiaries_income_autorent_complete_check,
  drop constraint if exists subsidiaries_income_autorent_accounts_different_check;

alter table public.subsidiaries
  add constraint subsidiaries_income_autorent_complete_check check(
    not applies_income_autorent or(
      autorent_active_account_id is not null
      and autorent_passive_account_id is not null
      and autorent_percentage is not null
      and autorent_percentage>0
      and autorent_percentage<=1
    )
  ),
  add constraint subsidiaries_income_autorent_accounts_different_check check(
    autorent_active_account_id is null
    or autorent_passive_account_id is null
    or autorent_active_account_id<>autorent_passive_account_id
  );

create index if not exists subsidiaries_income_autorent_active_account_idx
  on public.subsidiaries(autorent_active_account_id)
  where autorent_active_account_id is not null;
create index if not exists subsidiaries_income_autorent_passive_account_idx
  on public.subsidiaries(autorent_passive_account_id)
  where autorent_passive_account_id is not null;

alter table public.invoice
  add column if not exists autorent_base_amount numeric(18,4) not null default 0,
  add column if not exists autorent_percentage_applied numeric(5,4) not null default 0,
  add column if not exists autorent_total_amount numeric(18,4) not null default 0;
alter table public.credit_note
  add column if not exists autorent_base_amount numeric(18,4) not null default 0,
  add column if not exists autorent_percentage_applied numeric(5,4) not null default 0,
  add column if not exists autorent_total_amount numeric(18,4) not null default 0;
alter table public.debit_note
  add column if not exists autorent_base_amount numeric(18,4) not null default 0,
  add column if not exists autorent_percentage_applied numeric(5,4) not null default 0,
  add column if not exists autorent_total_amount numeric(18,4) not null default 0;

alter table public.invoice
  drop constraint if exists invoice_income_autorent_amounts_check,
  add constraint invoice_income_autorent_amounts_check check(
    autorent_base_amount>=0 and autorent_percentage_applied>=0
    and autorent_percentage_applied<=1 and autorent_total_amount>=0
  );
alter table public.credit_note
  drop constraint if exists credit_note_income_autorent_amounts_check,
  add constraint credit_note_income_autorent_amounts_check check(
    autorent_base_amount>=0 and autorent_percentage_applied>=0
    and autorent_percentage_applied<=1 and autorent_total_amount>=0
  );
alter table public.debit_note
  drop constraint if exists debit_note_income_autorent_amounts_check,
  add constraint debit_note_income_autorent_amounts_check check(
    autorent_base_amount>=0 and autorent_percentage_applied>=0
    and autorent_percentage_applied<=1 and autorent_total_amount>=0
  );

create or replace function public.validate_income_autorent_configuration(
  p_subsidiary_id bigint,
  p_country_id bigint,
  p_applies boolean,
  p_active_account_id bigint,
  p_passive_account_id bigint,
  p_percentage numeric
) returns void
language plpgsql
stable
security definer
set search_path=public,pg_temp
as $$
begin
  if not coalesce(p_applies,false) then return;end if;

  if not exists(
    select 1 from public.countries c
    where c.country_id=p_country_id
      and(
        upper(coalesce(c.country_code_iso2,''))='CO'
        or upper(coalesce(c.country_code_iso3,''))='COL'
        or lower(btrim(c.name))='colombia'
      )
  )then
    raise exception 'La autorretencion de renta solo puede activarse para subsidiarias de Colombia.';
  end if;
  if p_percentage is null or p_percentage<=0 or p_percentage>1 then
    raise exception 'La tarifa de autorretencion debe ser un factor mayor que cero y menor o igual a uno (0.0110 equivale a 1.10%%).';
  end if;
  if p_active_account_id is null or p_passive_account_id is null then
    raise exception 'Configure las cuentas de activo y pasivo para la autorretencion de renta.';
  end if;
  if p_active_account_id=p_passive_account_id then
    raise exception 'Las cuentas de activo y pasivo de autorretencion deben ser diferentes.';
  end if;
  if not exists(
    select 1
    from public.chart_accounts a
    join public.account_subsidiaries sa using(account_id)
    where a.account_id=p_active_account_id and sa.subsidiary_id=p_subsidiary_id
      and sa.is_active and a.accepts_entries and not a.is_inactive
      and a.category='Activo' and a.financial_statement='Balance General'
  )then
    raise exception 'La cuenta de anticipo de autorretencion debe ser una cuenta activa de Activo, de Balance General, que acepte movimientos en la subsidiaria.';
  end if;
  if not exists(
    select 1
    from public.chart_accounts a
    join public.account_subsidiaries sa using(account_id)
    where a.account_id=p_passive_account_id and sa.subsidiary_id=p_subsidiary_id
      and sa.is_active and a.accepts_entries and not a.is_inactive
      and a.category='Pasivo' and a.financial_statement='Balance General'
  )then
    raise exception 'La cuenta por pagar de autorretencion debe ser una cuenta activa de Pasivo, de Balance General, que acepte movimientos en la subsidiaria.';
  end if;
end
$$;

create or replace function public.validate_subsidiary_income_autorent() returns trigger
language plpgsql
set search_path=public,pg_temp
as $$
begin
  perform public.validate_income_autorent_configuration(
    new.subsidiary_id,new.country_id,new.applies_income_autorent,
    new.autorent_active_account_id,new.autorent_passive_account_id,new.autorent_percentage
  );
  return new;
end
$$;

drop trigger if exists validate_subsidiary_income_autorent_trigger on public.subsidiaries;
create trigger validate_subsidiary_income_autorent_trigger
before insert or update of country_id,applies_income_autorent,autorent_active_account_id,
  autorent_passive_account_id,autorent_percentage
on public.subsidiaries
for each row execute function public.validate_subsidiary_income_autorent();

do $$
begin
  if to_regprocedure('public.save_sales_invoice_without_income_autorent(jsonb,bigint)') is null then
    alter function public.save_sales_invoice(jsonb,bigint)
      rename to save_sales_invoice_without_income_autorent;
  end if;
  if to_regprocedure('public.save_sales_note_without_income_autorent(text,jsonb,bigint)') is null then
    alter function public.save_sales_note(text,jsonb,bigint)
      rename to save_sales_note_without_income_autorent;
  end if;
end
$$;

revoke all on function public.save_sales_invoice_without_income_autorent(jsonb,bigint)
  from public,anon,authenticated;
revoke all on function public.save_sales_note_without_income_autorent(text,jsonb,bigint)
  from public,anon,authenticated;

create or replace function public.save_sales_invoice(payload jsonb,target_invoice_id bigint default null)
returns jsonb
language plpgsql
security definer
set search_path=public,pg_temp
as $$
declare
  result jsonb;
  invoice_key bigint;
  journal_key bigint;
  subsidiary_key bigint;
  location_key bigint;
  configured boolean;
  country_key bigint;
  active_account_key bigint;
  passive_account_key bigint;
  configured_rate numeric;
  applied_rate numeric:=0;
  taxable_base numeric:=0;
  autorent_amount numeric:=0;
  prior_journal_key bigint;
  prior_active_account_key bigint;
  prior_passive_account_key bigint;
  credited_base numeric:=0;
  credited_autorent numeric:=0;
begin
  -- Capture the historical rate and accounts before the established workflow
  -- rebuilds all journal lines during an edit.
  if target_invoice_id is not null then
    select i.autorent_percentage_applied,i.journal_id
      into applied_rate,prior_journal_key
    from public.invoice i
    where i.invoice_id=target_invoice_id and i.subsidiary_id=public.active_subsidiary_id();
    if found and applied_rate>0 then
      select l.account_id into prior_active_account_key
      from public.journal_line l
      where l.journal_id=prior_journal_key
        and l.note='Autorretencion de renta - anticipo' and l.debit>0
      order by l.journal_line_id limit 1;
      select l.account_id into prior_passive_account_key
      from public.journal_line l
      where l.journal_id=prior_journal_key
        and l.note='Autorretencion de renta - por pagar' and l.credit>0
      order by l.journal_line_id limit 1;
    end if;
  end if;

  result:=public.save_sales_invoice_without_income_autorent(payload,target_invoice_id);
  invoice_key:=(result->>'invoiceId')::bigint;
  journal_key:=(result->>'journalId')::bigint;

  select i.subsidiary_id,i.location_id,s.country_id,s.applies_income_autorent,
    s.autorent_active_account_id,s.autorent_passive_account_id,s.autorent_percentage
  into subsidiary_key,location_key,country_key,configured,
    active_account_key,passive_account_key,configured_rate
  from public.invoice i join public.subsidiaries s using(subsidiary_id)
  where i.invoice_id=invoice_key;

  if target_invoice_id is null then
    if configured then
      perform public.validate_income_autorent_configuration(
        subsidiary_key,country_key,configured,active_account_key,
        passive_account_key,configured_rate
      );
      applied_rate:=configured_rate;
    else
      applied_rate:=0;
      active_account_key:=null;
      passive_account_key:=null;
    end if;
  elsif applied_rate>0 then
    -- An issued document keeps its original rate and accounts even if the
    -- subsidiary master is changed or disabled later.
    active_account_key:=coalesce(prior_active_account_key,active_account_key);
    passive_account_key:=coalesce(prior_passive_account_key,passive_account_key);
    if active_account_key is null or passive_account_key is null then
      raise exception 'No fue posible recuperar las cuentas historicas de autorretencion de la factura.';
    end if;
  else
    active_account_key:=null;
    passive_account_key:=null;
  end if;

  if applied_rate>0 then
    select round(coalesce(sum(l.amount),0),4)
      into taxable_base
    from public.sales_invoice_line l
    join public.chart_accounts a using(account_id)
    where l.invoice_id=invoice_key and a.category='Ingreso';
    autorent_amount:=round(taxable_base*applied_rate,4);
  end if;

  -- Credit notes reverse only the autorent of their source invoice. Debit
  -- notes have their own independently frozen autorent and do not expand it.
  select coalesce(sum(n.autorent_base_amount),0),coalesce(sum(n.autorent_total_amount),0)
    into credited_base,credited_autorent
  from public.credit_note n where n.invoice_id=invoice_key;
  if credited_base>taxable_base+0.0001 or credited_autorent>autorent_amount+0.0001 then
    raise exception 'La factura no puede quedar por debajo de la autorretencion ya reversada mediante notas de credito.';
  end if;

  update public.invoice set
    autorent_base_amount=taxable_base,
    autorent_percentage_applied=applied_rate,
    autorent_total_amount=autorent_amount
  where invoice_id=invoice_key;

  delete from public.journal_line
  where journal_id=journal_key
    and note in('Autorretencion de renta - anticipo','Autorretencion de renta - por pagar');

  if autorent_amount>0 then
    insert into public.journal_line(
      journal_id,account_id,debit,credit,debit_fx,credit_fx,location_id,note
    )values
      (journal_key,active_account_key,autorent_amount,0,autorent_amount,0,location_key,
       'Autorretencion de renta - anticipo'),
      (journal_key,passive_account_key,0,autorent_amount,0,autorent_amount,location_key,
       'Autorretencion de renta - por pagar');
  end if;

  -- The tax counterpart is materialized by sync_journal_gl_impacts and is not
  -- a raw journal_line. Keep the header on the document total plus the balanced
  -- internal autorent movement instead of summing only raw lines.
  update public.journal set
    total_debit=(result->>'total')::numeric+autorent_amount,
    total_credit=(result->>'total')::numeric+autorent_amount
  where journal_id=journal_key;
  -- journal_transaction_sync mirrors the journal header into transaction.
  -- Restore the commercial document total because autorent is internal and
  -- must never inflate CxC or the transaction amount shown to the customer.
  update public."transaction" t set total_amount=(result->>'total')::numeric
  from public.journal j
  where j.journal_id=journal_key and t.transaction_id=j.transaction_id;
  perform public.sync_journal_gl_impacts(journal_key);

  return result||jsonb_build_object(
    'autorentBase',taxable_base,
    'autorentPercentageApplied',applied_rate,
    'autorentTotal',autorent_amount
  );
end
$$;

create or replace function public.save_sales_note(
  p_kind text,p_payload jsonb,p_target_id bigint default null
)returns jsonb
language plpgsql
security definer
set search_path=public,pg_temp
as $$
declare
  result jsonb;
  normalized_kind text:=upper(p_kind);
  note_key bigint;
  journal_key bigint;
  invoice_key bigint:=(p_payload->>'invoice_id')::bigint;
  source_currency_key bigint;
  source_exchange_rate numeric;
  location_key bigint;
  applied_rate numeric:=0;
  taxable_base numeric:=0;
  autorent_amount numeric:=0;
  original_autorent numeric:=0;
  prior_note_journal_key bigint;
  source_invoice_journal_key bigint;
  subsidiary_key bigint;
  country_key bigint;
  configured boolean;
  configured_rate numeric;
  configured_active_account_key bigint;
  configured_passive_account_key bigint;
  active_account_key bigint;
  passive_account_key bigint;
  original_base numeric:=0;
  credited_autorent numeric:=0;
  credited_base numeric:=0;
  available_autorent numeric:=0;
  available_base numeric:=0;
begin
  if normalized_kind not in('CREDIT','DEBIT') then
    raise exception 'Tipo de nota no valido.';
  end if;

  select i.currency_id,i.exchange_rate into source_currency_key,source_exchange_rate
  from public.invoice i
  where i.invoice_id=invoice_key and i.subsidiary_id=public.active_subsidiary_id();
  if not found then
    raise exception 'La factura no pertenece a la subsidiaria activa.';
  end if;
  if nullif(p_payload->>'currency_id','')::bigint is distinct from source_currency_key then
    raise exception 'La nota debe utilizar la misma moneda de la factura original.';
  end if;
  if normalized_kind='CREDIT'
    and nullif(p_payload->>'exchange_rate','')::numeric is distinct from source_exchange_rate then
    raise exception 'La nota de credito debe utilizar el mismo tipo de cambio de la factura original para reversar exactamente su autorretencion.';
  end if;

  if p_target_id is not null then
    if normalized_kind='CREDIT' then
      select n.autorent_percentage_applied,n.journal_id,n.invoice_id
        into applied_rate,prior_note_journal_key,invoice_key
      from public.credit_note n join public.invoice i using(invoice_id)
      where n.cn_id=p_target_id and i.subsidiary_id=public.active_subsidiary_id();
    else
      select n.autorent_percentage_applied,n.journal_id,n.invoice_id
        into applied_rate,prior_note_journal_key,invoice_key
      from public.debit_note n join public.invoice i using(invoice_id)
      where n.dn_id=p_target_id and i.subsidiary_id=public.active_subsidiary_id();
    end if;
    if found and applied_rate>0 then
      select l.account_id into active_account_key
      from public.journal_line l where l.journal_id=prior_note_journal_key
        and l.note='Autorretencion de renta - anticipo'
        and(case when normalized_kind='CREDIT' then l.credit else l.debit end)>0
      order by l.journal_line_id limit 1;
      select l.account_id into passive_account_key
      from public.journal_line l where l.journal_id=prior_note_journal_key
        and l.note='Autorretencion de renta - por pagar'
        and(case when normalized_kind='CREDIT' then l.debit else l.credit end)>0
      order by l.journal_line_id limit 1;
    end if;
  else
    select i.subsidiary_id,i.autorent_percentage_applied,i.autorent_base_amount,
      i.autorent_total_amount,i.journal_id
      into subsidiary_key,applied_rate,original_base,original_autorent,source_invoice_journal_key
    from public.invoice i
    where i.invoice_id=invoice_key and i.subsidiary_id=public.active_subsidiary_id();
    if not found then
      raise exception 'La factura no pertenece a la subsidiaria activa.';
    end if;
    if normalized_kind='DEBIT' then
      select s.country_id,s.applies_income_autorent,s.autorent_percentage,
        s.autorent_active_account_id,s.autorent_passive_account_id
      into country_key,configured,configured_rate,
        configured_active_account_key,configured_passive_account_key
      from public.subsidiaries s where s.subsidiary_id=subsidiary_key;
      if configured then
        perform public.validate_income_autorent_configuration(
          subsidiary_key,country_key,configured,configured_active_account_key,
          configured_passive_account_key,configured_rate
        );
        applied_rate:=configured_rate;
        active_account_key:=configured_active_account_key;
        passive_account_key:=configured_passive_account_key;
      else
        applied_rate:=0;
      end if;
    elsif applied_rate>0 then
      select l.account_id into active_account_key
      from public.journal_line l where l.journal_id=source_invoice_journal_key
        and l.note='Autorretencion de renta - anticipo' and l.debit>0
      order by l.journal_line_id limit 1;
      select l.account_id into passive_account_key
      from public.journal_line l where l.journal_id=source_invoice_journal_key
        and l.note='Autorretencion de renta - por pagar' and l.credit>0
      order by l.journal_line_id limit 1;
    end if;
  end if;

  result:=public.save_sales_note_without_income_autorent(p_kind,p_payload,p_target_id);
  note_key:=(result->>'noteId')::bigint;
  journal_key:=(result->>'journalId')::bigint;

  if normalized_kind='CREDIT' then
    select n.invoice_id,n.location_id into invoice_key,location_key
    from public.credit_note n where n.cn_id=note_key;
  else
    select n.invoice_id,n.location_id into invoice_key,location_key
    from public.debit_note n where n.dn_id=note_key;
  end if;

  if p_target_id is not null then
    select i.subsidiary_id,i.autorent_base_amount,i.autorent_total_amount,i.journal_id
      into subsidiary_key,original_base,original_autorent,source_invoice_journal_key
    from public.invoice i where i.invoice_id=invoice_key;
  end if;

  if applied_rate>0 then
    if active_account_key is null and normalized_kind='CREDIT' then
      select l.account_id into active_account_key
      from public.journal_line l where l.journal_id=source_invoice_journal_key
        and l.note='Autorretencion de renta - anticipo' and l.debit>0
      order by l.journal_line_id limit 1;
    end if;
    if passive_account_key is null and normalized_kind='CREDIT' then
      select l.account_id into passive_account_key
      from public.journal_line l where l.journal_id=source_invoice_journal_key
        and l.note='Autorretencion de renta - por pagar' and l.credit>0
      order by l.journal_line_id limit 1;
    end if;
    if(active_account_key is null or passive_account_key is null)and normalized_kind='DEBIT' then
      select s.country_id,s.applies_income_autorent,s.autorent_percentage,
        s.autorent_active_account_id,s.autorent_passive_account_id
      into country_key,configured,configured_rate,
        configured_active_account_key,configured_passive_account_key
      from public.subsidiaries s where s.subsidiary_id=subsidiary_key;
      if configured then
        perform public.validate_income_autorent_configuration(
          subsidiary_key,country_key,configured,configured_active_account_key,
          configured_passive_account_key,configured_rate
        );
        active_account_key:=configured_active_account_key;
        passive_account_key:=configured_passive_account_key;
      end if;
    end if;
    if active_account_key is null or passive_account_key is null then
      raise exception 'No fue posible recuperar las cuentas historicas de autorretencion de la factura original.';
    end if;

    select round(coalesce(sum(l.amount),0),4)
      into taxable_base
    from public.sales_note_line l
    join public.chart_accounts a using(account_id)
    where l.note_kind=normalized_kind and l.note_id=note_key and a.category='Ingreso';
    autorent_amount:=round(taxable_base*applied_rate,4);
  end if;

  if normalized_kind='CREDIT' then
    select coalesce(sum(n.autorent_base_amount),0),coalesce(sum(n.autorent_total_amount),0)
      into credited_base,credited_autorent
    from public.credit_note n
    where n.invoice_id=invoice_key and n.cn_id<>note_key;
    available_base:=greatest(original_base-credited_base,0);
    available_autorent:=greatest(original_autorent-credited_autorent,0);
    if taxable_base>available_base+0.0001 or autorent_amount>available_autorent+0.0001 then
      raise exception 'La autorretencion reversada por notas de credito no puede superar la autorretencion de la factura original.';
    end if;
    update public.credit_note set
      autorent_base_amount=taxable_base,
      autorent_percentage_applied=applied_rate,
      autorent_total_amount=autorent_amount
    where cn_id=note_key;
  else
    update public.debit_note set
      autorent_base_amount=taxable_base,
      autorent_percentage_applied=applied_rate,
      autorent_total_amount=autorent_amount
    where dn_id=note_key;
  end if;

  delete from public.journal_line
  where journal_id=journal_key
    and note in('Autorretencion de renta - anticipo','Autorretencion de renta - por pagar');

  if autorent_amount>0 and normalized_kind='CREDIT' then
    insert into public.journal_line(
      journal_id,account_id,debit,credit,debit_fx,credit_fx,location_id,note
    )values
      (journal_key,passive_account_key,autorent_amount,0,autorent_amount,0,location_key,
       'Autorretencion de renta - por pagar'),
      (journal_key,active_account_key,0,autorent_amount,0,autorent_amount,location_key,
       'Autorretencion de renta - anticipo');
  elsif autorent_amount>0 then
    insert into public.journal_line(
      journal_id,account_id,debit,credit,debit_fx,credit_fx,location_id,note
    )values
      (journal_key,active_account_key,autorent_amount,0,autorent_amount,0,location_key,
       'Autorretencion de renta - anticipo'),
      (journal_key,passive_account_key,0,autorent_amount,0,autorent_amount,location_key,
       'Autorretencion de renta - por pagar');
  end if;

  update public.journal set
    total_debit=(result->>'total')::numeric+autorent_amount,
    total_credit=(result->>'total')::numeric+autorent_amount
  where journal_id=journal_key;
  update public."transaction" t set total_amount=(result->>'total')::numeric
  from public.journal j
  where j.journal_id=journal_key and t.transaction_id=j.transaction_id;
  perform public.sync_journal_gl_impacts(journal_key);

  return result||jsonb_build_object(
    'autorentBase',taxable_base,
    'autorentPercentageApplied',applied_rate,
    'autorentTotal',autorent_amount
  );
end
$$;

revoke all on function public.validate_income_autorent_configuration(bigint,bigint,boolean,bigint,bigint,numeric),
  public.save_sales_invoice(jsonb,bigint),public.save_sales_note(text,jsonb,bigint)
from public,anon;
grant execute on function public.save_sales_invoice(jsonb,bigint),
  public.save_sales_note(text,jsonb,bigint) to authenticated;

notify pgrst,'reload schema';
