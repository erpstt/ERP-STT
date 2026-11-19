-- A complemented cut belongs to its original calendar month, even if requested later.
do $$declare body text;patched text;begin
 body:=pg_get_functiondef('public.run_fixed_asset_depreciation(date,jsonb)'::regprocedure);
 patched:=replace(body,'pid:=asset_posting_private.period(p_date);','pid:=asset_posting_private.period((date_trunc(''month'',d.depreciation_date)+interval ''1 month -1 day'')::date);');
 patched:=replace(patched,'''journal_date'',p_date','''journal_date'',(date_trunc(''month'',d.depreciation_date)+interval ''1 month -1 day'')::date');
 if patched=body then raise exception 'Unexpected cut completion function';end if;execute patched;
end$$;

-- Prevent a later invoice from posting the same external sale a second time.
create function asset_operation_private.prevent_duplicate_sale_invoice() returns trigger language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$begin
 if exists(select 1 from public.asset_disposal d join public.asset a using(asset_id) where a.subsidiary_id=new.subsidiary_id and d.invoice_reference=btrim(new.invoice_number) and d.disposal_type='VENTA' and d.reversed_at is null and d.journal_id is not null) then
  raise exception using errcode='55000',message='Esta factura externa ya fue contabilizada en Bajas y ventas de Activos Fijos.';
 end if;return new;
end$$;
create trigger prevent_duplicate_asset_sale before insert or update of invoice_number,subsidiary_id on public.invoice for each row execute function asset_operation_private.prevent_duplicate_sale_invoice();
revoke all on function asset_operation_private.prevent_duplicate_sale_invoice() from public,anon,authenticated,service_role;
notify pgrst,'reload schema';
