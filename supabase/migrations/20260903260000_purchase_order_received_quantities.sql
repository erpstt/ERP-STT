create or replace function purchase_document_detail(p_document_id bigint) returns jsonb
language sql stable security definer set search_path=public as $$
select jsonb_build_object(
 'header',to_jsonb(d),
 'lines',coalesce((select jsonb_agg(to_jsonb(l)||jsonb_build_object(
   'quantity_received',case when d.document_type='ORDER' then coalesce((select sum(rl.quantity) from purchase_document rd join purchase_document_line rl on rl.document_id=rd.document_id where rd.document_type='RECEIPT' and rd.source_document_id=d.document_id and rl.line_number=l.line_number),0) else 0 end,
   'quantity_remaining',case when d.document_type='ORDER' then l.quantity-coalesce((select sum(rl.quantity) from purchase_document rd join purchase_document_line rl on rl.document_id=rd.document_id where rd.document_type='RECEIPT' and rd.source_document_id=d.document_id and rl.line_number=l.line_number),0) else l.quantity end
 ) order by l.line_number) from purchase_document_line l where l.document_id=d.document_id),'[]')
) from purchase_document d where d.document_id=p_document_id and d.subsidiary_id=active_subsidiary_id()
$$;

create or replace function validate_purchase_receipt_quantity() returns trigger
language plpgsql security definer set search_path=public,pg_temp as $$
declare receipt purchase_document%rowtype;ordered_quantity numeric;already_received numeric;
begin
 select * into receipt from purchase_document where document_id=new.document_id;
 if receipt.document_type<>'RECEIPT' then return new; end if;
 if receipt.source_document_id is null or not exists(select 1 from purchase_document where document_id=receipt.source_document_id and document_type='ORDER' and subsidiary_id=receipt.subsidiary_id) then raise exception 'La recepción debe estar vinculada a una orden de compra.';end if;
 select quantity into ordered_quantity from purchase_document_line where document_id=receipt.source_document_id and line_number=new.line_number;
 if ordered_quantity is null then raise exception 'La línea % no existe en la orden de compra.',new.line_number;end if;
 select coalesce(sum(rl.quantity),0) into already_received from purchase_document rd join purchase_document_line rl on rl.document_id=rd.document_id where rd.document_type='RECEIPT' and rd.source_document_id=receipt.source_document_id and rd.document_id<>receipt.document_id and rl.line_number=new.line_number;
 if already_received+new.quantity>ordered_quantity then raise exception 'La cantidad a recibir (%) supera la cantidad pendiente (%) de la línea %.',new.quantity,ordered_quantity-already_received,new.line_number;end if;
 return new;
end$$;
drop trigger if exists validate_purchase_receipt_quantity_trigger on purchase_document_line;
create trigger validate_purchase_receipt_quantity_trigger before insert or update on purchase_document_line for each row execute function validate_purchase_receipt_quantity();
grant execute on function purchase_document_detail(bigint) to authenticated;
notify pgrst,'reload schema';
