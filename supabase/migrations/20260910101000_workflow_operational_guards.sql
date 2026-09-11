create or replace function wf_require_approved_source()returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
begin
 if tg_table_name='purchase_document'and new.document_type='RECEIPT'and not exists(select 1 from purchase_document where document_id=new.source_document_id and document_type='ORDER'and status='APROBADO')then raise exception'La orden de compra debe completar su flujo de aprobación antes de recibir inventario.';
 elsif tg_table_name='sales_document'and new.document_type='DELIVERY'and not exists(select 1 from sales_document where document_id=new.source_document_id and document_type='ORDER'and status='APROBADO')then raise exception'La orden de venta debe completar su flujo de aprobación antes del despacho.';
 end if;return new;end$$;
drop trigger if exists wf_purchase_approved_source on purchase_document;create trigger wf_purchase_approved_source before insert or update of source_document_id,document_type on purchase_document for each row execute function wf_require_approved_source();
drop trigger if exists wf_sales_approved_source on sales_document;create trigger wf_sales_approved_source before insert or update of source_document_id,document_type on sales_document for each row execute function wf_require_approved_source();
revoke all on function wf_require_approved_source()from public,anon;

