-- Opening bank auxiliary.
--
-- The opening journal remains the accounting source of truth. These tables
-- retain the operational bank-account composition required by bank balances,
-- classic reconciliation and the four-column cash proof without posting the
-- opening amounts to the general ledger a second time.

create table if not exists public.opening_bank_accounts(
  id bigint generated always as identity primary key,
  run_id bigint not null references public.opening_balance_runs(id) on delete cascade,
  subsidiary_id bigint not null references public.subsidiaries(subsidiary_id) on delete restrict,
  bank_account_id bigint not null references public.bank_account(bank_account_id) on delete restrict,
  bank_id bigint not null references public.banks(bank_id) on delete restrict,
  currency_id bigint not null references public.currencies(currency_id) on delete restrict,
  ledger_account_id bigint not null references public.chart_accounts(account_id) on delete restrict,
  is_active boolean not null default false,
  activated_at timestamptz,
  opening_reversed_at timestamptz,
  created_by bigint references public.users(user_id),
  updated_by bigint references public.users(user_id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(run_id,bank_account_id)
);

create table if not exists public.opening_bank_items(
  id bigint generated always as identity primary key,
  opening_bank_account_id bigint not null references public.opening_bank_accounts(id) on delete cascade,
  source_row integer not null check(source_row>1),
  record_type text not null check(record_type in('SALDO_CONCILIADO','DEPOSITO_EN_TRANSITO','CHEQUE_EN_TRANSITO')),
  transaction_date date not null,
  value_date date,
  reference text,
  beneficiary text,
  description text,
  original_amount numeric(24,6) not null,
  local_equivalent numeric(24,6) not null,
  -- The parser canonicalizes the spreadsheet values before invoking the RPC:
  -- deposits are positive, checks are negative and the cleared balance keeps
  -- its accounting sign (including an overdraft). Keep that signed value.
  signed_original_amount numeric(24,6) generated always as(original_amount)stored,
  signed_local_equivalent numeric(24,6) generated always as(local_equivalent)stored,
  created_bank_tran_id bigint references public.bank_transaction(bank_tran_id) on delete set null,
  raw_data jsonb not null default'{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(opening_bank_account_id,source_row),
  check(
    record_type='SALDO_CONCILIADO'
      and(
        original_amount=0 and local_equivalent=0
        or original_amount<>0 and local_equivalent<>0
          and original_amount*local_equivalent>0
      )
    or record_type='DEPOSITO_EN_TRANSITO'
      and original_amount>0 and local_equivalent>0
    or record_type='CHEQUE_EN_TRANSITO'
      and original_amount<0 and local_equivalent<0
  )
);

create table if not exists public.opening_bank_gl_links(
  opening_bank_account_id bigint not null references public.opening_bank_accounts(id) on delete cascade,
  opening_balance_line_id bigint not null references public.opening_balance_lines(id) on delete cascade,
  primary key(opening_bank_account_id,opening_balance_line_id)
);

create unique index if not exists opening_bank_one_cleared_balance_idx
  on public.opening_bank_items(opening_bank_account_id)
  where record_type='SALDO_CONCILIADO';
create index if not exists opening_bank_accounts_run_idx
  on public.opening_bank_accounts(run_id,is_active,bank_account_id);
create index if not exists opening_bank_items_account_idx
  on public.opening_bank_items(opening_bank_account_id,record_type,transaction_date,id);
create index if not exists opening_bank_gl_line_idx
  on public.opening_bank_gl_links(opening_balance_line_id);

alter table public.bank_transaction
  add column if not exists opening_bank_item_id bigint references public.opening_bank_items(id) on delete restrict,
  add column if not exists opening_balance_line_id bigint references public.opening_balance_lines(id) on delete set null,
  add column if not exists is_opening_balance boolean not null default false;

alter table public.bank_transaction
  add constraint bank_transaction_opening_trace_check
  check(is_opening_balance=(opening_bank_item_id is not null));

create unique index if not exists bank_transaction_opening_item_idx
  on public.bank_transaction(opening_bank_item_id)
  where opening_bank_item_id is not null;
create index if not exists bank_transaction_opening_balance_idx
  on public.bank_transaction(bank_account_id,is_opening_balance,tran_date,bank_tran_id)
  where is_opening_balance;

alter table public.opening_bank_accounts enable row level security;
alter table public.opening_bank_items enable row level security;
alter table public.opening_bank_gl_links enable row level security;

drop policy if exists opening_bank_accounts_select on public.opening_bank_accounts;
create policy opening_bank_accounts_select on public.opening_bank_accounts
 for select to authenticated using(
  exists(select 1 from public.user_subsidiaries access
   where access.user_id=public.app_user_id()
    and access.subsidiary_id=opening_bank_accounts.subsidiary_id)
 );

drop policy if exists opening_bank_items_select on public.opening_bank_items;
create policy opening_bank_items_select on public.opening_bank_items
 for select to authenticated using(
  exists(select 1 from public.opening_bank_accounts account
   join public.user_subsidiaries access on access.subsidiary_id=account.subsidiary_id
   where account.id=opening_bank_items.opening_bank_account_id
    and access.user_id=public.app_user_id())
 );

drop policy if exists opening_bank_gl_links_select on public.opening_bank_gl_links;
create policy opening_bank_gl_links_select on public.opening_bank_gl_links
 for select to authenticated using(
  exists(select 1 from public.opening_bank_accounts account
   join public.user_subsidiaries access on access.subsidiary_id=account.subsidiary_id
   where account.id=opening_bank_gl_links.opening_bank_account_id
    and access.user_id=public.app_user_id())
 );

-- Returns the two-sided reconciliation by ledger account and currency. The
-- auxiliary formula is cleared balance + deposits in transit - checks in
-- transit, in both original and local currency.
create or replace function public.opening_bank_reconciliation(p_run_id bigint)
returns jsonb language sql stable security definer set search_path=public,pg_temp as $$
with run as(
 select r.* from public.opening_balance_runs r
 where r.id=p_run_id and r.subsidiary_id=public.active_subsidiary_id()
),ledger as(
 select l.account_id,l.currency_id,
  sum(case when l.local_debit>0 then l.foreign_amount else-l.foreign_amount end)original_amount,
  sum(l.local_debit-l.local_credit)local_amount
 from run r join public.opening_balance_lines l on l.run_id=r.id
 where l.source_type='GL'and exists(
  select 1 from public.bank_account bank
  where bank.subsidiary_id=r.subsidiary_id and bank.account_id=l.account_id
 )
 group by l.account_id,l.currency_id
),auxiliary_accounts as(
 select account.ledger_account_id account_id,account.currency_id,
  string_agg(distinct bank.bank_code,', 'order by bank.bank_code)bank_code,
  string_agg(distinct bank.bank_name,', 'order by bank.bank_name)bank_name,
  string_agg(distinct bank_account.account_number,', 'order by bank_account.account_number)account_number,
  sum(item.signed_original_amount)original_amount,
  sum(item.signed_local_equivalent)local_amount
 from run r join public.opening_bank_accounts account on account.run_id=r.id
 join public.opening_bank_items item on item.opening_bank_account_id=account.id
 join public.bank_account bank_account on bank_account.bank_account_id=account.bank_account_id
 join public.banks bank on bank.bank_id=account.bank_id
 where account.opening_reversed_at is null
 group by account.ledger_account_id,account.currency_id
),keys as(
 select account_id,currency_id from ledger
 union select account_id,currency_id from auxiliary_accounts
),rows as(
 select key.account_id,key.currency_id,
  coalesce(auxiliary.bank_code,catalog.bank_code)bank_code,
  coalesce(auxiliary.bank_name,catalog.bank_name)bank_name,
  coalesce(auxiliary.account_number,catalog.account_number)account_number,
  chart.account_number ledger_account_number,chart.account_name ledger_account_name,currency.currency_code currency,
  coalesce(ledger.original_amount,0)ledger_original,
  coalesce(auxiliary.original_amount,0)auxiliary_original,
  coalesce(ledger.original_amount,0)-coalesce(auxiliary.original_amount,0)original_difference,
  coalesce(ledger.local_amount,0)ledger_local,
  coalesce(auxiliary.local_amount,0)auxiliary_local,
  coalesce(ledger.local_amount,0)-coalesce(auxiliary.local_amount,0)local_difference
 from keys key join public.chart_accounts chart on chart.account_id=key.account_id
 join public.currencies currency on currency.currency_id=key.currency_id
 left join ledger on ledger.account_id=key.account_id and ledger.currency_id=key.currency_id
 left join auxiliary_accounts auxiliary on auxiliary.account_id=key.account_id and auxiliary.currency_id=key.currency_id
 left join lateral(
  select string_agg(distinct bank.bank_code,', 'order by bank.bank_code)bank_code,
   string_agg(distinct bank.bank_name,', 'order by bank.bank_name)bank_name,
   string_agg(distinct account.account_number,', 'order by account.account_number)account_number
  from run r join public.bank_account account on account.subsidiary_id=r.subsidiary_id
  join public.banks bank using(bank_id)
  where account.account_id=key.account_id and account.currency_id=key.currency_id
 )catalog on true
)
select coalesce(jsonb_agg(jsonb_build_object(
 'bankCode',bank_code,'bankName',bank_name,'accountNumber',account_number,
 'ledgerAccountId',account_id,'ledgerAccountNumber',ledger_account_number,'ledgerAccountName',ledger_account_name,
 'currencyId',currency_id,'currency',currency,
 'ledger',ledger_original,'auxiliary',auxiliary_original,'difference',original_difference,
 'ledgerLocal',ledger_local,'auxiliaryLocal',auxiliary_local,'localDifference',local_difference,
 'balanced',abs(original_difference)<.005 and abs(local_difference)<.005
)order by ledger_account_number,currency),'[]'::jsonb)from rows
$$;

create or replace function public.opening_bank_assert_reconciled(p_run_id bigint)
returns void language plpgsql stable security definer set search_path=public,pg_temp as $$
declare reconciliation jsonb;
begin
 reconciliation:=public.opening_bank_reconciliation(p_run_id);
 if exists(select 1 from jsonb_array_elements(reconciliation)item
  where abs(coalesce((item->>'difference')::numeric,0))>=.005
     or abs(coalesce((item->>'localDifference')::numeric,0))>=.005)then
  raise exception 'El Auxiliar de Bancos no coincide con el Libro Mayor por cuenta contable y moneda. Corrija las diferencias antes de continuar.';
 end if;
end$$;

-- Stages one flat item per input row. Bank and account number identify the
-- operational account without exposing internal ids in the spreadsheet.
create or replace function public.opening_bank_stage(p_run_id bigint,p_items jsonb)
returns integer language plpgsql security definer set search_path=public,pg_temp as $$
declare
 run_row public.opening_balance_runs%rowtype;item jsonb;account_row record;header_key bigint;
 source_row_value integer;record_type_value text;transaction_date_value date;value_date_value date;
 original_value numeric(24,6);local_value numeric(24,6);matches integer;created_count integer:=0;
 bank_code_value text;account_number_value text;currency_value text;reference_value text;
begin
 if jsonb_typeof(coalesce(p_items,'[]'::jsonb))<>'array'then raise exception 'El Auxiliar de Bancos debe ser una lista válida.';end if;
 select *into run_row from public.opening_balance_runs
  where id=p_run_id and subsidiary_id=public.active_subsidiary_id()for update;
 if run_row.id is null then raise exception 'Lote de apertura no disponible para el Auxiliar de Bancos.';end if;
 if run_row.status not in('VALIDATED','POSTED')then raise exception 'El lote debe estar validado o contabilizado para cargar el Auxiliar de Bancos.';end if;

 -- A new validation replaces only staged data. Active items are immutable and
 -- can coexist with a later file containing other bank accounts.
 delete from public.opening_bank_accounts where run_id=p_run_id and not is_active;

 for item in select value from jsonb_array_elements(coalesce(p_items,'[]'::jsonb))loop
  begin
   source_row_value:=coalesce(nullif(item->>'sourceRow','')::integer,created_count+2);
   record_type_value:=upper(btrim(coalesce(item->>'recordType','')));
   bank_code_value:=btrim(coalesce(item->>'bankCode',''));
   account_number_value:=btrim(coalesce(item->>'accountNumber',''));
   currency_value:=upper(btrim(coalesce(item->>'currency','')));
   transaction_date_value:=coalesce(nullif(item->>'transactionDate','')::date,run_row.opening_date);
   value_date_value:=nullif(item->>'valueDate','')::date;
   original_value:=(item->>'originalAmount')::numeric;
   local_value:=(item->>'localEquivalent')::numeric;
  exception when invalid_text_representation or numeric_value_out_of_range or datetime_field_overflow then
   raise exception 'Auxiliar de Bancos fila %: revise fechas e importes.',coalesce(item->>'sourceRow','?');
  end;
   if original_value is null or local_value is null then
    raise exception 'Auxiliar de Bancos fila %: complete el importe original y su equivalente local.',source_row_value;
   end if;
  if source_row_value<=1 then raise exception 'Auxiliar de Bancos: la fila de origen debe ser mayor que 1.';end if;
  if bank_code_value=''or account_number_value=''or currency_value=''then
   raise exception 'Auxiliar de Bancos fila %: complete banco, cuenta bancaria y moneda.',source_row_value;
  end if;
  if record_type_value not in('SALDO_CONCILIADO','DEPOSITO_EN_TRANSITO','CHEQUE_EN_TRANSITO')then
   raise exception 'Auxiliar de Bancos fila %: tipo de registro no válido.',source_row_value;
  end if;
  if transaction_date_value>run_row.opening_date or value_date_value>run_row.opening_date then
   raise exception 'Auxiliar de Bancos fila %: las fechas no pueden ser posteriores a la fecha de apertura.',source_row_value;
  end if;
   if record_type_value='SALDO_CONCILIADO'then
    if(original_value=0)<>(local_value=0)or(original_value<>0 and original_value*local_value<=0)then
     raise exception 'Auxiliar de Bancos fila %: el saldo original y su equivalente local deben ser ambos cero o conservar el mismo signo.',source_row_value;
    end if;
   elsif record_type_value='DEPOSITO_EN_TRANSITO'and(original_value<=0 or local_value<=0)then
    raise exception 'Auxiliar de Bancos fila %: el depósito en tránsito debe recibirse con signo positivo.',source_row_value;
   elsif record_type_value='CHEQUE_EN_TRANSITO'and(original_value>=0 or local_value>=0)then
    raise exception 'Auxiliar de Bancos fila %: el cheque en tránsito debe recibirse con signo negativo.',source_row_value;
   end if;
  reference_value:=nullif(btrim(item->>'reference'),'');
  if record_type_value<>'SALDO_CONCILIADO'and reference_value is null then
   raise exception 'Auxiliar de Bancos fila %: indique la referencia de la partida en tránsito.',source_row_value;
  end if;

  select count(*)into matches from public.bank_account account join public.banks bank using(bank_id)
   where account.subsidiary_id=run_row.subsidiary_id and not coalesce(account.is_credit_card,false)
    and lower(bank.bank_code)=lower(bank_code_value)and btrim(account.account_number)=account_number_value;
  if matches<>1 then
   raise exception 'Auxiliar de Bancos fila %: banco % y cuenta % no existen, no pertenecen a la subsidiaria o son ambiguos.',source_row_value,bank_code_value,account_number_value;
  end if;
  select account.bank_account_id,account.bank_id,account.currency_id,account.account_id ledger_account_id,
   bank.bank_code,bank.bank_name,currency.currency_code,account.account_number
   into account_row
  from public.bank_account account join public.banks bank using(bank_id)join public.currencies currency using(currency_id)
  where account.subsidiary_id=run_row.subsidiary_id and not coalesce(account.is_credit_card,false)
   and lower(bank.bank_code)=lower(bank_code_value)and btrim(account.account_number)=account_number_value;
  if account_row.currency_code<>currency_value then
   raise exception 'Auxiliar de Bancos fila %: la moneda % no coincide con la moneda % de la cuenta bancaria.',source_row_value,currency_value,account_row.currency_code;
  end if;
   if exists(
    select 1 from public.bank_reconciliation reconciliation
    where reconciliation.bank_account_id=account_row.bank_account_id
     and reconciliation.status='CERRADA'and reconciliation.reconciliation_date>=run_row.opening_date
   )then
    raise exception 'Auxiliar de Bancos fila %: la cuenta bancaria tiene una conciliación cerrada posterior a la apertura.',source_row_value;
   end if;
   if exists(
    select 1 from public.quadratic_bank_reconciliations reconciliation
    where reconciliation.bank_account_id=account_row.bank_account_id
     and reconciliation.status in('approved','closed')
     and(make_date(reconciliation.period_year,reconciliation.period_month,1)+interval'1 month'-interval'1 day')::date>=run_row.opening_date
   )then
    raise exception 'Auxiliar de Bancos fila %: la cuenta bancaria tiene una prueba de efectivo aprobada o cerrada posterior a la apertura.',source_row_value;
   end if;
  if not exists(select 1 from public.account_subsidiaries scope join public.chart_accounts chart using(account_id)
   where scope.subsidiary_id=run_row.subsidiary_id and scope.account_id=account_row.ledger_account_id
    and scope.is_active and chart.accepts_entries and not chart.is_inactive)then
   raise exception 'Auxiliar de Bancos fila %: la cuenta contable vinculada al banco no está habilitada para la subsidiaria.',source_row_value;
  end if;
  -- A zero-net bank account may legitimately have no GL row: for example, a
  -- zero cleared balance plus equal deposits and checks in transit. The final
  -- reconciliation validates the complete auxiliary against the ledger and
  -- rejects any non-zero auxiliary total that lacks its corresponding GL sum.

  select id into header_key from public.opening_bank_accounts
   where run_id=run_row.id and bank_account_id=account_row.bank_account_id;
  if header_key is not null and exists(select 1 from public.opening_bank_accounts where id=header_key and is_active)then
   raise exception 'La cuenta bancaria % ya tiene un auxiliar inicial activo.',account_row.account_number;
  end if;
  if header_key is null then
   insert into public.opening_bank_accounts(run_id,subsidiary_id,bank_account_id,bank_id,currency_id,ledger_account_id,created_by,updated_by)
   values(run_row.id,run_row.subsidiary_id,account_row.bank_account_id,account_row.bank_id,account_row.currency_id,account_row.ledger_account_id,public.app_user_id(),public.app_user_id())
   returning id into header_key;
   insert into public.opening_bank_gl_links(opening_bank_account_id,opening_balance_line_id)
   select header_key,line.id from public.opening_balance_lines line
   where line.run_id=run_row.id and line.source_type='GL'and line.account_id=account_row.ledger_account_id and line.currency_id=account_row.currency_id;
  end if;
  insert into public.opening_bank_items(opening_bank_account_id,source_row,record_type,transaction_date,value_date,reference,beneficiary,description,original_amount,local_equivalent,raw_data)
  values(header_key,source_row_value,record_type_value,transaction_date_value,value_date_value,reference_value,nullif(btrim(item->>'beneficiary'),''),nullif(btrim(item->>'description'),''),original_value,local_value,item);
  created_count:=created_count+1;
 end loop;

 if exists(select 1 from public.opening_bank_accounts account where account.run_id=run_row.id and not account.is_active
  and(select count(*)from public.opening_bank_items item where item.opening_bank_account_id=account.id and item.record_type='SALDO_CONCILIADO')<>1)then
  raise exception 'Cada cuenta del Auxiliar de Bancos debe incluir exactamente un registro SALDO_CONCILIADO.';
 end if;
 perform public.opening_bank_assert_reconciled(run_row.id);
 return created_count;
end$$;

-- Extend the existing options function. This wraps the current implementation,
-- which already includes Fixed Assets and Pending-to-Invoice catalogs.
alter function public.opening_balance_options()
 rename to opening_balance_options_before_opening_bank;
revoke all on function public.opening_balance_options_before_opening_bank()from public,anon,authenticated;

create function public.opening_balance_options()returns jsonb
language plpgsql stable security definer set search_path=public,pg_temp as $$
declare base jsonb;sid bigint:=public.active_subsidiary_id();
begin
 base:=public.opening_balance_options_before_opening_bank();
 return base||jsonb_build_object(
  'banks',coalesce((select jsonb_agg(jsonb_build_object('id',bank.bank_id,'code',bank.bank_code,'name',bank.bank_name)order by bank.bank_name)
   from(select distinct b.bank_id,b.bank_code,b.bank_name from public.bank_account account join public.banks b using(bank_id)
    where account.subsidiary_id=sid and not coalesce(account.is_credit_card,false))bank),'[]'::jsonb),
  'bankAccounts',coalesce((select jsonb_agg(jsonb_build_object(
   'id',account.bank_account_id,'bankId',account.bank_id,'bankCode',bank.bank_code,'bankName',bank.bank_name,
   'accountNumber',account.account_number,'currencyId',account.currency_id,'currency',currency.currency_code,
   'ledgerAccountId',account.account_id,'ledgerAccountNumber',chart.account_number,'ledgerAccountName',chart.account_name
  )order by bank.bank_name,account.account_number)from public.bank_account account join public.banks bank using(bank_id)
   join public.currencies currency using(currency_id)join public.chart_accounts chart using(account_id)
   where account.subsidiary_id=sid and not coalesce(account.is_credit_card,false)),'[]'::jsonb),
  'bankRecordTypes',jsonb_build_array(
   jsonb_build_object('code','SALDO_CONCILIADO','name','Saldo conciliado inicial'),
   jsonb_build_object('code','DEPOSITO_EN_TRANSITO','name','Depósito en tránsito'),
   jsonb_build_object('code','CHEQUE_EN_TRANSITO','name','Cheque en tránsito')
  )
 );
end$$;

alter function public.opening_balance_preview(bigint)
 rename to opening_balance_preview_before_opening_bank;
revoke all on function public.opening_balance_preview_before_opening_bank(bigint)from public,anon,authenticated;

create function public.opening_balance_preview(p_run_id bigint)returns jsonb
language plpgsql stable security definer set search_path=public,pg_temp as $$
declare base jsonb;reconciliation jsonb;
begin
 base:=public.opening_balance_preview_before_opening_bank(p_run_id);
 if base is null then return null;end if;
 reconciliation:=public.opening_bank_reconciliation(p_run_id);
 return base||jsonb_build_object(
  'bankItems',coalesce((select jsonb_agg(jsonb_build_object(
   'id',item.id,'row',item.source_row,'sourceRow',item.source_row,
   'bankAccountId',account.bank_account_id,'bankCode',bank.bank_code,'bankName',bank.bank_name,'accountNumber',bank_account.account_number,
   'recordType',item.record_type,'transactionDate',item.transaction_date,'valueDate',item.value_date,'reference',item.reference,
   'beneficiary',item.beneficiary,'description',item.description,'currency',currency.currency_code,
   'originalAmount',item.original_amount,'signedOriginalAmount',item.signed_original_amount,
   'localEquivalent',item.local_equivalent,'signedLocalEquivalent',item.signed_local_equivalent,
   'created',item.created_bank_tran_id is not null,'bankTransactionId',item.created_bank_tran_id,'active',account.is_active,'errors','[]'::jsonb
  )order by bank.bank_name,bank_account.account_number,item.source_row)
  from public.opening_bank_accounts account join public.opening_bank_items item on item.opening_bank_account_id=account.id
  join public.bank_account bank_account on bank_account.bank_account_id=account.bank_account_id
  join public.banks bank on bank.bank_id=account.bank_id join public.currencies currency on currency.currency_id=account.currency_id
  where account.run_id=p_run_id),'[]'::jsonb),
  'bankReconciliation',reconciliation,
  'bankSummary',(select jsonb_build_object(
   'count',count(item.id),'accounts',count(distinct account.id),
   'openingBalance',coalesce(sum(item.original_amount)filter(where item.record_type='SALDO_CONCILIADO'),0),
   'openingLocal',coalesce(sum(item.local_equivalent)filter(where item.record_type='SALDO_CONCILIADO'),0),
   'originalAmount',coalesce(sum(item.signed_original_amount),0),'localEquivalent',coalesce(sum(item.signed_local_equivalent),0),
   'transitCount',count(item.id)filter(where item.record_type<>'SALDO_CONCILIADO'),
   'transitDeposits',coalesce(sum(item.original_amount)filter(where item.record_type='DEPOSITO_EN_TRANSITO'),0),
   'transitChecks',coalesce(sum(abs(item.original_amount))filter(where item.record_type='CHEQUE_EN_TRANSITO'),0),
   'transitDepositsLocal',coalesce(sum(item.local_equivalent)filter(where item.record_type='DEPOSITO_EN_TRANSITO'),0),
   'transitChecksLocal',coalesce(sum(abs(item.local_equivalent))filter(where item.record_type='CHEQUE_EN_TRANSITO'),0),
   'pending',count(item.id)filter(where item.created_bank_tran_id is null),
   'active',count(item.id)filter(where account.is_active),
   'balanced',coalesce((select bool_and(abs((row->>'difference')::numeric)<.005 and abs((row->>'localDifference')::numeric)<.005)
    from jsonb_array_elements(reconciliation)row),true)
  )from public.opening_bank_accounts account left join public.opening_bank_items item on item.opening_bank_account_id=account.id
   where account.run_id=p_run_id)
 );
end$$;

-- Validation permits adding the bank auxiliary to an already posted opening.
alter function public.opening_balance_validate(jsonb)
 rename to opening_balance_validate_before_opening_bank;
revoke all on function public.opening_balance_validate_before_opening_bank(jsonb)from public,anon,authenticated;

create function public.opening_balance_validate(p jsonb)returns jsonb
language plpgsql security definer set search_path=public,pg_temp as $$
declare output jsonb;rid bigint;sid bigint;existing public.opening_balance_runs%rowtype;
 bank_payload jsonb:=coalesce(p->'banks',p->'bankItems');has_banks boolean:=false;has_other boolean:=false;
begin
 sid:=public.opening_balance_assert_access('create');
 if coalesce(p->>'expectedSubsidiaryId','')<>sid::text then
  raise exception 'La empresa activa cambió desde que abrió la carga. Recargue la pantalla y seleccione nuevamente los archivos.';
 end if;
 if((p ? 'banks')or(p ? 'bankItems'))and jsonb_typeof(coalesce(bank_payload,'[]'::jsonb))<>'array'then
  raise exception 'El Auxiliar de Bancos debe ser una lista válida.';
 end if;
 has_banks:=jsonb_typeof(coalesce(bank_payload,'[]'::jsonb))='array'and jsonb_array_length(coalesce(bank_payload,'[]'::jsonb))>0;
 has_other:=jsonb_array_length(coalesce(p->'rows','[]'::jsonb))>0
  or jsonb_array_length(coalesce(p->'assets','[]'::jsonb))>0
  or jsonb_array_length(coalesce(p->'pending',p->'pendingItems','[]'::jsonb))>0;
 select *into existing from public.opening_balance_runs where subsidiary_id=sid and status<>'REVERSED'order by id desc limit 1;
 if existing.status='POSTED'and has_banks and not has_other then
  rid:=existing.id;
 else
  output:=public.opening_balance_validate_before_opening_bank((p-'banks')-'bankItems');
  rid:=(output->'run'->>'id')::bigint;
 end if;
 if rid is null then raise exception 'No fue posible identificar el lote de apertura validado.';end if;
 if has_banks then perform public.opening_bank_stage(rid,bank_payload);end if;
 if has_banks or exists(select 1 from public.opening_bank_accounts where run_id=rid)
  or coalesce(existing.status,'')<>'POSTED'then perform public.opening_bank_assert_reconciled(rid);end if;
 return public.opening_balance_preview(rid);
end$$;

create or replace function public.opening_bank_activate(p_run_id bigint)
returns integer language plpgsql security definer set search_path=public,pg_temp as $$
declare run_row public.opening_balance_runs%rowtype;item_row record;transaction_key bigint;line_key bigint;bank_transaction_key bigint;created_count integer:=0;
begin
 select *into run_row from public.opening_balance_runs where id=p_run_id and subsidiary_id=public.active_subsidiary_id()for update;
 if run_row.id is null or run_row.status<>'POSTED'or run_row.journal_id is null then raise exception 'La apertura debe estar contabilizada antes de activar el Auxiliar de Bancos.';end if;
 select transaction_id into transaction_key from public.journal where journal_id=run_row.journal_id;
 if transaction_key is null then raise exception 'El asiento de apertura no tiene una transacción contable asociada.';end if;
 if exists(select 1 from public.opening_bank_accounts staged join public.bank_account current using(bank_account_id)
  where staged.run_id=run_row.id and staged.opening_reversed_at is null and(
   current.subsidiary_id<>staged.subsidiary_id or current.bank_id<>staged.bank_id
   or current.currency_id<>staged.currency_id or current.account_id<>staged.ledger_account_id
   or coalesce(current.is_credit_card,false)
   or not exists(select 1 from public.account_subsidiaries scope join public.chart_accounts chart using(account_id)
    where scope.subsidiary_id=staged.subsidiary_id and scope.account_id=staged.ledger_account_id
     and scope.is_active and chart.accepts_entries and not chart.is_inactive)
  ))then
  raise exception 'La configuración de una cuenta bancaria cambió desde la validación. Valide nuevamente el Auxiliar de Bancos.';
 end if;
 perform public.opening_bank_assert_reconciled(run_row.id);
 if exists(
  select 1 from public.opening_bank_accounts account join public.bank_reconciliation reconciliation using(bank_account_id)
  where account.run_id=run_row.id and account.opening_reversed_at is null
   and reconciliation.status='CERRADA'and reconciliation.reconciliation_date>=run_row.opening_date
 )then
  raise exception 'No se puede activar el Auxiliar de Bancos: existe una conciliación bancaria cerrada posterior a la apertura.';
 end if;
 if exists(
  select 1 from public.opening_bank_accounts account join public.quadratic_bank_reconciliations reconciliation using(bank_account_id)
  where account.run_id=run_row.id and account.opening_reversed_at is null and reconciliation.status in('approved','closed')
   and(make_date(reconciliation.period_year,reconciliation.period_month,1)+interval'1 month'-interval'1 day')::date>=run_row.opening_date
 )then
  raise exception 'No se puede activar el Auxiliar de Bancos: existe una prueba de efectivo aprobada o cerrada posterior a la apertura.';
 end if;
 perform 1 from public.bank_account account where account.bank_account_id in(
  select bank_account_id from public.opening_bank_accounts where run_id=run_row.id and opening_reversed_at is null
 )order by account.bank_account_id for update;
 perform set_config('app.opening_bank_internal','1',true);
 for item_row in
  select item.*,account.bank_account_id,account.id header_id,
   coalesce((select min(link.opening_balance_line_id)from public.opening_bank_gl_links link where link.opening_bank_account_id=account.id),null)opening_line_id,
   journal.journal_number
  from public.opening_bank_accounts account join public.opening_bank_items item on item.opening_bank_account_id=account.id
  join public.journal journal on journal.journal_id=run_row.journal_id
  where account.run_id=run_row.id and account.opening_reversed_at is null and item.created_bank_tran_id is null
  order by account.bank_account_id,case when item.record_type='SALDO_CONCILIADO'then 0 else 1 end,item.source_row
 loop
  bank_transaction_key:=null;
  insert into public.bank_transaction(
   tran_date,value_date,bank_account_id,transaction_id,amount,tran_type,reference_number,beneficiary,description,reconciliation_status,
   opening_bank_item_id,opening_balance_line_id,is_opening_balance
  )values(
   item_row.transaction_date,item_row.value_date,item_row.bank_account_id,transaction_key,item_row.signed_original_amount,
   case item_row.record_type when'SALDO_CONCILIADO'then'SALDO_INICIAL'else item_row.record_type end,
   coalesce(item_row.reference,item_row.journal_number),item_row.beneficiary,
   coalesce(item_row.description,case item_row.record_type when'SALDO_CONCILIADO'then'Saldo bancario inicial conciliado'when'DEPOSITO_EN_TRANSITO'then'Depósito en tránsito al inicio'else'Cheque en tránsito al inicio'end),
   case when item_row.record_type='SALDO_CONCILIADO'then'CONCILIADO'else'PENDIENTE_EN_TRANSITO'end,
   item_row.id,item_row.opening_line_id,true
  )on conflict do nothing returning bank_tran_id into bank_transaction_key;
  if bank_transaction_key is null then select bank_tran_id into bank_transaction_key from public.bank_transaction where opening_bank_item_id=item_row.id;end if;
  if bank_transaction_key is null then raise exception 'No fue posible crear el movimiento inicial de la fila %.',item_row.source_row;end if;
  update public.opening_bank_items set created_bank_tran_id=bank_transaction_key,updated_at=now()where id=item_row.id;
  created_count:=created_count+1;
 end loop;
 update public.opening_bank_accounts account set is_active=true,activated_at=coalesce(activated_at,now()),updated_at=now(),updated_by=public.app_user_id()
 where account.run_id=run_row.id and account.opening_reversed_at is null
  and not exists(select 1 from public.opening_bank_items item where item.opening_bank_account_id=account.id and item.created_bank_tran_id is null);
 update public.bank_account account set balance=coalesce((select sum(movement.amount)from public.bank_transaction movement where movement.bank_account_id=account.bank_account_id),0)
 where account.bank_account_id in(select bank_account_id from public.opening_bank_accounts where run_id=run_row.id and opening_reversed_at is null);
 perform set_config('app.opening_bank_internal','',true);
 return created_count;
end$$;

alter function public.opening_balance_post(bigint)
 rename to opening_balance_post_before_opening_bank;
revoke all on function public.opening_balance_post_before_opening_bank(bigint)from public,anon,authenticated;

create function public.opening_balance_post(p_run_id bigint)returns jsonb
language plpgsql security definer set search_path=public,pg_temp as $$
declare run_row public.opening_balance_runs%rowtype;result jsonb;has_bank boolean;has_other boolean;created_count integer:=0;
begin
 perform public.opening_balance_assert_access('create');
 select *into run_row from public.opening_balance_runs where id=p_run_id and subsidiary_id=public.active_subsidiary_id()for update;
 if run_row.id is null then raise exception 'Lote no disponible.';end if;
 has_bank:=exists(select 1 from public.opening_bank_accounts account join public.opening_bank_items item on item.opening_bank_account_id=account.id
  where account.run_id=p_run_id and account.opening_reversed_at is null and item.created_bank_tran_id is null);
 has_other:=exists(select 1 from public.opening_fixed_asset_lines where run_id=p_run_id and created_asset_id is null)
  or exists(select 1 from public.opening_pending_invoice_items where run_id=p_run_id and not is_active);
 if exists(select 1 from public.opening_bank_accounts where run_id=p_run_id and opening_reversed_at is null)
  or run_row.status<>'POSTED'then perform public.opening_bank_assert_reconciled(p_run_id);end if;
 if run_row.status='POSTED'and not has_other then
  result:=jsonb_build_object('runId',run_row.id,'journalId',run_row.journal_id,
   'journalNumber',(select journal_number from public.journal where journal_id=run_row.journal_id),
   'bankOnly',has_bank or exists(select 1 from public.opening_bank_accounts where run_id=p_run_id));
 else
  result:=public.opening_balance_post_before_opening_bank(p_run_id);
 end if;
 if exists(select 1 from public.opening_bank_accounts account join public.opening_bank_items item on item.opening_bank_account_id=account.id
  where account.run_id=p_run_id and account.opening_reversed_at is null and item.created_bank_tran_id is null)then
  created_count:=public.opening_bank_activate(p_run_id);
 end if;
 return result||jsonb_build_object('bankItemsCreated',created_count,'bankOnly',coalesce((result->>'bankOnly')::boolean,false));
end$$;

alter function public.opening_balance_reverse(bigint)
 rename to opening_balance_reverse_before_opening_bank;
revoke all on function public.opening_balance_reverse_before_opening_bank(bigint)from public,anon,authenticated;

create function public.opening_balance_reverse(p_run_id bigint)returns jsonb
language plpgsql security definer set search_path=public,pg_temp as $$
declare run_row public.opening_balance_runs%rowtype;result jsonb;reversed_count integer:=0;
begin
 perform public.opening_balance_assert_access('delete');
 select *into run_row from public.opening_balance_runs where id=p_run_id and subsidiary_id=public.active_subsidiary_id()for update;
 if run_row.id is null or run_row.status<>'POSTED'then raise exception 'Apertura contabilizada no encontrada.';end if;
 if exists(select 1 from public.opening_bank_accounts account join public.bank_reconciliation reconciliation using(bank_account_id)
  where account.run_id=p_run_id and reconciliation.status='CERRADA'and reconciliation.reconciliation_date>=run_row.opening_date)then
  raise exception 'No se puede reversar la apertura: existe una conciliación bancaria cerrada posterior o igual a la fecha de apertura.';
 end if;
 if exists(select 1 from public.opening_bank_accounts account join public.quadratic_bank_reconciliations reconciliation using(bank_account_id)
  where account.run_id=p_run_id and reconciliation.status in('approved','closed')
   and(make_date(reconciliation.period_year,reconciliation.period_month,1)+interval'1 month'-interval'1 day')::date>=run_row.opening_date)then
  raise exception 'No se puede reversar la apertura: existe una prueba de efectivo aprobada o cerrada posterior.';
 end if;
 if exists(select 1 from public.opening_bank_accounts account join public.opening_bank_items item on item.opening_bank_account_id=account.id
  join public.bank_reconciliation_match m on m.bank_tran_id=item.created_bank_tran_id where account.run_id=p_run_id)
  or exists(select 1 from public.opening_bank_accounts account join public.opening_bank_items item on item.opening_bank_account_id=account.id
  join public.quadratic_reconciliation_matches m on m.bank_tran_id=item.created_bank_tran_id where account.run_id=p_run_id)then
  raise exception 'No se puede reversar la apertura: existen partidas iniciales ya conciliadas con un extracto.';
 end if;
 if exists(select 1 from public.opening_bank_accounts account join public.opening_bank_items item on item.opening_bank_account_id=account.id
  join public.quadratic_reconciliation_items adjustment on adjustment.bank_tran_id=item.created_bank_tran_id where account.run_id=p_run_id)then
  raise exception 'No se puede reversar la apertura: existen partidas iniciales utilizadas en una prueba de efectivo.';
 end if;
 if exists(select 1 from public.opening_bank_accounts account join public.bank_transaction movement using(bank_account_id)
  where account.run_id=p_run_id and movement.tran_date>=run_row.opening_date
   and not exists(select 1 from public.opening_bank_items item join public.opening_bank_accounts source on source.id=item.opening_bank_account_id
    where item.id=movement.opening_bank_item_id and source.run_id=p_run_id))then
  raise exception 'No se puede reversar la apertura: existen movimientos bancarios posteriores.';
 end if;
 result:=public.opening_balance_reverse_before_opening_bank(p_run_id);
 select count(*)into reversed_count from public.opening_bank_items item join public.opening_bank_accounts account on account.id=item.opening_bank_account_id
  where account.run_id=p_run_id and item.created_bank_tran_id is not null;
 perform 1 from public.bank_account account where account.bank_account_id in(select bank_account_id from public.opening_bank_accounts where run_id=p_run_id)
  order by account.bank_account_id for update;
 perform set_config('app.opening_bank_internal','1',true);
 delete from public.bank_transaction movement using public.opening_bank_items item,public.opening_bank_accounts account
  where movement.opening_bank_item_id=item.id and item.opening_bank_account_id=account.id and account.run_id=p_run_id;
 update public.opening_bank_accounts set is_active=false,opening_reversed_at=now(),updated_at=now(),updated_by=public.app_user_id()where run_id=p_run_id;
 update public.bank_account account set balance=coalesce((select sum(movement.amount)from public.bank_transaction movement where movement.bank_account_id=account.bank_account_id),0)
  where account.bank_account_id in(select bank_account_id from public.opening_bank_accounts where run_id=p_run_id);
 perform set_config('app.opening_bank_internal','',true);
 return result||jsonb_build_object('bankItemsReversed',reversed_count);
end$$;

create or replace function public.protect_opening_bank_transaction()returns trigger
language plpgsql security definer set search_path=public,pg_temp as $$
begin
 if coalesce(current_setting('app.opening_bank_internal',true),'')='1'then
  return case when tg_op='DELETE'then old else new end;
 end if;
 if tg_op='INSERT'then
  if coalesce(new.is_opening_balance,false)or new.opening_bank_item_id is not null or new.opening_balance_line_id is not null then
   raise exception 'Los movimientos del Auxiliar de Bancos solo pueden crearse desde la contabilización de saldos iniciales.';
  end if;
  return new;
 end if;
 if tg_op='DELETE'then
  if coalesce(old.is_opening_balance,false)or old.opening_bank_item_id is not null or old.opening_balance_line_id is not null then
   raise exception 'Los movimientos del Auxiliar de Bancos solo se eliminan desde la reversión de saldos iniciales.';
  end if;
  return old;
 end if;
 if coalesce(old.is_opening_balance,false)or coalesce(new.is_opening_balance,false)
   or old.opening_bank_item_id is not null or new.opening_bank_item_id is not null
   or old.opening_balance_line_id is not null or new.opening_balance_line_id is not null then
  if old.tran_type in('DEPOSITO_EN_TRANSITO','CHEQUE_EN_TRANSITO')
    and(to_jsonb(new)-array['reconciliation_status','value_date'])=(to_jsonb(old)-array['reconciliation_status','value_date'])then
   return new;
  end if;
  raise exception 'Los movimientos del Auxiliar de Bancos solo se modifican al conciliarlos o desde la reversión de saldos iniciales.';
 end if;
 return new;
end$$;
drop trigger if exists protect_opening_bank_transaction_trigger on public.bank_transaction;
create trigger protect_opening_bank_transaction_trigger before insert or update or delete on public.bank_transaction
for each row execute function public.protect_opening_bank_transaction();

-- The cleared opening balance is already reconciled and must never be paired
-- with a statement line. Opening deposits/checks in transit remain eligible.
create or replace function public.prevent_opening_balance_match()returns trigger
language plpgsql security definer set search_path=public,pg_temp as $$
begin
 if exists(select 1 from public.bank_transaction movement where movement.bank_tran_id=new.bank_tran_id and movement.tran_type='SALDO_INICIAL')then
  raise exception 'El saldo bancario inicial conciliado no se puede emparejar con una línea del extracto.';
 end if;
 return new;
end$$;
drop trigger if exists prevent_opening_balance_match_trigger on public.bank_reconciliation_match;
create trigger prevent_opening_balance_match_trigger before insert or update of bank_tran_id on public.bank_reconciliation_match
for each row execute function public.prevent_opening_balance_match();

drop trigger if exists prevent_opening_balance_quadratic_match_trigger on public.quadratic_reconciliation_matches;
create trigger prevent_opening_balance_quadratic_match_trigger before insert or update of bank_tran_id on public.quadratic_reconciliation_matches
for each row execute function public.prevent_opening_balance_match();

drop trigger if exists prevent_opening_balance_quadratic_item_trigger on public.quadratic_reconciliation_items;
create trigger prevent_opening_balance_quadratic_item_trigger before insert or update of bank_tran_id on public.quadratic_reconciliation_items
for each row execute function public.prevent_opening_balance_match();

-- Every row supplied by the initial bank auxiliary belongs to the opening
-- book balance, even when its transaction date falls inside the first month.
create or replace function public.quadratic_book_values(p_bank_account_id bigint,p_year integer,p_month integer)
returns table(start_balance numeric,receipts numeric,disbursements numeric,end_balance numeric)
language sql stable security definer set search_path=public,pg_temp as $$
 with bounds as(
  select make_date(p_year,p_month,1)d1,(make_date(p_year,p_month,1)+interval'1 month')::date d2
 ),v as(
  select
   coalesce(sum(b.amount)filter(where b.tran_date<x.d1 or(coalesce(b.is_opening_balance,false)and b.tran_date>=x.d1 and b.tran_date<x.d2)),0)::numeric start_balance,
   coalesce(sum(greatest(b.amount,0))filter(where not coalesce(b.is_opening_balance,false)and b.tran_date>=x.d1 and b.tran_date<x.d2),0)::numeric receipts,
   coalesce(sum(greatest(-b.amount,0))filter(where not coalesce(b.is_opening_balance,false)and b.tran_date>=x.d1 and b.tran_date<x.d2),0)::numeric disbursements
  from bounds x left join public.bank_transaction b on b.bank_account_id=p_bank_account_id and b.tran_date<x.d2
  group by x.d1,x.d2
 )select start_balance,receipts,disbursements,start_balance+receipts-disbursements from v
$$;

-- Hide the technical cleared balance from reconciliation rows. Unmatched
-- opening deposits/checks remain visible in WORKSPACE after their original
-- period so they can be cleared against a later statement.
create or replace function public.run_bank_reconciliation_report(p_filters jsonb default '{}'::jsonb)
returns jsonb language plpgsql stable security definer set search_path=public,pg_temp as $$
declare account_key bigint;date_from date;date_to date;mode text;page_no int;page_size int;result jsonb;
begin
 account_key:=nullif(p_filters->>'bankAccountId','')::bigint;
 date_from:=nullif(p_filters->>'dateFrom','')::date;date_to:=nullif(p_filters->>'dateTo','')::date;
 mode:=coalesce(nullif(p_filters->>'bankView',''),'AUXILIARY');
 page_no:=greatest(coalesce((p_filters->>'page')::int,1),1);page_size:=least(greatest(coalesce((p_filters->>'pageSize')::int,50),10),250);
 if account_key is null or not exists(select 1 from public.bank_account ba join public.user_subsidiaries u using(subsidiary_id)
  where ba.bank_account_id=account_key and u.user_id=public.app_user_id())then raise exception 'Seleccione una cuenta bancaria autorizada.';end if;
 if date_from is null or date_to is null then raise exception 'El rango de fechas es obligatorio.';end if;
 with movements as(
  select bt.bank_tran_id id,bt.tran_date date,coalesce(bt.value_date,bt.tran_date)value_date,bt.reconciliation_status,
   coalesce(tt.abbreviation,bt.tran_type)transaction_type,coalesce(bt.reference_number,t.tran_number)reference,
   coalesce(bt.beneficiary,c.company_name,s.company_name,e.first_name||' '||e.last_name,'—')beneficiary,
   coalesce(nullif(bt.description,''),tt.name,bt.tran_type)description,
   coalesce(nullif(j.memo,''),notes.line_notes,nullif(bt.description,''),'Sin nota registrada')note,
   greatest(bt.amount,0)deposits,greatest(-bt.amount,0)withdrawals,
   coalesce((select sum(previous.amount)from public.bank_transaction previous where previous.bank_account_id=account_key
    and(previous.tran_date<bt.tran_date or previous.tran_date=bt.tran_date and previous.bank_tran_id<=bt.bank_tran_id)),0)running_balance,
   count(*)over()total_count
  from public.bank_transaction bt left join public."transaction"t using(transaction_id)
  left join public.transaction_types tt using(transaction_type_id)left join public.customers c on c.customer_id=t.customer_id
  left join public.suppliers s on s.supplier_id=t.supplier_id left join public.journal j using(transaction_id)
  left join lateral(select string_agg(distinct nullif(trim(jl.note),''),' · ')line_notes,max(jl.employee_id)employee_id
   from public.journal_line jl where jl.journal_id=j.journal_id)notes on true left join public.employees e on e.employee_id=notes.employee_id
  where bt.bank_account_id=account_key and bt.tran_type<>'SALDO_INICIAL'and(
   bt.tran_date between date_from and date_to or(
    mode='WORKSPACE'and coalesce(bt.is_opening_balance,false)
    and bt.tran_type in('DEPOSITO_EN_TRANSITO','CHEQUE_EN_TRANSITO')
    and bt.reconciliation_status='PENDIENTE_EN_TRANSITO'and bt.tran_date<date_from and bt.tran_date<=date_to
   )
  )
 ),paged as(select*from movements order by date,id limit page_size offset(page_no-1)*page_size),
 latest_statement as(select*from public.bank_statement where bank_account_id=account_key and statement_date<=date_to order by statement_date desc limit 1),
 latest_reconciliation as(select*from public.bank_reconciliation where bank_account_id=account_key and reconciliation_date<=date_to order by reconciliation_date desc limit 1)
 select jsonb_build_object(
  'rows',coalesce((select jsonb_agg(to_jsonb(p)-'total_count')from paged p),'[]'::jsonb),
  'total',coalesce((select max(total_count)from movements),0),'page',page_no,'pageSize',page_size,
  'statementLines',coalesce((select jsonb_agg(to_jsonb(sl)order by sl.bank_date,sl.statement_line_id)from latest_statement bs join public.bank_statement_line sl using(statement_id)),'[]'::jsonb),
  'reconciliation',coalesce((select to_jsonb(r)from latest_reconciliation r),'{}'::jsonb),
  'summary',jsonb_build_object(
   'bookBalance',coalesce((select sum(amount)from public.bank_transaction where bank_account_id=account_key and tran_date<=date_to),0),
   'openingBalance',coalesce((select sum(amount)from public.bank_transaction where bank_account_id=account_key and is_opening_balance and tran_date<=date_to),0),
   'statementBalance',coalesce((select closing_balance from latest_statement),0),
   'transitPayments',coalesce((select sum(greatest(-bt.amount,0))from public.bank_transaction bt where bt.bank_account_id=account_key
    and bt.tran_date<=date_to and bt.reconciliation_status='PENDIENTE_EN_TRANSITO'and bt.tran_type<>'SALDO_INICIAL'),0),
   'transitDeposits',coalesce((select sum(greatest(bt.amount,0))from public.bank_transaction bt where bt.bank_account_id=account_key
    and bt.tran_date<=date_to and bt.reconciliation_status='PENDIENTE_EN_TRANSITO'and bt.tran_type<>'SALDO_INICIAL'),0)
  )
 )into result;
 return result;
end$$;

create or replace function public.auto_match_bank_reconciliation(p_bank_account_id bigint,p_cutoff date)
returns integer language plpgsql security definer set search_path=public,pg_temp as $$
declare rec_id bigint;matched integer:=0;r record;
begin
 rec_id:=public.ensure_open_bank_reconciliation(p_bank_account_id,p_cutoff);
 for r in
  select bt.bank_tran_id,sl.statement_line_id from public.bank_transaction bt
  join public.bank_statement bs on bs.bank_account_id=bt.bank_account_id and bs.statement_date=p_cutoff
  join public.bank_statement_line sl using(statement_id)
  where bt.bank_account_id=p_bank_account_id and bt.tran_date<=p_cutoff and bt.tran_type<>'SALDO_INICIAL'
   and bt.reconciliation_status<>'CONCILIADO'and sl.reconciliation_status<>'CONCILIADO'
   and abs(bt.amount-sl.amount)<.005 and abs(bt.tran_date-sl.bank_date)<=3
   and coalesce(lower(bt.reference_number),'')=coalesce(lower(sl.reference),'')
 loop
  insert into public.bank_reconciliation_match(reconciliation_id,bank_tran_id,statement_line_id,match_type,matched_by)
  values(rec_id,r.bank_tran_id,r.statement_line_id,'AUTOMATICO',public.app_user_id())on conflict do nothing;
  if found then
   update public.bank_transaction set reconciliation_status='CONCILIADO',value_date=(select bank_date from public.bank_statement_line where statement_line_id=r.statement_line_id)
    where bank_tran_id=r.bank_tran_id;
   update public.bank_statement_line set reconciliation_status='CONCILIADO'where statement_line_id=r.statement_line_id;
   matched:=matched+1;
  end if;
 end loop;
 return matched;
end$$;

create or replace function public.match_bank_transaction(p_bank_tran_id bigint,p_statement_line_id bigint,p_cutoff date)
returns bigint language plpgsql security definer set search_path=public,pg_temp as $$
declare rec_id bigint;account_key bigint;new_id bigint;movement_type text;
begin
 select bank_account_id,tran_type into account_key,movement_type from public.bank_transaction where bank_tran_id=p_bank_tran_id;
 if account_key is null then raise exception 'El movimiento del ERP seleccionado no existe.';end if;
 if movement_type='SALDO_INICIAL'then raise exception 'El saldo bancario inicial conciliado no se puede emparejar con una línea del extracto.';end if;
 if not exists(select 1 from public.bank_statement_line sl join public.bank_statement bs using(statement_id)
  where sl.statement_line_id=p_statement_line_id and bs.bank_account_id=account_key)then
  raise exception 'El movimiento del extracto pertenece a otra cuenta bancaria.';
 end if;
 rec_id:=public.ensure_open_bank_reconciliation(account_key,p_cutoff);
 insert into public.bank_reconciliation_match(reconciliation_id,bank_tran_id,statement_line_id,match_type,matched_by)
 values(rec_id,p_bank_tran_id,p_statement_line_id,'MANUAL',public.app_user_id())returning match_id into new_id;
 update public.bank_transaction set reconciliation_status='CONCILIADO',value_date=(select bank_date from public.bank_statement_line where statement_line_id=p_statement_line_id)
  where bank_tran_id=p_bank_tran_id;
 update public.bank_statement_line set reconciliation_status='CONCILIADO'where statement_line_id=p_statement_line_id;
 return new_id;
end$$;

create or replace function public.close_bank_reconciliation(p_bank_account_id bigint,p_cutoff date,p_bank_adjustments numeric default 0)
returns bigint language plpgsql security definer set search_path=public,pg_temp as $$
declare rec_id bigint;books numeric;statement numeric;checks numeric;deposits numeric;diff numeric;
begin
 perform public.auto_match_bank_reconciliation(p_bank_account_id,p_cutoff);
 rec_id:=public.ensure_open_bank_reconciliation(p_bank_account_id,p_cutoff);
 select coalesce(sum(amount),0)into books from public.bank_transaction where bank_account_id=p_bank_account_id and tran_date<=p_cutoff;
 select closing_balance into statement from public.bank_statement where bank_account_id=p_bank_account_id and statement_date=p_cutoff;
 if statement is null then raise exception 'No existe un extracto bancario importado para la fecha de conciliación seleccionada.';end if;
 select coalesce(sum(greatest(-amount,0)),0),coalesce(sum(greatest(amount,0)),0)into checks,deposits
 from public.bank_transaction where bank_account_id=p_bank_account_id and tran_date<=p_cutoff
  and reconciliation_status='PENDIENTE_EN_TRANSITO'and tran_type<>'SALDO_INICIAL';
 diff:=(books+checks-deposits+coalesce(p_bank_adjustments,0))-statement;
 if abs(diff)>=.005 then raise exception 'La conciliación todavía presenta una diferencia de %. Revise los movimientos pendientes antes de finalizar.',to_char(abs(diff),'FM999G999G999G990D00');end if;
 update public.bank_reconciliation set reconciliation_date=p_cutoff,status='CERRADA',book_balance=books,statement_balance=statement,
  transit_payments=checks,transit_deposits=deposits,bank_adjustments=coalesce(p_bank_adjustments,0),difference=diff,
  closed_at=now(),closed_by=public.app_user_id()where reconciliation_id=rec_id;
 return rec_id;
end$$;

-- Reclassify opening auxiliary movements in the professional closing report.
alter function public.bank_reconciliation_close_report(bigint,date)
 rename to bank_reconciliation_close_report_before_opening_bank;
revoke all on function public.bank_reconciliation_close_report_before_opening_bank(bigint,date)from public,anon,authenticated;

create function public.bank_reconciliation_close_report(p_bank_account_id bigint,p_cutoff date)
returns jsonb language plpgsql stable security definer set search_path=public,pg_temp as $$
declare base jsonb;rec public.bank_reconciliation%rowtype;period_row public.fiscal_periods%rowtype;summary jsonb;movements jsonb;
begin
 base:=public.bank_reconciliation_close_report_before_opening_bank(p_bank_account_id,p_cutoff);
 select *into rec from public.bank_reconciliation where bank_account_id=p_bank_account_id and reconciliation_date=p_cutoff and status='CERRADA';
 select *into period_row from public.fiscal_periods where fiscal_period_id=rec.fiscal_period_id;
 summary:=(base->'summary')||jsonb_build_object(
  'openingBalance',coalesce((select sum(bt.amount)from public.bank_transaction bt where bt.bank_account_id=p_bank_account_id
   and bt.tran_date<=rec.reconciliation_date and(bt.tran_date<period_row.start_date or coalesce(bt.is_opening_balance,false))),0),
  'entries',coalesce((select sum(greatest(bt.amount,0))from public.bank_transaction bt where bt.bank_account_id=p_bank_account_id
   and bt.tran_date between period_row.start_date and rec.reconciliation_date and not coalesce(bt.is_opening_balance,false)),0),
  'exits',coalesce((select sum(greatest(-bt.amount,0))from public.bank_transaction bt where bt.bank_account_id=p_bank_account_id
   and bt.tran_date between period_row.start_date and rec.reconciliation_date and not coalesce(bt.is_opening_balance,false)),0)
 );
 select coalesce(jsonb_agg(row_value order by(row_value->>'date')::date,(row_value->>'id')::bigint),'[]'::jsonb)into movements
 from jsonb_array_elements(coalesce(base->'movements','[]'::jsonb))as rows(row_value)
 where not exists(select 1 from public.bank_transaction bt where bt.bank_tran_id=(row_value->>'id')::bigint and bt.is_opening_balance);
 return base||jsonb_build_object('summary',summary,'movements',movements);
end$$;

-- A book movement or statement row may be paired only once across all
-- quadratic periods. The original constraint was scoped to one period.
create or replace function public.quadratic_validate_match()returns trigger
language plpgsql security definer set search_path=public,pg_temp as $$
declare r public.quadratic_bank_reconciliations%rowtype;
begin
 select *into r from public.quadratic_bank_reconciliations where reconciliation_id=coalesce(new.reconciliation_id,old.reconciliation_id);
 if r.reconciliation_id is null or r.status not in('draft','in_review')then raise exception 'El punteo no se puede modificar en el estado actual.';end if;
 if tg_op='DELETE'then return old;end if;
 if not exists(select 1 from public.bank_transaction b where b.bank_tran_id=new.bank_tran_id
  and b.bank_account_id=r.bank_account_id and b.tran_type<>'SALDO_INICIAL')then
  raise exception 'El movimiento contable no pertenece a la cuenta bancaria o corresponde al saldo inicial técnico.';
 end if;
 if not exists(select 1 from public.bank_statement_line l join public.bank_statement s using(statement_id)
  where l.statement_line_id=new.statement_line_id and s.bank_account_id=r.bank_account_id)then
  raise exception 'El movimiento del extracto pertenece a otra cuenta bancaria.';
 end if;
 if exists(select 1 from public.quadratic_reconciliation_matches m
  where m.match_id is distinct from new.match_id and(m.bank_tran_id=new.bank_tran_id or m.statement_line_id=new.statement_line_id))then
  raise exception 'Uno de los movimientos ya fue punteado en otra prueba de efectivo.';
 end if;
 return new;
end$$;

create or replace function public.quadratic_reconciliation_match(p_reconciliation_id bigint,p_bank_tran_id bigint,p_statement_line_id bigint)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare r public.quadratic_bank_reconciliations%rowtype;bt public.bank_transaction%rowtype;sl public.bank_statement_line%rowtype;key bigint;
begin
 select *into r from public.quadratic_bank_reconciliations where reconciliation_id=p_reconciliation_id for update;
 if r.reconciliation_id is null or not public.quadratic_can(r.subsidiary_id,'BANK_QUADRATIC_MANAGE')then
  raise exception using errcode='42501',message='Conciliación no encontrada o no autorizada.';
 end if;
 if r.status not in('draft','in_review')then raise exception 'El punteo solo se modifica en borrador o revisión.';end if;
 select *into bt from public.bank_transaction where bank_tran_id=p_bank_tran_id and bank_account_id=r.bank_account_id;
 select l.*into sl from public.bank_statement_line l join public.bank_statement s using(statement_id)
  where l.statement_line_id=p_statement_line_id and s.bank_account_id=r.bank_account_id;
 if bt.bank_tran_id is null or sl.statement_line_id is null then raise exception 'Seleccione movimientos de la misma cuenta bancaria.';end if;
 if bt.tran_type='SALDO_INICIAL'then raise exception 'El saldo bancario inicial conciliado no se puede puntear contra el extracto.';end if;
 if round(bt.amount-sl.amount,2)<>0 then raise exception 'Los importes seleccionados no coinciden.';end if;
 if exists(select 1 from public.quadratic_reconciliation_matches m
  where m.bank_tran_id=p_bank_tran_id or m.statement_line_id=p_statement_line_id)then
  raise exception 'Uno de los movimientos ya fue punteado en otra prueba de efectivo.';
 end if;
 if exists(select 1 from public.quadratic_reconciliation_items item where item.reconciliation_id=p_reconciliation_id
  and(item.bank_tran_id=p_bank_tran_id or item.statement_line_id=p_statement_line_id))then
  raise exception 'Una partida de ajuste ya utiliza uno de los movimientos.';
 end if;
 insert into public.quadratic_reconciliation_matches(reconciliation_id,bank_tran_id,statement_line_id,match_type,matched_by)
 values(p_reconciliation_id,p_bank_tran_id,p_statement_line_id,'MANUAL',public.app_user_id())returning match_id into key;
 return jsonb_build_object('success',true,'id',key);
end$$;

create or replace function public.quadratic_reconciliation_auto_match(p_reconciliation_id bigint,p_tolerance_days integer default 3)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare r public.quadratic_bank_reconciliations%rowtype;row_value record;matched integer:=0;d1 date;d2 date;
begin
 if p_tolerance_days not between 0 and 31 then raise exception 'La tolerancia debe estar entre 0 y 31 días.';end if;
 select *into r from public.quadratic_bank_reconciliations where reconciliation_id=p_reconciliation_id for update;
 if r.reconciliation_id is null or not public.quadratic_can(r.subsidiary_id,'BANK_QUADRATIC_MANAGE')then
  raise exception using errcode='42501',message='Conciliación no encontrada o no autorizada.';
 end if;
 if r.status not in('draft','in_review')then raise exception 'El punteo solo se modifica en borrador o revisión.';end if;
 d1:=make_date(r.period_year,r.period_month,1);d2:=(d1+interval'1 month')::date;
 for row_value in
  select bt.bank_tran_id,sl.statement_line_id from public.bank_transaction bt
  join lateral(
   select sl.statement_line_id from public.bank_statement s join public.bank_statement_line sl using(statement_id)
   where s.bank_account_id=r.bank_account_id and s.statement_date>=d1 and s.statement_date<d2
    and abs(sl.amount-bt.amount)<.005 and abs(sl.bank_date-bt.tran_date)<=p_tolerance_days
    and nullif(lower(trim(sl.reference)),'')=nullif(lower(trim(bt.reference_number)),'')
    and not exists(select 1 from public.quadratic_reconciliation_matches m where m.statement_line_id=sl.statement_line_id)
    and not exists(select 1 from public.quadratic_reconciliation_items item
     where item.reconciliation_id=r.reconciliation_id and item.statement_line_id=sl.statement_line_id)
   order by abs(sl.bank_date-bt.tran_date),sl.statement_line_id limit 1
  )sl on true
  where bt.bank_account_id=r.bank_account_id and bt.tran_type<>'SALDO_INICIAL'and(
   bt.tran_date>=d1 and bt.tran_date<d2 or(
    coalesce(bt.is_opening_balance,false)and bt.tran_type in('DEPOSITO_EN_TRANSITO','CHEQUE_EN_TRANSITO')
    and bt.tran_date<d1 and bt.reconciliation_status='PENDIENTE_EN_TRANSITO'
   )
  )and nullif(trim(bt.reference_number),'')is not null
   and not exists(select 1 from public.quadratic_reconciliation_matches m where m.bank_tran_id=bt.bank_tran_id)
   and not exists(select 1 from public.quadratic_reconciliation_items item
    where item.reconciliation_id=r.reconciliation_id and item.bank_tran_id=bt.bank_tran_id)
  order by bt.tran_date,bt.bank_tran_id
 loop
  begin
   insert into public.quadratic_reconciliation_matches(reconciliation_id,bank_tran_id,statement_line_id,match_type,matched_by)
   values(r.reconciliation_id,row_value.bank_tran_id,row_value.statement_line_id,'AUTOMATIC',public.app_user_id());
   matched:=matched+1;
  exception when unique_violation then null;end;
 end loop;
 return jsonb_build_object('success',true,'matched',matched);
end$$;

alter function public.quadratic_reconciliation_get(bigint)
 rename to quadratic_reconciliation_get_before_opening_bank;
revoke all on function public.quadratic_reconciliation_get_before_opening_bank(bigint)from public,anon,authenticated;

create function public.quadratic_reconciliation_get(p_reconciliation_id bigint)returns jsonb
language plpgsql stable security definer set search_path=public,pg_temp as $$
declare base jsonb;r public.quadratic_bank_reconciliations%rowtype;d1 date;d2 date;book_transactions jsonb;
begin
 base:=public.quadratic_reconciliation_get_before_opening_bank(p_reconciliation_id);
 select *into r from public.quadratic_bank_reconciliations where reconciliation_id=p_reconciliation_id;
 d1:=make_date(r.period_year,r.period_month,1);d2:=(d1+interval'1 month')::date;
 select coalesce(jsonb_agg(jsonb_build_object(
  'id',b.bank_tran_id,'date',b.tran_date,'valueDate',b.value_date,'reference',b.reference_number,
  'description',b.description,'beneficiary',b.beneficiary,'amount',b.amount,'matchId',m.match_id
 )order by b.tran_date,b.bank_tran_id),'[]'::jsonb)into book_transactions
 from public.bank_transaction b left join public.quadratic_reconciliation_matches m
  on m.reconciliation_id=r.reconciliation_id and m.bank_tran_id=b.bank_tran_id
 where b.bank_account_id=r.bank_account_id and b.tran_type<>'SALDO_INICIAL'and(
  b.tran_date>=d1 and b.tran_date<d2 or(
   coalesce(b.is_opening_balance,false)and b.tran_type in('DEPOSITO_EN_TRANSITO','CHEQUE_EN_TRANSITO')
   and b.tran_date<d1 and b.reconciliation_status='PENDIENTE_EN_TRANSITO'
  )
 )and not exists(select 1 from public.quadratic_reconciliation_matches prior_match
  where prior_match.bank_tran_id=b.bank_tran_id and prior_match.reconciliation_id<>r.reconciliation_id);
 return jsonb_set(base,'{bookTransactions}',book_transactions,true);
end$$;

revoke all on table public.opening_bank_accounts,public.opening_bank_items,public.opening_bank_gl_links from public,anon,authenticated;
grant select on table public.opening_bank_accounts,public.opening_bank_items,public.opening_bank_gl_links to authenticated;

revoke all on function public.opening_bank_reconciliation(bigint),public.opening_bank_assert_reconciled(bigint),
 public.opening_bank_stage(bigint,jsonb),public.opening_bank_activate(bigint),
 public.protect_opening_bank_transaction(),public.prevent_opening_balance_match(),
 public.quadratic_book_values(bigint,integer,integer),public.quadratic_validate_match()
from public,anon,authenticated;

revoke all on function public.opening_balance_options(),public.opening_balance_preview(bigint),public.opening_balance_validate(jsonb),
 public.opening_balance_post(bigint),public.opening_balance_reverse(bigint),public.run_bank_reconciliation_report(jsonb),
 public.auto_match_bank_reconciliation(bigint,date),public.match_bank_transaction(bigint,bigint,date),
 public.close_bank_reconciliation(bigint,date,numeric),public.bank_reconciliation_close_report(bigint,date),
 public.quadratic_reconciliation_get(bigint),public.quadratic_reconciliation_match(bigint,bigint,bigint),
 public.quadratic_reconciliation_auto_match(bigint,integer)
from public,anon;

grant execute on function public.opening_balance_options(),public.opening_balance_preview(bigint),public.opening_balance_validate(jsonb),
 public.opening_balance_post(bigint),public.opening_balance_reverse(bigint),public.run_bank_reconciliation_report(jsonb),
 public.auto_match_bank_reconciliation(bigint,date),public.match_bank_transaction(bigint,bigint,date),
 public.close_bank_reconciliation(bigint,date,numeric),public.bank_reconciliation_close_report(bigint,date),
 public.quadratic_reconciliation_get(bigint),public.quadratic_reconciliation_match(bigint,bigint,bigint),
 public.quadratic_reconciliation_auto_match(bigint,integer)
to authenticated;

notify pgrst,'reload schema';
