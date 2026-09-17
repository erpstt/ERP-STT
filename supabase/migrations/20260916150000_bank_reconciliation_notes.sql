create or replace function public.run_bank_reconciliation_report(p_filters jsonb default '{}'::jsonb)
returns jsonb language plpgsql stable security definer set search_path=public as $$
declare account_key bigint;date_from date;date_to date;mode text;page_no int;page_size int;result jsonb;
begin
 account_key:=nullif(p_filters->>'bankAccountId','')::bigint;date_from:=nullif(p_filters->>'dateFrom','')::date;date_to:=nullif(p_filters->>'dateTo','')::date;mode:=coalesce(nullif(p_filters->>'bankView',''),'AUXILIARY');page_no:=greatest(coalesce((p_filters->>'page')::int,1),1);page_size:=least(greatest(coalesce((p_filters->>'pageSize')::int,50),10),250);
 if account_key is null or not exists(select 1 from bank_account ba join user_subsidiaries u using(subsidiary_id)where ba.bank_account_id=account_key and u.user_id=app_user_id())then raise exception'Seleccione una cuenta bancaria autorizada.';end if;
 if date_from is null or date_to is null then raise exception'El rango de fechas es obligatorio.';end if;
 with movements as(
  select bt.bank_tran_id id,bt.tran_date date,coalesce(bt.value_date,bt.tran_date)value_date,bt.reconciliation_status,coalesce(tt.abbreviation,bt.tran_type)transaction_type,coalesce(bt.reference_number,t.tran_number)reference,coalesce(bt.beneficiary,c.company_name,s.company_name,e.first_name||' '||e.last_name,'—')beneficiary,
   coalesce(nullif(bt.description,''),tt.name,bt.tran_type)description,coalesce(nullif(j.memo,''),notes.line_notes,nullif(bt.description,''),'Sin nota registrada')note,
   greatest(bt.amount,0)deposits,greatest(-bt.amount,0)withdrawals,
   coalesce((select sum(previous.amount)from bank_transaction previous where previous.bank_account_id=account_key and(previous.tran_date<bt.tran_date or previous.tran_date=bt.tran_date and previous.bank_tran_id<=bt.bank_tran_id)),0)running_balance,count(*)over()total_count
  from bank_transaction bt left join"transaction"t using(transaction_id)left join transaction_types tt using(transaction_type_id)left join customers c on c.customer_id=t.customer_id left join suppliers s on s.supplier_id=t.supplier_id left join journal j using(transaction_id)
  left join lateral(select string_agg(distinct nullif(trim(jl.note),''),' · ')line_notes,max(jl.employee_id)employee_id from journal_line jl where jl.journal_id=j.journal_id)notes on true left join employees e on e.employee_id=notes.employee_id
  where bt.bank_account_id=account_key and bt.tran_date between date_from and date_to
 ),paged as(select*from movements order by date,id limit page_size offset(page_no-1)*page_size),latest_statement as(select*from bank_statement where bank_account_id=account_key and statement_date<=date_to order by statement_date desc limit 1),latest_reconciliation as(select*from bank_reconciliation where bank_account_id=account_key and reconciliation_date<=date_to order by reconciliation_date desc limit 1)
 select jsonb_build_object('rows',coalesce((select jsonb_agg(to_jsonb(p)-'total_count')from paged p),'[]'::jsonb),'total',coalesce((select max(total_count)from movements),0),'page',page_no,'pageSize',page_size,'statementLines',coalesce((select jsonb_agg(to_jsonb(sl)order by sl.bank_date,sl.statement_line_id)from latest_statement bs join bank_statement_line sl using(statement_id)),'[]'::jsonb),'reconciliation',coalesce((select to_jsonb(r)from latest_reconciliation r),'{}'::jsonb),'summary',jsonb_build_object('bookBalance',coalesce((select sum(amount)from bank_transaction where bank_account_id=account_key and tran_date<=date_to),0),'statementBalance',coalesce((select closing_balance from latest_statement),0),'transitPayments',coalesce((select sum(withdrawals)from movements where reconciliation_status='PENDIENTE_EN_TRANSITO'),0),'transitDeposits',coalesce((select sum(deposits)from movements where reconciliation_status='PENDIENTE_EN_TRANSITO'),0)))into result;
 return result;
end$$;
grant execute on function public.run_bank_reconciliation_report(jsonb)to authenticated;
notify pgrst,'reload schema';
