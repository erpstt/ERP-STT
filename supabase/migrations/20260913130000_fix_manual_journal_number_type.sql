create or replace function public.next_manual_journal_number(journal_kind text, sid bigint)
returns text language plpgsql security definer set search_path=public,pg_temp as $$
declare abbreviation_value text:=case journal_kind
 when 'Asientos Pendientes de Facturar' then 'ASI_PEN'
 when 'Asiento de Nóminas' then 'ASI_NOM'
 when 'Asiento de Liquidación' then 'ASI_LIQ'
 else 'ASI_DIA' end; tt bigint; result text; last_used bigint;
begin
 perform pg_advisory_xact_lock(hashtextextended('manual-journal-number:'||abbreviation_value,0));
 select transaction_type_id into tt from transaction_types where abbreviation=abbreviation_value;
 if tt is null then raise exception 'No existe el tipo de asiento %.',abbreviation_value; end if;
 select coalesce(max(substring(n from '[0-9]+$')::bigint),0) into last_used
 from (select journal_number n from journal union all select tran_number from "transaction") numbers
 where n ~ ('^'||abbreviation_value||'-[0-9]+$');
 insert into number_sequences(scope_type,transaction_type_id,subsidiary_id,prefix,current_number,padding_length)
 values('Transacción',tt,sid,abbreviation_value||'-',last_used,8)
 on conflict(transaction_type_id,subsidiary_id) where scope_type='Transacción' do nothing;
 loop
   result:=next_transaction_number(tt,sid);
   exit when not exists(select 1 from journal where journal_number=result)
     and not exists(select 1 from "transaction" where tran_number=result);
 end loop;
 return result;
end $$;
revoke all on function public.next_manual_journal_number(text,bigint) from public,anon,authenticated;

-- Preserve the deployed journal validation, line handling and optional wrappers.
do $$declare f record; old_source text:=$old$ select transaction_type_id into tt from transaction_types where abbreviation='ASI_DIA' limit 1;
 begin number:=public.next_transaction_number(tt,sid);exception when others then number:='ASI-'||to_char(clock_timestamp(),'YYYYMMDDHH24MISSMS');end;$old$;
 changed integer:=0;
begin
 for f in select p.oid,pg_get_functiondef(p.oid) definition from pg_proc p join pg_namespace n on n.oid=p.pronamespace
 where n.nspname='public' and p.proname in ('create_journal_entry','create_journal_entry_without_service_month') loop
   if position(old_source in f.definition)>0 then
     execute replace(f.definition,old_source,' number:=public.next_manual_journal_number(payload->>''journal_type'',sid);');
     changed:=changed+1;
   elsif position('next_manual_journal_number' in f.definition)>0 then changed:=changed+1;
   end if;
 end loop;
 if changed=0 then raise exception 'La función de creación cambió; revise su numeración antes de aplicar esta migración.'; end if;
end $$;

-- Correct only the journal explicitly reported by the user, preserving its suffix.
do $$declare j record; tt bigint; corrected text:='ASI_PEN-00000001';
begin
 select * into j from journal where journal_number='ASI_DIA-00000017'
 and journal_type='Asientos Pendientes de Facturar' for update;
 if not found then return; end if;
 if exists(select 1 from journal where journal_number=corrected)
 or exists(select 1 from "transaction" where tran_number=corrected) then raise exception 'El número corregido ya está ocupado.'; end if;
 select transaction_type_id into tt from transaction_types where abbreviation='ASI_PEN';
 insert into number_sequences(scope_type,transaction_type_id,subsidiary_id,prefix,current_number,padding_length)
 values('Transacción',tt,j.subsidiary_id,'ASI_PEN-',1,8)
 on conflict(transaction_type_id,subsidiary_id) where scope_type='Transacción'
 do update set current_number=greatest(number_sequences.current_number,1);
 update "transaction" set tran_number=corrected where transaction_id=j.transaction_id;
 update journal set journal_number=corrected where journal_id=j.journal_id;
end $$;
notify pgrst,'reload schema';
