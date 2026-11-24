alter table report_delivery_private.receivable_discount_marks
 add column financial_creditor_id bigint references public.financial_creditors(financial_creditor_id),
 add column operation_number text check(length(operation_number)<=120),
 add column operation_due_date date;
alter table report_delivery_private.receivable_discount_history
 add column financial_creditor_id bigint,
 add column operation_number text,
 add column operation_due_date date;

create function public.save_receivable_discount_operation(p_invoice_id bigint,p_creditor_id bigint,p_operation text,p_due_date date,p_expected boolean,p_expected_at timestamptz)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$
declare uid bigint;sid bigint;old_mark report_delivery_private.receivable_discount_marks;result jsonb;
begin
 perform report_template_private.enter('reports:accounting-reports','view');
 uid:=public.app_user_id();
 select i.subsidiary_id into sid from public.invoice i join public.user_subsidiaries a on a.subsidiary_id=i.subsidiary_id and a.user_id=uid where i.invoice_id=p_invoice_id;
 if sid is null then raise exception using errcode='42501',message='Factura no disponible en sus subsidiarias autorizadas.';end if;
 if p_expected is null or p_creditor_id is null or nullif(btrim(p_operation),'') is null or length(btrim(p_operation))>120 or p_due_date is null or not isfinite(p_due_date) then raise exception using errcode='22023',message='Complete acreedor financiero, número de operación y vencimiento.';end if;
 if not exists(select 1 from public.financial_creditors c join public.financial_creditor_subsidiaries a using(financial_creditor_id) where c.financial_creditor_id=p_creditor_id and a.subsidiary_id=sid and not coalesce(c.is_inactive,false)) then raise exception using errcode='42501',message='El acreedor financiero no está activo o no pertenece a la subsidiaria de la factura.';end if;
 perform pg_advisory_xact_lock(hashtextextended('receivable-discount:'||p_invoice_id::text,0));
 select * into old_mark from report_delivery_private.receivable_discount_marks where invoice_id=p_invoice_id;
 if coalesce(old_mark.discounted,false)<>p_expected or old_mark.updated_at is distinct from p_expected_at then raise exception using errcode='40001',message='Otro usuario cambió los datos. Consulte nuevamente el informe.';end if;
 insert into report_delivery_private.receivable_discount_marks(invoice_id,discounted,updated_by,financial_creditor_id,operation_number,operation_due_date)
 values(p_invoice_id,true,uid,p_creditor_id,btrim(p_operation),p_due_date)
 on conflict(invoice_id) do update set discounted=true,updated_by=uid,updated_at=clock_timestamp(),financial_creditor_id=excluded.financial_creditor_id,operation_number=excluded.operation_number,operation_due_date=excluded.operation_due_date;
 insert into report_delivery_private.receivable_discount_history(invoice_id,discounted,changed_by,financial_creditor_id,operation_number,operation_due_date)values(p_invoice_id,true,uid,p_creditor_id,btrim(p_operation),p_due_date);
 select to_jsonb(m) into result from report_delivery_private.receivable_discount_marks m where invoice_id=p_invoice_id;
 return result;
end $$;
revoke all on function public.save_receivable_discount_operation(bigint,bigint,text,date,boolean,timestamptz) from public,anon;
grant execute on function public.save_receivable_discount_operation(bigint,bigint,text,date,boolean,timestamptz) to authenticated;
