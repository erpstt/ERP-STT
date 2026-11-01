CREATE OR REPLACE FUNCTION public.save_sales_document(p_payload jsonb, p_document_id bigint DEFAULT NULL::bigint)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare sid bigint:=active_subsidiary_id();did bigint:=p_document_id;kind text:=p_payload->>'type';abbr text;tt bigint;st bigint;num text;tid bigint;line jsonb;n int:=0;total numeric:=0;tax numeric;gross numeric;prod products%rowtype;
begin
 if kind not in('QUOTE','ORDER','DELIVERY')then raise exception'Tipo de documento inválido.';end if;
 if jsonb_array_length(coalesce(p_payload->'lines','[]'))=0 then raise exception'Agregue al menos una línea.';end if;
 abbr:=case kind when'QUOTE'then'COT_VEN'when'ORDER'then'PED_VEN'else'DES_INV'end;
 select transaction_type_id into tt from transaction_types where abbreviation=abbr;select status_id into st from status order by case upper(code)when'APROBADO'then 1 else 2 end limit 1;
 for line in select value from jsonb_array_elements(p_payload->'lines')loop tax:=round((line->>'quantity')::numeric*(line->>'unit_price')::numeric*coalesce(nullif(line->>'tax_rate','')::numeric,0)/100,6);total:=total+(line->>'quantity')::numeric*(line->>'unit_price')::numeric+tax;end loop;
 if did is null then
  begin num:=next_transaction_number(tt,sid);exception when others then num:=abbr||'-'||to_char(clock_timestamp(),'YYYYMMDDHH24MISSMS');end;
  insert into "transaction"(tran_number,tran_date,transaction_type_id,subsidiary_id,currency_id,exchange_rate,fiscal_period_id,total_amount,status_id,customer_id,payment_term_id)values(num,(p_payload->>'date')::date,tt,sid,(p_payload->>'currency_id')::bigint,(p_payload->>'rate')::numeric,(p_payload->>'period_id')::bigint,total,st,(p_payload->>'customer_id')::bigint,nullif(p_payload->>'payment_term_id','')::bigint)returning transaction_id into tid;
  insert into sales_document(document_type,document_number,document_date,valid_until,customer_id,subsidiary_id,currency_id,exchange_rate,fiscal_period_id,location_id,payment_term_id,source_document_id,status,memo,total_amount,transaction_id,created_by)values(kind,num,(p_payload->>'date')::date,nullif(p_payload->>'valid_until','')::date,(p_payload->>'customer_id')::bigint,sid,(p_payload->>'currency_id')::bigint,(p_payload->>'rate')::numeric,(p_payload->>'period_id')::bigint,nullif(p_payload->>'location_id','')::bigint,nullif(p_payload->>'payment_term_id','')::bigint,nullif(p_payload->>'source_id','')::bigint,coalesce(nullif(p_payload->>'status',''),'BORRADOR'),p_payload->>'memo',total,tid,app_user_id())returning document_id into did;
 else select transaction_id,document_number into tid,num from sales_document where document_id=did and subsidiary_id=sid for update;if tid is null then raise exception'Documento no encontrado.';end if;delete from sales_document_line where document_id=did;update sales_document set document_date=(p_payload->>'date')::date,valid_until=nullif(p_payload->>'valid_until','')::date,customer_id=(p_payload->>'customer_id')::bigint,currency_id=(p_payload->>'currency_id')::bigint,exchange_rate=(p_payload->>'rate')::numeric,fiscal_period_id=(p_payload->>'period_id')::bigint,location_id=nullif(p_payload->>'location_id','')::bigint,payment_term_id=nullif(p_payload->>'payment_term_id','')::bigint,source_document_id=nullif(p_payload->>'source_id','')::bigint,status=p_payload->>'status',memo=p_payload->>'memo',total_amount=total,updated_at=now()where document_id=did;update "transaction"set tran_date=(p_payload->>'date')::date,total_amount=total where transaction_id=tid;end if;
 for line in select value from jsonb_array_elements(p_payload->'lines')loop n:=n+1;select*into prod from products where product_id=(line->>'product_id')::bigint;tax:=round((line->>'quantity')::numeric*(line->>'unit_price')::numeric*coalesce(nullif(line->>'tax_rate','')::numeric,0)/100,6);gross:=(line->>'quantity')::numeric*(line->>'unit_price')::numeric+tax;insert into sales_document_line(document_id,line_number,product_id,account_id,description,quantity,unit_price,tax_code_id,tax_rate,tax_amount,gross_amount,department_id,cost_center_id,class_id,related_company_id)values(did,n,prod.product_id,prod.sales_account_id,line->>'description',(line->>'quantity')::numeric,(line->>'unit_price')::numeric,nullif(line->>'tax_code_id','')::bigint,coalesce(nullif(line->>'tax_rate','')::numeric,0),tax,gross,nullif(line->>'department_id','')::bigint,nullif(line->>'cost_center_id','')::bigint,nullif(line->>'class_id','')::bigint,nullif(line->>'related_company_id','')::bigint);if kind='DELIVERY'then insert into stock_movements(movement_date,transaction_id,product_id,location_id,quantity,movement_type,unit_cost)values((p_payload->>'date')::date,tid,prod.product_id,(p_payload->>'location_id')::bigint,-(line->>'quantity')::numeric,'DESPACHO_VENTA',coalesce(prod.purchase_cost,0));end if;end loop;
 return jsonb_build_object('id',did,'number',num);
