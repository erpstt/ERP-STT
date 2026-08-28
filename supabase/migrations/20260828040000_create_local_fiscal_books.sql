insert into public.accounting_books(book_name,subsidiary_id,base_currency_id,is_primary,is_active)
select 'Fiscal local',s.subsidiary_id,s.currency_id,not exists(select 1 from public.accounting_books current_book where current_book.subsidiary_id=s.subsidiary_id and current_book.is_primary=true and current_book.is_active=true),true
from public.subsidiaries s
on conflict(book_name,subsidiary_id) do update set base_currency_id=excluded.base_currency_id,is_active=true,is_primary=case when exists(select 1 from public.accounting_books other_book where other_book.subsidiary_id=excluded.subsidiary_id and other_book.accounting_book_id<>accounting_books.accounting_book_id and other_book.is_primary=true and other_book.is_active=true) then accounting_books.is_primary else true end;

do $$declare current_journal bigint;begin for current_journal in select journal_id from public.journal loop perform public.sync_journal_gl_impacts(current_journal);end loop;end$$;
