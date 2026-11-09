-- Build the complete FX journal, then synchronize its local-only ledger once.
-- The existing trigger already supports this transaction-local batching flag.
-- Authorization, numbering, source snapshots and financial amounts stay intact.
do $guard$declare item record;begin
 for item in select *from(values
  ('sequence_security_private.runtime_fx_post(bigint,date,integer,text)','a9b4d8849df82b49aa6175ef81ad8e4b'),
  ('fx_revaluation_private.fx_post_journal(bigint,date,integer,text)','1a565305abef709b193253f01b4eb274'),
  ('public.sync_journal_gl_impacts(bigint)','c6d71f38184b146e970940155556fae4'),
  ('public.sync_journal_gl_impacts_trigger()','f9fe5b9f1704666e265e0e4f9926ea9d'),
  ('public.fx_local_only_gl()','9d8e0bde91089f3874e02a4cc38847b4'),
  ('public.fx_protect_journals()','8f9b7de072f90ff31c0082f8298cb70d'),
  ('fx_revaluation_private.check_journal(bigint,bigint)','56cebe4ad20904517ad53340f6eb1bdb'),
  ('public.fx_execute(jsonb)','d7628859173d2fd5ea6eefc4bba68320'),
  ('fx_revaluation_private.fx_execute(jsonb)','21565358b312c8314878e07cbf60eb85'),
  ('public.next_transaction_number(bigint,bigint)','00eba4a9d3fd6a4ef9e346fd131c965f'),
  ('sequence_security_private.runtime_transaction_next(bigint,bigint)','a11bbe0d1a12107a60f7d213ef2e08e9'),
  ('sequence_security_private.actor()','f5e3806b728f0bc1ad82285326e6e12b'),
  ('sequence_security_private.enter(text)','ca61707d443fa40714eb713edc8612f9'),
  ('public.security_assert_role_access(text,text)','df2f76788809016bdedd1bdd7195e944')
 )v(signature,source_md5)loop
  if not exists(select 1 from pg_proc where oid=to_regprocedure(item.signature)and md5(prosrc)=item.source_md5)then
   raise exception 'Unexpected FX journal batching dependency: %',item.signature;
  end if;
 end loop;
end$guard$;

do $patch$
declare definition text;needle text;replacement text;
begin
 definition:=pg_get_functiondef('sequence_security_private.runtime_fx_post(bigint,date,integer,text)'::regprocedure);
 needle:='counterpart_account bigint;';
 replacement:=$body$counterpart_account bigint;
  previous_defer text:=current_setting('nexo.defer_journal_gl_sync',true);
  previous_fx_posting text:=current_setting('nexo.fx_posting',true);$body$;
 if(length(definition)-length(replace(definition,needle,'')))/length(needle)<>1 then raise exception 'Unexpected FX journal declaration boundary';end if;
 definition:=replace(definition,needle,replacement);
 needle:='perform set_config(''nexo.fx_posting'',''on'',true);';
 replacement:=$body$perform set_config('nexo.defer_journal_gl_sync','on',true);
  perform set_config('nexo.fx_posting','on',true);$body$;
 if(length(definition)-length(replace(definition,needle,'')))/length(needle)<>1 then raise exception 'Unexpected FX journal posting boundary';end if;
 definition:=replace(definition,needle,replacement);
 needle:=$body$perform set_config('nexo.fx_posting','off',true);
  return journal_key;$body$;
 replacement:=$body$-- Direct synchronization intentionally runs even when the caller had already
  -- deferred trigger synchronization. FX local-only protections remain active.
  perform public.sync_journal_gl_impacts(journal_key);
  perform set_config('nexo.defer_journal_gl_sync',coalesce(previous_defer,''),true);
  perform set_config('nexo.fx_posting',coalesce(previous_fx_posting,''),true);
  return journal_key;
exception
  when query_canceled then
    perform set_config('nexo.defer_journal_gl_sync',coalesce(previous_defer,''),true);
    perform set_config('nexo.fx_posting',coalesce(previous_fx_posting,''),true);
    raise;
  when others then
    perform set_config('nexo.defer_journal_gl_sync',coalesce(previous_defer,''),true);
    perform set_config('nexo.fx_posting',coalesce(previous_fx_posting,''),true);
    raise;$body$;
 if(length(definition)-length(replace(definition,needle,'')))/length(needle)<>1 then raise exception 'Unexpected FX journal completion boundary';end if;
 execute replace(definition,needle,replacement);
end$patch$;
notify pgrst,'reload schema';
