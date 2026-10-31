-- C-04 containment: balances and operational headers are not manual catalogs.
set local lock_timeout='5s';set local statement_timeout='60s';
create schema inventory_balance_private;
revoke all on schema inventory_balance_private from public,anon,authenticated,service_role;
grant usage on schema inventory_balance_private to authenticated;
create function inventory_balance_private.allowed(k text) returns boolean language plpgsql stable security definer set search_path=pg_catalog,public,pg_temp as $$begin
 perform asset_posting_private.identity();return k=any(array['stock','stock-adjustments','stock-lots','stock-serials','stock-reservations','stock-transfers','stock-movements']) and (asset_posting_private.allowed('inventory:'||k,'view') or (k='stock-movements' and purchase_order_private.allowed('RECEIPT','view')));
 exception when insufficient_privilege then return false;end$$;
create function inventory_balance_private.location(id bigint) returns boolean language sql stable security definer set search_path=pg_catalog,public,pg_temp as $$select exists(select 1 from public.locations l where l.location_id=$1 and (l.subsidiary_id=asset_posting_private.identity() or exists(select 1 from public.location_subsidiaries s where s.location_id=l.location_id and s.subsidiary_id=asset_posting_private.identity())))$$;
create function inventory_balance_private.product(id bigint) returns boolean language sql stable security definer set search_path=pg_catalog,public,pg_temp as $$select exists(select 1 from public.product_subsidiaries p where p.product_id=$1 and p.subsidiary_id=asset_posting_private.identity())$$;
create function inventory_balance_private.transaction(id bigint) returns boolean language sql stable security definer set search_path=pg_catalog,public,pg_temp as $$select $1 is null or exists(select 1 from public."transaction" t where t.transaction_id=$1 and t.subsidiary_id=asset_posting_private.identity())$$;
create function inventory_balance_private.visible(k text,id bigint) returns boolean language plpgsql stable security definer set search_path=pg_catalog,public,pg_temp as $$declare sid bigint;begin
 if inventory_balance_private.allowed(k) is not true then return false;end if;sid:=asset_posting_private.identity();
 case k
 when 'stock' then return exists(select 1 from public.stock s where s.stock_id=id and inventory_balance_private.product(s.product_id) and inventory_balance_private.location(s.location_id) and (s.bin_id is null or exists(select 1 from public.bins b join public.warehouse_locations w using(warehouse_location_id) where b.bin_id=s.bin_id and w.location_id=s.location_id)));
 when 'stock-lots' then return exists(select 1 from public.stock_lots s where s.lot_id=id and inventory_balance_private.product(s.product_id) and inventory_balance_private.location(s.location_id));
 when 'stock-serials' then return exists(select 1 from public.stock_serials s where s.serial_id=id and inventory_balance_private.product(s.product_id) and inventory_balance_private.location(s.location_id) and (s.lot_id is null or exists(select 1 from public.stock_lots l where l.lot_id=s.lot_id and l.location_id=s.location_id and l.product_id=s.product_id)));
 when 'stock-reservations' then return exists(select 1 from public.stock_reservation s where s.reservation_id=id and inventory_balance_private.product(s.product_id) and inventory_balance_private.location(s.location_id) and inventory_balance_private.transaction(s.transaction_id));
 when 'stock-transfers' then return exists(select 1 from public.stock_transfer s where s.transfer_id=id and inventory_balance_private.location(s.source_location_id) and inventory_balance_private.location(s.target_location_id) and inventory_balance_private.transaction(s.transaction_id));
 when 'stock-adjustments' then return exists(select 1 from public.stock_adjustment s where s.adjustment_id=id and inventory_balance_private.location(s.location_id) and inventory_balance_private.transaction(s.transaction_id) and exists(select 1 from public.account_subsidiaries a where a.account_id=s.account_id and a.subsidiary_id=sid));
 when 'stock-movements' then return exists(select 1 from public.stock_movements s where s.movement_id=id and purchase_receipt_private.stock_visible(s.transaction_id,s.location_id));
 else return false;end case;
 exception when insufficient_privilege then return false;end$$;
