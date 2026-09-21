alter table public.chart_accounts add column payment_request_enabled boolean not null default false;
update public.chart_accounts set payment_request_enabled=true where account_number in('614014','622005','614015')and category='Gasto';
create or replace function pr_allowed_account(p_id bigint) returns boolean language sql stable security definer set search_path=public,pg_temp as $$
 select exists(select 1 from chart_accounts a join account_subsidiaries s using(account_id)
 where a.account_id=p_id and s.subsidiary_id=pr_access() and s.is_active and (a.category in('Activo','Pasivo')or(a.category in('Costo','Gasto')and a.payment_request_enabled)) and a.accepts_entries and not a.is_inactive
 and not exists(select 1 from bank_account b where b.account_id=a.account_id)
 and not exists(select 1 from cashbox b where b.account_id=a.account_id)
 and a.account_number!~'^(1102|1105|2105)'
 and a.account_name!~*'banc|caja|efectivo|cash|cuentas? .*por (cobrar|pagar)|cxc|cxp|receivable|payable'
 and not exists(with recursive ancestors as(select g.group_id,g.parent_id,g.group_code,g.group_name from account_group g where g.group_id=a.account_group_id union select g.group_id,g.parent_id,g.group_code,g.group_name from account_group g join ancestors p on g.group_id=p.parent_id)
 select 1 from ancestors where group_code~'^(1102|1105|2105)' or group_name~*'banc|caja|efectivo|cash|cuentas? .*por (cobrar|pagar)|cxc|cxp|receivable|payable'))
$$;
create or replace function pr_validate(p_id bigint) returns void language plpgsql security definer set search_path=public,pg_temp as $$
declare h solicitudes_pago%rowtype;l solicitudes_pago_lineas%rowtype;n integer:=0;amount numeric:=0;reserved numeric:=0;
begin
 select * into strict h from solicitudes_pago where id=p_id and id_subsidiaria=pr_access();
 if not exists(select 1 from subsidiary_currencies where subsidiary_id=h.id_subsidiaria and currency_id=h.id_moneda) and h.id_moneda<>(select currency_id from subsidiaries where subsidiary_id=h.id_subsidiaria) then raise exception 'La moneda no esta autorizada para la subsidiaria.';end if;
 if h.tipo_solicitud='CXP' and not exists(select 1 from suppliers s where s.supplier_id=h.id_proveedor and (s.primary_subsidiary_id=h.id_subsidiaria or exists(select 1 from entity_subsidiaries e where e.supplier_id=s.supplier_id and e.subsidiary_id=h.id_subsidiaria))) then raise exception 'Proveedor no autorizado para esta subsidiaria.';end if;
 for l in select * from solicitudes_pago_lineas where id_solicitud=h.id loop
 n:=n+1;amount:=amount+l.monto;
 if h.tipo_solicitud='CXP' then
 perform pg_advisory_xact_lock(hashtextextended('payment-request-invoice:'||l.id_factura_proveedor,0));
 if not exists(select 1 from supplier_invoice i where i.invoice_id=l.id_factura_proveedor and i.subsidiary_id=h.id_subsidiaria and i.supplier_id=h.id_proveedor and i.currency_id=h.id_moneda) then raise exception 'Seleccione facturas del proveedor y de la misma moneda.';end if;
 select coalesce(sum(x.monto),0) into reserved from solicitudes_pago_lineas x join solicitudes_pago r on r.id=x.id_solicitud
 where x.id_factura_proveedor=l.id_factura_proveedor and r.id<>h.id and r.estado in('BORRADOR','PENDIENTE_APROBACION','APROBADO');
 if l.monto>pr_invoice_balance(l.id_factura_proveedor)-reserved then raise exception 'La factura % tiene saldo reservado por otra Solicitud de Pago pendiente o aprobada.',l.id_factura_proveedor;end if;
 else
 if not pr_allowed_account(l.id_cuenta_contable) then raise exception 'Cuenta no habilitada para solicitudes de pago. Seleccione una cuenta permitida de Activo/Pasivo o una cuenta de Costo/Gasto autorizada.';end if;
 if nullif(trim(l.concepto),'') is null then raise exception 'Indique el concepto de cada imputacion.';end if;
 if l.tipo_tercero is null or (l.tipo_tercero='Cliente' and l.id_cliente is null) or (l.tipo_tercero='Proveedor' and l.id_proveedor is null) or (l.tipo_tercero='Empleado' and l.id_empleado is null) then raise exception 'Seleccione el tercero de cada imputacion.';end if;
 if l.id_cliente is not null and not exists(select 1 from customers c where c.customer_id=l.id_cliente and (c.primary_subsidiary_id=h.id_subsidiaria or exists(select 1 from entity_subsidiaries e where e.customer_id=c.customer_id and e.subsidiary_id=h.id_subsidiaria))) then raise exception 'Cliente fuera de la subsidiaria.';end if;
 if l.id_proveedor is not null and not exists(select 1 from suppliers s where s.supplier_id=l.id_proveedor and (s.primary_subsidiary_id=h.id_subsidiaria or exists(select 1 from entity_subsidiaries e where e.supplier_id=s.supplier_id and e.subsidiary_id=h.id_subsidiaria))) then raise exception 'Proveedor fuera de la subsidiaria.';end if;
 if l.id_empleado is not null and not exists(select 1 from employees where employee_id=l.id_empleado and subsidiary_id=h.id_subsidiaria and is_active) then raise exception 'Empleado fuera de la subsidiaria o inactivo.';end if;
 if l.id_centro_costo is not null and not exists(select 1 from cost_centers where cost_center_id=l.id_centro_costo and subsidiary_id=h.id_subsidiaria) then raise exception 'Centro de costo fuera de la subsidiaria.';end if;
 end if;
 end loop;
 if n=0 or amount<>h.total then raise exception 'La solicitud requiere lineas y un total consistente.';end if;
end$$;

revoke all on function pr_allowed_account(bigint),pr_validate(bigint) from public,anon,authenticated;
notify pgrst,'reload schema';