end$function$;

CREATE OR REPLACE FUNCTION public.sales_document_report(p_filters jsonb)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$select jsonb_build_object('rows',coalesce(jsonb_agg(jsonb_build_object('id',d.document_id,'number',d.document_number,'date',d.document_date,'type',d.document_type,'customer',c.company_name,'currency',cu.currency_code,'total',d.total_amount,'status',d.status,'source',src.document_number,'hasNextDocument',case when d.document_type='DELIVERY'then exists(select 1 from invoice i where i.sales_delivery_document_id=d.document_id)else exists(select 1 from sales_document n where n.source_document_id=d.document_id)end)order by d.document_date desc,d.document_id desc),'[]'))from sales_document d join customers c on c.customer_id=d.customer_id join currencies cu on cu.currency_id=d.currency_id left join sales_document src on src.document_id=d.source_document_id where d.subsidiary_id=active_subsidiary_id()and d.document_type=p_filters->>'type'and d.document_date between(p_filters->>'from')::date and(p_filters->>'to')::date$function$;

CREATE OR REPLACE FUNCTION public.link_invoice_to_sales_delivery()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$declare doc text;begin if new.sales_delivery_document_id is null then doc:=substring(coalesce(new.memo,'')from'(DES_INV-[A-Za-z0-9_-]+)');if doc is not null then select document_id into new.sales_delivery_document_id from sales_document where document_number=doc and document_type='DELIVERY'and subsidiary_id=new.subsidiary_id and customer_id=new.customer_id;end if;end if;return new;end$function$;

CREATE OR REPLACE FUNCTION public.sales_document_detail(p_document_id bigint)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$select jsonb_build_object('header',to_jsonb(d),'lines',coalesce((select jsonb_agg(to_jsonb(l)order by line_number)from sales_document_line l where l.document_id=d.document_id),'[]'))from sales_document d where d.document_id=p_document_id and d.subsidiary_id=active_subsidiary_id()$function$;

CREATE OR REPLACE FUNCTION public.delete_sales_document(p_document_id bigint)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$declare d sales_document%rowtype;begin select*into d from sales_document where document_id=p_document_id and subsidiary_id=active_subsidiary_id()for update;if exists(select 1 from sales_document where source_document_id=p_document_id)then raise exception'El documento tiene transacciones posteriores relacionadas.';end if;delete from stock_movements where transaction_id=d.transaction_id;delete from sales_document where document_id=p_document_id;delete from "transaction"where transaction_id=d.transaction_id;return true;end$function$;

