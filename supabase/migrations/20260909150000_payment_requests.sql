insert into transaction_types(abbreviation,name,module_category,description) values('SOL_PAG','Solicitud de Pago','Contabilidad','Solicitud administrativa sin impacto contable hasta su ejecucion.') on conflict(abbreviation) do nothing;
create table if not exists solicitudes_pago(
 id bigint generated always as identity primary key, numero text not null unique,
 id_subsidiaria bigint not null references subsidiaries,id_moneda bigint not null references currencies,
 tipo_solicitud text not null check(tipo_solicitud in ('CXP','OTROS')),
 estado text not null default 'BORRADOR' check(estado in ('BORRADOR','PENDIENTE_APROBACION','APROBADO','APLICADO','RECHAZADO','ANULADO')),
 fecha_solicitud date not null default current_date,fecha_pago_programada date not null,
 id_solicitante bigint not null references users,id_proveedor bigint references suppliers,concepto text not null,
 total numeric(24,6) not null check(total>0),version integer not null default 1,
 aprobado_por bigint references users,aprobado_at timestamptz,aplicado_por bigint references users,aplicado_at timestamptz,
 payment_id bigint references supplier_payment,check_id bigint references bank_check,journal_id bigint references journal,
 metodo_pago text,referencia_bancaria text,created_at timestamptz not null default now(),updated_at timestamptz not null default now(),
 check((tipo_solicitud='CXP' and id_proveedor is not null)or(tipo_solicitud='OTROS' and id_proveedor is null))
);
create table if not exists solicitudes_pago_lineas(
 id bigint generated always as identity primary key,id_solicitud bigint not null references solicitudes_pago,
 id_factura_proveedor bigint references supplier_invoice,id_cuenta_contable bigint references chart_accounts,
 tipo_tercero text check(tipo_tercero in ('Cliente','Proveedor','Empleado')),
 id_cliente bigint references customers,id_proveedor bigint references suppliers,id_empleado bigint references employees,
 id_centro_costo bigint references cost_centers,concepto text,monto numeric(24,6) not null check(monto>0),
 check((id_factura_proveedor is null)<>(id_cuenta_contable is null)),
 check(num_nonnulls(id_cliente,id_proveedor,id_empleado)<=1),unique(id_solicitud,id_factura_proveedor)
);
create table if not exists solicitudes_pago_eventos(
 id bigint generated always as identity primary key,id_solicitud bigint not null references solicitudes_pago,
 usuario bigint not null references users,fecha timestamptz not null default now(),accion text not null,nota text
);
create index if not exists solicitudes_pago_scope on solicitudes_pago(id_subsidiaria,estado,tipo_solicitud,fecha_pago_programada);
create index if not exists solicitudes_pago_date on solicitudes_pago(id_subsidiaria,fecha_solicitud,id_solicitante,id_proveedor);
create index if not exists solicitudes_pago_lines on solicitudes_pago_lineas(id_solicitud);
create index if not exists solicitudes_pago_events on solicitudes_pago_eventos(id_solicitud,id);
alter table solicitudes_pago enable row level security;alter table solicitudes_pago_lineas enable row level security;alter table solicitudes_pago_eventos enable row level security;
drop policy if exists pr_read on solicitudes_pago;create policy pr_read on solicitudes_pago for select to authenticated using(id_subsidiaria=active_subsidiary_id());
drop policy if exists pr_lines_read on solicitudes_pago_lineas;create policy pr_lines_read on solicitudes_pago_lineas for select to authenticated using(exists(select 1 from solicitudes_pago h where h.id=id_solicitud and h.id_subsidiaria=active_subsidiary_id()));
drop policy if exists pr_events_read on solicitudes_pago_eventos;create policy pr_events_read on solicitudes_pago_eventos for select to authenticated using(exists(select 1 from solicitudes_pago h where h.id=id_solicitud and h.id_subsidiaria=active_subsidiary_id()));
revoke all on solicitudes_pago,solicitudes_pago_lineas,solicitudes_pago_eventos from public,anon,authenticated;
grant select on solicitudes_pago,solicitudes_pago_lineas,solicitudes_pago_eventos to authenticated;

