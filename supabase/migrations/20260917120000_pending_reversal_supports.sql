-- Save supporting files and links atomically with error/correction reversals.
create or replace function reverse_pending_invoice_journal(p_journal_id bigint,p_payload jsonb)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare src journal%rowtype;d date;amount numeric(24,6);foreign_amount numeric(24,6);ratio numeric(30,15);kind text;invoice_key bigint;reason text;period_key bigint;type_key bigint;status_key bigint;number text;transaction_key bigint;reversal_key bigint;memo_value text;support jsonb;supports jsonb;
begin
 if not exists(select 1 from user_roles ur join role_permissions rp using(role_id)join permissions p using(permission_id)where ur.user_id=app_user_id()and p.code='accounting:journal:reverse')then raise exception'No tiene permiso para reversar asientos.';end if;
 select*into src from journal where journal_id=p_journal_id and subsidiary_id in(select subsidiary_id from user_subsidiaries where user_id=app_user_id())for update;
 if src.journal_id is null or not(src.journal_number like'ASI_PEN-%'or src.journal_type='Asientos Pendientes de Facturar')then raise exception'El asiento seleccionado no es ASI_PEN.';end if;
 if src.status<>'CONTABILIZADO'or src.reversal_status in('REVERSADO_TOTAL','ANULADO')then raise exception'El asiento no tiene saldo disponible para reversar.';end if;
 d:=nullif(p_payload->>'reversalDate','')::date;amount:=nullif(p_payload->>'amount','')::numeric;kind:=p_payload->>'type';invoice_key:=nullif(p_payload->>'invoiceId','')::bigint;reason:=nullif(trim(p_payload->>'errorDescription'),'');
 if d is null or amount is null or amount<=0 then raise exception'Indique una fecha y un monto de reversión válidos.';end if;
 if amount>src.pending_balance_local+.000001 then raise exception'El monto a reversar (%) supera el saldo disponible pendiente del asiento (%).',to_char(amount,'FM999G999G999G990D00'),to_char(src.pending_balance_local,'FM999G999G999G990D00');end if;
 if kind not in('FACTURACION','ERROR_CORRECCION')then raise exception'Seleccione el tipo de reversión.';end if;
 if kind='FACTURACION'and(invoice_key is null or not exists(select 1 from invoice i where i.invoice_id=invoice_key and i.subsidiary_id=src.subsidiary_id and(not exists(select 1 from journal_line jl where jl.journal_id=src.journal_id and jl.customer_id is not null)or i.customer_id in(select jl.customer_id from journal_line jl where jl.journal_id=src.journal_id and jl.customer_id is not null))))then raise exception'Seleccione una factura de venta válida para el cliente del asiento.';end if;
 if kind='ERROR_CORRECCION'and(reason is null or length(reason)<15)then raise exception'La descripción del error debe contener al menos 15 caracteres.';end if;
 supports:=coalesce(p_payload->'supports','[]'::jsonb);
 if jsonb_typeof(supports)<>'array' then raise exception 'Los archivos de respaldo no son válidos.';end if;
 if jsonb_array_length(supports)>0 and kind is distinct from 'ERROR_CORRECCION' then raise exception 'Solo las reversiones por error / corrección permiten archivos de respaldo.';end if;
 for support in select value from jsonb_array_elements(supports) loop
  if support->>'support_type'='Enlace' then
   if nullif(trim(support->>'display_name'),'') is null or coalesce(support->>'support_url','') !~* '^https?://[^[:space:]/?#]+[^[:space:]]*$' then raise exception 'Ingrese un enlace de respaldo válido que comience con http:// o https://';end if;
  elsif support->>'support_type'='Archivo' then
  if nullif(trim(support->>'file_name'),'') is null or nullif(trim(support->>'display_name'),'') is null or support->>'file_data' is null or coalesce((support->>'file_size')::bigint,-1) not between 0 and 5242880 then raise exception 'Archivo de respaldo inválido o superior a 5 MB.';end if;
  if length(support->>'file_data')>7100000 or (support->>'file_data') !~ '^data:[^,]*;base64,' then raise exception 'El contenido del archivo de respaldo no es válido.';end if;
  if octet_length(decode(split_part(support->>'file_data',',',2),'base64'))<>(support->>'file_size')::bigint then raise exception 'El tamaño del archivo de respaldo no coincide con su contenido.';end if;
  else raise exception 'Tipo de respaldo no válido.';end if;
 end loop;
 select fiscal_period_id into period_key from fiscal_periods where subsidiary_id=src.subsidiary_id and d between start_date and end_date and not is_closed and not coalesce(gl_closed,false)and not coalesce(is_inactive,false)order by start_date desc limit 1 for update;
 if period_key is null then raise exception'No existe un período contable abierto para la fecha de reversión.';end if;
 select transaction_type_id into type_key from transaction_types where abbreviation='ASI_REV_PEN';select status_id into status_key from"transaction"where transaction_id=src.transaction_id;
 insert into number_sequences(scope_type,transaction_type_id,subsidiary_id,prefix,current_number,padding_length)values('Transacción',type_key,src.subsidiary_id,'ASI_REV_PEN-',0,8)on conflict(transaction_type_id,subsidiary_id)where scope_type='Transacción'do nothing;
 number:=next_transaction_number(type_key,src.subsidiary_id);ratio:=amount/src.pending_initial_local;foreign_amount:=round(src.pending_initial_foreign*ratio,6);memo_value:=case when kind='FACTURACION'then'Reversión de '||src.journal_number||' por factura '||(select invoice_number from invoice where invoice_id=invoice_key)else'Reversión de '||src.journal_number||': '||reason end;
 insert into"transaction"(tran_number,tran_date,transaction_type_id,subsidiary_id,currency_id,exchange_rate,fiscal_period_id,total_amount,status_id)values(number,d,type_key,src.subsidiary_id,src.currency_id,src.exchange_rate,period_key,amount,status_key)returning transaction_id into transaction_key;
 insert into journal(journal_number,journal_date,transaction_id,subsidiary_id,currency_id,fiscal_period_id,exchange_rate,memo,journal_type,total_debit,total_credit,status,created_by,reversed_from_journal_id)values(number,d,transaction_key,src.subsidiary_id,src.currency_id,period_key,src.exchange_rate,memo_value,'Reversión de Pendiente de Facturar',amount,amount,'CONTABILIZADO',app_user_id(),src.journal_id)returning journal_id into reversal_key;
 insert into journal_line(journal_id,account_id,debit,credit,debit_fx,credit_fx,department_id,class_id,location_id,tax_code_id,tax_rate,gross_amount,note,entity_type,customer_id,supplier_id,employee_id,cost_center_id,financial_creditor_id,related_company_id)
 select reversal_key,account_id,round(credit*ratio,6),round(debit*ratio,6),round(credit_fx*ratio,6),round(debit_fx*ratio,6),department_id,class_id,location_id,tax_code_id,tax_rate,round(coalesce(gross_amount,0)*ratio,6),memo_value,entity_type,customer_id,supplier_id,employee_id,cost_center_id,financial_creditor_id,related_company_id from journal_line where journal_id=src.journal_id;
 perform sync_journal_gl_impacts(reversal_key);
 insert into pending_invoice_reversal(source_journal_id,reversal_journal_id,reversal_date,reversed_local,reversed_foreign,reversal_type,sales_invoice_id,error_description)values(src.journal_id,reversal_key,d,amount,foreign_amount,kind,case when kind='FACTURACION'then invoice_key end,case when kind='ERROR_CORRECCION'then reason end);
 perform set_config('app.pending_reversal_write','1',true);
 update journal set pending_reversed_local=pending_reversed_local+amount,pending_reversed_foreign=pending_reversed_foreign+foreign_amount,pending_balance_local=greatest(pending_initial_local-pending_reversed_local-amount,0),pending_balance_foreign=greatest(pending_initial_foreign-pending_reversed_foreign-foreign_amount,0),reversal_status=case when pending_initial_local-pending_reversed_local-amount<=.000001 then'REVERSADO_TOTAL'else'REVERSADO_PARCIAL'end where journal_id=src.journal_id;
 for support in select value from jsonb_array_elements(supports) loop
  if support->>'support_type'='Enlace' then
   insert into journal_support(journal_id,support_type,display_name,support_url)values(reversal_key,'Enlace',support->>'display_name',support->>'support_url');
  else
  insert into journal_support(journal_id,support_type,display_name,file_name,mime_type,file_size,file_data)
  values(reversal_key,'Archivo',support->>'display_name',support->>'file_name',coalesce(support->>'mime_type','application/octet-stream'),(support->>'file_size')::bigint,support->>'file_data');
  end if;
 end loop;
 return jsonb_build_object('journalId' ,reversal_key,'number',number,'amount',amount,'remaining',greatest(src.pending_balance_local-amount,0));
end$$;
