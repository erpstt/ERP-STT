-- Preserve existing customer assignments during edits of unrelated master data.
-- All identity, explicit role grants, subsidiary authorization and revision checks remain in place.
do $patch$
declare target regprocedure;body text;old text;replacement text;startpos int;endpos int;
begin
 target:=coalesce(to_regprocedure('entity_master_private.save_entity_master(text,jsonb,bigint)'),to_regprocedure('public.save_entity_master(text,jsonb,bigint)'));
 if target is null then raise exception 'Missing entity master save function';end if;
 body:=pg_get_functiondef(target);
 old:=$old$subs:=entity_master_private.ids(p_payload->'subsidiary_ids');curs:=entity_master_private.ids(p_payload->'currency_ids');$old$;
 if position(old in body)=0 then raise exception 'Unexpected assignment validation';end if;
 replacement:=old||$new$
 if p_catalog='customers' and p_id is not null then
  oldsubs:=entity_master_private.scope_ids(p_catalog,p_id);
  execute format('select array_agg(currency_id)from public.%I where %I=$1',c.curtable,c.pk)into oldcurs using p_id;
  -- Checkbox ordering must not silently change the primary subsidiary or currency.
  select array_agg(x.v order by (x.v=(oldrow->>'primary_subsidiary_id')::bigint)desc,x.n)into subs from unnest(subs)with ordinality x(v,n);
  select array_agg(x.v order by (x.v=(oldrow->>'currency_id')::bigint)desc,x.n)into curs from unnest(curs)with ordinality x(v,n);
 end if;
$new$;
 body:=replace(body,old,replacement);
 startpos:=position('if not entity_master_private.currency_ok(curs[1],subs[1])'in body);
 if startpos=0 then raise exception 'Missing currency validation';end if;
 endpos:=position('then raise exception'in substring(body from startpos));
 old:=substring(body from startpos for endpos-1);
 replacement:='if not (p_catalog=''customers'' and p_id is not null and oldsubs @> subs and oldsubs <@ subs and oldcurs @> curs and oldcurs <@ curs) and ('||substring(old from 4)||') ';
 body:=replace(body,old,replacement);
 old:=$old$(d.subsidiary_id=subs[1]or exists(select 1 from public.department_subsidiaries ds where ds.department_id=d.department_id and ds.subsidiary_id=subs[1]))$old$;
 if position(old in body)=0 then raise exception 'Missing department scope validation';end if;
 body:=replace(body,old,$new$(d.subsidiary_id=any(subs)or exists(select 1 from public.department_subsidiaries ds where ds.department_id=d.department_id and ds.subsidiary_id=any(subs)))$new$);
 old:=$old$is_active and is_sales_representative and subsidiary_id=subs[1]$old$;
 if position(old in body)=0 then raise exception 'Missing representative scope validation';end if;
 body:=replace(body,old,$new$is_active and is_sales_representative and subsidiary_id=any(subs)$new$);
 execute body;
end $patch$;
notify pgrst,'reload schema';
