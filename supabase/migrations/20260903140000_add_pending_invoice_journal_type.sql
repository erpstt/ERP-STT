insert into public.transaction_types(abbreviation,name,module_category,description)
values (
  'ASI_PEN',
  'Asientos Pendientes de Facturar',
  'Contabilidad',
  'Registro contable de operaciones pendientes de facturación.'
)
on conflict(abbreviation) do update set
  name=excluded.name,
  module_category=excluded.module_category,
  description=excluded.description;

create or replace function public.sync_journal_transaction() returns trigger
language plpgsql
security definer
set search_path=public,pg_temp
as $$
declare
  tt bigint;
  st bigint;
  tid bigint;
  type_abbreviation text;
begin
  type_abbreviation:=case
    when new.journal_type='Asientos Pendientes de Facturar' then 'ASI_PEN'
    else 'ASI_DIA'
  end;

  select transaction_type_id into tt
  from transaction_types
  where abbreviation=type_abbreviation
  limit 1;

  select status_id into st
  from status
  where code='APROBADO' and module='Transacciones'
  limit 1;

  if tt is null then
    raise exception 'No existe el tipo de transacción %.',type_abbreviation;
  end if;
  if st is null then
    select status_id into st from status order by status_id limit 1;
  end if;

  if new.transaction_id is null then
    insert into public."transaction"(
      tran_number,tran_date,transaction_type_id,subsidiary_id,currency_id,
      exchange_rate,fiscal_period_id,total_amount,status_id
    ) values (
      new.journal_number,new.journal_date,tt,new.subsidiary_id,new.currency_id,
      new.exchange_rate,new.fiscal_period_id,
      greatest(coalesce(new.total_debit,0),coalesce(new.total_credit,0)),st
    )
    on conflict(tran_number) do update set
      tran_date=excluded.tran_date,
      transaction_type_id=excluded.transaction_type_id,
      subsidiary_id=excluded.subsidiary_id,
      currency_id=excluded.currency_id,
      exchange_rate=excluded.exchange_rate,
      fiscal_period_id=excluded.fiscal_period_id,
      total_amount=excluded.total_amount,
      status_id=excluded.status_id
    returning transaction_id into tid;
    new.transaction_id:=tid;
  else
    update public."transaction" set
      tran_date=new.journal_date,
      transaction_type_id=tt,
      subsidiary_id=new.subsidiary_id,
      currency_id=new.currency_id,
      exchange_rate=new.exchange_rate,
      fiscal_period_id=new.fiscal_period_id,
      total_amount=greatest(coalesce(new.total_debit,0),coalesce(new.total_credit,0)),
      status_id=st
    where transaction_id=new.transaction_id;
  end if;
  return new;
end
$$;

notify pgrst,'reload schema';
