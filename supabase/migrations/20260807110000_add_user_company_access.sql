create table if not exists public.user_subsidiaries(
  id bigint generated always as identity primary key,
  user_id bigint not null references public.users(user_id) on delete cascade,
  subsidiary_id bigint not null references public.subsidiaries(subsidiary_id) on delete cascade,
  unique(user_id,subsidiary_id)
);
create table if not exists public.user_company_sessions(
  session_id text primary key,
  user_id bigint not null references public.users(user_id) on delete cascade,
  subsidiary_id bigint not null references public.subsidiaries(subsidiary_id) on delete cascade,
  selected_at timestamptz not null default now()
);
insert into public.users(email,password_hash,first_name,last_name,is_active) values('demo@nexo.com','auth:managed-by-supabase','Administrador','Nexo',true) on conflict(email) do update set is_active=true;
insert into public.user_subsidiaries(user_id,subsidiary_id) select u.user_id,s.subsidiary_id from public.users u cross join public.subsidiaries s where lower(u.email)='demo@nexo.com' and s.is_active=true on conflict do nothing;
insert into public.user_subsidiaries(user_id,subsidiary_id) select distinct e.user_id,e.subsidiary_id from public.employees e where e.user_id is not null on conflict do nothing;
create or replace function public.app_user_id() returns bigint language sql stable security definer set search_path=public as $$select user_id from public.users where lower(email)=lower(coalesce(auth.jwt()->>'email','')) limit 1$$;
create or replace function public.app_session_id() returns text language sql stable as $$select coalesce(auth.jwt()->>'session_id',auth.jwt()->>'sub')$$;
create or replace function public.active_subsidiary_id() returns bigint language sql stable security definer set search_path=public as $$select subsidiary_id from public.user_company_sessions where session_id=public.app_session_id() and user_id=public.app_user_id() limit 1$$;
grant execute on function public.app_user_id() to authenticated;
grant execute on function public.app_session_id() to authenticated;
grant execute on function public.active_subsidiary_id() to authenticated;
alter table public.user_subsidiaries enable row level security;
alter table public.user_company_sessions enable row level security;
drop policy if exists "user_subsidiaries_access" on public.user_subsidiaries;
drop policy if exists "user_company_sessions_access" on public.user_company_sessions;
create policy "user_subsidiaries_access" on public.user_subsidiaries for all to authenticated using(true) with check(true);
create policy "user_company_sessions_access" on public.user_company_sessions for all to authenticated using(user_id=public.app_user_id()) with check(user_id=public.app_user_id() and exists(select 1 from public.user_subsidiaries us where us.user_id=public.app_user_id() and us.subsidiary_id=user_company_sessions.subsidiary_id));

