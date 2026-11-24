create or replace function entity_master_private.entity_master_list(p_catalog text) returns jsonb
language plpgsql stable security definer set search_path=pg_catalog,public,pg_temp as $$
declare c record;r jsonb;sid bigint;uid bigint;assigned bigint[];may_edit boolean;may_delete boolean;
begin
 sid:=entity_master_private.access(p_catalog,'view');
 if p_catalog<>'suppliers' then
 select *into c from entity_master_private.meta(p_catalog);
 execute format('select coalesce(jsonb_agg(entity_master_private.dto($1,%I)order by %I),''[]'')from public.%I where entity_master_private.visible($1,%I)',c.pk,c.pk,c.t,c.pk)into r using p_catalog;return r;
 end if;
 uid:=public.app_user_id();
 select coalesce(array_agg(subsidiary_id),'{}'::bigint[]) into assigned from public.user_subsidiaries where user_id=uid;
 may_edit:=entity_master_private.allowed('suppliers','edit');may_delete:=entity_master_private.allowed('suppliers','delete');
 select coalesce(jsonb_agg(to_jsonb(s)||jsonb_build_object(
 'subsidiary_ids',coalesce((select jsonb_agg(x.id order by x.n)from unnest(entity_master_private.scope_ids('suppliers',s.supplier_id))with ordinality x(id,n)where x.id=any(assigned)),'[]'::jsonb),
 'currency_ids',coalesce((select jsonb_agg(currency_id order by is_primary desc,currency_id)from public.supplier_currencies where supplier_id=s.supplier_id),'[]'::jsonb),
 'withholding_rules',coalesce((select jsonb_agg(jsonb_build_object('subsidiary_id',w.subsidiary_id,'tax_code_id',w.tax_code_id)order by w.subsidiary_id,w.tax_code_id)from public.entity_withholding_rules w where w.supplier_id=s.supplier_id and w.subsidiary_id=any(assigned)),'[]'::jsonb),
 '_revision',entity_master_private.fingerprint('suppliers',s.supplier_id),
 '_actions',jsonb_build_object('canEdit',may_edit and entity_master_private.scope_ids('suppliers',s.supplier_id)<@assigned,
 'canDelete',case when may_delete and entity_master_private.scope_ids('suppliers',s.supplier_id)<@assigned then not entity_master_private.used('suppliers',s.supplier_id)else false end))
 order by s.supplier_id),'[]'::jsonb)into r
 from public.suppliers s where exists(select 1 from public.entity_subsidiaries e where e.supplier_id=s.supplier_id and e.subsidiary_id=sid);
 return r;
end $$;