CREATE OR REPLACE FUNCTION public.sales_workflow_options()
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
select jsonb_build_object(
 'subsidiary',jsonb_build_object('id',s.subsidiary_id,'name',s.name,'currencyId',s.currency_id),
 'customers',coalesce((select jsonb_agg(jsonb_build_object('id',c.customer_id,'name',c.company_name,'paymentTermId',c.payment_term_id,'departmentId',c.department_id))from customers c join entity_subsidiaries es using(customer_id)where es.subsidiary_id=s.subsidiary_id),'[]'),
 'products',coalesce((select jsonb_agg(jsonb_build_object('id',p.product_id,'code',p.item_code,'name',p.display_name,'price',p.sales_price,'accountId',p.sales_account_id))from products p join product_subsidiaries ps using(product_id)where ps.subsidiary_id=s.subsidiary_id and ps.is_active and p.is_active and p.product_usage in('Venta','Ambas')),'[]'),
 'currencies',coalesce((select jsonb_agg(jsonb_build_object('id',c.currency_id,'code',c.currency_code,'name',c.name)order by sc.is_primary desc,c.currency_code)from subsidiary_currencies sc join currencies c using(currency_id)where sc.subsidiary_id=s.subsidiary_id),'[]'),
 'rates',coalesce((select jsonb_agg(jsonb_build_object('fromCurrencyId',er.from_currency_id,'toCurrencyId',er.to_currency_id,'date',er.effective_date,'rate',er.spot_rate)order by er.effective_date desc)from exchange_rates er where er.from_currency_id in(select currency_id from subsidiary_currencies where subsidiary_id=s.subsidiary_id)and er.to_currency_id in(select currency_id from subsidiary_currencies where subsidiary_id=s.subsidiary_id)),'[]'),
 'periods',coalesce((select jsonb_agg(jsonb_build_object('id',fiscal_period_id,'name',period_name,'start',start_date,'end',end_date))from fiscal_periods where subsidiary_id=s.subsidiary_id and not is_closed and not coalesce(ar_closed,false)),'[]'),
 'locations',coalesce((select jsonb_agg(jsonb_build_object('id',l.location_id,'name',l.name))from locations l left join location_subsidiaries ls using(location_id)where l.subsidiary_id=s.subsidiary_id or ls.subsidiary_id=s.subsidiary_id),'[]'),
 'terms',(select coalesce(jsonb_agg(jsonb_build_object('id',term_id,'name',term_name)),'[]')from payment_terms),
 'taxes',coalesce((select jsonb_agg(distinct jsonb_build_object('id',t.tax_code_id,'name',t.code_name,'rate',t.rate_percentage))from tax_codes t left join tax_code_subsidiaries ts using(tax_code_id)where t.subsidiary_id=s.subsidiary_id or ts.subsidiary_id=s.subsidiary_id),'[]'),
 'departments',(select coalesce(jsonb_agg(distinct jsonb_build_object('id',d.department_id,'name',d.name)),'[]')from departments d join customers c on c.department_id=d.department_id join entity_subsidiaries es on es.customer_id=c.customer_id where es.subsidiary_id=s.subsidiary_id),
 'costs',(select coalesce(jsonb_agg(jsonb_build_object('id',cc.cost_center_id,'name',cc.name,'departmentId',c.department_id,'classId',cc.class_id)),'[]')from cost_centers cc join customers c on c.customer_id=cc.customer_id where cc.subsidiary_id=s.subsidiary_id and not cc.is_inactive),
 'classes',(select coalesce(jsonb_agg(jsonb_build_object('id',cl.class_id,'name',cl.name)),'[]')from classes cl join class_subsidiaries cs using(class_id)where cs.subsidiary_id=s.subsidiary_id and not cl.is_inactive),
 'sources',coalesce((select jsonb_agg(jsonb_build_object('id',document_id,'type',document_type,'number',document_number,'customerId',customer_id))from sales_document where subsidiary_id=s.subsidiary_id and status<>'CANCELADO'),'[]'))
from subsidiaries s where s.subsidiary_id=active_subsidiary_id()$function$;
