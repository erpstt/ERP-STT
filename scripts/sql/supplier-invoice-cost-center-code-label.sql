do $change$
declare current_definition text; updated_definition text;
begin
 current_definition:=pg_get_functiondef('public.supplier_invoice_form_options(bigint)'::regprocedure);
 updated_definition:=replace(current_definition,
 'array[''cost_center_id'',''name'',''cost_center_type'',''department_id'',''customer_id'',''class_id'',''is_inactive'',''is_active'']',
 'array[''cost_center_id'',''code'',''name'',''cost_center_type'',''department_id'',''customer_id'',''class_id'',''is_inactive'',''is_active'']');
 if updated_definition=current_definition then raise exception 'Unexpected supplier invoice cost-center projection';end if;
 execute updated_definition;
end $change$;
