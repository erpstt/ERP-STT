create or replace function purchase_workflow_options() returns jsonb
language sql stable security definer set search_path=public as $$
select jsonb_build_object(
 'subsidiary',jsonb_build_object('id',s.subsidiary_id,'name',s.name,'currencyId',s.currency_id),
 'suppliers',coalesce((select jsonb_agg(jsonb_build_object('id',p.supplier_id,'name',p.company_name,'paymentTermId',p.payment_term_id)) from suppliers p join entity_subsidiaries es using(supplier_id) where es.subsidiary_id=s.subsidiary_id),'[]'),
 'products',coalesce((select jsonb_agg(jsonb_build_object('id',p.product_id,'code',p.item_code,'name',p.display_name,'cost',p.purchase_cost,'accountId',p.purchase_account_id)) from products p join product_subsidiaries ps using(product_id) where ps.subsidiary_id=s.subsidiary_id and ps.is_active and p.is_active),'[]'),
 'currencies',(select jsonb_agg(jsonb_build_object('id',currency_id,'code',currency_code)) from currencies),
 'periods',coalesce((select jsonb_agg(jsonb_build_object('id',fiscal_period_id,'name',period_name,'start',start_date,'end',end_date)) from fiscal_periods where subsidiary_id=s.subsidiary_id and not is_closed and not coalesce(ap_closed,false)),'[]'),
 'locations',coalesce((select jsonb_agg(distinct jsonb_build_object('id',l.location_id,'name',l.name)) from locations l left join location_subsidiaries ls using(location_id) where l.subsidiary_id=s.subsidiary_id or ls.subsidiary_id=s.subsidiary_id),'[]'),
 'terms',(select coalesce(jsonb_agg(jsonb_build_object('id',term_id,'name',term_name)),'[]') from payment_terms),
 'taxes',(select coalesce(jsonb_agg(jsonb_build_object('id',tax_code_id,'name',code_name,'rate',rate_percentage)),'[]') from tax_codes),
 'sources',coalesce((select jsonb_agg(jsonb_build_object('id',document_id,'type',document_type,'number',document_number,'supplierId',supplier_id)) from purchase_document where subsidiary_id=s.subsidiary_id and status<>'CANCELADO'),'[]')
) from subsidiaries s where s.subsidiary_id=active_subsidiary_id()
$$;
grant execute on function purchase_workflow_options() to authenticated;
notify pgrst,'reload schema';