create or replace function pr_access() returns bigint language plpgsql stable security definer set search_path=public,pg_temp as $$
declare sid bigint:=active_subsidiary_id();begin
 if sid is null or app_user_id() is null or not exists(select 1 from user_subsidiaries where subsidiary_id=sid and user_id=app_user_id()) then raise exception 'Seleccione una subsidiaria autorizada.';end if;return sid;end$$;
create or replace function pr_can_approve() returns boolean language sql stable security definer set search_path=public,pg_temp as $$
 select app_is_admin() or exists(select 1 from subsidiaries where subsidiary_id=pr_access() and administrative_approver='user:'||app_user_id())
$$;
create or replace function pr_can_execute() returns boolean language sql stable security definer set search_path=public,pg_temp as $$
 select app_is_admin() or exists(select 1 from roles r join user_roles u using(role_id) where r.role_id=app_active_role_id() and u.user_id=app_user_id() and lower(r.role_name) in ('tesoreria','tesorería','tesorero','tesorera','treasury'))
$$;
-- Exclude actual bank/cash mappings, control account codes and their group hierarchy.
create or replace function pr_allowed_account(p_id bigint) returns boolean language sql stable security definer set search_path=public,pg_temp as $$
 select exists(select 1 from chart_accounts a join account_subsidiaries s using(account_id)
 where a.account_id=p_id and s.subsidiary_id=pr_access() and s.is_active and a.category in('Activo','Pasivo') and a.accepts_entries and not a.is_inactive
 and not exists(select 1 from bank_account b where b.account_id=a.account_id)
 and not exists(select 1 from cashbox b where b.account_id=a.account_id)
 and a.account_number!~'^(1102|1105|2105)'
 and a.account_name!~*'banc|caja|efectivo|cash|cuentas? .*por (cobrar|pagar)|cxc|cxp|receivable|payable'
 and not exists(with recursive ancestors as(select g.group_id,g.parent_id,g.group_code,g.group_name from account_group g where g.group_id=a.account_group_id union select g.group_id,g.parent_id,g.group_code,g.group_name from account_group g join ancestors p on g.group_id=p.parent_id)
 select 1 from ancestors where group_code~'^(1102|1105|2105)' or group_name~*'banc|caja|efectivo|cash|cuentas? .*por (cobrar|pagar)|cxc|cxp|receivable|payable'))
$$;
create or replace function pr_invoice_balance(p_id bigint) returns numeric language sql stable security definer set search_path=public,pg_temp as $$
 select greatest(i.total_amount-coalesce((select sum(amount) from supplier_payment_application where invoice_id=i.invoice_id),0)
 -coalesce((select sum(amount) from supplier_credit_note where invoice_id=i.invoice_id),0)
 +coalesce((select sum(amount) from supplier_debit_note where invoice_id=i.invoice_id),0),0)
 from supplier_invoice i where i.invoice_id=p_id and i.subsidiary_id=pr_access()
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
 if not pr_allowed_account(l.id_cuenta_contable) then raise exception 'Cuenta no permitida: use Activo o Pasivo, excluyendo bancos, caja, CxC y CxP.';end if;
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

