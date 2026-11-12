-- Parse only address lists, not display names or mail headers. NULL means invalid.
create or replace function entity_master_private.customer_email_recipients(value text)
returns text[] language plpgsql immutable security invoker set search_path=pg_catalog,pg_temp as $fn$
declare item text;result text[]:=array[]::text[];seen text[]:=array[]::text[];localpart text;
begin
 if value is null or btrim(value)='' then return result;end if;
 if length(value)>6000 or value~'[[:cntrl:]]' then return null;end if;
 foreach item in array regexp_split_to_array(value,'[,;]') loop
  item:=btrim(item);if item='' then continue;end if;localpart:=split_part(item,'@',1);
  if length(item)>254 or length(localpart)>64 or left(localpart,1)='.' or right(localpart,1)='.' or position('..'in localpart)>0
   or item!~$email$^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$$email$
  then return null;end if;
  if not lower(item)=any(seen)then result:=array_append(result,item);seen:=array_append(seen,lower(item));end if;
 end loop;
 if cardinality(result)>20 then return null;end if;return result;
end $fn$;
revoke all on function entity_master_private.customer_email_recipients(text) from public,anon,authenticated,service_role;

-- Keep the current save function's authorization, locking and all other validations.
do $patch$
declare target regprocedure;body text;old text;replacement text;startpos int;endpos int;
begin
 target:=coalesce(to_regprocedure('entity_master_private.save_entity_master(text,jsonb,bigint)'),to_regprocedure('public.save_entity_master(text,jsonb,bigint)'));
 if target is null then raise exception 'Missing entity master save function';end if;
 body:=pg_get_functiondef(target);
 old:=$old$if data->>'email'is not null and(length(data->>'email')>254 or data->>'email'!~$old$;
 if position(old in body)=0 then raise exception 'Unexpected customer email validation';end if;
 startpos:=position(old in body);endpos:=position('then raise exception'in substring(body from startpos));
 old:=substring(body from startpos for endpos-1);
 replacement:=$new$if data->>'email'is not null and ((p_catalog='customers' and coalesce(cardinality(entity_master_private.customer_email_recipients(data->>'email')),0)=0) or (p_catalog<>'customers' and (length(data->>'email')>254 or data->>'email'!~'^[^[:space:]@,;<>]+@[^[:space:]@,;<>]+\.[^[:space:]@,;<>]+$'))) $new$;
 body:=replace(body,old,replacement);
 old:=$old$if(data->>'envio_estado_cuenta_auto')::boolean$old$;
 if position(old in body)=0 then raise exception 'Missing statement opt-in validation';end if;
 body:=replace(body,old,$new$if p_catalog='customers' and data->>'email'is not null then data:=jsonb_set(data,'{email}',to_jsonb(array_to_string(entity_master_private.customer_email_recipients(data->>'email'),', ')));end if;
 if(data->>'envio_estado_cuenta_auto')::boolean$new$);
 execute body;
 -- The statement queue uses the same customer email field and must accept lists.
 target:=to_regprocedure('public.statement_enqueue(bigint,bigint,date,text,text,boolean)');
 if target is not null then
  body:=pg_get_functiondef(target);startpos:=position($old$case when coalesce(snap->>'email','')~$old$in body);
  if startpos=0 then raise exception 'Unexpected statement recipient validation';end if;
  endpos:=position($old$then 'PENDIENTE'$old$in substring(body from startpos));
  if endpos=0 then raise exception 'Missing statement pending status';end if;
  old:=substring(body from startpos for endpos-1);
  body:=replace(body,old,$new$case when coalesce(cardinality(entity_master_private.customer_email_recipients(snap->>'email')),0)>0 $new$);
  execute body;
 end if;
end $patch$;
notify pgrst,'reload schema';