-- Minimal labels for records the caller may actually see; no general catalog grants.
create function public.inventory_balance_options(p_catalog text) returns jsonb language plpgsql stable security definer set search_path=pg_catalog,public,pg_temp as $$declare t text;key text;r jsonb;records jsonb:='[]';begin
 if inventory_balance_private.allowed(p_catalog) is not true then raise exception using errcode='42501',message='El rol activo no puede consultar estas existencias.';end if;
 t:=case p_catalog when 'stock' then 'stock' when 'stock-adjustments' then 'stock_adjustment' when 'stock-lots' then 'stock_lots' when 'stock-serials' then 'stock_serials' when 'stock-reservations' then 'stock_reservation' when 'stock-transfers' then 'stock_transfer' when 'stock-movements' then 'stock_movements' end;
 key:=case p_catalog when 'stock' then 'stock_id' when 'stock-adjustments' then 'adjustment_id' when 'stock-lots' then 'lot_id' when 'stock-serials' then 'serial_id' when 'stock-reservations' then 'reservation_id' when 'stock-transfers' then 'transfer_id' when 'stock-movements' then 'movement_id' end;
 for r in execute format('select to_jsonb(s) from public.%I s where inventory_balance_private.visible($1,s.%I)',t,key) using p_catalog loop records:=records||jsonb_build_array(r);end loop;
 return jsonb_build_object(
 'inventory/products',(select coalesce(jsonb_agg(jsonb_build_object('product_id',p.product_id,'item_code',p.item_code,'display_name',p.display_name)),'[]') from public.products p where exists(select 1 from jsonb_array_elements(records) x where (x->>'product_id')::bigint=p.product_id)),
 'organization/locations',(select coalesce(jsonb_agg(jsonb_build_object('location_id',l.location_id,'name',l.name)),'[]') from public.locations l where exists(select 1 from jsonb_array_elements(records) x where l.location_id in((x->>'location_id')::bigint,(x->>'source_location_id')::bigint,(x->>'target_location_id')::bigint))),
 'inventory/bins',(select coalesce(jsonb_agg(jsonb_build_object('bin_id',b.bin_id,'bin_code',b.bin_code)),'[]') from public.bins b where exists(select 1 from jsonb_array_elements(records) x where b.bin_id=(x->>'bin_id')::bigint)),
 'inventory/stock-lots',(select coalesce(jsonb_agg(jsonb_build_object('lot_id',l.lot_id,'lot_number',l.lot_number)),'[]') from public.stock_lots l where exists(select 1 from jsonb_array_elements(records) x where l.lot_id=(x->>'lot_id')::bigint)),
 'transaction-engine/transactions',(select coalesce(jsonb_agg(jsonb_build_object('transaction_id',t.transaction_id,'tran_number',t.tran_number)),'[]') from public."transaction" t where exists(select 1 from jsonb_array_elements(records) x where t.transaction_id=(x->>'transaction_id')::bigint)),
 'accounting/chart-accounts',(select coalesce(jsonb_agg(jsonb_build_object('account_id',a.account_id,'account_number',a.account_number,'account_name',a.account_name)),'[]') from public.chart_accounts a where exists(select 1 from jsonb_array_elements(records) x where a.account_id=(x->>'account_id')::bigint)),
 'core/status',(select coalesce(jsonb_agg(jsonb_build_object('status_id',s.status_id,'code',s.code)),'[]') from public.status s where exists(select 1 from jsonb_array_elements(records) x where s.status_id=(x->>'status_id')::bigint)),
 'transaction-engine/transaction-lines','[]'::jsonb);
end$$;
do $$declare t text;k text;pk text;p record;c record;begin
 for t,k,pk in select * from (values('stock','stock','stock_id'),('stock_adjustment','stock-adjustments','adjustment_id'),('stock_lots','stock-lots','lot_id'),('stock_serials','stock-serials','serial_id'),('stock_reservation','stock-reservations','reservation_id'),('stock_transfer','stock-transfers','transfer_id')) x(t,k,pk) loop
 execute format('alter table public.%I enable row level security',t);for p in select policyname from pg_policies where schemaname='public' and tablename=t loop execute format('drop policy %I on public.%I',p.policyname,t);end loop;
 execute format('revoke all on public.%I from public,anon,authenticated,service_role',t);for c in select column_name from information_schema.columns where table_schema='public' and table_name=t loop execute format('revoke all (%I) on public.%I from public,anon,authenticated,service_role',c.column_name,t);end loop;
 execute format('grant select on public.%I to authenticated',t);execute format('create policy inventory_balance_read on public.%I for select to authenticated using(inventory_balance_private.visible(%L,%I))',t,k,pk);
 end loop;end$$;
revoke all on all functions in schema inventory_balance_private from public,anon,authenticated,service_role;
grant execute on function inventory_balance_private.visible(text,bigint) to authenticated;
revoke all on function public.inventory_balance_options(text) from public,anon,authenticated,service_role;
grant execute on function public.inventory_balance_options(text) to authenticated;
notify pgrst,'reload schema';