create or replace function pr_save(p jsonb) returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare sid bigint:=pr_access();h solicitudes_pago%rowtype;l jsonb;rid bigint;tt bigint;num text;vtotal numeric;kind text:=p->>'type';
begin
 if kind is null or kind not in('CXP','OTROS') then raise exception 'Seleccione el tipo de solicitud.';end if;
 if nullif(p->>'plannedDate','') is null or nullif(trim(p->>'concept'),'') is null then raise exception 'Indique fecha programada y concepto.';end if;
 if jsonb_typeof(p->'lines') is distinct from 'array' or jsonb_array_length(p->'lines')=0 or jsonb_array_length(p->'lines')>500 then raise exception 'Agregue entre 1 y 500 lineas.';end if;
 select sum((x->>'amount')::numeric) into vtotal from jsonb_array_elements(p->'lines')x;
 if vtotal is null or vtotal<=0 or vtotal>1000000000000 then raise exception 'Importe no valido.';end if;
 if nullif(p->>'id','') is not null then
 select * into h from solicitudes_pago where id=(p->>'id')::bigint and id_subsidiaria=sid for update;
 if h.id is null or h.estado not in('BORRADOR','RECHAZADO') or (h.id_solicitante<>app_user_id() and not app_is_admin()) then raise exception 'No puede modificar esta solicitud.';end if;
 if h.version is distinct from (p->>'version')::integer then raise exception 'La solicitud cambio. Vuelva a abrirla.';end if;
 rid:=h.id;
 update solicitudes_pago set tipo_solicitud=kind,id_moneda=(p->>'currencyId')::bigint,id_proveedor=case when kind='CXP' then (p->>'supplierId')::bigint end,fecha_pago_programada=(p->>'plannedDate')::date,concepto=trim(p->>'concept'),total=vtotal,estado='BORRADOR',version=version+1,updated_at=now() where id=rid;
 delete from solicitudes_pago_lineas where id_solicitud=rid;
 else
 select transaction_type_id into tt from transaction_types where abbreviation='SOL_PAG';
 begin num:=next_transaction_number(tt,sid);exception when others then num:='SOL_PAG-'||to_char(clock_timestamp(),'YYYYMMDDHH24MISSMS');end;
 insert into solicitudes_pago(numero,id_subsidiaria,id_moneda,tipo_solicitud,fecha_pago_programada,id_solicitante,id_proveedor,concepto,total)
 values(num,sid,(p->>'currencyId')::bigint,kind,(p->>'plannedDate')::date,app_user_id(),case when kind='CXP' then (p->>'supplierId')::bigint end,trim(p->>'concept'),vtotal) returning id into rid;
 end if;
 for l in select value from jsonb_array_elements(p->'lines') loop
 insert into solicitudes_pago_lineas(id_solicitud,id_factura_proveedor,id_cuenta_contable,tipo_tercero,id_cliente,id_proveedor,id_empleado,id_centro_costo,concepto,monto)
 values(rid,case when kind='CXP' then (l->>'invoiceId')::bigint end,case when kind='OTROS' then (l->>'accountId')::bigint end,
 case when kind='OTROS' then l->>'entityType' end,
 case when kind='OTROS' and l->>'entityType'='Cliente' then (l->>'entityId')::bigint end,
 case when kind='OTROS' and l->>'entityType'='Proveedor' then (l->>'entityId')::bigint end,
 case when kind='OTROS' and l->>'entityType'='Empleado' then (l->>'entityId')::bigint end,
 case when kind='OTROS' then nullif(l->>'costCenterId','')::bigint end,l->>'concept',(l->>'amount')::numeric);
 end loop;
 perform pr_validate(rid);
 insert into solicitudes_pago_eventos(id_solicitud,usuario,accion) values(rid,app_user_id(),'GUARDAR_BORRADOR');
 return jsonb_build_object('id',rid);
end$$;

create or replace function pr_transition(p jsonb) returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare sid bigint:=pr_access();h solicitudes_pago%rowtype;act text:=p->>'transition';target text;
begin
 select * into h from solicitudes_pago where id=(p->>'id')::bigint and id_subsidiaria=sid for update;
 if h.id is null then raise exception 'Solicitud no encontrada.';end if;
 if h.version is distinct from (p->>'version')::integer then raise exception 'La solicitud cambio. Vuelva a abrirla.';end if;
 if act='SUBMIT' and h.estado='BORRADOR' and (h.id_solicitante=app_user_id() or app_is_admin()) then perform pr_validate(h.id);target:='PENDIENTE_APROBACION';
 elsif act in('APPROVE','REJECT') and h.estado='PENDIENTE_APROBACION' and pr_can_approve() then
 if act='APPROVE' then perform pr_validate(h.id);target:='APROBADO';else target:='RECHAZADO';end if;
 elsif act='CANCEL' and h.estado in('BORRADOR','PENDIENTE_APROBACION','RECHAZADO','APROBADO') and ((h.estado<>'APROBADO' and h.id_solicitante=app_user_id()) or pr_can_approve()) then target:='ANULADO';
 else raise exception 'Accion no permitida para su usuario o para el estado actual.';end if;
 if act in('REJECT','CANCEL') and nullif(trim(p->>'reason'),'') is null then raise exception 'Indique el motivo.';end if;
 update solicitudes_pago set estado=target,version=version+1,updated_at=now(),aprobado_por=case when target='APROBADO' then app_user_id() else aprobado_por end,aprobado_at=case when target='APROBADO' then now() else aprobado_at end where id=h.id;
 insert into solicitudes_pago_eventos(id_solicitud,usuario,accion,nota) values(h.id,app_user_id(),target,p->>'reason');return jsonb_build_object('id',h.id);
