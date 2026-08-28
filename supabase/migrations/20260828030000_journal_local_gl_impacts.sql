create or replace function public.sync_journal_gl_impacts(target_journal_id bigint) returns void language plpgsql security definer set search_path=public,pg_temp as $$
declare j journal%rowtype;book_id bigint;
begin
 select * into j from journal where journal_id=target_journal_id;
 if not found or j.transaction_id is null then return;end if;
 select accounting_book_id into book_id from accounting_books where subsidiary_id=j.subsidiary_id and is_primary=true and is_active=true order by accounting_book_id limit 1;
 if book_id is null then select accounting_book_id into book_id from accounting_books where subsidiary_id=j.subsidiary_id and is_active=true order by accounting_book_id limit 1;end if;
 if book_id is null then return;end if;
 delete from gl_impact where transaction_id=j.transaction_id;
 insert into gl_impact(transaction_id,account_id,subsidiary_id,fiscal_period_id,accounting_book_id,debit_amount,credit_amount,debit_fx,credit_fx,posting_date)
 select j.transaction_id,l.account_id,j.subsidiary_id,j.fiscal_period_id,book_id,l.debit*j.exchange_rate,l.credit*j.exchange_rate,l.debit,l.credit,j.journal_date from journal_line l where l.journal_id=j.journal_id and (l.debit>0 or l.credit>0);
end$$;
create or replace function public.sync_journal_gl_impacts_trigger() returns trigger language plpgsql security definer set search_path=public,pg_temp as $$begin perform sync_journal_gl_impacts(coalesce(new.journal_id,old.journal_id));return coalesce(new,old);end$$;
drop trigger if exists journal_line_gl_impact_sync on journal_line;
create trigger journal_line_gl_impact_sync after insert or update or delete on journal_line for each row execute function sync_journal_gl_impacts_trigger();
update journal_line set debit=debit;
