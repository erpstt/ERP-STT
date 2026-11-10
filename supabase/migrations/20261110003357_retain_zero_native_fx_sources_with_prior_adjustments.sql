-- A previously revalued monetary source may reach zero foreign principal while
-- retaining a local balance that must be unwound. Preserve its existing source
-- key, including a prior-adjustment group whose sum becomes zero after cancel.
-- Never introduce settled AR/AP sources without that historical FX anchor.
do $patch$
declare definition text;needle text;replacement text;
begin
 if not exists(select 1 from pg_proc where oid=to_regprocedure('fx_revaluation_private.fx_exposures(date,bigint)')
   and md5(prosrc)='2d16b1c9db606638e64f3a79e18cf59c')then
  raise exception 'Unexpected FX exposure calculation before zero-native source preservation';
 end if;
 definition:=pg_get_functiondef('fx_revaluation_private.fx_exposures(date,bigint)'::regprocedure);
 needle:='  where abs(balance.fc)>.000001;';
 replacement:=$body$  where abs(balance.fc)>.000001
    or(adjustment.source_key is not null
      and round(round(balance.local+coalesce(adjustment.local,0),6),2)<>0);$body$;
 if(length(definition)-length(replace(definition,needle,'')))/length(needle)<>1 then
  raise exception 'Unexpected FX zero-native exposure boundary';
 end if;
 execute replace(definition,needle,replacement);
end $patch$;
notify pgrst,'reload schema';