end$$;

create or replace function pr_execute(p jsonb) returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare sid bigint:=pr_access();h solicitudes_pago%rowtype;ba bank_account%rowtype;d date:=(p->>'date')::date;rate numeric:=(p->>'rate')::numeric;per bigint;data jsonb;result jsonb;jid bigint;tid bigint;method text:=p->>'method';
begin
 if not pr_can_execute() then raise exception 'Solo Tesoreria o un administrador puede ejecutar pagos.';end if;
 select * into h from solicitudes_pago where id=(p->>'id')::bigint and id_subsidiaria=sid for update;
 if h.id is null then raise exception 'Solicitud no encontrada.';end if;
 if h.estado='APLICADO' then return jsonb_build_object('id',h.id,'journalId',h.journal_id);end if;
 if h.estado<>'APROBADO' or h.version is distinct from (p->>'version')::integer then raise exception 'Solo puede ejecutar una solicitud aprobada y actualizada.';end if;
 if method is null or method not in('TRANSFERENCIA','CHEQUE','SINPE') or nullif(trim(p->>'reference'),'') is null then raise exception 'Seleccione metodo y referencia bancaria.';end if;
 if d is null or rate is null or rate<=0 or rate>1000000000 then raise exception 'Indique fecha real de pago y tipo de cambio positivo.';end if;
 select * into ba from bank_account where bank_account_id=(p->>'bankId')::bigint and subsidiary_id=sid and not coalesce(is_credit_card,false) for update;
 if ba.bank_account_id is null or ba.currency_id<>h.id_moneda then raise exception 'Seleccione un banco de la subsidiaria en la moneda de la solicitud.';end if;
 if h.id_moneda=(select currency_id from subsidiaries where subsidiary_id=sid) and rate<>1 then raise exception 'La moneda funcional requiere tasa 1.';end if;
 select fiscal_period_id into per from fiscal_periods where subsidiary_id=sid and d between start_date and end_date and not is_closed and not gl_closed and not is_inactive and (h.tipo_solicitud<>'CXP' or not ap_closed) order by start_date desc limit 1 for update;
 if per is null then raise exception 'No existe periodo contable abierto para ejecutar el pago.';end if;
 lock table supplier_payment_application,supplier_credit_note,supplier_debit_note in share row exclusive mode;
 perform 1 from supplier_invoice where invoice_id in(select id_factura_proveedor from solicitudes_pago_lineas where id_solicitud=h.id) order by invoice_id for update;
 perform pr_validate(h.id);
 if h.tipo_solicitud='CXP' then
 select jsonb_agg(jsonb_build_object('invoice_id',id_factura_proveedor,'amount',monto)) into data from solicitudes_pago_lineas where id_solicitud=h.id;
 perform set_config('nexo.payment_request_id',h.id::text,true);
 result:=save_supplier_payment(jsonb_build_object('date',d,'rate',rate,'period_id',per,'supplier_id',h.id_proveedor,'account_id',ba.bank_account_id,'reference',p->>'reference','memo',h.numero||' / '||h.concepto||' / '||method,'applications',data));
 perform set_config('nexo.payment_request_id','',true);
 jid:=(result->>'journalId')::bigint;
 select transaction_id into tid from supplier_payment where payment_id=(result->>'id')::bigint;
 update "transaction" set transaction_type_id=(select transaction_type_id from transaction_types where abbreviation='PAG_PRO') where transaction_id=tid;
 update solicitudes_pago set payment_id=(result->>'id')::bigint where id=h.id;
 else
 select jsonb_agg(jsonb_build_object('account_id',id_cuenta_contable,'amount',monto,'entity_type',tipo_tercero,'entity_id',coalesce(id_cliente,id_proveedor,id_empleado),'cost_center_id',id_centro_costo,'note',concepto)) into data from solicitudes_pago_lineas where id_solicitud=h.id;
 result:=save_bank_check_transfer(jsonb_build_object('payment_type',case when method='SINPE' then 'TRANSFERENCIA' else method end,'payment_date',d,'exchange_rate',rate,'fiscal_period_id',per,'bank_account_id',ba.bank_account_id,'currency_id',h.id_moneda,'bank_reference',p->>'reference','beneficiary',h.concepto,'memo',h.numero||' / '||h.concepto||' / '||method,'lines',data));
 jid:=(result->>'journalId')::bigint;update solicitudes_pago set check_id=(result->>'checkId')::bigint where id=h.id;
 end if;
 update solicitudes_pago set estado='APLICADO',journal_id=jid,metodo_pago=method,referencia_bancaria=p->>'reference',aplicado_por=app_user_id(),aplicado_at=now(),version=version+1,updated_at=now() where id=h.id;
 insert into solicitudes_pago_eventos(id_solicitud,usuario,accion,nota) values(h.id,app_user_id(),'APLICADO',method||' / '||(p->>'reference'));
 return jsonb_build_object('id',h.id,'journalId',jid);
