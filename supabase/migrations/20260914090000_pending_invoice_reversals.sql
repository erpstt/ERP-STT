insert into transaction_types(abbreviation,name,module_category,description)
values('ASI_REV_PEN','Reversión de Pendiente de Facturar','Contabilidad','Reversión total o parcial controlada de un asiento ASI_PEN.')
on conflict(abbreviation)do update set name=excluded.name,module_category=excluded.module_category,description=excluded.description;

alter table journal
 add column if not exists pending_initial_local numeric(24,6) not null default 0,
 add column if not exists pending_initial_foreign numeric(24,6) not null default 0,
 add column if not exists pending_reversed_local numeric(24,6) not null default 0,
 add column if not exists pending_reversed_foreign numeric(24,6) not null default 0,
 add column if not exists pending_balance_local numeric(24,6) not null default 0,
 add column if not exists pending_balance_foreign numeric(24,6) not null default 0,
 add column if not exists reversal_status varchar(24) not null default 'N/A';

alter table journal drop constraint if exists journal_pending_reversal_status_allowed;
alter table journal add constraint journal_pending_reversal_status_allowed check(reversal_status in('N/A','PENDIENTE','REVERSADO_PARCIAL','REVERSADO_TOTAL','ANULADO'));
alter table journal drop constraint if exists journal_pending_reversal_amounts_valid;
alter table journal add constraint journal_pending_reversal_amounts_valid check(pending_initial_local>=0 and pending_initial_foreign>=0 and pending_reversed_local>=0 and pending_reversed_foreign>=0 and pending_balance_local>=0 and pending_balance_foreign>=0 and pending_reversed_local<=pending_initial_local+.000001 and pending_reversed_foreign<=pending_initial_foreign+.000001);

update journal j set pending_initial_local=j.total_debit,pending_initial_foreign=x.foreign,
 pending_balance_local=j.total_debit,pending_balance_foreign=x.foreign,reversal_status=case when j.status='ANULADO'then'ANULADO'else'PENDIENTE'end
from(select journal_id,coalesce(sum(debit_fx),0)foreign from journal_line group by journal_id)x
where x.journal_id=j.journal_id and(j.journal_number like'ASI_PEN-%'or j.journal_type='Asientos Pendientes de Facturar')and j.reversal_status='N/A';

create table if not exists pending_invoice_reversal(
 reversal_id bigint generated always as identity primary key,
 source_journal_id bigint not null references journal(journal_id),
 reversal_journal_id bigint not null unique references journal(journal_id),
 reversal_date date not null,
 reversed_local numeric(24,6)not null check(reversed_local>0),
 reversed_foreign numeric(24,6)not null check(reversed_foreign>=0),
 reversal_type varchar(24)not null check(reversal_type in('FACTURACION','ERROR_CORRECCION')),
 sales_invoice_id bigint references invoice(invoice_id),
 error_description text,
 created_by bigint not null references users(user_id)default app_user_id(),
 created_at timestamptz not null default now(),
 check((reversal_type='FACTURACION'and sales_invoice_id is not null and error_description is null)or(reversal_type='ERROR_CORRECCION'and sales_invoice_id is null and length(trim(error_description))>=15))
);
create index if not exists pending_invoice_reversal_source_idx on pending_invoice_reversal(source_journal_id,reversal_date,reversal_id);

create or replace function refresh_pending_invoice_amounts()returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
declare target bigint:=coalesce(new.journal_id,old.journal_id);
begin
 update journal j set pending_initial_local=x.local_amount,pending_initial_foreign=x.foreign_amount,pending_balance_local=x.local_amount,pending_balance_foreign=x.foreign_amount,reversal_status=case when j.status='ANULADO'then'ANULADO'else'PENDIENTE'end
 from(select coalesce(sum(debit),0)local_amount,coalesce(sum(debit_fx),0)foreign_amount from journal_line where journal_id=target)x
 where j.journal_id=target and(j.journal_number like'ASI_PEN-%'or j.journal_type='Asientos Pendientes de Facturar')and j.pending_reversed_local=0 and j.reversal_status in('N/A','PENDIENTE');
 return coalesce(new,old);
