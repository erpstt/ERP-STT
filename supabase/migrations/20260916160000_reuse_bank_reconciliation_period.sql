create or replace function public.ensure_open_bank_reconciliation(p_bank_account_id bigint,p_cutoff date)
returns bigint language plpgsql security definer set search_path=public,pg_temp as $$
declare period_key bigint;reconciliation_key bigint;current_status text;
begin
 if not exists(select 1 from bank_account ba join user_subsidiaries u using(subsidiary_id)where ba.bank_account_id=p_bank_account_id and u.user_id=app_user_id())then raise exception'No tiene acceso a la cuenta bancaria seleccionada.';end if;
 select fp.fiscal_period_id into period_key from bank_account ba join fiscal_periods fp on fp.subsidiary_id=ba.subsidiary_id and p_cutoff between fp.start_date and fp.end_date where ba.bank_account_id=p_bank_account_id order by fp.start_date desc limit 1;
 if period_key is null then raise exception'No existe un período fiscal para la fecha de conciliación seleccionada.';end if;
 select reconciliation_id,status into reconciliation_key,current_status from bank_reconciliation where bank_account_id=p_bank_account_id and fiscal_period_id=period_key for update;
 if current_status='CERRADA'then raise exception'La conciliación de esta cuenta para el período seleccionado ya está cerrada.';end if;
 if reconciliation_key is null then
  insert into bank_reconciliation(reconciliation_date,bank_account_id,fiscal_period_id,status)values(p_cutoff,p_bank_account_id,period_key,'ABIERTA')returning reconciliation_id into reconciliation_key;
 else
  update bank_reconciliation set reconciliation_date=p_cutoff where reconciliation_id=reconciliation_key;
 end if;
 return reconciliation_key;
end$$;

create or replace function public.auto_match_bank_reconciliation(p_bank_account_id bigint,p_cutoff date)
returns integer language plpgsql security definer set search_path=public,pg_temp as $$
declare rec_id bigint;matched integer:=0;r record;
begin
 rec_id:=ensure_open_bank_reconciliation(p_bank_account_id,p_cutoff);
 for r in select bt.bank_tran_id,sl.statement_line_id from bank_transaction bt join bank_statement bs on bs.bank_account_id=bt.bank_account_id and bs.statement_date=p_cutoff join bank_statement_line sl using(statement_id)where bt.bank_account_id=p_bank_account_id and bt.tran_date<=p_cutoff and bt.reconciliation_status<>'CONCILIADO'and sl.reconciliation_status<>'CONCILIADO'and abs(bt.amount-sl.amount)<.005 and abs(bt.tran_date-sl.bank_date)<=3 and coalesce(lower(bt.reference_number),'')=coalesce(lower(sl.reference),'')loop
  insert into bank_reconciliation_match(reconciliation_id,bank_tran_id,statement_line_id,match_type,matched_by)values(rec_id,r.bank_tran_id,r.statement_line_id,'AUTOMATICO',app_user_id())on conflict do nothing;
  if found then update bank_transaction set reconciliation_status='CONCILIADO',value_date=(select bank_date from bank_statement_line where statement_line_id=r.statement_line_id)where bank_tran_id=r.bank_tran_id;update bank_statement_line set reconciliation_status='CONCILIADO'where statement_line_id=r.statement_line_id;matched:=matched+1;end if;
 end loop;
 return matched;
end$$;

create or replace function public.match_bank_transaction(p_bank_tran_id bigint,p_statement_line_id bigint,p_cutoff date)
returns bigint language plpgsql security definer set search_path=public,pg_temp as $$
declare rec_id bigint;account_key bigint;new_id bigint;
begin
 select bank_account_id into account_key from bank_transaction where bank_tran_id=p_bank_tran_id;
 if account_key is null then raise exception'El movimiento del ERP seleccionado no existe.';end if;
 if not exists(select 1 from bank_statement_line sl join bank_statement bs using(statement_id)where sl.statement_line_id=p_statement_line_id and bs.bank_account_id=account_key)then raise exception'El movimiento del extracto pertenece a otra cuenta bancaria.';end if;
 rec_id:=ensure_open_bank_reconciliation(account_key,p_cutoff);
 insert into bank_reconciliation_match(reconciliation_id,bank_tran_id,statement_line_id,match_type,matched_by)values(rec_id,p_bank_tran_id,p_statement_line_id,'MANUAL',app_user_id())returning match_id into new_id;
 update bank_transaction set reconciliation_status='CONCILIADO',value_date=(select bank_date from bank_statement_line where statement_line_id=p_statement_line_id)where bank_tran_id=p_bank_tran_id;
 update bank_statement_line set reconciliation_status='CONCILIADO'where statement_line_id=p_statement_line_id;
 return new_id;
end$$;

create or replace function public.close_bank_reconciliation(p_bank_account_id bigint,p_cutoff date,p_bank_adjustments numeric default 0)
returns bigint language plpgsql security definer set search_path=public,pg_temp as $$
declare rec_id bigint;books numeric;statement numeric;checks numeric;deposits numeric;diff numeric;
begin
 perform auto_match_bank_reconciliation(p_bank_account_id,p_cutoff);
 rec_id:=ensure_open_bank_reconciliation(p_bank_account_id,p_cutoff);
 select coalesce(sum(amount),0)into books from bank_transaction where bank_account_id=p_bank_account_id and tran_date<=p_cutoff;
 select closing_balance into statement from bank_statement where bank_account_id=p_bank_account_id and statement_date=p_cutoff;
 if statement is null then raise exception'No existe un extracto bancario importado para la fecha de conciliación seleccionada.';end if;
 select coalesce(sum(greatest(-amount,0)),0),coalesce(sum(greatest(amount,0)),0)into checks,deposits from bank_transaction where bank_account_id=p_bank_account_id and tran_date<=p_cutoff and reconciliation_status='PENDIENTE_EN_TRANSITO';
 diff:=(books+checks-deposits+coalesce(p_bank_adjustments,0))-statement;
 if abs(diff)>=.005 then raise exception'La conciliación todavía presenta una diferencia de %. Revise los movimientos pendientes antes de finalizar.',to_char(abs(diff),'FM999G999G999G990D00');end if;
 update bank_reconciliation set reconciliation_date=p_cutoff,status='CERRADA',book_balance=books,statement_balance=statement,transit_payments=checks,transit_deposits=deposits,bank_adjustments=coalesce(p_bank_adjustments,0),difference=diff,closed_at=now(),closed_by=app_user_id()where reconciliation_id=rec_id;
 return rec_id;
end$$;

revoke all on function public.ensure_open_bank_reconciliation(bigint,date)from public,anon;
grant execute on function public.ensure_open_bank_reconciliation(bigint,date),public.auto_match_bank_reconciliation(bigint,date),public.match_bank_transaction(bigint,bigint,date),public.close_bank_reconciliation(bigint,date,numeric)to authenticated;
notify pgrst,'reload schema';
