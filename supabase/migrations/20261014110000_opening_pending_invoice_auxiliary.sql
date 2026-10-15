-- Opening pending-to-invoice auxiliary.
--
-- The opening journal remains the only source of the GL balance.  These tables
-- keep the operational composition needed to reverse an opening pending item
-- later, without posting a second opening entry.

create table if not exists public.opening_pending_invoice_items(
  id bigint generated always as identity primary key,
  run_id bigint not null references public.opening_balance_runs(id) on delete cascade,
  subsidiary_id bigint not null references public.subsidiaries(subsidiary_id) on delete restrict,
  reference text not null check(btrim(reference)<>''),
  origin_date date not null,
  customer_id bigint not null references public.customers(customer_id) on delete restrict,
  currency_id bigint not null references public.currencies(currency_id) on delete restrict,
  historical_exchange_rate numeric(24,10) not null check(historical_exchange_rate>0),
  service_month text not null check(service_month~'^[0-9]{4}-(0[1-9]|1[0-2])$'),
  service_country_id bigint not null references public.countries(country_id) on delete restrict,
  initial_local numeric(24,6) not null check(initial_local>0),
  initial_foreign numeric(24,6) not null check(initial_foreign>0),
  reversed_local numeric(24,6) not null default 0 check(reversed_local>=0),
  reversed_foreign numeric(24,6) not null default 0 check(reversed_foreign>=0),
  balance_local numeric(24,6) not null check(balance_local>=0),
  balance_foreign numeric(24,6) not null check(balance_foreign>=0),
  reversal_status text not null default 'PENDIENTE'
    check(reversal_status in('PENDIENTE','REVERSADO_PARCIAL','REVERSADO_TOTAL','ANULADO')),
  is_active boolean not null default false,
  activated_at timestamptz,
  opening_reversed_at timestamptz,
  support_url text,
  note text,
  raw_data jsonb not null default '{}'::jsonb,
  created_by bigint references public.users(user_id),
  updated_by bigint references public.users(user_id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(run_id,reference),
  check(reversed_local<=initial_local+.000001 and reversed_foreign<=initial_foreign+.000001),
  check(abs(balance_local-(initial_local-reversed_local))<=.000001),
  check(abs(balance_foreign-(initial_foreign-reversed_foreign))<=.000001)
);

create table if not exists public.opening_pending_invoice_lines(
  id bigint generated always as identity primary key,
  item_id bigint not null references public.opening_pending_invoice_items(id) on delete cascade,
  row_number integer not null check(row_number>0),
  line_role text not null check(line_role in('CONTROL','COUNTERPART')),
  account_id bigint not null references public.chart_accounts(account_id) on delete restrict,
  local_debit numeric(24,6) not null default 0 check(local_debit>=0),
  local_credit numeric(24,6) not null default 0 check(local_credit>=0),
  foreign_debit numeric(24,6) not null default 0 check(foreign_debit>=0),
  foreign_credit numeric(24,6) not null default 0 check(foreign_credit>=0),
  department_id bigint references public.departments(department_id) on delete restrict,
  cost_center_id bigint references public.cost_centers(cost_center_id) on delete restrict,
  class_id bigint references public.classes(class_id) on delete restrict,
  location_id bigint references public.locations(location_id) on delete restrict,
  financial_creditor_id bigint references public.financial_creditors(financial_creditor_id) on delete restrict,
  related_company_id bigint references public.related_companies(related_company_id) on delete restrict,
  service_month text not null check(service_month~'^[0-9]{4}-(0[1-9]|1[0-2])$'),
  service_country_id bigint not null references public.countries(country_id) on delete restrict,
  note text,
  raw_data jsonb not null default '{}'::jsonb,
  unique(item_id,row_number),
  unique(item_id,line_role),
  check((local_debit>0)<>(local_credit>0)),
  check((foreign_debit>0)<>(foreign_credit>0)),
  check((local_debit>0)=(foreign_debit>0))
);

create table if not exists public.opening_pending_invoice_supports(
  id bigint generated always as identity primary key,
  item_id bigint not null references public.opening_pending_invoice_items(id) on delete cascade,
  support_type text not null check(support_type in('Archivo','Enlace')),
  display_name text not null check(btrim(display_name)<>''),
  support_url text,
  file_name text,
  mime_type text,
  file_size bigint,
  file_data text,
  created_at timestamptz not null default now(),
  check(
    support_type='Enlace'and support_url is not null and file_data is null
    or support_type='Archivo'and file_name is not null and file_data is not null and file_size between 0 and 5242880
  )
);

create index if not exists opening_pending_items_run_idx
  on public.opening_pending_invoice_items(run_id,is_active,reversal_status);
create index if not exists opening_pending_items_subsidiary_idx
  on public.opening_pending_invoice_items(subsidiary_id,origin_date);
create index if not exists opening_pending_items_customer_idx
  on public.opening_pending_invoice_items(customer_id,reversal_status);
create index if not exists opening_pending_lines_item_idx
  on public.opening_pending_invoice_lines(item_id,line_role);
create index if not exists opening_pending_supports_item_idx
  on public.opening_pending_invoice_supports(item_id);

alter table public.opening_pending_invoice_items enable row level security;
alter table public.opening_pending_invoice_lines enable row level security;
alter table public.opening_pending_invoice_supports enable row level security;

drop policy if exists opening_pending_items_select on public.opening_pending_invoice_items;
create policy opening_pending_items_select on public.opening_pending_invoice_items
 for select to authenticated using(
  exists(select 1 from public.user_subsidiaries access
   where access.user_id=public.app_user_id()
    and access.subsidiary_id=opening_pending_invoice_items.subsidiary_id)
 );

drop policy if exists opening_pending_lines_select on public.opening_pending_invoice_lines;
create policy opening_pending_lines_select on public.opening_pending_invoice_lines
 for select to authenticated using(
  exists(select 1 from public.opening_pending_invoice_items item
   join public.user_subsidiaries access on access.subsidiary_id=item.subsidiary_id
   where item.id=opening_pending_invoice_lines.item_id and access.user_id=public.app_user_id())
 );

drop policy if exists opening_pending_supports_select on public.opening_pending_invoice_supports;
create policy opening_pending_supports_select on public.opening_pending_invoice_supports
 for select to authenticated using(
  exists(select 1 from public.opening_pending_invoice_items item
   join public.user_subsidiaries access on access.subsidiary_id=item.subsidiary_id
   where item.id=opening_pending_invoice_supports.item_id and access.user_id=public.app_user_id())
 );

-- A reversal has exactly one operational origin: a regular ASI_PEN journal or
-- an opening auxiliary item.  No fictitious source journal is created.
alter table public.pending_invoice_reversal
  alter column source_journal_id drop not null,
  add column if not exists source_opening_pending_id bigint
    references public.opening_pending_invoice_items(id) on delete restrict;

alter table public.pending_invoice_reversal
  drop constraint if exists pending_invoice_reversal_one_source;
alter table public.pending_invoice_reversal
  add constraint pending_invoice_reversal_one_source
  check((source_journal_id is not null)<>(source_opening_pending_id is not null));

create index if not exists pending_invoice_reversal_opening_source_idx
  on public.pending_invoice_reversal(source_opening_pending_id,reversal_date,reversal_id)
  where source_opening_pending_id is not null;

-- Controlled reversals carry the subledger status of their source.  They must
-- not be annulled through the generic journal action because that would undo
-- only the GL while leaving the auxiliary marked as reversed.
create or replace function public.guard_pending_invoice_generic_reversal()
returns trigger language plpgsql set search_path=public,pg_temp as $$
begin
 if new.status='ANULADO'and old.status<>'ANULADO'
  and exists(select 1 from pending_invoice_reversal where reversal_journal_id=old.journal_id)then
  raise exception 'No se puede anular genéricamente una reversión controlada. Use el flujo de Pendientes de Facturar.';
 end if;
 if old.journal_number like'ASI_PEN-%'or old.journal_type='Asientos Pendientes de Facturar'then
  if new.status='ANULADO'and old.status<>'ANULADO'then
   if exists(select 1 from pending_invoice_reversal where source_journal_id=old.journal_id)then raise exception 'No se puede anular un ASI_PEN con reversiones aplicadas.';end if;
   if exists(select 1 from journal where reversed_from_journal_id=old.journal_id)then raise exception 'Use la acción Reversar Pendiente para los asientos ASI_PEN.';end if;
   new.reversal_status:='ANULADO';new.pending_balance_local:=0;new.pending_balance_foreign:=0;
  end if;
 end if;
 return new;
end$$;

create or replace function public.opening_pending_country_id(p_value text)
returns bigint language plpgsql stable security definer set search_path=public,pg_temp as $$
declare value_text text:=nullif(btrim(p_value),'');result_id bigint;matches integer;
begin
 if value_text is null then return null;end if;
 if value_text~*'^ID:[0-9]+$'then
  select count(*),min(country_id)into matches,result_id from countries
   where country_id=substring(value_text from 4)::bigint;
 elsif value_text~'^[0-9]+$'then
  select count(*),min(country_id)into matches,result_id from countries where country_id=value_text::bigint;
 else
  select count(*),min(country_id)into matches,result_id from countries
   where lower(name)=lower(value_text)or upper(coalesce(country_code_iso2,''))=upper(value_text)
    or upper(coalesce(country_code_iso3,''))=upper(value_text);
 end if;
 if matches<>1 then raise exception 'País de servicio "%" no existe o es ambiguo. Use ISO, nombre exacto o ID:identificador.',value_text;end if;
 return result_id;
end$$;

create or replace function public.opening_pending_invoice_stage(p_run_id bigint,p_items jsonb)
returns integer language plpgsql security definer set search_path=public,pg_temp as $$
declare
 run_row opening_balance_runs%rowtype;item jsonb;line jsonb;support jsonb;
 item_key bigint;customer_key bigint;currency_key bigint;local_currency bigint;country_key bigint;
 control_account bigint;counterpart_account bigint;account_key bigint;
 department_key bigint;cost_key bigint;class_key bigint;location_key bigint;creditor_key bigint;related_key bigint;
 center_customer bigint;center_department bigint;center_class bigint;
 reference_value text;origin_value date;service_month_value text;row_value integer;line_count integer;
 local_debit_value numeric;local_credit_value numeric;foreign_debit_value numeric;foreign_credit_value numeric;
 control_local numeric;counterpart_local numeric;control_foreign numeric;counterpart_foreign numeric;rate_value numeric;
 count_items integer:=0;role_value text;link_value text;supports jsonb;
begin
 if p_items is null then return 0;end if;
 if jsonb_typeof(p_items)<>'array'then raise exception 'El auxiliar de pendientes debe ser una lista válida.';end if;
 select * into run_row from opening_balance_runs
  where id=p_run_id and subsidiary_id=active_subsidiary_id()for update;
 if run_row.id is null then raise exception 'La apertura no pertenece a la subsidiaria activa.';end if;
 if exists(select 1 from opening_pending_invoice_items where run_id=p_run_id and(is_active or reversed_local>0))then
  raise exception 'El auxiliar de pendientes de facturar ya fue activado para esta apertura.';
 end if;
 delete from opening_pending_invoice_items where run_id=p_run_id;
 if jsonb_array_length(p_items)=0 then return 0;end if;

 select currency_id into local_currency from subsidiaries where subsidiary_id=run_row.subsidiary_id;
 select a.account_id into control_account from chart_accounts a join account_subsidiaries s using(account_id)
  where a.account_number='113003'and s.subsidiary_id=run_row.subsidiary_id and s.is_active
   and a.accepts_entries and not a.is_inactive limit 1;
 select a.account_id into counterpart_account from chart_accounts a join account_subsidiaries s using(account_id)
  where a.account_number='413001'and s.subsidiary_id=run_row.subsidiary_id and s.is_active
   and a.accepts_entries and not a.is_inactive limit 1;
 if control_account is null then raise exception 'La cuenta 113003 · Facturación Pendiente de Emitir no está habilitada para la subsidiaria.';end if;
 if counterpart_account is null then raise exception 'La cuenta 413001 · Servicios Pendientes de Facturar no está habilitada para la subsidiaria.';end if;

 for item in select value from jsonb_array_elements(p_items)loop
  count_items:=count_items+1;
  reference_value:=nullif(btrim(item->>'reference'),'');
  if reference_value is null then raise exception 'Pendientes registro %: indique una referencia única.',count_items;end if;
  if length(reference_value)>100 then raise exception 'Pendiente %: la referencia no puede exceder 100 caracteres.',left(reference_value,100);end if;
  begin origin_value:=nullif(item->>'originDate','')::date;
  exception when invalid_text_representation then raise exception 'Pendiente %: fecha de origen inválida.',reference_value;end;
  if origin_value is null or origin_value>run_row.opening_date then
   raise exception 'Pendiente %: la fecha de origen debe ser igual o anterior a la apertura.',reference_value;
  end if;
  service_month_value:=nullif(btrim(item->>'serviceMonth'),'');
  if service_month_value is null or service_month_value!~'^[0-9]{4}-(0[1-9]|1[0-2])$'then
   raise exception 'Pendiente %: el mes de servicio debe tener formato AAAA-MM.',reference_value;
  end if;
  if service_month_value>to_char(run_row.opening_date,'YYYY-MM')then
   raise exception 'Pendiente %: el mes de servicio no puede ser posterior al mes de apertura.',reference_value;
  end if;
  country_key:=opening_pending_country_id(coalesce(item->>'serviceCountry',item->>'serviceCountryId'));
  if country_key is null then raise exception 'Pendiente %: indique el país de servicio.',reference_value;end if;
  select c.customer_id into customer_key from customers c
   where c.tax_id=item->>'entityTaxId'and(c.primary_subsidiary_id=run_row.subsidiary_id
    or exists(select 1 from entity_subsidiaries e where e.customer_id=c.customer_id and e.subsidiary_id=run_row.subsidiary_id))limit 1;
  if customer_key is null then raise exception 'Pendiente %: cliente con identificación % no encontrado.',reference_value,coalesce(item->>'entityTaxId','');end if;
  select c.currency_id into currency_key from currencies c where upper(c.currency_code)=upper(item->>'currency')
   and(c.currency_id=local_currency or exists(select 1 from subsidiary_currencies sc where sc.subsidiary_id=run_row.subsidiary_id and sc.currency_id=c.currency_id))limit 1;
  if currency_key is null then raise exception 'Pendiente %: la moneda % no está habilitada.',reference_value,coalesce(item->>'currency','');end if;
  if jsonb_typeof(coalesce(item->'lines','[]'::jsonb))<>'array'or jsonb_array_length(coalesce(item->'lines','[]'::jsonb))<>2 then
   raise exception 'Pendiente %: incluya exactamente dos líneas, 113003 al debe y 413001 al haber.',reference_value;
  end if;

  control_local:=0;counterpart_local:=0;control_foreign:=0;counterpart_foreign:=0;line_count:=0;
  -- First pass validates the exact accounting composition and determines the
  -- historical rate before inserting the header.
  for line in select value from jsonb_array_elements(item->'lines')loop
   line_count:=line_count+1;
   select a.account_id into account_key from chart_accounts a join account_subsidiaries s using(account_id)
    where a.account_number=line->>'account'and s.subsidiary_id=run_row.subsidiary_id and s.is_active
     and a.accepts_entries and not a.is_inactive limit 1;
   if account_key is null then raise exception 'Pendiente % línea %: cuenta % no habilitada.',reference_value,line_count,coalesce(line->>'account','');end if;
   begin
    local_debit_value:=coalesce(nullif(line->>'debit','')::numeric,0);
    local_credit_value:=coalesce(nullif(line->>'credit','')::numeric,0);
    foreign_debit_value:=coalesce(nullif(line->>'debitFx','')::numeric,case when currency_key=local_currency then local_debit_value else 0 end);
    foreign_credit_value:=coalesce(nullif(line->>'creditFx','')::numeric,case when currency_key=local_currency then local_credit_value else 0 end);
   exception when invalid_text_representation or numeric_value_out_of_range then
    raise exception 'Pendiente % línea %: revise los importes.',reference_value,line_count;
   end;
   if least(local_debit_value,local_credit_value,foreign_debit_value,foreign_credit_value)<0
    or(local_debit_value>0)=(local_credit_value>0)
    or(foreign_debit_value>0)=(foreign_credit_value>0)
    or(local_debit_value>0)<>(foreign_debit_value>0)then
    raise exception 'Pendiente % línea %: indique un único lado y conserve el mismo lado en moneda local y original.',reference_value,line_count;
   end if;
   if account_key=control_account and local_debit_value>0 then
    control_local:=control_local+local_debit_value;control_foreign:=control_foreign+foreign_debit_value;
   elsif account_key=counterpart_account and local_credit_value>0 then
    counterpart_local:=counterpart_local+local_credit_value;counterpart_foreign:=counterpart_foreign+foreign_credit_value;
   else
    raise exception 'Pendiente %: la composición original debe ser 113003 al debe y 413001 al haber.',reference_value;
   end if;
  end loop;
  if control_local<=0 or abs(control_local-counterpart_local)>.005 or abs(control_foreign-counterpart_foreign)>.005 then
   raise exception 'Pendiente %: el asiento original no cuadra en moneda local u original.',reference_value;
  end if;
  if currency_key=local_currency then
   if abs(control_local-control_foreign)>.000001 then raise exception 'Pendiente %: los importes local y original deben coincidir en moneda funcional.',reference_value;end if;
   rate_value:=1;
  else
   rate_value:=coalesce(nullif(item->>'exchangeRate','')::numeric,control_local/nullif(control_foreign,0));
   if rate_value is null or rate_value<=0 or abs(control_local-round(control_foreign*rate_value,6))>.005 then
    raise exception 'Pendiente %: el tipo de cambio histórico no reproduce el importe local.',reference_value;
   end if;
  end if;

  link_value:=coalesce(nullif(btrim(item->>'supportUrl'),''),nullif(btrim(item->>'supportLink'),''));
  if link_value is not null and link_value!~*'^https?://[^[:space:]/?#]+[^[:space:]]*$'then
   raise exception 'Pendiente %: el enlace de respaldo no es válido.',reference_value;
  end if;
  insert into opening_pending_invoice_items(
   run_id,subsidiary_id,reference,origin_date,customer_id,currency_id,historical_exchange_rate,
   service_month,service_country_id,initial_local,initial_foreign,balance_local,balance_foreign,support_url,note,raw_data,created_by,updated_by
  )values(
   run_row.id,run_row.subsidiary_id,reference_value,origin_value,customer_key,currency_key,rate_value,
   service_month_value,country_key,control_local,control_foreign,control_local,control_foreign,link_value,nullif(btrim(item->>'note'),''),item-'supports',app_user_id(),app_user_id()
  )returning id into item_key;

  line_count:=0;
  for line in select value from jsonb_array_elements(item->'lines')loop
   line_count:=line_count+1;row_value:=coalesce(nullif(line->>'sourceRow','')::integer,line_count);
   select account_id into account_key from chart_accounts where account_number=line->>'account'limit 1;
   local_debit_value:=coalesce(nullif(line->>'debit','')::numeric,0);local_credit_value:=coalesce(nullif(line->>'credit','')::numeric,0);
   foreign_debit_value:=coalesce(nullif(line->>'debitFx','')::numeric,case when currency_key=local_currency then local_debit_value else 0 end);
   foreign_credit_value:=coalesce(nullif(line->>'creditFx','')::numeric,case when currency_key=local_currency then local_credit_value else 0 end);
   role_value:=case when account_key=control_account then'CONTROL'else'COUNTERPART'end;
   if(line ? 'isControlLine')and coalesce((line->>'isControlLine')::boolean,false)<>(role_value='CONTROL')then
    raise exception 'Pendiente % línea %: el indicador de cuenta control no coincide con la cuenta.',reference_value,row_value;
   end if;
   department_key:=opening_balance_dimension_id('department',line->>'department',run_row.subsidiary_id);
   cost_key:=opening_balance_dimension_id('costCenter',line->>'costCenter',run_row.subsidiary_id);
   class_key:=opening_balance_dimension_id('class',line->>'className',run_row.subsidiary_id);
   creditor_key:=opening_balance_dimension_id('financialCreditor',line->>'financialCreditor',run_row.subsidiary_id);
   related_key:=opening_balance_dimension_id('relatedCompany',line->>'relatedCompany',run_row.subsidiary_id);
   location_key:=opening_balance_dimension_id('location',line->>'location',run_row.subsidiary_id);
   if role_value='COUNTERPART'and cost_key is null then
    raise exception 'Pendiente % línea %: el centro de costos es obligatorio para la cuenta 413001.',reference_value,row_value;
   end if;
   if cost_key is not null then
    select cc.customer_id,cu.department_id,cc.class_id into center_customer,center_department,center_class
     from cost_centers cc left join customers cu on cu.customer_id=cc.customer_id where cc.cost_center_id=cost_key;
    if center_customer is not null and center_customer<>customer_key then raise exception 'Pendiente % línea %: el centro de costos pertenece a otro cliente.',reference_value,row_value;end if;
    if center_department is not null then
     if department_key is null then department_key:=center_department;
     elsif department_key<>center_department then raise exception 'Pendiente % línea %: el centro de costos no corresponde al departamento.',reference_value,row_value;end if;
    end if;
    if center_class is not null then
     if class_key is not null and class_key<>center_class then raise exception 'Pendiente % línea %: la clase no corresponde al centro de costos.',reference_value,row_value;end if;
     class_key:=center_class;
    elsif class_key is not null then raise exception 'Pendiente % línea %: el centro de costos no tiene la clase indicada.',reference_value,row_value;
    end if;
   elsif class_key is not null then raise exception 'Pendiente % línea %: indique centro de costos para asignar una clase.',reference_value,row_value;
   end if;
   insert into opening_pending_invoice_lines(
    item_id,row_number,line_role,account_id,local_debit,local_credit,foreign_debit,foreign_credit,
    department_id,cost_center_id,class_id,location_id,financial_creditor_id,related_company_id,
    service_month,service_country_id,note,raw_data
   )values(
    item_key,row_value,role_value,account_key,local_debit_value,local_credit_value,foreign_debit_value,foreign_credit_value,
    department_key,cost_key,class_key,location_key,creditor_key,related_key,service_month_value,country_key,
    coalesce(nullif(btrim(line->>'note'),''),nullif(btrim(item->>'note'),'')),line
   );
  end loop;

  if link_value is not null then
   insert into opening_pending_invoice_supports(item_id,support_type,display_name,support_url)
    values(item_key,'Enlace','Respaldo de '||reference_value,link_value);
  end if;
  supports:=coalesce(item->'supports','[]'::jsonb);
  if jsonb_typeof(supports)<>'array'then raise exception 'Pendiente %: los respaldos no son válidos.',reference_value;end if;
  for support in select value from jsonb_array_elements(supports)loop
   if coalesce(support->>'supportType',support->>'support_type')='Enlace'then
    if nullif(btrim(coalesce(support->>'displayName',support->>'display_name')),'')is null
     or coalesce(support->>'supportUrl',support->>'support_url','')!~*'^https?://[^[:space:]/?#]+[^[:space:]]*$'then
     raise exception 'Pendiente %: enlace de respaldo inválido.',reference_value;
    end if;
    insert into opening_pending_invoice_supports(item_id,support_type,display_name,support_url)
     values(item_key,'Enlace',coalesce(support->>'displayName',support->>'display_name'),coalesce(support->>'supportUrl',support->>'support_url'));
   elsif coalesce(support->>'supportType',support->>'support_type')='Archivo'then
    if nullif(btrim(coalesce(support->>'fileName',support->>'file_name')),'')is null
     or nullif(btrim(coalesce(support->>'displayName',support->>'display_name')),'')is null
     or coalesce(support->>'fileData',support->>'file_data')is null
     or coalesce(coalesce(support->>'fileSize',support->>'file_size')::bigint,-1)not between 0 and 5242880 then
     raise exception 'Pendiente %: archivo de respaldo inválido o superior a 5 MB.',reference_value;
    end if;
    if length(coalesce(support->>'fileData',support->>'file_data'))>7100000
     or coalesce(support->>'fileData',support->>'file_data')!~'^data:[^,]*;base64,'then raise exception 'Pendiente %: contenido de respaldo inválido.',reference_value;end if;
    if octet_length(decode(split_part(coalesce(support->>'fileData',support->>'file_data'),',',2),'base64'))
      <>coalesce(support->>'fileSize',support->>'file_size')::bigint then
     raise exception 'Pendiente %: el tamaño del respaldo no coincide con su contenido.',reference_value;
    end if;
    insert into opening_pending_invoice_supports(item_id,support_type,display_name,file_name,mime_type,file_size,file_data)
     values(item_key,'Archivo',coalesce(support->>'displayName',support->>'display_name'),coalesce(support->>'fileName',support->>'file_name'),
      coalesce(support->>'mimeType',support->>'mime_type','application/octet-stream'),coalesce(support->>'fileSize',support->>'file_size')::bigint,
      coalesce(support->>'fileData',support->>'file_data'));
   else raise exception 'Pendiente %: tipo de respaldo no válido.',reference_value;
   end if;
  end loop;
 end loop;
 return count_items;
end$$;

create or replace function public.opening_pending_invoice_reconciliation(p_run_id bigint)
returns jsonb language sql stable security definer set search_path=public as $$
with run as(
 select r.* from opening_balance_runs r where r.id=p_run_id and r.subsidiary_id=active_subsidiary_id()
),control as(
 select a.account_id,a.account_number,a.account_name from chart_accounts a
  where a.account_number='113003'
),ledger_values as(
 select l.currency_id,l.local_debit-l.local_credit local_amount,
  case when l.local_debit>0 then l.foreign_amount else-l.foreign_amount end foreign_amount
 from run r join opening_balance_lines l on l.run_id=r.id join control c on c.account_id=l.account_id
 where r.status<>'POSTED'
 union all
 select coalesce(g.original_currency_id,j.currency_id),g.debit_amount-g.credit_amount,g.debit_fx-g.credit_fx
 from run r join journal j on j.journal_id=r.journal_id join gl_impact g on g.transaction_id=j.transaction_id
 join accounting_books b using(accounting_book_id)join control c on c.account_id=g.account_id
 where r.status='POSTED'and b.is_primary and b.is_active
),ledger as(
 select currency_id,sum(local_amount)local_amount,sum(foreign_amount)foreign_amount from ledger_values group by currency_id
),auxiliary as(
 select i.currency_id,sum(i.initial_local)local_amount,sum(i.initial_foreign)foreign_amount,
  sum(i.initial_local)filter(where i.is_active)existing_local,
  sum(i.initial_foreign)filter(where i.is_active)existing_foreign,
  sum(i.initial_local)filter(where not i.is_active)staged_local,
  sum(i.initial_foreign)filter(where not i.is_active)staged_foreign
 from opening_pending_invoice_items i where i.run_id=p_run_id group by i.currency_id
),keys as(
 select currency_id from ledger union select currency_id from auxiliary
)
select coalesce(jsonb_agg(jsonb_build_object(
 'accountId',c.account_id,'accountNumber',c.account_number,'accountName',c.account_name,
 'currencyId',k.currency_id,'currency',cu.currency_code,
 'ledger',coalesce(l.local_amount,0),'existing',coalesce(a.existing_local,0),'staged',coalesce(a.staged_local,0),'auxiliary',coalesce(a.local_amount,0),
 'difference',coalesce(l.local_amount,0)-coalesce(a.local_amount,0),
 'ledgerForeign',coalesce(l.foreign_amount,0),'auxiliaryForeign',coalesce(a.foreign_amount,0),
 'foreignDifference',coalesce(l.foreign_amount,0)-coalesce(a.foreign_amount,0),
 'balanced',abs(coalesce(l.local_amount,0)-coalesce(a.local_amount,0))<=.005
  and abs(coalesce(l.foreign_amount,0)-coalesce(a.foreign_amount,0))<=.005
)order by cu.currency_code),'[]'::jsonb)
from keys k cross join control c join currencies cu on cu.currency_id=k.currency_id
left join ledger l on l.currency_id=k.currency_id left join auxiliary a on a.currency_id=k.currency_id
$$;

-- Extend opening options with the immutable accounting rule and service-country
-- catalog used by the downloadable template.
alter function public.opening_balance_options()
  rename to opening_balance_options_before_opening_pending;
revoke all on function public.opening_balance_options_before_opening_pending()from public,anon,authenticated;

create function public.opening_balance_options()returns jsonb
language plpgsql stable security definer set search_path=public,pg_temp as $$
declare base jsonb;sid bigint:=active_subsidiary_id();
begin
 base:=opening_balance_options_before_opening_pending();
 return base||jsonb_build_object(
  'pendingAccounts',jsonb_build_object(
   'control',(select jsonb_build_object('id',a.account_id,'number',a.account_number,'name',a.account_name)from chart_accounts a join account_subsidiaries s using(account_id)where a.account_number='113003'and s.subsidiary_id=sid and s.is_active limit 1),
   'counterpart',(select jsonb_build_object('id',a.account_id,'number',a.account_number,'name',a.account_name)from chart_accounts a join account_subsidiaries s using(account_id)where a.account_number='413001'and s.subsidiary_id=sid and s.is_active limit 1)
  ),
  'countries',coalesce((select jsonb_agg(jsonb_build_object('id',country_id,'name',name,'iso2',country_code_iso2,'iso3',country_code_iso3)order by name)from countries),'[]'::jsonb)
 );
end$$;

alter function public.opening_balance_preview(bigint)
  rename to opening_balance_preview_before_opening_pending;
revoke all on function public.opening_balance_preview_before_opening_pending(bigint)from public,anon,authenticated;

create function public.opening_balance_preview(p_run_id bigint)returns jsonb
language plpgsql stable security definer set search_path=public,pg_temp as $$
declare base jsonb;reconciliation jsonb;
begin
 base:=opening_balance_preview_before_opening_pending(p_run_id);
 if base is null then return null;end if;
 reconciliation:=opening_pending_invoice_reconciliation(p_run_id);
 return base||jsonb_build_object(
  'pendingItems',coalesce((select jsonb_agg(jsonb_build_object(
   'id',i.id,'pendingId',i.id,'reference',i.reference,'originDate',i.origin_date,'customerId',i.customer_id,'customer',c.company_name,
   'customerName',c.company_name,'entityTaxId',c.tax_id,'customerIdentification',c.tax_id,
   'currencyId',i.currency_id,'currency',cu.currency_code,'exchangeRate',i.historical_exchange_rate,'rate',i.historical_exchange_rate,'serviceMonth',i.service_month,
   'serviceCountryId',i.service_country_id,'serviceCountry',country.name,'initialLocal',i.initial_local,'initialForeign',i.initial_foreign,
   'initial',i.initial_local,'reversedLocal',i.reversed_local,'reversedForeign',i.reversed_foreign,'reversed',i.reversed_local,
   'balanceLocal',i.balance_local,'balanceForeign',i.balance_foreign,'balance',i.balance_local,
   'status',i.reversal_status,'active',i.is_active,'created',i.is_active,'supportUrl',i.support_url,'note',i.note,'errors','[]'::jsonb,
   'lines',coalesce((select jsonb_agg(jsonb_build_object(
    'id',l.id,'row',l.row_number,'role',l.line_role,'account',a.account_number,'accountName',a.account_name,
    'debit',l.local_debit,'credit',l.local_credit,'debitFx',l.foreign_debit,'creditFx',l.foreign_credit,
    'department',d.name,'costCenter',case when cc.cost_center_id is null then null else cc.code||' · '||cc.name end,
    'className',cl.name,'location',lo.name,'financialCreditor',fc.name,'relatedCompany',rc.name,'note',l.note
   )order by l.row_number)from opening_pending_invoice_lines l join chart_accounts a on a.account_id=l.account_id
    left join departments d on d.department_id=l.department_id left join cost_centers cc on cc.cost_center_id=l.cost_center_id left join classes cl on cl.class_id=l.class_id
    left join locations lo on lo.location_id=l.location_id left join financial_creditors fc on fc.financial_creditor_id=l.financial_creditor_id
    left join related_companies rc on rc.related_company_id=l.related_company_id where l.item_id=i.id),'[]'::jsonb),
   'supports',coalesce((select jsonb_agg(jsonb_build_object('id',s.id,'type',s.support_type,'name',s.display_name,'url',s.support_url,'fileName',s.file_name,'mimeType',s.mime_type,'fileSize',s.file_size)order by s.id)from opening_pending_invoice_supports s where s.item_id=i.id),'[]'::jsonb)
  )order by i.origin_date,i.id)from opening_pending_invoice_items i join customers c on c.customer_id=i.customer_id join currencies cu on cu.currency_id=i.currency_id
   join countries country on country.country_id=i.service_country_id where i.run_id=p_run_id),'[]'::jsonb),
  'pendingReconciliation',reconciliation,
  'pendingSummary',(select jsonb_build_object(
   'count',count(*),'initial',coalesce(sum(initial_local),0),'reversed',coalesce(sum(reversed_local),0),'balance',coalesce(sum(balance_local),0),
   'pending',count(*)filter(where reversal_status='PENDIENTE'),'pendingCount',count(*)filter(where reversal_status='PENDIENTE'),'partial',count(*)filter(where reversal_status='REVERSADO_PARCIAL'),
   'total',count(*)filter(where reversal_status='REVERSADO_TOTAL'),'active',count(*)filter(where is_active),
   'balanced',coalesce((select bool_and(abs((x->>'difference')::numeric)<=.005 and abs((x->>'foreignDifference')::numeric)<=.005)from jsonb_array_elements(reconciliation)x),true)
  )from opening_pending_invoice_items where run_id=p_run_id)
 );
end$$;

alter function public.opening_balance_validate(jsonb)
  rename to opening_balance_validate_before_opening_pending;
revoke all on function public.opening_balance_validate_before_opening_pending(jsonb)from public,anon,authenticated;

create function public.opening_balance_validate(p jsonb)returns jsonb
language plpgsql security definer set search_path=public,pg_temp as $$
declare output jsonb;rid bigint;sid bigint;existing opening_balance_runs%rowtype;pending_payload jsonb:=coalesce(p->'pending',p->'pendingItems');has_pending boolean:=false;
begin
 sid:=opening_balance_assert_access('create');
 if coalesce(p->>'expectedSubsidiaryId','')<>sid::text then raise exception 'La empresa activa cambió desde que abrió la carga. Recargue la pantalla y seleccione nuevamente los archivos.';end if;
 if((p ? 'pending')or(p ? 'pendingItems'))and jsonb_typeof(coalesce(pending_payload,'[]'::jsonb))<>'array'then raise exception 'El auxiliar de pendientes debe ser una lista válida.';end if;
 has_pending:=jsonb_typeof(coalesce(pending_payload,'[]'::jsonb))='array'and jsonb_array_length(coalesce(pending_payload,'[]'::jsonb))>0;
 select * into existing from opening_balance_runs where subsidiary_id=sid and status<>'REVERSED'order by id desc limit 1;
 if existing.status='POSTED'and has_pending and jsonb_array_length(coalesce(pending_payload,'[]'::jsonb))>0
  and jsonb_array_length(coalesce(p->'rows','[]'::jsonb))=0 and jsonb_array_length(coalesce(p->'assets','[]'::jsonb))=0 then
  rid:=existing.id;
 elsif existing.status='POSTED'and has_pending and jsonb_array_length(coalesce(pending_payload,'[]'::jsonb))>0 then
  output:=opening_balance_validate_before_opening_pending(p-'pending'-'pendingItems');
  rid:=(output->'run'->>'id')::bigint;
 else
  output:=opening_balance_validate_before_opening_pending(p-'pending'-'pendingItems');
  rid:=(output->'run'->>'id')::bigint;
 end if;
 if has_pending then perform opening_pending_invoice_stage(rid,coalesce(pending_payload,'[]'::jsonb));end if;
 return opening_balance_preview(rid);
end$$;

alter function public.opening_balance_post(bigint)
  rename to opening_balance_post_before_opening_pending;
revoke all on function public.opening_balance_post_before_opening_pending(bigint)from public,anon,authenticated;

create function public.opening_balance_post(p_run_id bigint)returns jsonb
language plpgsql security definer set search_path=public,pg_temp as $$
declare run_row opening_balance_runs%rowtype;result jsonb;reconciliation jsonb;has_pending boolean;has_assets boolean;activated_count integer:=0;
begin
 perform opening_balance_assert_access('create');
 select * into run_row from opening_balance_runs where id=p_run_id and subsidiary_id=active_subsidiary_id()for update;
 if run_row.id is null then raise exception 'Lote no disponible.';end if;
 has_pending:=exists(select 1 from opening_pending_invoice_items where run_id=p_run_id and not is_active);
 reconciliation:=opening_pending_invoice_reconciliation(p_run_id);
 if exists(select 1 from jsonb_array_elements(reconciliation)x
  where abs(coalesce((x->>'difference')::numeric,0))>.005 or abs(coalesce((x->>'foreignDifference')::numeric,0))>.005)then
  raise exception 'El auxiliar de pendientes de facturar no coincide con la cuenta 113003 del Libro Mayor. Corrija la conciliación antes de continuar.';
 end if;
 if run_row.status='POSTED'then
  has_assets:=exists(select 1 from opening_fixed_asset_lines where run_id=p_run_id and created_asset_id is null);
  if has_assets then result:=opening_balance_post_before_opening_pending(p_run_id);
  elsif not has_pending then raise exception 'No hay auxiliares pendientes de activar.';
  else result:=jsonb_build_object('runId',run_row.id,'journalId',run_row.journal_id,'journalNumber',(select journal_number from journal where journal_id=run_row.journal_id),'pendingOnly',true);end if;
 else
  result:=opening_balance_post_before_opening_pending(p_run_id);
 end if;
 update opening_pending_invoice_items set is_active=true,activated_at=coalesce(activated_at,now()),updated_at=now(),updated_by=app_user_id()
  where run_id=p_run_id and not is_active;
 get diagnostics activated_count=row_count;
 return result||jsonb_build_object('pendingActivated',activated_count);
end$$;

alter function public.opening_balance_reverse(bigint)
  rename to opening_balance_reverse_before_opening_pending;
revoke all on function public.opening_balance_reverse_before_opening_pending(bigint)from public,anon,authenticated;

create function public.opening_balance_reverse(p_run_id bigint)returns jsonb
language plpgsql security definer set search_path=public,pg_temp as $$
declare result jsonb;run_row opening_balance_runs%rowtype;sid bigint;
begin
 sid:=opening_balance_assert_access('delete');
 select *into run_row from opening_balance_runs where id=p_run_id and subsidiary_id=sid for update;
 if run_row.id is null or run_row.status<>'POSTED'then raise exception 'Apertura contabilizada no encontrada.';end if;
 if exists(select 1 from pending_invoice_reversal r join opening_pending_invoice_items i on i.id=r.source_opening_pending_id where i.run_id=p_run_id)then
  raise exception 'No se puede reversar la apertura: existen reversiones posteriores aplicadas al auxiliar de pendientes de facturar.';
 end if;
 result:=opening_balance_reverse_before_opening_pending(p_run_id);
 update opening_pending_invoice_items set is_active=false,opening_reversed_at=now(),reversal_status='ANULADO',updated_at=now(),updated_by=app_user_id()
  where run_id=p_run_id;
 return result;
end$$;

create or replace function public.validate_pending_reversal_invoice()
returns trigger language plpgsql set search_path=public,pg_temp as $$
declare source_customer bigint;source_subsidiary bigint;linked_invoice invoice%rowtype;
begin
 if(new.source_journal_id is null)=(new.source_opening_pending_id is null)then raise exception 'La reversión debe tener un único origen.';end if;
 if new.reversal_type<>'FACTURACION'then return new;end if;
 if new.source_journal_id is not null then
  select l.customer_id,j.subsidiary_id into source_customer,source_subsidiary from journal j
   left join lateral(select customer_id from journal_line where journal_id=j.journal_id and customer_id is not null order by journal_line_id limit 1)l on true
   where j.journal_id=new.source_journal_id;
 else
  select customer_id,subsidiary_id into source_customer,source_subsidiary from opening_pending_invoice_items where id=new.source_opening_pending_id;
 end if;
 select * into linked_invoice from invoice where invoice_id=new.sales_invoice_id;
 if source_customer is null or linked_invoice.invoice_id is null or linked_invoice.customer_id<>source_customer
  or linked_invoice.subsidiary_id<>source_subsidiary
  or date_trunc('month',linked_invoice.invoice_date)<>date_trunc('month',new.reversal_date)then
  raise exception 'La factura vinculada debe pertenecer al cliente, subsidiaria y mes de la reversión.';
 end if;
 return new;
end$$;

drop trigger if exists validate_pending_reversal_invoice_trigger on public.pending_invoice_reversal;
create trigger validate_pending_reversal_invoice_trigger
 before insert or update of source_journal_id,source_opening_pending_id,reversal_date,reversal_type,sales_invoice_id
 on public.pending_invoice_reversal for each row execute function public.validate_pending_reversal_invoice();

create or replace function public.opening_pending_invoice_reversal_options(p_item_id bigint,p_reversal_date date)
returns jsonb language plpgsql stable security definer set search_path=public,pg_temp as $$
declare item opening_pending_invoice_items%rowtype;reversal_month date;
begin
 select i.*into item from opening_pending_invoice_items i join user_subsidiaries u using(subsidiary_id)
  where i.id=p_item_id and u.user_id=app_user_id()and i.is_active;
 if item.id is null then raise exception 'El pendiente inicial no existe o no está activo.';end if;
 if p_reversal_date is null then raise exception 'Indique la fecha de reversión para consultar las facturas.';end if;
 reversal_month:=date_trunc('month',p_reversal_date)::date;
 return jsonb_build_object(
  'journal',jsonb_build_object('id',-item.id,'openingPendingId',item.id,'sourceType','OPENING','number',item.reference,'date',item.origin_date,
   'initialLocal',item.initial_local,'initialForeign',item.initial_foreign,'reversedLocal',item.reversed_local,'reversedForeign',item.reversed_foreign,
   'balanceLocal',item.balance_local,'balanceForeign',item.balance_foreign,'status',item.reversal_status,'currencyId',item.currency_id,'customerId',item.customer_id),
  'invoices',coalesce((select jsonb_agg(jsonb_build_object('id',i.invoice_id,'number',i.invoice_number,'date',i.invoice_date,'customerId',i.customer_id,'customer',c.company_name,'total',i.total_amount)order by i.invoice_date desc,i.invoice_id desc)
   from invoice i join customers c using(customer_id)where i.subsidiary_id=item.subsidiary_id and i.customer_id=item.customer_id
    and i.invoice_date>=reversal_month and i.invoice_date<reversal_month+interval'1 month'),'[]'::jsonb),
  'reversals',coalesce((select jsonb_agg(jsonb_build_object('id',r.reversal_id,'journalId',r.reversal_journal_id,'number',j.journal_number,'date',r.reversal_date,
   'amount',r.reversed_local,'type',r.reversal_type,'invoice',i.invoice_number,'reason',r.error_description,'user',coalesce(u.first_name||' '||u.last_name,u.email))order by r.reversal_date,r.reversal_id)
   from pending_invoice_reversal r join journal j on j.journal_id=r.reversal_journal_id left join invoice i on i.invoice_id=r.sales_invoice_id
   left join users u on u.user_id=r.created_by where r.source_opening_pending_id=item.id),'[]'::jsonb)
 );
end$$;

create or replace function public.reverse_opening_pending_invoice(p_item_id bigint,p_payload jsonb)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare
 item opening_pending_invoice_items%rowtype;run_row opening_balance_runs%rowtype;control_line opening_pending_invoice_lines%rowtype;counterpart_line opening_pending_invoice_lines%rowtype;
 run_key bigint;
 reversal_date_value date;amount_value numeric(24,6);foreign_value numeric(24,6);ratio numeric(30,15);kind text;invoice_key bigint;reason text;
 period_key bigint;type_key bigint;status_key bigint;book_key bigint;number_value text;transaction_key bigint;journal_key bigint;memo_value text;is_final boolean;
 support jsonb;supports jsonb;control_account bigint;counterpart_account bigint;
begin
 if not exists(select 1 from user_roles ur join role_permissions rp using(role_id)join permissions p using(permission_id)
  where ur.user_id=app_user_id()and p.code='accounting:journal:reverse')then raise exception 'No tiene permiso para reversar asientos.';end if;
 select i.run_id into run_key from opening_pending_invoice_items i join user_subsidiaries u using(subsidiary_id)
  where i.id=p_item_id and u.user_id=app_user_id();
 if run_key is null then raise exception 'El pendiente inicial no existe.';end if;
 -- Uniform lock order for posting/opening reversal/pending reversal: run first,
 -- then the auxiliary item.  Re-read both records after acquiring the locks.
 select *into run_row from opening_balance_runs where id=run_key and subsidiary_id=active_subsidiary_id()for update;
 select i.*into item from opening_pending_invoice_items i where i.id=p_item_id and i.run_id=run_key and i.subsidiary_id=run_row.subsidiary_id for update;
 if run_row.id is null or item.id is null then raise exception 'El pendiente inicial no existe o cambió de subsidiaria.';end if;
 if not item.is_active or run_row.status<>'POSTED'or item.reversal_status in('REVERSADO_TOTAL','ANULADO')then raise exception 'El pendiente inicial no tiene saldo disponible para reversar.';end if;
 reversal_date_value:=nullif(p_payload->>'reversalDate','')::date;amount_value:=nullif(p_payload->>'amount','')::numeric;
 kind:=p_payload->>'type';invoice_key:=nullif(p_payload->>'invoiceId','')::bigint;reason:=nullif(btrim(p_payload->>'errorDescription'),'');
 if reversal_date_value is null or reversal_date_value<=run_row.opening_date then raise exception 'La reversión debe ser posterior a la fecha de apertura.';end if;
 if amount_value is null or amount_value<=0 then raise exception 'Indique un monto de reversión válido.';end if;
 if amount_value>item.balance_local+.000001 then raise exception 'El monto a reversar (%) supera el saldo disponible (%).',amount_value,item.balance_local;end if;
 if kind not in('FACTURACION','ERROR_CORRECCION')then raise exception 'Seleccione el tipo de reversión.';end if;
 if kind='FACTURACION'and(invoice_key is null or not exists(select 1 from invoice i where i.invoice_id=invoice_key and i.subsidiary_id=item.subsidiary_id
  and i.customer_id=item.customer_id and date_trunc('month',i.invoice_date)=date_trunc('month',reversal_date_value)))then
  raise exception 'Seleccione una factura válida del cliente y del mismo mes de la reversión.';
 end if;
 if kind='ERROR_CORRECCION'and(reason is null or length(reason)<15)then raise exception 'La descripción del error debe contener al menos 15 caracteres.';end if;
 supports:=coalesce(p_payload->'supports','[]'::jsonb);
 if jsonb_typeof(supports)<>'array'then raise exception 'Los archivos de respaldo no son válidos.';end if;
 if jsonb_array_length(supports)>0 and kind<>'ERROR_CORRECCION'then raise exception 'Solo las reversiones por error / corrección permiten respaldos.';end if;
 for support in select value from jsonb_array_elements(supports)loop
  if support->>'support_type'='Enlace'then
   if nullif(btrim(support->>'display_name'),'')is null or coalesce(support->>'support_url','')!~*'^https?://[^[:space:]/?#]+[^[:space:]]*$'then raise exception 'Ingrese un enlace válido.';end if;
  elsif support->>'support_type'='Archivo'then
   if nullif(btrim(support->>'file_name'),'')is null or nullif(btrim(support->>'display_name'),'')is null or support->>'file_data'is null
    or coalesce((support->>'file_size')::bigint,-1)not between 0 and 5242880 then raise exception 'Archivo de respaldo inválido o superior a 5 MB.';end if;
  else raise exception 'Tipo de respaldo no válido.';end if;
 end loop;
 select *into control_line from opening_pending_invoice_lines where item_id=item.id and line_role='CONTROL';
 select *into counterpart_line from opening_pending_invoice_lines where item_id=item.id and line_role='COUNTERPART';
 select account_id into control_account from chart_accounts where account_number='113003';
 select account_id into counterpart_account from chart_accounts where account_number='413001';
 if control_line.account_id<>control_account or counterpart_line.account_id<>counterpart_account then raise exception 'La composición contable del pendiente fue modificada. Valide 113003 y 413001.';end if;
 select fiscal_period_id into period_key from fiscal_periods where subsidiary_id=item.subsidiary_id and reversal_date_value between start_date and end_date
  and not is_closed and not coalesce(gl_closed,false)and not coalesce(is_inactive,false)order by start_date desc limit 1 for update;
 if period_key is null then raise exception 'No existe un período contable abierto para la fecha de reversión.';end if;
 select transaction_type_id into type_key from transaction_types where abbreviation='ASI_REV_PEN';
 if type_key is null then raise exception 'No existe el tipo de transacción ASI_REV_PEN.';end if;
 select status_id into status_key from status where code='APROBADO'and module='Transacciones'limit 1;
 if status_key is null then select status_id into status_key from status order by status_id limit 1;end if;
 if status_key is null then raise exception 'No existe un estado contable para registrar la reversión.';end if;
 select accounting_book_id into book_key from accounting_books where subsidiary_id=item.subsidiary_id and is_primary and is_active order by accounting_book_id limit 1;
 if book_key is null then raise exception 'Configure un libro contable principal activo.';end if;
 insert into number_sequences(scope_type,transaction_type_id,subsidiary_id,prefix,current_number,padding_length)
  values('Transacción',type_key,item.subsidiary_id,'ASI_REV_PEN-',0,8)
  on conflict(transaction_type_id,subsidiary_id)where scope_type='Transacción'do nothing;
 number_value:=next_transaction_number(type_key,item.subsidiary_id);is_final:=amount_value>=item.balance_local-.000001;
 if is_final then amount_value:=item.balance_local;foreign_value:=item.balance_foreign;
 else ratio:=amount_value/item.initial_local;foreign_value:=least(round(item.initial_foreign*ratio,6),item.balance_foreign);end if;
 memo_value:=case when kind='FACTURACION'then'Reversión de saldo inicial '||item.reference||' por factura '||(select invoice_number from invoice where invoice_id=invoice_key)
  else'Reversión de saldo inicial '||item.reference||': '||reason end;
 insert into "transaction"(tran_number,tran_date,transaction_type_id,subsidiary_id,currency_id,exchange_rate,fiscal_period_id,total_amount,status_id,customer_id)
  values(number_value,reversal_date_value,type_key,item.subsidiary_id,item.currency_id,item.historical_exchange_rate,period_key,amount_value,status_key,item.customer_id)
  returning transaction_id into transaction_key;
 insert into journal(journal_number,journal_date,transaction_id,subsidiary_id,currency_id,fiscal_period_id,exchange_rate,memo,journal_type,total_debit,total_credit,status,created_by)
  values(number_value,reversal_date_value,transaction_key,item.subsidiary_id,item.currency_id,period_key,item.historical_exchange_rate,memo_value,'Reversión de Pendiente de Facturar',amount_value,amount_value,'CONTABILIZADO',app_user_id())
  returning journal_id into journal_key;
 -- Exact required entry: Dr 413001 / Cr 113003.  Dimensions and service
 -- attributes remain attached to their respective historical lines.
 insert into journal_line(journal_id,account_id,debit,credit,debit_fx,credit_fx,department_id,class_id,location_id,cost_center_id,financial_creditor_id,related_company_id,
  service_month,service_country_id,note,entity_type,customer_id,historical_exchange_rate,original_currency_id)
 values
  (journal_key,counterpart_account,amount_value,0,foreign_value,0,counterpart_line.department_id,counterpart_line.class_id,counterpart_line.location_id,counterpart_line.cost_center_id,counterpart_line.financial_creditor_id,counterpart_line.related_company_id,counterpart_line.service_month,counterpart_line.service_country_id,memo_value,'Cliente',item.customer_id,item.historical_exchange_rate,item.currency_id),
  (journal_key,control_account,0,amount_value,0,foreign_value,control_line.department_id,control_line.class_id,control_line.location_id,control_line.cost_center_id,control_line.financial_creditor_id,control_line.related_company_id,control_line.service_month,control_line.service_country_id,memo_value,'Cliente',item.customer_id,item.historical_exchange_rate,item.currency_id);
 -- journal_line triggers build ordinary impacts using the journal rate. Replace
 -- them with the frozen local/original snapshot so the control account clears
 -- exactly, including the last partial-reversal rounding residue.
 delete from gl_impact where transaction_id=transaction_key;
 insert into gl_impact(transaction_id,account_id,subsidiary_id,fiscal_period_id,accounting_book_id,debit_amount,credit_amount,debit_fx,credit_fx,posting_date,original_currency_id)
 values
  (transaction_key,counterpart_account,item.subsidiary_id,period_key,book_key,amount_value,0,foreign_value,0,reversal_date_value,item.currency_id),
  (transaction_key,control_account,item.subsidiary_id,period_key,book_key,0,amount_value,0,foreign_value,reversal_date_value,item.currency_id);
 insert into pending_invoice_reversal(source_opening_pending_id,reversal_journal_id,reversal_date,reversed_local,reversed_foreign,reversal_type,sales_invoice_id,error_description)
  values(item.id,journal_key,reversal_date_value,amount_value,foreign_value,kind,case when kind='FACTURACION'then invoice_key end,case when kind='ERROR_CORRECCION'then reason end);
 update opening_pending_invoice_items set reversed_local=reversed_local+amount_value,reversed_foreign=reversed_foreign+foreign_value,
  balance_local=greatest(initial_local-reversed_local-amount_value,0),balance_foreign=greatest(initial_foreign-reversed_foreign-foreign_value,0),
  reversal_status=case when initial_local-reversed_local-amount_value<=.000001 then'REVERSADO_TOTAL'else'REVERSADO_PARCIAL'end,
  updated_at=now(),updated_by=app_user_id()where id=item.id;
 for support in select value from jsonb_array_elements(supports)loop
  if support->>'support_type'='Enlace'then insert into journal_support(journal_id,support_type,display_name,support_url)
   values(journal_key,'Enlace',support->>'display_name',support->>'support_url');
  else insert into journal_support(journal_id,support_type,display_name,file_name,mime_type,file_size,file_data)
   values(journal_key,'Archivo',support->>'display_name',support->>'file_name',coalesce(support->>'mime_type','application/octet-stream'),(support->>'file_size')::bigint,support->>'file_data');end if;
 end loop;
 return jsonb_build_object('journalId',journal_key,'number',number_value,'amount',amount_value,'remaining',greatest(item.balance_local-amount_value,0),'openingPendingId',item.id);
end$$;

-- Keep the existing public RPC contract.  Negative ids represent opening
-- auxiliary items; positive ids continue using the regular ASI_PEN workflow.
alter function public.pending_invoice_reversal_options(bigint,date)
  rename to pending_invoice_reversal_options_before_opening_pending;
revoke all on function public.pending_invoice_reversal_options_before_opening_pending(bigint,date)from public,anon,authenticated;

create function public.pending_invoice_reversal_options(p_journal_id bigint,p_reversal_date date)
returns jsonb language plpgsql stable security definer set search_path=public,pg_temp as $$
begin
 if p_journal_id<0 then return opening_pending_invoice_reversal_options(-p_journal_id,p_reversal_date);end if;
 return pending_invoice_reversal_options_before_opening_pending(p_journal_id,p_reversal_date);
end$$;

alter function public.reverse_pending_invoice_journal(bigint,jsonb)
  rename to reverse_pending_invoice_journal_before_opening_pending;
revoke all on function public.reverse_pending_invoice_journal_before_opening_pending(bigint,jsonb)from public,anon,authenticated;

create function public.reverse_pending_invoice_journal(p_journal_id bigint,p_payload jsonb)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
begin
 if p_journal_id<0 then return reverse_opening_pending_invoice(-p_journal_id,p_payload);end if;
 return reverse_pending_invoice_journal_before_opening_pending(p_journal_id,p_payload);
end$$;

-- Replace the non-consolidated implementation used by the existing USD
-- wrapper.  Thus both local and consolidated reports include opening items.
create or replace function public.run_pending_invoice_control_report_before_consolidation(p_filters jsonb default'{}')
returns jsonb language plpgsql stable security definer set search_path=public,pg_temp as $$
declare sids bigint[];df date;dt date;customer_key bigint;state text;result jsonb;
begin
 select coalesce(array_agg(value::bigint),array[]::bigint[])into sids from jsonb_array_elements_text(coalesce(p_filters->'subsidiaryIds','[]'));
 if cardinality(sids)=0 then sids:=array[active_subsidiary_id()];end if;
 if exists(select 1 from unnest(sids)x where not exists(select 1 from user_subsidiaries u where u.user_id=app_user_id()and u.subsidiary_id=x))then raise exception 'No tiene acceso a la subsidiaria.';end if;
 df:=coalesce(nullif(p_filters->>'dateFrom','')::date,'1900-01-01');dt:=coalesce(nullif(p_filters->>'dateTo','')::date,current_date);
 customer_key:=nullif(p_filters->>'pendingCustomerId','')::bigint;state:=nullif(p_filters->>'pendingStatus','');
 with base as(
  select 'JOURNAL'::text source_type,j.journal_id source_id,j.journal_id,j.journal_number,j.journal_date date,
   coalesce(c.customer_id,0)customer_id,coalesce(c.company_name,'Sin tercero asignado')customer,j.currency_id,
   j.pending_initial_local initial,j.pending_reversed_local reversed,j.pending_balance_local balance,j.reversal_status status,false opening_balance
  from journal j left join lateral(select jl.customer_id,cu.company_name from journal_line jl join customers cu using(customer_id)where jl.journal_id=j.journal_id limit 1)c on true
  where j.subsidiary_id=any(sids)and j.journal_date between df and dt and(j.journal_number like'ASI_PEN-%'or j.journal_type='Asientos Pendientes de Facturar')
   and(customer_key is null or c.customer_id=customer_key)and(state is null or j.reversal_status=state)
  union all
  select 'OPENING'::text,i.id,-i.id,i.reference,i.origin_date,i.customer_id,c.company_name,i.currency_id,
   i.initial_local,i.reversed_local,i.balance_local,i.reversal_status,true
  from opening_pending_invoice_items i join customers c using(customer_id)join opening_balance_runs r on r.id=i.run_id
  where i.subsidiary_id=any(sids)and i.is_active and i.opening_reversed_at is null and r.status='POSTED'and i.origin_date between df and dt
   and(customer_key is null or i.customer_id=customer_key)and(state is null or i.reversal_status=state)
 ),decorated as(
  select b.*,case when b.source_type='JOURNAL'then(
   select coalesce(jsonb_agg(jsonb_build_object('journalId',r.reversal_journal_id,'number',jr.journal_number,'date',r.reversal_date,'amount',r.reversed_local,'type',r.reversal_type,'reference',coalesce(inv.invoice_number,r.error_description),'user',coalesce(u.first_name||' '||u.last_name,u.email))order by r.reversal_date,r.reversal_id),'[]'::jsonb)
   from pending_invoice_reversal r join journal jr on jr.journal_id=r.reversal_journal_id left join invoice inv on inv.invoice_id=r.sales_invoice_id left join users u on u.user_id=r.created_by where r.source_journal_id=b.source_id
  )else(
   select coalesce(jsonb_agg(jsonb_build_object('journalId',r.reversal_journal_id,'number',jr.journal_number,'date',r.reversal_date,'amount',r.reversed_local,'type',r.reversal_type,'reference',coalesce(inv.invoice_number,r.error_description),'user',coalesce(u.first_name||' '||u.last_name,u.email))order by r.reversal_date,r.reversal_id),'[]'::jsonb)
   from pending_invoice_reversal r join journal jr on jr.journal_id=r.reversal_journal_id left join invoice inv on inv.invoice_id=r.sales_invoice_id left join users u on u.user_id=r.created_by where r.source_opening_pending_id=b.source_id
  )end reversals from base b
 )
 select jsonb_build_object(
  'rows',coalesce(jsonb_agg(jsonb_build_object('journal_id',b.journal_id,'source_id',b.source_id,'source_type',b.source_type,'opening_balance',b.opening_balance,
   'journal_number',b.journal_number,'date',b.date,'customer_id',b.customer_id,'customer',b.customer,'currency_id',b.currency_id,
   'initial',b.initial,'reversed',b.reversed,'balance',b.balance,'status',b.status,
   'support_url',(select i.support_url from opening_pending_invoice_items i where b.source_type='OPENING'and i.id=b.source_id),
   'reversals',b.reversals)order by b.date,b.source_type,b.source_id),'[]'::jsonb),
  'total',count(*),'summary',jsonb_build_object('initial',coalesce(sum(b.initial),0),'reversed',coalesce(sum(b.reversed),0),'balance',coalesce(sum(b.balance),0))
 )into result from decorated b;
 return result;
end$$;

revoke all on table public.opening_pending_invoice_items,public.opening_pending_invoice_lines,public.opening_pending_invoice_supports from anon,authenticated;
grant select on table public.opening_pending_invoice_items,public.opening_pending_invoice_lines,public.opening_pending_invoice_supports to authenticated;

revoke all on function public.opening_pending_country_id(text),public.opening_pending_invoice_stage(bigint,jsonb),public.opening_pending_invoice_reconciliation(bigint),public.opening_pending_invoice_reversal_options(bigint,date),public.reverse_opening_pending_invoice(bigint,jsonb)from public,anon,authenticated;
revoke all on function public.opening_balance_options(),public.opening_balance_validate(jsonb),public.opening_balance_preview(bigint),public.opening_balance_post(bigint),public.opening_balance_reverse(bigint),public.pending_invoice_reversal_options(bigint,date),public.reverse_pending_invoice_journal(bigint,jsonb)from public,anon;
grant execute on function public.opening_balance_options(),public.opening_balance_validate(jsonb),public.opening_balance_preview(bigint),public.opening_balance_post(bigint),public.opening_balance_reverse(bigint),public.pending_invoice_reversal_options(bigint,date),public.reverse_pending_invoice_journal(bigint,jsonb)to authenticated;
grant execute on function public.opening_pending_invoice_reversal_options(bigint,date),public.reverse_opening_pending_invoice(bigint,jsonb)to authenticated;

notify pgrst,'reload schema';
