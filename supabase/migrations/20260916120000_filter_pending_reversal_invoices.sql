drop function if exists public.pending_invoice_reversal_options(bigint);

create or replace function public.pending_invoice_reversal_options(p_journal_id bigint,p_reversal_date date)
returns jsonb language plpgsql stable security definer set search_path=public,pg_temp as $$
declare j journal%rowtype;customer_key bigint;reversal_month date;
begin
 select*into j from journal where journal_id=p_journal_id and subsidiary_id in(select subsidiary_id from user_subsidiaries where user_id=app_user_id());
 if j.journal_id is null or not(j.journal_number like'ASI_PEN-%'or j.journal_type='Asientos Pendientes de Facturar')then raise exception'El asiento seleccionado no es un pendiente de facturar.';end if;
 if p_reversal_date is null then raise exception'Indique la fecha de reversión para consultar las facturas.';end if;
 select customer_id into customer_key from journal_line where journal_id=j.journal_id and customer_id is not null order by journal_line_id limit 1;
 reversal_month:=date_trunc('month',p_reversal_date)::date;
 return jsonb_build_object('journal',jsonb_build_object('id',j.journal_id,'number',j.journal_number,'date',j.journal_date,'initialLocal',j.pending_initial_local,'initialForeign',j.pending_initial_foreign,'reversedLocal',j.pending_reversed_local,'reversedForeign',j.pending_reversed_foreign,'balanceLocal',j.pending_balance_local,'balanceForeign',j.pending_balance_foreign,'status',j.reversal_status,'currencyId',j.currency_id,'customerId',customer_key),
  'invoices',coalesce((select jsonb_agg(jsonb_build_object('id',i.invoice_id,'number',i.invoice_number,'date',i.invoice_date,'customerId',i.customer_id,'customer',c.company_name,'total',i.total_amount)order by i.invoice_date desc,i.invoice_id desc)from invoice i join customers c using(customer_id)where customer_key is not null and i.subsidiary_id=j.subsidiary_id and i.customer_id=customer_key and i.invoice_date>=reversal_month and i.invoice_date<reversal_month+interval'1 month'),'[]'::jsonb),
  'reversals',coalesce((select jsonb_agg(jsonb_build_object('id',r.reversal_id,'journalId',r.reversal_journal_id,'number',rev.journal_number,'date',r.reversal_date,'amount',r.reversed_local,'type',r.reversal_type,'invoice',i.invoice_number,'reason',r.error_description,'user',coalesce(u.first_name||' '||u.last_name,u.email))order by r.reversal_date,r.reversal_id)from pending_invoice_reversal r join journal rev on rev.journal_id=r.reversal_journal_id left join invoice i on i.invoice_id=r.sales_invoice_id left join users u on u.user_id=r.created_by where r.source_journal_id=j.journal_id),'[]'::jsonb));
end$$;

create or replace function public.validate_pending_reversal_invoice()
returns trigger language plpgsql set search_path=public,pg_temp as $$
declare source_customer bigint;linked_invoice invoice%rowtype;
begin
 if new.reversal_type<>'FACTURACION' then return new;end if;
 select customer_id into source_customer from journal_line where journal_id=new.source_journal_id and customer_id is not null order by journal_line_id limit 1;
 select*into linked_invoice from invoice where invoice_id=new.sales_invoice_id;
 if source_customer is null or linked_invoice.invoice_id is null or linked_invoice.customer_id<>source_customer or date_trunc('month',linked_invoice.invoice_date)<>date_trunc('month',new.reversal_date) then
  raise exception'La factura vinculada debe pertenecer al cliente o tercero del asiento y al mismo mes de la reversión.';
 end if;
 return new;
end$$;

drop trigger if exists validate_pending_reversal_invoice_trigger on public.pending_invoice_reversal;
create trigger validate_pending_reversal_invoice_trigger before insert or update of source_journal_id,reversal_date,reversal_type,sales_invoice_id on public.pending_invoice_reversal for each row execute function public.validate_pending_reversal_invoice();

revoke all on function public.pending_invoice_reversal_options(bigint,date) from public,anon;
grant execute on function public.pending_invoice_reversal_options(bigint,date) to authenticated;
notify pgrst,'reload schema';
