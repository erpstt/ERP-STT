create or replace function public.normalize_bank_transfer_journal_line() returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
declare kind text;
begin
 select journal_type into kind from journal where journal_id=new.journal_id;
 if kind='Transferencia bancaria' then
  if new.debit>0 and new.debit_fx>0 then new:=jsonb_populate_record(new,jsonb_build_object('debit',new.debit_fx,'debit_fx',new.debit));end if;
  if new.credit>0 and new.credit_fx>0 then new:=jsonb_populate_record(new,jsonb_build_object('credit',new.credit_fx,'credit_fx',new.credit));end if;
 end if;
 return new;
end$$;
drop trigger if exists normalize_bank_transfer_journal_line_trigger on journal_line;
create trigger normalize_bank_transfer_journal_line_trigger before insert on journal_line for each row execute function normalize_bank_transfer_journal_line();

do $$declare target record;begin
 for target in select j.journal_id from journal j join bank_transfer bt using(journal_id) where j.journal_type='Transferencia bancaria' and bt.status='APROBADA' and bt.transaction_id in(26,27) loop
  alter table journal_line disable trigger journal_line_gl_impact_sync;
  update journal_line set debit=debit_fx,debit_fx=debit where journal_id=target.journal_id and debit>0 and debit_fx>0;
  update journal_line set credit=credit_fx,credit_fx=credit where journal_id=target.journal_id and credit>0 and credit_fx>0;
  alter table journal_line enable trigger journal_line_gl_impact_sync;
  perform sync_journal_gl_impacts(target.journal_id);
 end loop;
end$$;
notify pgrst,'reload schema';
