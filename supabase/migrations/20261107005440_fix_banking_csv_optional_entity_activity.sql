-- Customer/supplier masters may omit the optional inactive flag. Keep exact
-- tax-ID, subsidiary and uniqueness checks without altering any master data.
set local lock_timeout='5s';
set local statement_timeout='60s';
do $optional_entity_activity$
declare target regprocedure:='banking_csv_private.lookup(text,text,bigint)'::regprocedure;definition text;
 needle text:='not coalesce(c.is_inactive,false)';
begin
 if md5((select prosrc from pg_proc where oid=target))is distinct from '721f317cf3f28f61f22f9058eb0b2bfb' then
  raise exception 'Reviewed banking CSV entity lookup changed';
 end if;
 definition:=pg_get_functiondef(target);
 if (length(definition)-length(replace(definition,needle,'')))/length(needle)<>2 then
  raise exception 'Reviewed customer/supplier activity guards changed';
 end if;
 execute replace(definition,needle,'not coalesce((to_jsonb(c)->>''is_inactive'')::boolean,false)');
end$optional_entity_activity$;
notify pgrst,'reload schema';