end$$;

create or replace function pr_options() returns jsonb language plpgsql stable security definer set search_path=public,pg_temp as $$
declare sid bigint:=pr_access();result jsonb;begin
 select jsonb_build_object('userId',app_user_id(),'admin',app_is_admin(),'canApprove',pr_can_approve(),'canExecute',pr_can_execute(),
 'company',(select name from subsidiaries where subsidiary_id=sid),'baseCurrencyId',(select currency_id from subsidiaries where subsidiary_id=sid),
 'currencies',coalesce((select jsonb_agg(jsonb_build_object('id',c.currency_id,'name',c.currency_code)) from currencies c where c.currency_id in(select currency_id from subsidiary_currencies where subsidiary_id=sid union select currency_id from subsidiaries where subsidiary_id=sid)),'[]'),
 'suppliers',coalesce((select jsonb_agg(jsonb_build_object('id',s.supplier_id,'name',concat_ws(' / ',s.company_name,s.tax_id)) order by s.company_name) from suppliers s where s.primary_subsidiary_id=sid or exists(select 1 from entity_subsidiaries e where e.supplier_id=s.supplier_id and e.subsidiary_id=sid)),'[]'),
 'customers',coalesce((select jsonb_agg(jsonb_build_object('id',c.customer_id,'name',c.company_name) order by c.company_name) from customers c where c.primary_subsidiary_id=sid or exists(select 1 from entity_subsidiaries e where e.customer_id=c.customer_id and e.subsidiary_id=sid)),'[]'),
 'employees',coalesce((select jsonb_agg(jsonb_build_object('id',employee_id,'name',concat_ws(' ',first_name,last_name))) from employees where subsidiary_id=sid and is_active),'[]'),
 'users',coalesce((select jsonb_agg(jsonb_build_object('id',u.user_id,'name',u.email)) from users u join user_subsidiaries s using(user_id) where s.subsidiary_id=sid),'[]'),
 'accounts',coalesce((select jsonb_agg(jsonb_build_object('id',account_id,'name',account_number||' / '||account_name) order by account_number) from chart_accounts where pr_allowed_account(account_id)),'[]'),
 'costCenters',coalesce((select jsonb_agg(jsonb_build_object('id',cost_center_id,'name',name)) from cost_centers where subsidiary_id=sid),'[]'),
 'banks',coalesce((select jsonb_agg(jsonb_build_object('id',b.bank_account_id,'name',concat_ws(' / ',k.bank_name,b.account_number,c.currency_code),'currencyId',b.currency_id)) from bank_account b join banks k using(bank_id) join currencies c using(currency_id) where b.subsidiary_id=sid and not coalesce(b.is_credit_card,false)),'[]'),
 'rates',coalesce((select jsonb_agg(jsonb_build_object('currencyId',from_currency_id,'date',effective_date,'rate',spot_rate) order by effective_date desc) from exchange_rates where to_currency_id=(select currency_id from subsidiaries where subsidiary_id=sid)),'[]')
 ) into result;return result;end$$;
