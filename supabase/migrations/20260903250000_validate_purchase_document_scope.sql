create or replace function validate_purchase_document_header_scope() returns trigger
language plpgsql security definer set search_path=public,pg_temp as $$
begin
 if new.subsidiary_id<>active_subsidiary_id() then raise exception 'La subsidiaria del documento no corresponde a la subsidiaria activa.'; end if;
 if new.location_id is null or not exists(select 1 from locations l left join location_subsidiaries ls using(location_id) where l.location_id=new.location_id and (l.subsidiary_id=new.subsidiary_id or ls.subsidiary_id=new.subsidiary_id)) then raise exception 'Seleccione una ubicación de la subsidiaria activa.'; end if;
 if not exists(select 1 from currencies c where c.currency_id=new.currency_id and (c.currency_id=(select currency_id from subsidiaries where subsidiary_id=new.subsidiary_id) or exists(select 1 from subsidiary_currencies sc where sc.subsidiary_id=new.subsidiary_id and sc.currency_id=c.currency_id))) then raise exception 'La moneda no está habilitada para la subsidiaria.'; end if;
 return new;
end$$;
drop trigger if exists validate_purchase_document_header_scope_trigger on purchase_document;
create trigger validate_purchase_document_header_scope_trigger before insert or update on purchase_document for each row execute function validate_purchase_document_header_scope();

create or replace function validate_purchase_document_line_scope() returns trigger
language plpgsql security definer set search_path=public,pg_temp as $$
declare d purchase_document%rowtype;p products%rowtype;a chart_accounts%rowtype;expected_type text;actual_type text;
begin
 select * into d from purchase_document where document_id=new.document_id;
 select * into p from products where product_id=new.product_id;
 if p.product_id is null or not p.is_active or p.product_usage not in('Compra','Ambas') or not exists(select 1 from product_subsidiaries ps where ps.product_id=p.product_id and ps.subsidiary_id=d.subsidiary_id and ps.is_active) then raise exception 'El artículo debe estar activo, pertenecer a la subsidiaria y ser de Compra o Ambas.'; end if;
 if new.account_id is distinct from p.purchase_account_id then raise exception 'La cuenta contable debe ser la cuenta de compras configurada en el artículo.'; end if;
 if new.tax_code_id is not null and not exists(select 1 from tax_codes t left join tax_code_subsidiaries ts using(tax_code_id) where t.tax_code_id=new.tax_code_id and (t.subsidiary_id=d.subsidiary_id or ts.subsidiary_id=d.subsidiary_id)) then raise exception 'El impuesto no pertenece a la subsidiaria.'; end if;
 select * into a from chart_accounts where account_id=new.account_id;
 expected_type:=case when a.category='Costo' then 'Cliente' when a.category='Gasto' then 'Interno' else null end;
 if expected_type is null and exists(select 1 from account_group g where g.group_id=a.account_group_id and g.group_name~*'propiedad.*planta.*equipo|activo fijo') then expected_type:='Interno'; end if;
 if new.department_id is not null then select type into actual_type from departments where department_id=new.department_id;if expected_type is not null and actual_type<>expected_type then raise exception 'El tipo de departamento no corresponde a la clasificación de la cuenta.';end if;end if;
 if new.cost_center_id is not null and not exists(select 1 from cost_centers cc join customers cu using(customer_id) where cc.cost_center_id=new.cost_center_id and cu.department_id=new.department_id) then raise exception 'El centro de costos no corresponde al departamento.';end if;
 if new.cost_center_id is not null and new.class_id is distinct from(select class_id from cost_centers where cost_center_id=new.cost_center_id) then raise exception 'La clase debe corresponder al centro de costos.';end if;
 return new;
end$$;
drop trigger if exists validate_purchase_document_line_scope_trigger on purchase_document_line;
create trigger validate_purchase_document_line_scope_trigger before insert or update on purchase_document_line for each row execute function validate_purchase_document_line_scope();
