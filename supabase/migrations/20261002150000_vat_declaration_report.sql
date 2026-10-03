alter table public.tax_types add column if not exists is_indirect_tax boolean;
update public.tax_types
set is_indirect_tax=lower(type_name)~'(^|[^a-z])(iva|vat|gct|itbms|igv)([^a-z]|$)|valor agregado|general consumption|consumo general'
where is_indirect_tax is null;
alter table public.tax_types alter column is_indirect_tax set default false;
alter table public.tax_types alter column is_indirect_tax set not null;

alter table public.tax_codes add column if not exists is_purchase_creditable boolean;
alter table public.tax_codes add column if not exists is_import_tax boolean;
update public.tax_codes code
set is_purchase_creditable=not code.is_withholding and type_record.applies_to in('Compras','Ambos')
from public.tax_types type_record
where type_record.tax_type_id=code.tax_type_id and code.is_purchase_creditable is null;
update public.tax_codes
set is_import_tax=lower(code_name)~'(^|[^a-z])(imp|import|aduana|customs)([^a-z]|$)'
where is_import_tax is null;
alter table public.tax_codes alter column is_purchase_creditable set default true;
alter table public.tax_codes alter column is_purchase_creditable set not null;
alter table public.tax_codes alter column is_import_tax set default false;
alter table public.tax_codes alter column is_import_tax set not null;

insert into public.permissions(code,module,description)
values('tax:vat-report:view','Fiscal','Consultar y exportar la declaración mensual de IVA/GCT de la sociedad activa.')
on conflict(code)do update set module=excluded.module,description=excluded.description;

insert into public.role_permissions(role_id,permission_id)
select distinct role_record.role_id,permission_record.permission_id
from public.roles role_record
cross join public.permissions permission_record
where permission_record.code='tax:vat-report:view'
 and(
  role_record.is_system_role
  or lower(role_record.role_name)in('administrador','administrator','admin')
  or exists(
   select 1 from public.role_permissions prior_grant
   join public.permissions prior_permission using(permission_id)
   where prior_grant.role_id=role_record.role_id and prior_permission.code='tax_calendar.view'
  )
 )
on conflict do nothing;

create index if not exists invoice_vat_declaration_idx
 on public.invoice(subsidiary_id,invoice_date,transaction_id);
create index if not exists sales_invoice_line_vat_declaration_idx
 on public.sales_invoice_line(invoice_id,tax_code_id,tax_rate);
create index if not exists credit_note_vat_declaration_idx
 on public.credit_note(note_date,transaction_id,cn_id);
create index if not exists debit_note_vat_declaration_idx
 on public.debit_note(note_date,transaction_id,dn_id);
create index if not exists sales_note_line_vat_declaration_idx
 on public.sales_note_line(note_kind,note_id,tax_code_id,tax_rate);
create index if not exists supplier_invoice_vat_declaration_idx
 on public.supplier_invoice(subsidiary_id,invoice_date,transaction_id);
create index if not exists supplier_invoice_line_vat_declaration_idx
 on public.supplier_invoice_line(invoice_id,tax_code_id,tax_rate);
create index if not exists supplier_credit_note_vat_declaration_idx
 on public.supplier_credit_note(note_date,transaction_id,cn_id);
create index if not exists supplier_debit_note_vat_declaration_idx
 on public.supplier_debit_note(note_date,transaction_id,dn_id);
create index if not exists supplier_note_line_vat_declaration_idx
 on public.supplier_note_line(note_kind,note_id,tax_code_id,tax_rate);
create index if not exists customer_payment_withholding_vat_report_idx
 on public.customer_payment_withholding(payment_id,tax_code_id);
create index if not exists supplier_payment_withholding_vat_report_idx
 on public.supplier_payment_withholding(payment_id,tax_code_id);

create or replace function public.vat_declaration_report_options()
returns jsonb
language plpgsql
stable
security definer
set search_path=public,pg_temp
as $$
declare
 sid bigint:=active_subsidiary_id();
 result jsonb;
