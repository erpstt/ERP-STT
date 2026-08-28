create or replace function public.sync_journal_gl_impacts(target_journal_id bigint) returns void language plpgsql security definer set search_path=public,pg_temp as $$
declare j journal%rowtype;book_id bigint;
begin
 select * into j from journal where journal_id=target_journal_id;
 if not found or j.transaction_id is null then return;end if;
 select accounting_book_id into book_id from accounting_books where subsidiary_id=j.subsidiary_id and is_primary=true and is_active=true order by accounting_book_id limit 1;
 if book_id is null then select accounting_book_id into book_id from accounting_books where subsidiary_id=j.subsidiary_id and is_active=true order by accounting_book_id limit 1;end if;
 if book_id is null then return;end if;
 if exists(select 1 from journal_line l join tax_codes tax_code on tax_code.tax_code_id=l.tax_code_id join tax_types tax_type on tax_type.tax_type_id=tax_code.tax_type_id where l.journal_id=j.journal_id and coalesce(l.tax_rate,tax_code.rate_percentage,0)>0 and case when l.debit>0 then tax_type.asset_account_id else tax_type.liability_account_id end is null) then raise exception 'El tipo de impuesto seleccionado no tiene configurada la cuenta contable correspondiente.';end if;
 delete from gl_impact where transaction_id=j.transaction_id;
 insert into gl_impact(transaction_id,account_id,subsidiary_id,fiscal_period_id,accounting_book_id,debit_amount,credit_amount,debit_fx,credit_fx,posting_date)
 select j.transaction_id,l.account_id,j.subsidiary_id,j.fiscal_period_id,book_id,l.debit*j.exchange_rate,l.credit*j.exchange_rate,l.debit,l.credit,j.journal_date from journal_line l where l.journal_id=j.journal_id and (l.debit>0 or l.credit>0);
 insert into gl_impact(transaction_id,account_id,subsidiary_id,fiscal_period_id,accounting_book_id,debit_amount,credit_amount,debit_fx,credit_fx,posting_date)
 select j.transaction_id,case when l.debit>0 then tax_type.asset_account_id else tax_type.liability_account_id end,j.subsidiary_id,j.fiscal_period_id,book_id,case when l.debit>0 then greatest(l.debit,l.credit)*coalesce(l.tax_rate,tax_code.rate_percentage,0)/100*j.exchange_rate else 0 end,case when l.credit>0 then greatest(l.debit,l.credit)*coalesce(l.tax_rate,tax_code.rate_percentage,0)/100*j.exchange_rate else 0 end,case when l.debit>0 then greatest(l.debit,l.credit)*coalesce(l.tax_rate,tax_code.rate_percentage,0)/100 else 0 end,case when l.credit>0 then greatest(l.debit,l.credit)*coalesce(l.tax_rate,tax_code.rate_percentage,0)/100 else 0 end,j.journal_date
 from journal_line l join tax_codes tax_code on tax_code.tax_code_id=l.tax_code_id join tax_types tax_type on tax_type.tax_type_id=tax_code.tax_type_id
 where l.journal_id=j.journal_id and coalesce(l.tax_rate,tax_code.rate_percentage,0)>0 and case when l.debit>0 then tax_type.asset_account_id else tax_type.liability_account_id end is not null;
end$$;
do $$declare current_journal bigint;begin for current_journal in select journal_id from journal loop perform sync_journal_gl_impacts(current_journal);end loop;end$$;
