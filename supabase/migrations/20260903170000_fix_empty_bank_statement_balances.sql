update public.bank_statement bs
set closing_balance=coalesce(bs.opening_balance,0)+lines.net_amount
from (
  select sl.statement_id,sum(sl.amount) net_amount
  from public.bank_statement_line sl
  group by sl.statement_id
) lines
where lines.statement_id=bs.statement_id
  and bs.closing_balance=0
  and lines.net_amount<>0
  and bs.statement_date=date '2026-09-02'
  and exists (
    select 1 from public.bank_account ba
    where ba.bank_account_id=bs.bank_account_id
      and ba.account_number='002094351433'
  );

notify pgrst,'reload schema';