create or replace function pr_invoices(p jsonb) returns jsonb language sql stable security definer set search_path=public,pg_temp as $$
 select coalesce(jsonb_agg(jsonb_build_object('id',q.invoice_id,'number',q.invoice_number,'date',q.invoice_date,'dueDate',q.due_date,'total',q.total_amount,'balance',q.balance,'reserved',q.reserved,'available',greatest(q.balance-q.reserved,0)) order by q.due_date,q.invoice_id),'[]')
 from(select i.*,pr_invoice_balance(i.invoice_id) balance,coalesce((select sum(l.monto) from solicitudes_pago_lineas l join solicitudes_pago h on h.id=l.id_solicitud where l.id_factura_proveedor=i.invoice_id and h.estado in('BORRADOR','PENDIENTE_APROBACION','APROBADO') and h.id is distinct from nullif(p->>'requestId','')::bigint),0) reserved
 from supplier_invoice i where i.subsidiary_id=pr_access() and i.supplier_id=(p->>'supplierId')::bigint and i.currency_id=(p->>'currencyId')::bigint)q
 where q.balance>0
$$;
create or replace function supplier_payment_request_locks() returns jsonb language sql stable security definer set search_path=public,pg_temp as $$
 select coalesce(jsonb_agg(jsonb_build_object('invoiceId',l.id_factura_proveedor,'requestId',h.id,'requestNumber',h.numero,'status',h.estado,'amount',l.monto) order by h.id),'[]')
 from solicitudes_pago h join solicitudes_pago_lineas l on l.id_solicitud=h.id
 where h.id_subsidiaria=pr_access() and h.tipo_solicitud='CXP' and h.estado in('PENDIENTE_APROBACION','APROBADO')
$$;
create or replace function pr_report(p jsonb) returns jsonb language sql stable security definer set search_path=public,pg_temp as $$
 select coalesce(jsonb_agg(to_jsonb(q) order by q.id desc),'[]') from(select h.*,u.email solicitante,s.company_name proveedor,c.currency_code moneda from solicitudes_pago h join users u on u.user_id=h.id_solicitante left join suppliers s on s.supplier_id=h.id_proveedor join currencies c on c.currency_id=h.id_moneda
 where h.id_subsidiaria=pr_access()
 and(case when p->>'dateField'='planned' then h.fecha_pago_programada else h.fecha_solicitud end) between coalesce(nullif(p->>'from','')::date,'1900-01-01') and coalesce(nullif(p->>'to','')::date,'2999-12-31')
 and(nullif(p->>'status','') is null or h.estado=p->>'status') and(nullif(p->>'type','') is null or h.tipo_solicitud=p->>'type')
 and(nullif(p->>'requesterId','') is null or h.id_solicitante=(p->>'requesterId')::bigint)
 and(nullif(p->>'supplierId','') is null or h.id_proveedor=(p->>'supplierId')::bigint))q
