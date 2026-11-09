-- Keep the existing bundle's authorization, rows and other option branches.
-- Bank capabilities belong to the guarded public wrapper, not its raw source.
do $patch$
declare definition text;item record;needle text:='reconciliation_private.bank_reconciliation_options()';replacement text:='public.bank_reconciliation_options()';
begin
 for item in select *from(values
  ('public.accounting_report_options_bundle()','724724c6cdf49d5ab28e066b53f1d000'),
  ('public.bank_reconciliation_options()','5306f499e541652bf2974addd2e91c45'),
  ('reconciliation_private.annotate_draft_delete_options(jsonb)','ae9af73a2505b880357c6066391513c8'),
  ('reconciliation_private.draft_delete_snapshot(bigint,date,bigint)','89e92cae21b828f0ad779d2170f12a4b'),
  ('reconciliation_private.access(text,text)','db49a13764d60473eb083ed784e76786'),
  ('reconciliation_private.allowed(text,text)','927712f39f6253a97bfe95b32d942fa2'),
  ('reconciliation_private.bank_scope(bigint,date,boolean)','dea2f3c05681394fad5cf646ed4bde79'),
  ('public.security_assert_role_access(text,text)','df2f76788809016bdedd1bdd7195e944'),
  ('report_template_private.enter(text,text)','91fc047935f066b30e29a30452fed82b')
 )v(signature,source_md5)loop
  if not exists(select 1 from pg_proc where oid=to_regprocedure(item.signature)and md5(prosrc)=item.source_md5)then
   raise exception 'Unexpected bank options bundle dependency: %',item.signature;
  end if;
 end loop;
 definition:=pg_get_functiondef('public.accounting_report_options_bundle()'::regprocedure);
 if(length(definition)-length(replace(definition,needle,'')))/length(needle)<>1 then
  raise exception 'Expected one authorized bank-options bundle boundary';
 end if;
 execute replace(definition,needle,replacement);
end$patch$;
notify pgrst,'reload schema';