begin
 if app_user_id() is null or sid is null or not exists(
  select 1 from user_subsidiaries where user_id=app_user_id() and subsidiary_id=sid
 )then
  raise exception using errcode='42501',message='No tiene acceso a la subsidiaria activa.';
 end if;
 if not app_is_admin()and not exists(
  select 1 from role_permissions grant_record
  join permissions permission_record using(permission_id)
  where grant_record.role_id=app_active_role_id()and permission_record.code='tax:vat-report:view'
 )then
  raise exception using errcode='42501',message='No tiene permiso para consultar reportes fiscales.';
 end if;

 select jsonb_build_object(
  'subsidiary',jsonb_build_object(
   'id',s.subsidiary_id,'name',s.name,'legalName',s.legal_name,'taxId',s.tax_id,
   'countryId',country.country_id,'countryCode',coalesce(country.country_code_iso3,country.country_code_iso2),
   'countryName',country.name,'currencyId',currency.currency_id,'currencyCode',currency.currency_code,
   'currencyName',currency.name,'currencySymbol',currency.symbol
  ),
  'taxLabel',case
   when exists(select 1 from tax_types tt where tt.country_id=s.country_id and tt.is_indirect_tax and lower(tt.type_name)~'gct|general consumption|consumo general')then'GCT'
   when exists(select 1 from tax_types tt where tt.country_id=s.country_id and tt.is_indirect_tax and lower(tt.type_name)~'iva|valor agregado|vat|itbms|igv')then'IVA'
   else'Impuesto indirecto'end,
  'defaultPeriod',to_char(current_date,'YYYY-MM'),
  'periods',coalesce((
   select jsonb_agg(jsonb_build_object('value',period_value,'label',to_char(to_date(period_value||'-01','YYYY-MM-DD'),'TMMonth YYYY'))order by period_value desc)
   from(
    select distinct to_char(period_date,'YYYY-MM')period_value
    from(
     select current_date period_date
     union all select invoice_date from invoice where subsidiary_id=sid and invoice_date is not null
     union all select note_date from credit_note n join invoice i using(invoice_id)where i.subsidiary_id=sid and note_date is not null
     union all select note_date from debit_note n join invoice i using(invoice_id)where i.subsidiary_id=sid and note_date is not null
     union all select invoice_date from supplier_invoice where subsidiary_id=sid and invoice_date is not null
     union all select note_date from supplier_credit_note n join supplier_invoice i using(invoice_id)where i.subsidiary_id=sid and note_date is not null
     union all select note_date from supplier_debit_note n join supplier_invoice i using(invoice_id)where i.subsidiary_id=sid and note_date is not null
    )available_dates where period_date is not null
   )available_periods
  ),'[]'::jsonb),
  'documentStatuses',coalesce((
   select jsonb_agg(jsonb_build_object('value',x.code,'label',x.name)order by x.name)
   from(
    select distinct st.code,st.name
    from "transaction" transaction_record join status st using(status_id)
    join transaction_types type_record using(transaction_type_id)
    where transaction_record.subsidiary_id=sid
      and type_record.abbreviation in('FAC_VEN','NC_VEN','ND_VEN','FAC_PRO','NC_PRO','ND_PRO')
      and upper(st.code)not in('ANULADO','CANCELADO','BORRADOR')
   )x
  ),jsonb_build_array(jsonb_build_object('value','APROBADO','label','Aprobado'))),
  'defaultDocumentStatuses',jsonb_build_array('APROBADO')
 )into result
 from subsidiaries s
 join countries country using(country_id)
 join currencies currency using(currency_id)
 where s.subsidiary_id=sid;

 return result;
end
$$;

create or replace function public.run_vat_declaration_report(p_filters jsonb default '{}'::jsonb)
returns jsonb
language plpgsql
stable
security definer
set search_path=public,pg_temp
as $$
declare
 sid bigint:=active_subsidiary_id();
 requested_sid bigint:=nullif(p_filters->>'subsidiaryId','')::bigint;
 period_value text:=coalesce(nullif(p_filters->>'periodMonth',''),to_char(current_date,'YYYY-MM'));
 period_start date;
 period_end date;
 include_adjustments boolean:=case when lower(coalesce(p_filters->>'includeAdjustments','true'))in('false','0','no')then false else true end;
 selected_statuses text[]:=array(
  select upper(value)
  from jsonb_array_elements_text(
   case when jsonb_typeof(p_filters->'documentStatuses')='array' then p_filters->'documentStatuses'
        when jsonb_typeof(p_filters->'statuses')='array' then p_filters->'statuses'
        else jsonb_build_array('APROBADO')end
  )value
 );
 prior_credit numeric:=greatest(coalesce(nullif(p_filters->>'priorPeriodCredit','')::numeric,0),0);
 company_country_id bigint;
 result jsonb;
