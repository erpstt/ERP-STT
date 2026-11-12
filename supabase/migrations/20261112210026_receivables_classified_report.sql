-- Report-only classification: never changes invoices, applications or journal balances.
create table report_delivery_private.receivable_discount_marks (
 invoice_id bigint primary key references public.invoice(invoice_id) on delete cascade,
 discounted boolean not null,
 updated_at timestamptz not null default clock_timestamp(),
 updated_by bigint not null references public.users(user_id)
);
create table report_delivery_private.receivable_discount_history (
 id bigint generated always as identity primary key,
 invoice_id bigint not null,
 discounted boolean not null,
 changed_at timestamptz not null default clock_timestamp(),
 changed_by bigint not null references public.users(user_id)
);
alter table report_delivery_private.receivable_discount_marks enable row level security;
alter table report_delivery_private.receivable_discount_history enable row level security;
revoke all on report_delivery_private.receivable_discount_marks,report_delivery_private.receivable_discount_history from public,anon,authenticated;

create function public.run_classified_receivables_report(p_filters jsonb default '{}'::jsonb)
returns jsonb language plpgsql stable security definer set search_path=pg_catalog,public,pg_temp as $$
declare result jsonb; enriched jsonb;
begin
 perform report_template_private.enter('reports:accounting-reports','view');
 result:=public.run_aging_report('AR',p_filters);
 select coalesce(jsonb_agg(item.value||jsonb_build_object(
   'discounted',coalesce(mark.discounted,false),
   'discount_updated_at',mark.updated_at,
   'intercompany',case when account.account_id is not null then account.account_number='113002' else coalesce(customer.is_intercompany,false) end
 ) order by item.ordinality),'[]'::jsonb) into enriched
 from jsonb_array_elements(coalesce(result->'rows','[]'::jsonb)) with ordinality item(value,ordinality)
 join public.invoice invoice on invoice.invoice_id=(item.value->>'document_id')::bigint
 join public.customers customer on customer.customer_id=invoice.customer_id
 left join public.chart_accounts account on account.account_id=invoice.receivable_account_id
 left join report_delivery_private.receivable_discount_marks mark using(invoice_id)
 where exists(select 1 from public.user_subsidiaries access where access.user_id=public.app_user_id() and access.subsidiary_id=invoice.subsidiary_id);
 return result||jsonb_build_object('rows',enriched);
end $$;

create function public.set_receivable_discount_mark(p_invoice_id bigint,p_discounted boolean,p_expected boolean)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$
declare current_mark boolean; result jsonb; uid bigint;
begin
 perform report_template_private.enter('reports:accounting-reports','view');
 uid:=public.app_user_id();
 if p_discounted is null or p_expected is null then raise exception using errcode='22023',message='Seleccione una marca válida.';end if;
 if not exists(select 1 from public.invoice i join public.user_subsidiaries access on access.subsidiary_id=i.subsidiary_id and access.user_id=uid where i.invoice_id=p_invoice_id)
 then raise exception using errcode='42501',message='Factura no disponible en sus subsidiarias autorizadas.';end if;
 perform pg_advisory_xact_lock(hashtextextended('receivable-discount:'||p_invoice_id::text,0));
 select discounted into current_mark from report_delivery_private.receivable_discount_marks where invoice_id=p_invoice_id;
 current_mark:=coalesce(current_mark,false);
 if current_mark<>p_expected then raise exception using errcode='40001',message='Otro usuario cambió esta marca. Consulte nuevamente el informe.';end if;
 insert into report_delivery_private.receivable_discount_marks(invoice_id,discounted,updated_by)
 values(p_invoice_id,p_discounted,uid) on conflict(invoice_id)do update set discounted=excluded.discounted,updated_by=excluded.updated_by,updated_at=clock_timestamp();
 if current_mark<>p_discounted then
 insert into report_delivery_private.receivable_discount_history(invoice_id,discounted,changed_by)values(p_invoice_id,p_discounted,uid);
 end if;
 select jsonb_build_object('invoiceId',invoice_id,'discounted',discounted,'updatedAt',updated_at)into result from report_delivery_private.receivable_discount_marks where invoice_id=p_invoice_id;
 return result;
end $$;
revoke all on function public.run_classified_receivables_report(jsonb),public.set_receivable_discount_mark(bigint,boolean,boolean) from public,anon;
grant execute on function public.run_classified_receivables_report(jsonb),public.set_receivable_discount_mark(bigint,boolean,boolean) to authenticated;
