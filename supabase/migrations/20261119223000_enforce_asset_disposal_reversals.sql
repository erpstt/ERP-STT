-- Only the asset workflow can reverse its journal and restore the asset atomically.
create or replace function asset_operation_private.post_disposal_journal(p_entry jsonb,p_sid bigint,p_asset bigint,p_kind text,p_reversed bigint default null) returns bigint
language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$
declare jid bigint;previous text:=coalesce(current_setting('app.asset_proposal_internal',true),'');previous_reversal text:=coalesce(current_setting('app.asset_disposal_reverse',true),'');begin
 perform journal_entry_private.validate_payload(p_entry,p_sid);
 perform set_config('app.asset_proposal_internal','1',true);
 jid:=journal_entry_private.create_journal_entry(p_entry);
 if p_reversed is not null then
  perform set_config('app.asset_disposal_reverse',p_reversed::text,true);
  update public.journal set reversed_from_journal_id=p_reversed where journal_id=jid;
  perform set_config('app.asset_disposal_reverse',previous_reversal,true);
 end if;
 perform public.sync_journal_gl_impacts(jid);
 if not exists(select 1 from public.journal j join public.gl_impact g using(transaction_id) where j.journal_id=jid) then raise exception using errcode='55000',message='El asiento no generó movimientos en el libro mayor.';end if;
 insert into asset_operation_private.disposal_journal_links values(jid,p_asset,p_kind);
 perform set_config('app.asset_proposal_internal',previous,true);
 return jid;
end$$;
create function asset_operation_private.require_disposal_reversal() returns trigger language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$begin
 if new.reversed_from_journal_id is not null and exists(select 1 from asset_operation_private.disposal_journal_links where journal_id=new.reversed_from_journal_id) and coalesce(current_setting('app.asset_disposal_reverse',true),'')<>new.reversed_from_journal_id::text then
  raise exception using errcode='55000',message='Revierta este asiento desde Bajas y ventas para mantener consistente el activo.';
 end if;return new;
end$$;
create trigger require_asset_disposal_reversal before insert or update of reversed_from_journal_id on public.journal for each row execute function asset_operation_private.require_disposal_reversal();
revoke all on function asset_operation_private.require_disposal_reversal() from public,anon,authenticated,service_role;
do $$declare body text;patched text;begin
 body:=pg_get_functiondef('asset_operation_private.disposal_values(bigint,date)'::regprocedure);
 patched:=replace(body,'elsif row_cut.depreciation_date<>p_date then','elsif row_cut.depreciation_date<>p_date or p_date<>(month_start+interval ''1 month -1 day'')::date then');
 if patched=body then raise exception 'Unexpected disposal cut validation';end if;execute patched;
end$$;
notify pgrst,'reload schema';