begin
 if app_user_id() is null or sid is null or not exists(
  select 1 from user_subsidiaries where user_id=app_user_id()and subsidiary_id=sid
 )then
  raise exception using errcode='42501',message='No tiene acceso a la subsidiaria activa.';
 end if;
 if not app_is_admin()and not exists(
  select 1 from role_permissions grant_record
  join permissions permission_record using(permission_id)
  where grant_record.role_id=app_active_role_id()and permission_record.code='tax:vat-report:view'
 )then
  raise exception using errcode='42501',message='No tiene permiso para consultar reportes fiscales.';
 end if;
 if requested_sid is not null and requested_sid<>sid then
  raise exception using errcode='42501',message='El informe fiscal solo puede generarse para la empresa activa.';
 end if;
 if period_value!~'^[0-9]{4}-(0[1-9]|1[0-2])$'then
  raise exception 'Seleccione un periodo fiscal válido.';
 end if;
 if prior_credit>999999999999999999::numeric then raise exception 'El saldo a favor anterior supera el límite permitido.';end if;
 if cardinality(selected_statuses)=0 then selected_statuses:=array['APROBADO'];end if;
 if exists(
  select 1 from unnest(selected_statuses)requested_status
  where requested_status in('ANULADO','CANCELADO','BORRADOR')
   or not exists(select 1 from status configured_status where upper(configured_status.code)=requested_status)
 )then
  raise exception 'La selección contiene un estado documental no permitido para la declaración fiscal.';
 end if;

 period_start:=to_date(period_value||'-01','YYYY-MM-DD');
 period_end:=(period_start+interval'1 month'-interval'1 day')::date;
 select country_id into company_country_id from subsidiaries where subsidiary_id=sid;

 with tax_catalog as(
  select tc.tax_code_id,tc.code_name,tc.rate_percentage,tc.country_id,tc.is_purchase_creditable,tc.is_import_tax,
   tt.type_name,tt.applies_to,tt.is_indirect_tax
  from tax_codes tc join tax_types tt using(tax_type_id)
  where not tc.is_withholding
 ),
 detail_source as(
  select 'SALES'::text side,'INVOICE'::text document_type,'Factura de venta'::text document_type_label,
   i.invoice_id document_id,i.invoice_number document_number,coalesce(i.invoice_date,transaction_record.tran_date)document_date,
   'Cliente'::text party_type,customer.customer_id party_id,customer.company_name party_name,customer.tax_id party_tax_id,
   line.tax_code_id,coalesce(tax.code_name,'SIN_CODIGO')tax_code,
   case when line.tax_code_id is null then'Sin código fiscal / No gravada'
        when tax.tax_code_id is null or tax.country_id<>company_country_id then'Código fiscal no disponible para el país de la empresa'
        when not tax.is_indirect_tax then'Operación no sujeta a IVA/GCT · '||tax.code_name
        when tax.applies_to not in('Ventas','Ambos')then'Código no aplicable a ventas · '||tax.code_name
        when coalesce(line.tax_rate,tax.rate_percentage,0)=0 then tax.type_name||' · Tarifa 0%'
        else tax.type_name||' · '||trim(to_char(coalesce(line.tax_rate,tax.rate_percentage,0),'FM990D999999'))||'%'end tax_description,
   case when line.tax_code_id is null or tax.tax_code_id is null or tax.country_id<>company_country_id
          or not tax.is_indirect_tax or tax.applies_to not in('Ventas','Ambos')then 0
        else coalesce(line.tax_rate,tax.rate_percentage,0)end::numeric tax_rate,
   line.amount::numeric original_base,line.tax_amount::numeric original_tax,line.gross_amount::numeric original_gross,
   coalesce(i.exchange_rate,transaction_record.exchange_rate,1)::numeric exchange_rate,
   currency.currency_code,line.line_id source_line_id,i.journal_id,upper(document_status.code)status,
   1::numeric sign,
   coalesce(tax.country_id=company_country_id and tax.is_indirect_tax and tax.applies_to in('Ventas','Ambos'),false)tax_reportable,
   false is_import_tax,
   case when line.tax_code_id is null then'NO_CODE'
        when tax.tax_code_id is null or tax.country_id<>company_country_id then'INVALID_COUNTRY'
        when not tax.is_indirect_tax then'NON_INDIRECT'
        when tax.applies_to not in('Ventas','Ambos')then'NOT_APPLICABLE'
        when coalesce(line.tax_rate,tax.rate_percentage,0)=0 then'ZERO_RATE'
        else'DOMESTIC'end tax_classification
  from invoice i join sales_invoice_line line using(invoice_id)
  join customers customer using(customer_id)
  join "transaction" transaction_record using(transaction_id)
  join status document_status using(status_id)
  join currencies currency on currency.currency_id=coalesce(i.currency_id,transaction_record.currency_id)
  left join journal on journal.journal_id=i.journal_id
  left join tax_catalog tax on tax.tax_code_id=line.tax_code_id
  where i.subsidiary_id=sid and coalesce(i.invoice_date,transaction_record.tran_date)between period_start and period_end
   and not coalesce(i.is_opening_balance,false)
   and upper(document_status.code)=any(selected_statuses)
   and journal.journal_id is not null and upper(journal.status)='CONTABILIZADO'

  union all
  select 'SALES',case when line.note_kind='CREDIT'then'CREDIT_NOTE'else'DEBIT_NOTE'end,
   case when line.note_kind='CREDIT'then'Nota de crédito de cliente'else'Nota de débito de cliente'end,
   case when line.note_kind='CREDIT'then credit.cn_id else debit.dn_id end,
   case when line.note_kind='CREDIT'then credit.cn_number else debit.dn_number end,
   coalesce(case when line.note_kind='CREDIT'then credit.note_date else debit.note_date end,transaction_record.tran_date),
   'Cliente',customer.customer_id,customer.company_name,customer.tax_id,line.tax_code_id,coalesce(tax.code_name,'SIN_CODIGO'),
   case when line.tax_code_id is null then'Sin código fiscal / No gravada'
        when tax.tax_code_id is null or tax.country_id<>company_country_id then'Código fiscal no disponible para el país de la empresa'
        when not tax.is_indirect_tax then'Operación no sujeta a IVA/GCT · '||tax.code_name
        when tax.applies_to not in('Ventas','Ambos')then'Código no aplicable a ventas · '||tax.code_name
        when coalesce(line.tax_rate,tax.rate_percentage,0)=0 then tax.type_name||' · Tarifa 0%'
        else tax.type_name||' · '||trim(to_char(coalesce(line.tax_rate,tax.rate_percentage,0),'FM990D999999'))||'%'end,
   case when line.tax_code_id is null or tax.tax_code_id is null or tax.country_id<>company_country_id
          or not tax.is_indirect_tax or tax.applies_to not in('Ventas','Ambos')then 0
        else coalesce(line.tax_rate,tax.rate_percentage,0)end,line.amount,line.tax_amount,line.gross_amount,
   coalesce(case when line.note_kind='CREDIT'then credit.exchange_rate else debit.exchange_rate end,transaction_record.exchange_rate,1),
   currency.currency_code,line.line_id,
   case when line.note_kind='CREDIT'then credit.journal_id else debit.journal_id end,
   upper(document_status.code),case when line.note_kind='CREDIT'then-1 else 1 end,
   coalesce(tax.country_id=company_country_id and tax.is_indirect_tax and tax.applies_to in('Ventas','Ambos'),false),
   false,
   case when line.tax_code_id is null then'NO_CODE'
        when tax.tax_code_id is null or tax.country_id<>company_country_id then'INVALID_COUNTRY'
        when not tax.is_indirect_tax then'NON_INDIRECT'
        when tax.applies_to not in('Ventas','Ambos')then'NOT_APPLICABLE'
        when coalesce(line.tax_rate,tax.rate_percentage,0)=0 then'ZERO_RATE'
        else'DOMESTIC'end
  from sales_note_line line
  left join credit_note credit on line.note_kind='CREDIT'and credit.cn_id=line.note_id
  left join debit_note debit on line.note_kind='DEBIT'and debit.dn_id=line.note_id
  join invoice original_invoice on original_invoice.invoice_id=coalesce(credit.invoice_id,debit.invoice_id)
  join customers customer on customer.customer_id=coalesce(credit.customer_id,debit.customer_id)
  join "transaction" transaction_record on transaction_record.transaction_id=coalesce(credit.transaction_id,debit.transaction_id)
  join status document_status using(status_id)
  join currencies currency on currency.currency_id=coalesce(credit.currency_id,debit.currency_id,transaction_record.currency_id)
  left join journal on journal.journal_id=coalesce(credit.journal_id,debit.journal_id)
  left join tax_catalog tax on tax.tax_code_id=line.tax_code_id
  where include_adjustments and original_invoice.subsidiary_id=sid
   and coalesce(case when line.note_kind='CREDIT'then credit.note_date else debit.note_date end,transaction_record.tran_date)between period_start and period_end
   and upper(document_status.code)=any(selected_statuses)
   and journal.journal_id is not null and upper(journal.status)='CONTABILIZADO'

  union all
  select 'PURCHASES','INVOICE','Factura de proveedor',i.invoice_id,i.invoice_number,
   coalesce(i.invoice_date,transaction_record.tran_date),'Proveedor',supplier.supplier_id,supplier.company_name,supplier.tax_id,
   line.tax_code_id,coalesce(tax.code_name,'SIN_CODIGO'),
   case when line.tax_code_id is null then'Sin código fiscal / No gravada'
        when tax.tax_code_id is null or tax.country_id<>company_country_id then'Código fiscal no disponible para el país de la empresa'
        when not tax.is_indirect_tax then'Compra no sujeta a IVA/GCT · '||tax.code_name
        when tax.applies_to not in('Compras','Ambos')then'Código no aplicable a compras · '||tax.code_name
        when not tax.is_purchase_creditable then tax.type_name||' · Impuesto no acreditable'
        when tax.is_import_tax then tax.type_name||' · Importación / Aduana · '||trim(to_char(coalesce(line.tax_rate,tax.rate_percentage,0),'FM990D999999'))||'%'
        when coalesce(line.tax_rate,tax.rate_percentage,0)=0 then tax.type_name||' · Tarifa 0%'
        else tax.type_name||' · '||trim(to_char(coalesce(line.tax_rate,tax.rate_percentage,0),'FM990D999999'))||'%'end,
   case when line.tax_code_id is null or tax.tax_code_id is null or tax.country_id<>company_country_id
          or not tax.is_indirect_tax or tax.applies_to not in('Compras','Ambos')then 0
        else coalesce(line.tax_rate,tax.rate_percentage,0)end,line.amount,line.tax_amount,line.gross_amount,
   coalesce(i.exchange_rate,transaction_record.exchange_rate,1),currency.currency_code,line.line_id,i.journal_id,
   upper(document_status.code),1,
   coalesce(tax.country_id=company_country_id and tax.is_indirect_tax and tax.applies_to in('Compras','Ambos')and tax.is_purchase_creditable,false),
   coalesce(tax.country_id=company_country_id and tax.is_indirect_tax and tax.is_import_tax,false),
   case when line.tax_code_id is null then'NO_CODE'
        when tax.tax_code_id is null or tax.country_id<>company_country_id then'INVALID_COUNTRY'
        when not tax.is_indirect_tax then'NON_INDIRECT'
        when tax.applies_to not in('Compras','Ambos')then'NOT_APPLICABLE'
        when not tax.is_purchase_creditable then'NON_CREDITABLE'
        when tax.is_import_tax then'IMPORT'
        when coalesce(line.tax_rate,tax.rate_percentage,0)=0 then'ZERO_RATE'
        else'DOMESTIC'end
  from supplier_invoice i join supplier_invoice_line line using(invoice_id)
  join suppliers supplier using(supplier_id)
  join "transaction" transaction_record using(transaction_id)
  join status document_status using(status_id)
  join currencies currency on currency.currency_id=coalesce(i.currency_id,transaction_record.currency_id)
  left join journal on journal.journal_id=i.journal_id
  left join tax_catalog tax on tax.tax_code_id=line.tax_code_id
  where i.subsidiary_id=sid and coalesce(i.invoice_date,transaction_record.tran_date)between period_start and period_end
   and not coalesce(i.is_opening_balance,false)
   and upper(document_status.code)=any(selected_statuses)
   and journal.journal_id is not null and upper(journal.status)='CONTABILIZADO'

  union all
  select 'PURCHASES',case when line.note_kind='CREDIT'then'CREDIT_NOTE'else'DEBIT_NOTE'end,
   case when line.note_kind='CREDIT'then'Nota de crédito de proveedor'else'Nota de débito de proveedor'end,
   case when line.note_kind='CREDIT'then credit.cn_id else debit.dn_id end,
   case when line.note_kind='CREDIT'then credit.cn_number else debit.dn_number end,
   coalesce(case when line.note_kind='CREDIT'then credit.note_date else debit.note_date end,transaction_record.tran_date),
   'Proveedor',supplier.supplier_id,supplier.company_name,supplier.tax_id,line.tax_code_id,coalesce(tax.code_name,'SIN_CODIGO'),
   case when line.tax_code_id is null then'Sin código fiscal / No gravada'
        when tax.tax_code_id is null or tax.country_id<>company_country_id then'Código fiscal no disponible para el país de la empresa'
        when not tax.is_indirect_tax then'Compra no sujeta a IVA/GCT · '||tax.code_name
        when tax.applies_to not in('Compras','Ambos')then'Código no aplicable a compras · '||tax.code_name
        when not tax.is_purchase_creditable then tax.type_name||' · Impuesto no acreditable'
        when tax.is_import_tax then tax.type_name||' · Importación / Aduana · '||trim(to_char(coalesce(line.tax_rate,tax.rate_percentage,0),'FM990D999999'))||'%'
        when coalesce(line.tax_rate,tax.rate_percentage,0)=0 then tax.type_name||' · Tarifa 0%'
        else tax.type_name||' · '||trim(to_char(coalesce(line.tax_rate,tax.rate_percentage,0),'FM990D999999'))||'%'end,
   case when line.tax_code_id is null or tax.tax_code_id is null or tax.country_id<>company_country_id
          or not tax.is_indirect_tax or tax.applies_to not in('Compras','Ambos')then 0
        else coalesce(line.tax_rate,tax.rate_percentage,0)end,line.amount,line.tax_amount,line.gross_amount,
   coalesce(case when line.note_kind='CREDIT'then credit.exchange_rate else debit.exchange_rate end,transaction_record.exchange_rate,1),
   currency.currency_code,line.line_id,
   case when line.note_kind='CREDIT'then credit.journal_id else debit.journal_id end,
   upper(document_status.code),case when line.note_kind='CREDIT'then-1 else 1 end,
   coalesce(tax.country_id=company_country_id and tax.is_indirect_tax and tax.applies_to in('Compras','Ambos')and tax.is_purchase_creditable,false),
   coalesce(tax.country_id=company_country_id and tax.is_indirect_tax and tax.is_import_tax,false),
   case when line.tax_code_id is null then'NO_CODE'
        when tax.tax_code_id is null or tax.country_id<>company_country_id then'INVALID_COUNTRY'
        when not tax.is_indirect_tax then'NON_INDIRECT'
        when tax.applies_to not in('Compras','Ambos')then'NOT_APPLICABLE'
        when not tax.is_purchase_creditable then'NON_CREDITABLE'
        when tax.is_import_tax then'IMPORT'
        when coalesce(line.tax_rate,tax.rate_percentage,0)=0 then'ZERO_RATE'
        else'DOMESTIC'end
  from supplier_note_line line
  left join supplier_credit_note credit on line.note_kind='CREDIT'and credit.cn_id=line.note_id
  left join supplier_debit_note debit on line.note_kind='DEBIT'and debit.dn_id=line.note_id
  join supplier_invoice original_invoice on original_invoice.invoice_id=coalesce(credit.invoice_id,debit.invoice_id)
  join suppliers supplier on supplier.supplier_id=coalesce(credit.supplier_id,debit.supplier_id)
  join "transaction" transaction_record on transaction_record.transaction_id=coalesce(credit.transaction_id,debit.transaction_id)
  join status document_status using(status_id)
  join currencies currency on currency.currency_id=coalesce(credit.currency_id,debit.currency_id,transaction_record.currency_id)
  left join journal on journal.journal_id=coalesce(credit.journal_id,debit.journal_id)
  left join tax_catalog tax on tax.tax_code_id=line.tax_code_id
  where include_adjustments and original_invoice.subsidiary_id=sid
   and coalesce(case when line.note_kind='CREDIT'then credit.note_date else debit.note_date end,transaction_record.tran_date)between period_start and period_end
   and upper(document_status.code)=any(selected_statuses)
   and journal.journal_id is not null and upper(journal.status)='CONTABILIZADO'
 ),
 details as(
  select side,document_type,document_type_label,document_id,document_number,document_date,party_type,party_id,party_name,party_tax_id,
   tax_code_id,tax_code,tax_description,tax_rate,tax_reportable,is_import_tax,tax_classification,
   sign*original_base*exchange_rate base_amount,
   sign*case when tax_reportable then original_tax else 0 end*exchange_rate tax_amount,
   sign*case when not tax_reportable then original_tax else 0 end*exchange_rate excluded_tax_amount,
   sign*original_gross*exchange_rate gross_amount,currency_code,exchange_rate,
   sign*original_base original_base,sign*original_tax original_tax,sign*original_gross original_gross,
   source_line_id,journal_id,status,
   side||':'||coalesce(tax_code_id::text,'NONE')||':'||tax_classification||':'||trim(to_char(tax_rate,'FM999999990D999999'))key
  from detail_source
 ),
 grouped as(
  select side,key,tax_code_id,tax_code,tax_description description,tax_rate rate,tax_reportable,is_import_tax,tax_classification,
   sum(base_amount)base_amount,sum(tax_amount)tax_amount,sum(gross_amount)gross_amount,
   sum(excluded_tax_amount)excluded_tax_amount,
   coalesce(sum(base_amount)filter(where document_type<>'INVOICE'),0)adjustment_base_amount,
   coalesce(sum(tax_amount)filter(where document_type<>'INVOICE'),0)adjustment_tax_amount,
   count(distinct(document_type,document_id))document_count,count(*)line_count
  from details group by side,key,tax_code_id,tax_code,tax_description,tax_rate,tax_reportable,is_import_tax,tax_classification
 ),
 withholding_events as(
  select 'SUFFERED'::text retention_side,i.invoice_id source_id,i.invoice_number document_number,
   coalesce(i.invoice_date,transaction_record.tran_date)event_date,customer.company_name party_name,customer.tax_id party_tax_id,
   tc.code_name tax_code,tt.type_name tax_description,w.rate_percentage,
   w.withholding_amount*coalesce(i.exchange_rate,transaction_record.exchange_rate,1)amount
  from sales_invoice_withholding w join invoice i using(invoice_id)
  join customers customer using(customer_id)join "transaction" transaction_record using(transaction_id)
  join status document_status using(status_id)join journal source_journal on source_journal.journal_id=i.journal_id
  join tax_codes tc using(tax_code_id)join tax_types tt using(tax_type_id)
  where i.subsidiary_id=sid and w.recognized_at_invoice
   and coalesce(i.invoice_date,transaction_record.tran_date)between period_start and period_end
   and upper(document_status.code)=any(selected_statuses)
   and upper(source_journal.status)='CONTABILIZADO'and tc.is_withholding and tt.is_indirect_tax
  union all
  select 'SUFFERED',payment.payment_id,payment.payment_number,payment.payment_date,customer.company_name,customer.tax_id,
   tc.code_name,tt.type_name,source.rate_percentage,w.withholding_amount*coalesce(payment.exchange_rate,1)
  from customer_payment_withholding w join customer_payment payment using(payment_id)
  join invoice i using(invoice_id)join customers customer on customer.customer_id=payment.customer_id
  join sales_invoice_withholding source using(invoice_withholding_id)
  join journal payment_journal on payment_journal.journal_id=payment.journal_id
  join tax_codes tc on tc.tax_code_id=w.tax_code_id join tax_types tt using(tax_type_id)
  where i.subsidiary_id=sid and not source.recognized_at_invoice and payment.payment_date between period_start and period_end
   and upper(coalesce(payment.status,'APROBADO'))not in('ANULADO','CANCELADO','BORRADOR')
   and upper(payment_journal.status)='CONTABILIZADO'and tc.is_withholding and tt.is_indirect_tax
  union all
  select 'PRACTICED',i.invoice_id,i.invoice_number,coalesce(i.invoice_date,transaction_record.tran_date),
   supplier.company_name,supplier.tax_id,tc.code_name,tt.type_name,w.rate_percentage,
   w.withholding_amount*coalesce(i.exchange_rate,transaction_record.exchange_rate,1)
  from supplier_invoice_withholding w join supplier_invoice i using(invoice_id)
  join suppliers supplier using(supplier_id)join "transaction" transaction_record using(transaction_id)
  join status document_status using(status_id)join journal source_journal on source_journal.journal_id=i.journal_id
  join tax_codes tc using(tax_code_id)join tax_types tt using(tax_type_id)
  where i.subsidiary_id=sid and w.recognized_at_invoice
   and coalesce(i.invoice_date,transaction_record.tran_date)between period_start and period_end
   and upper(document_status.code)=any(selected_statuses)
   and upper(source_journal.status)='CONTABILIZADO'and tc.is_withholding and tt.is_indirect_tax
  union all
  select 'PRACTICED',payment.payment_id,payment.payment_number,payment.payment_date,supplier.company_name,supplier.tax_id,
   tc.code_name,tt.type_name,source.rate_percentage,w.withholding_amount*coalesce(payment.exchange_rate,1)
  from supplier_payment_withholding w join supplier_payment payment using(payment_id)
  join supplier_invoice i using(invoice_id)join suppliers supplier on supplier.supplier_id=payment.supplier_id
  join supplier_invoice_withholding source using(invoice_withholding_id)
  join journal payment_journal on payment_journal.journal_id=payment.journal_id
  join tax_codes tc on tc.tax_code_id=w.tax_code_id join tax_types tt using(tax_type_id)
  where i.subsidiary_id=sid and not source.recognized_at_invoice and payment.payment_date between period_start and period_end
   and upper(coalesce(payment.status,'APROBADO'))not in('ANULADO','CANCELADO','BORRADOR')
   and upper(payment_journal.status)='CONTABILIZADO'and tc.is_withholding and tt.is_indirect_tax
 ),
 totals as(
  select
   coalesce(sum(base_amount)filter(where side='SALES'),0)sales_base,
   coalesce(sum(base_amount)filter(where side='SALES'and tax_reportable and tax_rate>0),0)sales_taxable_base,
   coalesce(sum(base_amount)filter(where side='SALES'and(not tax_reportable or tax_rate=0)),0)sales_exempt_base,
   coalesce(sum(tax_amount)filter(where side='SALES'),0)sales_tax,
   coalesce(sum(excluded_tax_amount)filter(where side='SALES'),0)excluded_sales_tax,
   coalesce(sum(gross_amount)filter(where side='SALES'),0)sales_gross,
   coalesce(sum(base_amount)filter(where side='PURCHASES'),0)purchase_base,
   coalesce(sum(base_amount)filter(where side='PURCHASES'and tax_reportable and tax_rate>0),0)purchase_taxable_base,
   coalesce(sum(base_amount)filter(where side='PURCHASES'and(not tax_reportable or tax_rate=0)),0)purchase_exempt_base,
   coalesce(sum(tax_amount)filter(where side='PURCHASES'),0)purchase_tax,
   coalesce(sum(excluded_tax_amount)filter(where side='PURCHASES'),0)excluded_purchase_tax,
   coalesce(sum(gross_amount)filter(where side='PURCHASES'),0)purchase_gross,
   count(distinct(document_type,document_id))filter(where side='SALES')sales_document_count,
   count(distinct(document_type,document_id))filter(where side='PURCHASES')purchase_document_count,
   count(*)line_count
  from details
 ),
 retention_totals as(
  select coalesce(sum(amount)filter(where retention_side='SUFFERED'),0)suffered,
   coalesce(sum(amount)filter(where retention_side='PRACTICED'),0)practiced
  from withholding_events
 ),
 settlement as(
  select totals.*,retention_totals.suffered,retention_totals.practiced,
   totals.sales_tax-totals.purchase_tax gross_tax,
   totals.sales_tax-totals.purchase_tax-retention_totals.suffered-retention_totals.practiced-prior_credit net_tax
  from totals cross join retention_totals
 )
 select jsonb_build_object(
  'header',(select jsonb_build_object(
   'subsidiaryId',company.subsidiary_id,'subsidiaryName',company.name,'legalName',company.legal_name,'taxId',company.tax_id,
   'countryCode',coalesce(country.country_code_iso3,country.country_code_iso2),'countryName',country.name,
   'taxLabel',case when exists(select 1 from tax_catalog where country_id=company_country_id and is_indirect_tax and lower(type_name)~'gct|general consumption|consumo general')then'GCT'
                   when exists(select 1 from tax_catalog where country_id=company_country_id and is_indirect_tax and lower(type_name)~'iva|valor agregado|vat|itbms|igv')then'IVA'
                   else'Impuesto indirecto'end,
   'periodMonth',period_value,'dateFrom',period_start,'dateTo',period_end,
   'currencyId',currency.currency_id,'currencyCode',currency.currency_code,'currencyName',currency.name,'currencySymbol',currency.symbol,
   'includeAdjustments',include_adjustments,'documentStatuses',to_jsonb(selected_statuses),'generatedAt',clock_timestamp()
  )from subsidiaries company join countries country using(country_id)join currencies currency using(currency_id)where company.subsidiary_id=sid),
  'summary',(select jsonb_build_object(
   'salesBase',sales_base,'salesTaxableBase',sales_taxable_base,'salesExemptBase',sales_exempt_base,'salesTax',sales_tax,'salesGross',sales_gross,
   'purchaseBase',purchase_base,'purchaseTaxableBase',purchase_taxable_base,'purchaseExemptBase',purchase_exempt_base,'purchaseTax',purchase_tax,'purchaseGross',purchase_gross,
   'excludedSalesTax',excluded_sales_tax,'excludedPurchaseTax',excluded_purchase_tax,
   'grossTax',gross_tax,'vatWithheldSuffered',suffered,'vatWithheldPracticed',practiced,
   'priorPeriodCredit',prior_credit,'netTax',net_tax,
   'position',case when net_tax>.005 then'PAYABLE'when net_tax<-.005 then'FAVOR'else'ZERO'end,
   'payableAmount',greatest(net_tax,0),'favorAmount',greatest(-net_tax,0),
   'salesDocumentCount',sales_document_count,'purchaseDocumentCount',purchase_document_count,
   'documentCount',sales_document_count+purchase_document_count,'lineCount',line_count,
   'warnings',coalesce((select jsonb_agg(warning)from(values
    (case when not exists(select 1 from tax_catalog where country_id=company_country_id and is_indirect_tax)then'No hay tipos de IVA/GCT configurados para el país de la empresa.'end),
    (case when exists(select 1 from details where tax_code_id is null)then'Las líneas sin código fiscal se presentan como no gravadas para conservar la base completa.'end),
    (case when exists(select 1 from details where tax_classification='NO_CODE'and abs(excluded_tax_amount)>.005)then'Hay líneas con impuesto pero sin código fiscal; ese impuesto se excluyó de la liquidación y requiere revisión.'end),
    (case when exists(select 1 from details where tax_classification='NON_CREDITABLE'and abs(excluded_tax_amount)>.005)then'El impuesto marcado como no acreditable se informa en el detalle, pero no reduce la posición fiscal.'end),
    (case when exists(select 1 from details where tax_classification in('INVALID_COUNTRY','NON_INDIRECT','NOT_APPLICABLE')and abs(excluded_tax_amount)>.005)then'Hay impuestos con clasificación fiscal no aplicable; se conservaron para auditoría y se excluyeron del cálculo.'end),
    (case when prior_credit>0 then'El saldo a favor anterior fue informado manualmente para esta liquidación.'end)
   )warning_list(warning)where warning is not null),'[]'::jsonb)
  )from settlement),
  'sales',jsonb_build_object(
   'rows',coalesce((select jsonb_agg(jsonb_build_object(
     'key',key,'side',side,'taxCodeId',tax_code_id,'taxCode',tax_code,'description',description,'rate',rate,
     'baseAmount',base_amount,'taxAmount',tax_amount,'grossAmount',gross_amount,
     'taxReportable',tax_reportable,'isImportTax',is_import_tax,'classification',tax_classification,'excludedTaxAmount',excluded_tax_amount,
    'adjustmentBaseAmount',adjustment_base_amount,'adjustmentAmount',adjustment_tax_amount,
    'documentCount',document_count,'lineCount',line_count
   )order by rate desc,tax_code)from grouped where side='SALES'),'[]'::jsonb),
   'totals',(select jsonb_build_object('baseAmount',sales_base,'taxAmount',sales_tax,'grossAmount',sales_gross)from settlement)
  ),
  'purchases',jsonb_build_object(
   'rows',coalesce((select jsonb_agg(jsonb_build_object(
     'key',key,'side',side,'taxCodeId',tax_code_id,'taxCode',tax_code,'description',description,'rate',rate,
     'baseAmount',base_amount,'taxAmount',tax_amount,'grossAmount',gross_amount,
     'taxReportable',tax_reportable,'isImportTax',is_import_tax,'classification',tax_classification,'excludedTaxAmount',excluded_tax_amount,
    'adjustmentBaseAmount',adjustment_base_amount,'adjustmentAmount',adjustment_tax_amount,
    'documentCount',document_count,'lineCount',line_count
   )order by rate desc,tax_code)from grouped where side='PURCHASES'),'[]'::jsonb),
   'totals',(select jsonb_build_object('baseAmount',purchase_base,'taxAmount',purchase_tax,'grossAmount',purchase_gross)from settlement)
  ),
  'details',coalesce((select jsonb_agg(jsonb_build_object(
   'key',key,'side',side,'documentType',document_type,'documentTypeLabel',document_type_label,
   'documentId',document_id,'documentNumber',document_number,'documentDate',document_date,
   'partyType',party_type,'partyId',party_id,'partyName',party_name,'partyTaxId',party_tax_id,
   'taxCodeId',tax_code_id,'taxCode',tax_code,'taxDescription',tax_description,'taxRate',tax_rate,
   'taxReportable',tax_reportable,'isImportTax',is_import_tax,'classification',tax_classification,
   'baseAmount',base_amount,'taxAmount',tax_amount,'excludedTaxAmount',excluded_tax_amount,'grossAmount',gross_amount,
   'currencyCode',currency_code,'exchangeRate',exchange_rate,'originalBase',original_base,'originalTax',original_tax,'originalGross',original_gross,
   'sourceLineId',source_line_id,'journalId',journal_id,'status',status
  )order by side,document_date,document_number,source_line_id)from details),'[]'::jsonb),
  'retentions',jsonb_build_object(
   'suffered',coalesce((select jsonb_agg(jsonb_build_object('sourceId',source_id,'documentNumber',document_number,'date',event_date,'partyName',party_name,'partyTaxId',party_tax_id,'taxCode',tax_code,'description',tax_description,'rate',rate_percentage,'amount',amount)order by event_date,document_number)from withholding_events where retention_side='SUFFERED'),'[]'::jsonb),
   'practiced',coalesce((select jsonb_agg(jsonb_build_object('sourceId',source_id,'documentNumber',document_number,'date',event_date,'partyName',party_name,'partyTaxId',party_tax_id,'taxCode',tax_code,'description',tax_description,'rate',rate_percentage,'amount',amount)order by event_date,document_number)from withholding_events where retention_side='PRACTICED'),'[]'::jsonb)
  )
 )into result;

 return result;
end
$$;

revoke all on function public.vat_declaration_report_options(),public.run_vat_declaration_report(jsonb)from public,anon;
grant execute on function public.vat_declaration_report_options(),public.run_vat_declaration_report(jsonb)to authenticated;

notify pgrst,'reload schema';