end$$;
drop trigger if exists refresh_pending_invoice_amounts_trigger on journal_line;
create trigger refresh_pending_invoice_amounts_trigger after insert or update or delete on journal_line for each row execute function refresh_pending_invoice_amounts();

create or replace function guard_pending_invoice_generic_reversal()returns trigger language plpgsql set search_path=public,pg_temp as $$
begin
 if old.journal_number like'ASI_PEN-%'or old.journal_type='Asientos Pendientes de Facturar'then
  if new.status='ANULADO'and old.status<>'ANULADO'then
   if exists(select 1 from pending_invoice_reversal where source_journal_id=old.journal_id)then raise exception'No se puede anular un ASI_PEN con reversiones aplicadas.';end if;
   if exists(select 1 from journal where reversed_from_journal_id=old.journal_id)then raise exception'Use la acción Reversar Pendiente para los asientos ASI_PEN.';end if;
   new.reversal_status:='ANULADO';new.pending_balance_local:=0;new.pending_balance_foreign:=0;
  end if;
 end if;
 return new;
end$$;
drop trigger if exists guard_pending_invoice_generic_reversal_trigger on journal;
create trigger guard_pending_invoice_generic_reversal_trigger before update on journal for each row execute function guard_pending_invoice_generic_reversal();

create or replace function pending_invoice_reversal_options(p_journal_id bigint)
returns jsonb language plpgsql stable security definer set search_path=public,pg_temp as $$
declare j journal%rowtype;customer_key bigint;
begin
 select*into j from journal where journal_id=p_journal_id and subsidiary_id in(select subsidiary_id from user_subsidiaries where user_id=app_user_id());
 if j.journal_id is null or not(j.journal_number like'ASI_PEN-%'or j.journal_type='Asientos Pendientes de Facturar')then raise exception'El asiento seleccionado no es un pendiente de facturar.';end if;
 select customer_id into customer_key from journal_line where journal_id=j.journal_id and customer_id is not null order by journal_line_id limit 1;
 return jsonb_build_object('journal',jsonb_build_object('id',j.journal_id,'number',j.journal_number,'date',j.journal_date,'initialLocal',j.pending_initial_local,'initialForeign',j.pending_initial_foreign,'reversedLocal',j.pending_reversed_local,'reversedForeign',j.pending_reversed_foreign,'balanceLocal',j.pending_balance_local,'balanceForeign',j.pending_balance_foreign,'status',j.reversal_status,'currencyId',j.currency_id,'customerId',customer_key),
  'invoices',coalesce((select jsonb_agg(jsonb_build_object('id',i.invoice_id,'number',i.invoice_number,'date',i.invoice_date,'customerId',i.customer_id,'customer',c.company_name,'total',i.total_amount)order by i.invoice_date desc,i.invoice_id desc)from invoice i join customers c using(customer_id)where i.subsidiary_id=j.subsidiary_id and(customer_key is null or i.customer_id=customer_key)),'[]'::jsonb),
  'reversals',coalesce((select jsonb_agg(jsonb_build_object('id',r.reversal_id,'journalId',r.reversal_journal_id,'number',rev.journal_number,'date',r.reversal_date,'amount',r.reversed_local,'type',r.reversal_type,'invoice',i.invoice_number,'reason',r.error_description,'user',coalesce(u.first_name||' '||u.last_name,u.email))order by r.reversal_date,r.reversal_id)from pending_invoice_reversal r join journal rev on rev.journal_id=r.reversal_journal_id left join invoice i on i.invoice_id=r.sales_invoice_id left join users u on u.user_id=r.created_by where r.source_journal_id=j.journal_id),'[]'::jsonb));
end$$;

create or replace function reverse_pending_invoice_journal(p_journal_id bigint,p_payload jsonb)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare src journal%rowtype;d date;amount numeric(24,6);foreign_amount numeric(24,6);ratio numeric(30,15);kind text;invoice_key bigint;reason text;period_key bigint;type_key bigint;status_key bigint;number text;transaction_key bigint;reversal_key bigint;memo_value text;
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
 return jsonb_build_object('journalId',reversal_key,'number',number,'amount',amount,'remaining',greatest(src.pending_balance_local-amount,0));