$$;
create or replace function pr_detail(p jsonb) returns jsonb language plpgsql stable security definer set search_path=public,pg_temp as $$
declare h solicitudes_pago%rowtype;begin select * into h from solicitudes_pago where id=(p->>'id')::bigint and id_subsidiaria=pr_access();if h.id is null then raise exception 'Solicitud no encontrada.';end if;
 return jsonb_build_object('header',to_jsonb(h),'lines',coalesce((select jsonb_agg(to_jsonb(l)||jsonb_build_object('invoiceNumber',i.invoice_number,'invoiceDate',i.invoice_date,'invoiceDueDate',i.due_date,'invoiceTotal',i.total_amount,'accountName',a.account_number||' / '||a.account_name,'party',coalesce(c.company_name,s.company_name,concat_ws(' ',e.first_name,e.last_name)),'costCenter',cc.name) order by l.id) from solicitudes_pago_lineas l left join supplier_invoice i on i.invoice_id=l.id_factura_proveedor left join chart_accounts a on a.account_id=l.id_cuenta_contable left join customers c on c.customer_id=l.id_cliente left join suppliers s on s.supplier_id=l.id_proveedor left join employees e on e.employee_id=l.id_empleado left join cost_centers cc on cc.cost_center_id=l.id_centro_costo where l.id_solicitud=h.id),'[]'),
 'events',coalesce((select jsonb_agg(to_jsonb(e)||jsonb_build_object('user',u.email) order by e.id) from solicitudes_pago_eventos e join users u on u.user_id=e.usuario where e.id_solicitud=h.id),'[]'));
end$$;
-- Keep executed documents immutable through the existing payment/journal editors.
create or replace function pr_protect_payment() returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
declare protected boolean;begin
 if tg_table_name='supplier_payment' then select exists(select 1 from solicitudes_pago where payment_id=old.payment_id and estado='APLICADO') into protected;
 elsif tg_table_name='bank_check' then select exists(select 1 from solicitudes_pago where check_id=old.check_id and estado='APLICADO') into protected;
 elsif tg_table_name='journal' then select exists(select 1 from solicitudes_pago where journal_id=old.journal_id and estado='APLICADO') into protected;
 else select exists(select 1 from solicitudes_pago where journal_id in(new.journal_id,old.journal_id) and estado='APLICADO') into protected;end if;
 if protected then raise exception 'El pago pertenece a una solicitud aplicada y no puede modificarse desde este editor.';end if;
 return case when tg_op='DELETE' then old else new end;end$$;
drop trigger if exists pr_protect on supplier_payment;create trigger pr_protect before update or delete on supplier_payment for each row execute function pr_protect_payment();
drop trigger if exists pr_protect on bank_check;create trigger pr_protect before update or delete on bank_check for each row execute function pr_protect_payment();
drop trigger if exists pr_protect on journal;create trigger pr_protect before update or delete on journal for each row execute function pr_protect_payment();
drop trigger if exists pr_protect on journal_line;create trigger pr_protect before insert or update or delete on journal_line for each row execute function pr_protect_payment();
create or replace function pr_protect_invoice_payment() returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
declare blocker record;allowed bigint:=nullif(current_setting('nexo.payment_request_id',true),'')::bigint;
begin
 select h.id,h.numero,h.estado into blocker from solicitudes_pago h join solicitudes_pago_lineas l on l.id_solicitud=h.id
 where l.id_factura_proveedor=new.invoice_id and h.estado in('PENDIENTE_APROBACION','APROBADO') and h.id is distinct from allowed order by h.id limit 1;
 if blocker.id is not null then raise exception 'La factura tiene la Solicitud de Pago % en estado %. Ejecute o anule esa solicitud desde Tesoreria.',blocker.numero,replace(blocker.estado,'_',' ');end if;
 return new;
end$$;
drop trigger if exists pr_protect_invoice_payment on supplier_payment_application;
create trigger pr_protect_invoice_payment before insert or update of invoice_id,amount on supplier_payment_application for each row execute function pr_protect_invoice_payment();
revoke all on function pr_access(),pr_can_approve(),pr_can_execute(),pr_allowed_account(bigint),pr_invoice_balance(bigint),pr_validate(bigint),pr_protect_payment(),pr_protect_invoice_payment() from public,anon,authenticated;
revoke all on function pr_options(),pr_invoices(jsonb),supplier_payment_request_locks(),pr_report(jsonb),pr_detail(jsonb),pr_save(jsonb),pr_transition(jsonb),pr_execute(jsonb) from public,anon;
grant execute on function pr_options(),pr_invoices(jsonb),supplier_payment_request_locks(),pr_report(jsonb),pr_detail(jsonb),pr_save(jsonb),pr_transition(jsonb),pr_execute(jsonb) to authenticated;
notify pgrst,'reload schema';
