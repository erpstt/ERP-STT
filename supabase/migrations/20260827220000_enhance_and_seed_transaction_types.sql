alter table public.transaction_types add column if not exists abbreviation text;
alter table public.transaction_types add column if not exists description text;

update public.transaction_types set abbreviation=code where abbreviation is null or trim(abbreviation)='';
update public.transaction_types set description='Registro existente migrado al nuevo catálogo.' where description is null or trim(description)='';
alter table public.transaction_types alter column abbreviation set not null;
alter table public.transaction_types alter column description set not null;
alter table public.transaction_types drop constraint if exists transaction_types_abbreviation_key;
alter table public.transaction_types add constraint transaction_types_abbreviation_key unique(abbreviation);

create sequence if not exists public.transaction_type_code_seq;
update public.transaction_types set code='TMP-'||transaction_type_id::text;
with numbered as(select transaction_type_id,row_number() over(order by transaction_type_id) n from public.transaction_types)
update public.transaction_types target set code='TT-'||lpad(numbered.n::text,8,'0') from numbered where numbered.transaction_type_id=target.transaction_type_id;
do $$declare total bigint;begin select count(*) into total from public.transaction_types;if total=0 then perform setval('public.transaction_type_code_seq',1,false);else perform setval('public.transaction_type_code_seq',total,true);end if;end$$;
alter table public.transaction_types alter column code set default ('TT-'||lpad(nextval('public.transaction_type_code_seq')::text,8,'0'));

insert into public.transaction_types(abbreviation,name,module_category,description) values
('FAC_VEN','Factura de Venta','Ventas','Registra la venta de bienes o servicios. Aumenta Cuentas por Cobrar (Débito) e Ingresos/Impuestos (Crédito).'),
('NC_VEN','Nota de Crédito Clientes','Ventas','Disminuye el saldo de una factura por devolución, descuento o anulación.'),
('ND_VEN','Nota de Débito Clientes','Ventas','Aumenta la deuda del cliente por penalizaciones, morosidad o cargos administrativos.'),
('REC_COB','Recibo de Cobro / Ingreso','Ventas','Registra la entrada de dinero a bancos/caja reduciendo la Cuenta por Cobrar.'),
('COT_VEN','Cotización / Proforma','Ventas','Documento comercial previo. No genera asientos contables ni afecta inventario.'),
('PED_VEN','Pedido / Orden de Venta','Ventas','Compromiso de compra que compromete o reserva stock en bodega. Sin impacto contable.'),
('FAC_PRO','Factura de Proveedor / CxP','Compras','Registra la obligación de pago por servicios o bienes recibidos. Afecta Gasto e IVA (Débito) y CxP (Crédito).'),
('NC_PRO','Nota de Crédito Proveedor','Compras','Aplica notas de crédito enviadas por proveedores para reducir el saldo por pagar.'),
('ND_PRO','Nota de Débito Proveedor','Compras','Incremento en la cuenta por pagar notificado por el proveedor.'),
('PAG_PRO','Pago a Proveedor / Egreso','Compras','Salida de fondos de banco/caja para cancelar facturas de proveedores.'),
('ORD_COM','Orden de Compra','Compras','Solicitud formal a proveedor. Genera compromiso presupuestario sin asiento contable.'),
('REQ_COM','Requisición de Compra','Compras','Solicitud interna de insumos entre departamentos.'),
('DEP_BAN','Depósito Bancario','Bancos y Tesorería','Registro de fondos ingresados a la cuenta corriente por ventas de contado o transferencias.'),
('TRF_BAN','Transferencia Interbancaria','Bancos y Tesorería','Movimiento de liquidez entre cuentas bancarias de la misma empresa o subsidiaria.'),
('LIQ_CCH','Liquidación de Caja Chica','Bancos y Tesorería','Legalización y reembolso de gastos menores pagados en efectivo.'),
('CON_BAN','Comisión / Gasto Bancario','Bancos y Tesorería','Cargos aplicados directamente por la entidad financiera.'),
('ASI_DIA','Asiento de Diario General','Contabilidad','Comprobante para ajustes libres de contabilidad.'),
('ASI_CIE','Asiento de Cierre Fiscal','Contabilidad','Proceso automático de fin de año que liquida cuentas de PyG contra Utilidades Retenidas.'),
('DIF_CAM','Asiento Diferencial Cambiario','Contabilidad','Valoración automática periódica de saldos en moneda extranjera a tipo de cambio oficial.')
on conflict(abbreviation) do update set name=excluded.name,module_category=excluded.module_category,description=excluded.description;
