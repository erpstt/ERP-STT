create or replace function public.bank_reconciliation_options()
returns jsonb language sql stable security definer set search_path=public,pg_temp as $$
with allowed_accounts as(
 select ba.bank_account_id,ba.account_number,ba.subsidiary_id,ba.currency_id,b.bank_id,b.bank_name,c.currency_code,c.symbol
 from bank_account ba join banks b using(bank_id)join currencies c using(currency_id)join user_subsidiaries u using(subsidiary_id)where u.user_id=app_user_id()
)
select jsonb_build_object(
 'accounts',coalesce((select jsonb_agg(jsonb_build_object('id',a.bank_account_id,'number',a.account_number,'name',a.bank_name||' - '||a.account_number,'bankId',a.bank_id,'bankName',a.bank_name,'subsidiaryId',a.subsidiary_id,'currencyId',a.currency_id,'currencyCode',a.currency_code,'currencySymbol',a.symbol)order by a.bank_name,a.account_number)from allowed_accounts a),'[]'::jsonb),
 'reconciliations',coalesce((select jsonb_agg(jsonb_build_object('id',r.reconciliation_id,'bankAccountId',r.bank_account_id,'accountNumber',a.account_number,'bankName',a.bank_name,'currencyCode',a.currency_code,'currencySymbol',a.symbol,'date',r.reconciliation_date,'period',fp.period_name,'status',r.status,'bookBalance',r.book_balance,'statementBalance',r.statement_balance,'transitPayments',r.transit_payments,'transitDeposits',r.transit_deposits,'adjustments',r.bank_adjustments,'difference',r.difference,'closedAt',r.closed_at,'closedBy',case when r.closed_by is null then null else coalesce(nullif(concat_ws(' ',u.first_name,u.last_name),''),u.email,'Sistema')end)order by r.reconciliation_date desc,r.reconciliation_id desc)from bank_reconciliation r join allowed_accounts a using(bank_account_id)join fiscal_periods fp using(fiscal_period_id)left join users u on u.user_id=r.closed_by),'[]'::jsonb)
)$$;
grant execute on function public.bank_reconciliation_options()to authenticated;
notify pgrst,'reload schema';