do $$
declare r record; p record; expression text;
begin
  for r in select * from (values
    ('subsidiaries','subsidiary_id'),('branches','subsidiary_id'),('departments','subsidiary_id'),('classes','subsidiary_id'),('cost_centers','subsidiary_id'),('locations','subsidiary_id'),
    ('fiscal_periods','subsidiary_id'),('tax_agencies','subsidiary_id'),('tax_codes','subsidiary_id'),('tax_groups','subsidiary_id'),('series','subsidiary_id'),('holidays','subsidiary_id'),
    ('accounting_books','subsidiary_id'),('account_subsidiaries','subsidiary_id'),('budget','subsidiary_id'),('allocation_rules','subsidiary_id'),('gl_impact','subsidiary_id'),('journal','subsidiary_id'),
    ('bank_account','subsidiary_id'),('cashbox','subsidiary_id'),('customers','primary_subsidiary_id'),('suppliers','primary_subsidiary_id'),('entity_subsidiaries','subsidiary_id'),('employees','subsidiary_id'),
    ('product_subsidiaries','subsidiary_id'),('item_location_configuration','subsidiary_id'),('price_list','subsidiary_id'),('quotation','subsidiary_id'),('sales_order','subsidiary_id'),('invoice','subsidiary_id'),
    ('transaction','subsidiary_id'),('purchase_requisition','subsidiary_id'),('purchase_order','subsidiary_id'),('supplier_invoice','subsidiary_id'),('expense_policy','subsidiary_id'),('expense','subsidiary_id'),
    ('asset','subsidiary_id'),('approval_matrix','subsidiary_id'),('folders','subsidiary_id'),('ai_prediction','subsidiary_id')
  ) as x(table_name,column_name)
  loop
    if to_regclass('public.'||r.table_name) is null then continue; end if;
    for p in select policyname from pg_policies where schemaname='public' and tablename=r.table_name loop execute format('drop policy %I on public.%I',p.policyname,r.table_name); end loop;
    expression:=case when r.table_name='subsidiaries' then '(subsidiary_id=public.active_subsidiary_id() or (public.active_subsidiary_id() is null and (exists(select 1 from public.user_subsidiaries us where us.user_id=public.app_user_id() and us.subsidiary_id=subsidiaries.subsidiary_id) or (lower(coalesce(auth.jwt()->>''email'',''''))=''demo@nexo.com'' and not exists(select 1 from public.user_subsidiaries us where us.user_id=public.app_user_id())))))' when r.table_name in('tax_agencies','tax_codes','holidays') then format('(%I is null or %I=public.active_subsidiary_id())',r.column_name,r.column_name) else format('%I=public.active_subsidiary_id()',r.column_name) end;
    execute format('create policy "company_select" on public.%I for select to authenticated using(%s)',r.table_name,expression);
    execute format('create policy "company_insert" on public.%I for insert to authenticated with check(%s)',r.table_name,expression);
    execute format('create policy "company_update" on public.%I for update to authenticated using(%s) with check(%s)',r.table_name,expression,expression);
    execute format('create policy "company_delete" on public.%I for delete to authenticated using(%s)',r.table_name,expression);
  end loop;
end$$;

do $$declare r record;p record;begin
  for r in select * from (values
    ('transaction_line','exists(select 1 from public."transaction" h where h.transaction_id=transaction_line.transaction_id and h.subsidiary_id=public.active_subsidiary_id())'),
    ('budget_line','exists(select 1 from public.budget h where h.budget_id=budget_line.budget_id and h.subsidiary_id=public.active_subsidiary_id())'),
    ('journal_line','exists(select 1 from public.journal h where h.journal_id=journal_line.journal_id and h.subsidiary_id=public.active_subsidiary_id())'),
    ('price_list_item','exists(select 1 from public.price_list h where h.price_list_id=price_list_item.price_list_id and h.subsidiary_id=public.active_subsidiary_id())'),
    ('goods_receipt','exists(select 1 from public.purchase_order h where h.po_id=goods_receipt.po_id and h.subsidiary_id=public.active_subsidiary_id())'),
    ('supplier_payment','exists(select 1 from public.bank_account h where h.bank_account_id=supplier_payment.bank_account_id and h.subsidiary_id=public.active_subsidiary_id())'),
    ('supplier_credit_note','exists(select 1 from public.supplier_invoice h where h.invoice_id=supplier_credit_note.invoice_id and h.subsidiary_id=public.active_subsidiary_id())'),
    ('supplier_debit_note','exists(select 1 from public.supplier_invoice h where h.invoice_id=supplier_debit_note.invoice_id and h.subsidiary_id=public.active_subsidiary_id())'),
    ('customer_payment','exists(select 1 from public.bank_account h where h.bank_account_id=customer_payment.bank_account_id and h.subsidiary_id=public.active_subsidiary_id())'),
    ('bank_transaction','exists(select 1 from public.bank_account h where h.bank_account_id=bank_transaction.bank_account_id and h.subsidiary_id=public.active_subsidiary_id())'),
    ('bank_statement','exists(select 1 from public.bank_account h where h.bank_account_id=bank_statement.bank_account_id and h.subsidiary_id=public.active_subsidiary_id())'),
    ('bank_reconciliation','exists(select 1 from public.bank_account h where h.bank_account_id=bank_reconciliation.bank_account_id and h.subsidiary_id=public.active_subsidiary_id())'),
    ('bank_check','exists(select 1 from public.bank_account h where h.bank_account_id=bank_check.bank_account_id and h.subsidiary_id=public.active_subsidiary_id())'),
    ('bank_deposit','exists(select 1 from public.bank_account h where h.bank_account_id=bank_deposit.bank_account_id and h.subsidiary_id=public.active_subsidiary_id())'),
    ('cash_transaction','exists(select 1 from public.cashbox h where h.cashbox_id=cash_transaction.cashbox_id and h.subsidiary_id=public.active_subsidiary_id())'),
    ('cash_opening','exists(select 1 from public.cashbox h where h.cashbox_id=cash_opening.cashbox_id and h.subsidiary_id=public.active_subsidiary_id())'),
    ('cash_closing','exists(select 1 from public.cashbox h where h.cashbox_id=cash_closing.cashbox_id and h.subsidiary_id=public.active_subsidiary_id())'),
    ('expense_line','exists(select 1 from public.expense h where h.expense_id=expense_line.expense_id and h.subsidiary_id=public.active_subsidiary_id())'),
    ('expense_approval','exists(select 1 from public.expense h where h.expense_id=expense_approval.expense_id and h.subsidiary_id=public.active_subsidiary_id())'),
    ('expense_payment','exists(select 1 from public.expense h where h.expense_id=expense_payment.expense_id and h.subsidiary_id=public.active_subsidiary_id())'),
    ('asset_depreciation','exists(select 1 from public.asset h where h.asset_id=asset_depreciation.asset_id and h.subsidiary_id=public.active_subsidiary_id())'),
    ('asset_disposal','exists(select 1 from public.asset h where h.asset_id=asset_disposal.asset_id and h.subsidiary_id=public.active_subsidiary_id())'),
    ('asset_maintenance','exists(select 1 from public.asset h where h.asset_id=asset_maintenance.asset_id and h.subsidiary_id=public.active_subsidiary_id())'),
    ('documents','exists(select 1 from public.folders h where h.folder_id=documents.folder_id and h.subsidiary_id=public.active_subsidiary_id())'),
    ('approval','exists(select 1 from public."transaction" h where h.transaction_id=approval.transaction_id and h.subsidiary_id=public.active_subsidiary_id())')
  )as x(table_name,expression)
  loop
    if to_regclass('public.'||r.table_name) is null then continue;end if;
    for p in select policyname from pg_policies where schemaname='public' and tablename=r.table_name loop execute format('drop policy %I on public.%I',p.policyname,r.table_name);end loop;
    execute format('create policy "company_select" on public.%I for select to authenticated using(%s)',r.table_name,r.expression);
    execute format('create policy "company_insert" on public.%I for insert to authenticated with check(%s)',r.table_name,r.expression);
    execute format('create policy "company_update" on public.%I for update to authenticated using(%s) with check(%s)',r.table_name,r.expression,r.expression);
    execute format('create policy "company_delete" on public.%I for delete to authenticated using(%s)',r.table_name,r.expression);
  end loop;
end$$;

do $$declare p record;begin
  if to_regclass('public.intercompany_eliminations') is not null then
    for p in select policyname from pg_policies where schemaname='public' and tablename='intercompany_eliminations' loop execute format('drop policy %I on public.intercompany_eliminations',p.policyname);end loop;
    create policy "company_select" on public.intercompany_eliminations for select to authenticated using(public.active_subsidiary_id() in(from_subsidiary_id,to_subsidiary_id));
    create policy "company_insert" on public.intercompany_eliminations for insert to authenticated with check(public.active_subsidiary_id() in(from_subsidiary_id,to_subsidiary_id));
    create policy "company_update" on public.intercompany_eliminations for update to authenticated using(public.active_subsidiary_id() in(from_subsidiary_id,to_subsidiary_id)) with check(public.active_subsidiary_id() in(from_subsidiary_id,to_subsidiary_id));
    create policy "company_delete" on public.intercompany_eliminations for delete to authenticated using(public.active_subsidiary_id() in(from_subsidiary_id,to_subsidiary_id));
  end if;
end$$;