end$$;

create or replace function pending_invoice_control_options()
returns jsonb language sql stable security definer set search_path=public,pg_temp as $$select jsonb_build_object('customers',coalesce((select jsonb_agg(jsonb_build_object('id',c.customer_id,'name',c.company_name)order by c.company_name)from customers c where exists(select 1 from entity_subsidiaries e join user_subsidiaries u using(subsidiary_id)where e.customer_id=c.customer_id and u.user_id=app_user_id())),'[]'::jsonb))$$;

create or replace function run_pending_invoice_control_report(p_filters jsonb default'{}')
returns jsonb language plpgsql stable security definer set search_path=public,pg_temp as $$
declare sids bigint[];df date;dt date;customer_key bigint;state text;result jsonb;
begin
 select coalesce(array_agg(value::bigint),array[]::bigint[])into sids from jsonb_array_elements_text(coalesce(p_filters->'subsidiaryIds','[]'));if cardinality(sids)=0 then sids:=array[active_subsidiary_id()];end if;
 if exists(select 1 from unnest(sids)x where not exists(select 1 from user_subsidiaries u where u.user_id=app_user_id()and u.subsidiary_id=x))then raise exception'No tiene acceso a la subsidiaria.';end if;
 df:=coalesce(nullif(p_filters->>'dateFrom','')::date,'1900-01-01');dt:=coalesce(nullif(p_filters->>'dateTo','')::date,current_date);customer_key:=nullif(p_filters->>'pendingCustomerId','')::bigint;state:=nullif(p_filters->>'pendingStatus','');
 with base as(select j.*,coalesce(c.customer_id,0)customer_id,coalesce(c.company_name,'Sin tercero asignado')customer from journal j left join lateral(select jl.customer_id,cu.company_name from journal_line jl join customers cu using(customer_id)where jl.journal_id=j.journal_id limit 1)c on true where j.subsidiary_id=any(sids)and j.journal_date between df and dt and(j.journal_number like'ASI_PEN-%'or j.journal_type='Asientos Pendientes de Facturar')and(customer_key is null or c.customer_id=customer_key)and(state is null or j.reversal_status=state))
 select jsonb_build_object('rows',coalesce(jsonb_agg(jsonb_build_object('journal_id',b.journal_id,'journal_number',b.journal_number,'date',b.journal_date,'customer_id',b.customer_id,'customer',b.customer,'initial',b.pending_initial_local,'reversed',b.pending_reversed_local,'balance',b.pending_balance_local,'status',b.reversal_status,'reversals',coalesce((select jsonb_agg(jsonb_build_object('journalId',r.reversal_journal_id,'number',jr.journal_number,'date',r.reversal_date,'amount',r.reversed_local,'type',r.reversal_type,'reference',coalesce(i.invoice_number,r.error_description),'user',coalesce(u.first_name||' '||u.last_name,u.email))order by r.reversal_date,r.reversal_id)from pending_invoice_reversal r join journal jr on jr.journal_id=r.reversal_journal_id left join invoice i on i.invoice_id=r.sales_invoice_id left join users u on u.user_id=r.created_by where r.source_journal_id=b.journal_id),'[]'::jsonb))order by b.journal_date,b.journal_id),'[]'::jsonb),'total',count(*),'summary',jsonb_build_object('initial',coalesce(sum(b.pending_initial_local),0),'reversed',coalesce(sum(b.pending_reversed_local),0),'balance',coalesce(sum(b.pending_balance_local),0)))into result from base b;return result;
end$$;

revoke all on function pending_invoice_reversal_options(bigint),reverse_pending_invoice_journal(bigint,jsonb),pending_invoice_control_options(),run_pending_invoice_control_report(jsonb)from public,anon;
grant execute on function pending_invoice_reversal_options(bigint),reverse_pending_invoice_journal(bigint,jsonb),pending_invoice_control_options(),run_pending_invoice_control_report(jsonb)to authenticated;
notify pgrst,'reload schema';
