-- Pagos masivos a proveedores (Costa Rica).
-- El modelo usa bigint para conservar las llaves nativas del ERP.

create extension if not exists pgcrypto;

alter table public.suppliers
  add column if not exists payment_iban varchar(22),
  add column if not exists payment_bank_id bigint references public.banks(bank_id),
  add column if not exists payment_id_type text,
  add column if not exists payment_beneficiary_name text;

alter table public.suppliers drop constraint if exists suppliers_payment_id_type_allowed;
alter table public.suppliers add constraint suppliers_payment_id_type_allowed
  check(payment_id_type is null or payment_id_type in('F','J','DIMEX','NITE'));

alter table public.bank_account add column if not exists iban varchar(22);

create table if not exists public.bank_payment_formats(
 format_id bigint generated always as identity primary key,
 country_id bigint not null references public.countries(country_id),
 bank_id bigint references public.banks(bank_id),
 format_code varchar(60) not null,
 format_name text not null,
 file_extension varchar(8) not null check(file_extension in('.txt','.csv','.xml')),
 currency_id bigint references public.currencies(currency_id),
 encoding varchar(20) not null default 'UTF-8',
 structure_definition jsonb not null default '{}'::jsonb,
 response_definition jsonb not null default '{}'::jsonb,
 is_active boolean not null default true,
 is_bank_verified boolean not null default false,
 source_reference text,
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now(),
 unique(country_id,bank_id,format_code,currency_id)
);

create table if not exists public.payment_batches(
 batch_id bigint generated always as identity primary key,
 subsidiary_id bigint not null references public.subsidiaries(subsidiary_id),
 bank_account_id bigint not null references public.bank_account(bank_account_id),
 payment_format_id bigint not null references public.bank_payment_formats(format_id),
 format_code_snapshot varchar(60) not null,
 format_name_snapshot text not null,
 file_extension_snapshot varchar(8) not null,
 encoding_snapshot varchar(20) not null,
 format_verified_snapshot boolean not null,
 format_source_reference_snapshot text,
 format_structure_snapshot jsonb not null,
 response_definition_snapshot jsonb not null,
 batch_number varchar(40) not null unique,
 execution_date date not null,
 currency_id bigint not null references public.currencies(currency_id),
 exchange_rate numeric(24,10) not null default 1 check(exchange_rate>0),
 application_total numeric(24,6) not null default 0 check(application_total>=0),
 total_amount numeric(24,6) not null default 0 check(total_amount>=0),
 item_count integer not null default 0 check(item_count>=0),
 status text not null default 'DRAFT' check(status in('DRAFT','FILE_GENERATED','SENT_TO_BANK','FULLY_APPLIED','PARTIALLY_REJECTED','CANCELLED')),
 generated_file_name text,
 generated_file_mime text,
 generated_file_checksum varchar(64),
 generated_at timestamptz,
 bank_response_reference text,
 bank_response_file_name text,
 bank_response_checksum varchar(64),
 bank_response_received_at timestamptz,
 created_by bigint not null references public.users(user_id),
 confirmed_by bigint references public.users(user_id),
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now()
);

-- El binario se inserta una sola vez para evitar copiarlo al log de cambios en cada actualización del lote.
create table if not exists public.payment_batch_files(
 batch_id bigint primary key references public.payment_batches(batch_id) on delete restrict,
 content bytea not null check(octet_length(content)between 1 and 10485760),
 created_at timestamptz not null default now()
);

create table if not exists public.payment_batch_response_files(
 response_file_id bigint generated always as identity primary key,
 batch_id bigint not null references public.payment_batches(batch_id) on delete restrict,
 file_name text not null,
 checksum varchar(64) not null,
 content bytea not null check(octet_length(content)between 1 and 5242880),
 uploaded_by bigint not null references public.users(user_id),
 created_at timestamptz not null default now(),
 unique(batch_id,checksum)
);

create table if not exists public.payment_batch_items(
 batch_item_id bigint generated always as identity primary key,
 batch_id bigint not null references public.payment_batches(batch_id) on delete restrict,
 payment_request_id bigint not null references public.solicitudes_pago(id) on delete restrict,
 supplier_id bigint not null references public.suppliers(supplier_id),
 currency_id bigint not null references public.currencies(currency_id),
 application_amount numeric(24,6) not null check(application_amount>0),
 amount numeric(24,6) not null check(amount>0),
 line_number integer not null,
 line_reference varchar(50) not null,
 request_number_snapshot text not null,
 vendor_name_snapshot text not null,
 vendor_tax_id_snapshot text not null,
 vendor_id_type_snapshot text not null,
 vendor_iban varchar(22) not null,
 processing_status text not null default 'LOCKED_IN_BATCH' check(processing_status in('LOCKED_IN_BATCH','PAID_CONFIRMED','REJECTED_BANK')),
 bank_reference_number text,
 rejection_code text,
 rejection_reason text,
 payment_id bigint references public.supplier_payment(payment_id),
 journal_id bigint references public.journal(journal_id),
 raw_response jsonb,
 processed_at timestamptz,
 created_at timestamptz not null default now(),
 unique(batch_id,payment_request_id),
 unique(batch_id,line_number),
 unique(batch_id,line_reference)
);

alter table public.payment_batch_items drop constraint if exists payment_batch_items_processing_status_check;
alter table public.payment_batch_items add constraint payment_batch_items_processing_status_check
 check(processing_status in('LOCKED_IN_BATCH','PAID_CONFIRMED','REJECTED_BANK','CANCELLED'));

alter table public.solicitudes_pago
 add column if not exists payment_batch_id bigint references public.payment_batches(batch_id),
 add column if not exists batch_processing_status text not null default 'UNASSIGNED',
 add column if not exists vendor_iban varchar(22),
 add column if not exists bank_reference_number text;

alter table public.solicitudes_pago drop constraint if exists solicitudes_pago_batch_processing_status_allowed;
alter table public.solicitudes_pago add constraint solicitudes_pago_batch_processing_status_allowed
 check(batch_processing_status in('UNASSIGNED','LOCKED_IN_BATCH','PAID_CONFIRMED','REJECTED_BANK'));

create sequence if not exists public.payment_batch_number_seq start 1;
create index if not exists payment_formats_scope_idx on public.bank_payment_formats(country_id,bank_id,currency_id,is_active);
create unique index if not exists bank_payment_formats_natural_uidx on public.bank_payment_formats(country_id,coalesce(bank_id,0),format_code,coalesce(currency_id,0));
create index if not exists payment_batches_scope_idx on public.payment_batches(subsidiary_id,created_at desc,status);
create index if not exists payment_batches_account_idx on public.payment_batches(bank_account_id,execution_date desc);
create index if not exists payment_batch_items_batch_idx on public.payment_batch_items(batch_id,processing_status,line_number);
create index if not exists payment_batch_items_request_idx on public.payment_batch_items(payment_request_id,created_at desc);
create index if not exists payment_batch_response_files_batch_idx on public.payment_batch_response_files(batch_id,created_at desc);
create unique index if not exists payment_request_active_batch_uidx on public.payment_batch_items(payment_request_id)
 where processing_status='LOCKED_IN_BATCH';
create index if not exists solicitudes_pago_batch_idx on public.solicitudes_pago(payment_batch_id,batch_processing_status);

-- Las secuencias históricas pueden quedar por debajo de números ya contabilizados.
-- Se adelanta PAG_PRO al máximo global y se serializa la emisión de cualquier tipo
-- de transacción para evitar colisiones entre subsidiarias o procesos concurrentes.
insert into public.number_sequences(scope_type,transaction_type_id,subsidiary_id,prefix,current_number,padding_length)
select 'Transacción',tt.transaction_type_id,s.subsidiary_id,'PAG_PRO-',
 coalesce((select max(substring(t.tran_number from '^PAG_PRO-([0-9]+)$')::bigint)
  from public."transaction" t where t.tran_number~'^PAG_PRO-[0-9]+$'),0),8
from public.transaction_types tt cross join public.subsidiaries s
where tt.abbreviation='PAG_PRO'
on conflict(transaction_type_id,subsidiary_id)where scope_type='Transacción'do update set
 current_number=greatest(public.number_sequences.current_number,excluded.current_number),
 prefix=excluded.prefix,padding_length=excluded.padding_length;

create or replace function public.next_transaction_number(target_type bigint,target_subsidiary bigint)returns text
language plpgsql security definer set search_path=public,pg_temp as $$
declare result text;
begin
 perform pg_advisory_xact_lock(hashtextextended('transaction-number:'||target_type::text,0));
 loop
  update public.number_sequences set current_number=current_number+1
  where scope_type='Transacción'and transaction_type_id=target_type and subsidiary_id=target_subsidiary
  returning coalesce(prefix,'')||lpad(current_number::text,padding_length,'0')||coalesce(suffix,'')into result;
  if result is null then raise exception 'No existe una secuencia para el tipo de transacción y subsidiaria seleccionados.';end if;
  exit when not exists(select 1 from public."transaction"where tran_number=result)
   and not exists(select 1 from public.journal where journal_number=result)
   and not exists(select 1 from public.supplier_payment where payment_number=result)
   and not exists(select 1 from public.customer_payment where payment_number=result);
 end loop;
 return result;
end$$;
revoke all on function public.next_transaction_number(bigint,bigint)from public,anon;
revoke all on function public.next_transaction_number(bigint,bigint)from authenticated;
grant execute on function public.next_transaction_number(bigint,bigint)to service_role;

insert into public.permissions(code,module,description) values
 ('TREASURY_PAYMENT_BATCH_VIEW','Tesorería','Consultar archivos y lotes de pagos masivos.'),
 ('TREASURY_PAYMENT_BATCH_MANAGE','Tesorería','Preparar, generar, descargar y cancelar lotes de pagos.'),
 ('TREASURY_PAYMENT_BATCH_EXECUTE','Tesorería','Confirmar respuestas bancarias y contabilizar lotes.')
on conflict(code)do update set module=excluded.module,description=excluded.description;

insert into public.role_permissions(role_id,permission_id)
select r.role_id,p.permission_id from public.roles r cross join public.permissions p
where p.code in('TREASURY_PAYMENT_BATCH_VIEW','TREASURY_PAYMENT_BATCH_MANAGE','TREASURY_PAYMENT_BATCH_EXECUTE')
 and(r.is_system_role or lower(r.role_name)in('administrador','administrator','admin','tesoreria','tesorería','tesorero','tesorera','treasury'))
on conflict do nothing;

create or replace function public.payment_batch_has_permission(p_code text)returns boolean
language sql stable security definer set search_path=public,pg_temp as $$
 select public.app_user_id() is not null
  and exists(select 1 from public.users u where u.user_id=public.app_user_id()and u.is_active)
  and(public.app_is_admin()or exists(
   select 1 from public.role_permissions rp join public.permissions p using(permission_id)
   where rp.role_id=public.app_active_role_id()and p.code=p_code))
$$;

create or replace function public.payment_batch_can(p_subsidiary_id bigint,p_code text)returns boolean
language sql stable security definer set search_path=public,pg_temp as $$
 select p_subsidiary_id=public.pr_access()
  and public.payment_batch_has_permission(p_code)and exists(
  select 1 from public.user_subsidiaries us
  where us.user_id=public.app_user_id()and us.subsidiary_id=p_subsidiary_id)
$$;

alter table public.bank_payment_formats enable row level security;
alter table public.bank_payment_formats force row level security;
alter table public.payment_batches enable row level security;
alter table public.payment_batches force row level security;
alter table public.payment_batch_items enable row level security;
alter table public.payment_batch_items force row level security;
alter table public.payment_batch_files enable row level security;
alter table public.payment_batch_files force row level security;
alter table public.payment_batch_response_files enable row level security;
alter table public.payment_batch_response_files force row level security;

create policy bank_payment_formats_read on public.bank_payment_formats for select to authenticated
 using(public.payment_batch_has_permission('TREASURY_PAYMENT_BATCH_VIEW'));
create policy payment_batches_read on public.payment_batches for select to authenticated
 using(public.payment_batch_can(subsidiary_id,'TREASURY_PAYMENT_BATCH_VIEW'));
create policy payment_batch_items_read on public.payment_batch_items for select to authenticated
 using(exists(select 1 from public.payment_batches b where b.batch_id=payment_batch_items.batch_id
  and public.payment_batch_can(b.subsidiary_id,'TREASURY_PAYMENT_BATCH_VIEW')));
create policy payment_batch_files_read on public.payment_batch_files for select to authenticated
 using(exists(select 1 from public.payment_batches b where b.batch_id=payment_batch_files.batch_id
  and public.payment_batch_can(b.subsidiary_id,'TREASURY_PAYMENT_BATCH_VIEW')));
create policy payment_batch_response_files_read on public.payment_batch_response_files for select to authenticated
 using(exists(select 1 from public.payment_batches b where b.batch_id=payment_batch_response_files.batch_id
  and public.payment_batch_can(b.subsidiary_id,'TREASURY_PAYMENT_BATCH_VIEW')));

create or replace function public.cr_iban_normalize(p_value text)returns text
language sql immutable parallel safe set search_path=public,pg_temp as $$
 select upper(regexp_replace(coalesce(p_value,''),'[^A-Za-z0-9]','','g'))
$$;

create or replace function public.cr_iban_valid(p_value text)returns boolean
language plpgsql immutable parallel safe set search_path=public,pg_temp as $$
declare v text:=public.cr_iban_normalize(p_value); rearranged text; remainder integer:=0; ch text; i integer;
begin
 if v!~'^CR[0-9]{20}$'then return false;end if;
 rearranged:=substring(v from 5)||'1227'||substring(v from 3 for 2);
 for i in 1..length(rearranged)loop
  ch:=substring(rearranged from i for 1);
  remainder:=(remainder*10+ch::integer)%97;
 end loop;
 return remainder=1;
exception when others then return false;
end$$;

create or replace function public.cr_tax_id_valid(p_value text,p_type text)returns boolean
language sql immutable parallel safe set search_path=public,pg_temp as $$
 select case upper(coalesce(p_type,''))
  when'F'then regexp_replace(coalesce(p_value,''),'[^0-9]','','g')~'^[0-9]{9}$'
  when'J'then regexp_replace(coalesce(p_value,''),'[^0-9]','','g')~'^[0-9]{10}$'
  when'NITE'then regexp_replace(coalesce(p_value,''),'[^0-9]','','g')~'^[0-9]{10}$'
  when'DIMEX'then regexp_replace(coalesce(p_value,''),'[^0-9]','','g')~'^[0-9]{11,12}$'
  else false end
$$;

create or replace function public.payment_batch_touch()returns trigger
language plpgsql set search_path=public,pg_temp as $$begin new.updated_at:=now();return new;end$$;
drop trigger if exists payment_batch_touch on public.payment_batches;
create trigger payment_batch_touch before update on public.payment_batches for each row execute function public.payment_batch_touch();

create or replace function public.payment_request_batch_guard()returns trigger
language plpgsql security definer set search_path=public,pg_temp as $$
declare context_batch text:=nullif(current_setting('nexo.payment_batch_id',true),'');
begin
 if old.batch_processing_status='LOCKED_IN_BATCH'
  and context_batch is distinct from old.payment_batch_id::text then
  raise exception using errcode='55000',message='La solicitud está bloqueada en el lote de pago '||coalesce(old.payment_batch_id::text,'')||' y no puede editarse, anularse ni pagarse manualmente.';
 end if;
 return case when tg_op='DELETE'then old else new end;
end$$;
drop trigger if exists payment_request_batch_guard on public.solicitudes_pago;
create trigger payment_request_batch_guard before update or delete on public.solicitudes_pago
 for each row execute function public.payment_request_batch_guard();

create or replace function public.supplier_invoice_batch_guard()returns trigger
language plpgsql security definer set search_path=public,pg_temp as $$
declare invoice_keys bigint[]:='{}'::bigint[]; locked_batch bigint;
 context_batch text:=nullif(current_setting('nexo.payment_batch_id',true),'');
begin
 if tg_op<>'INSERT'then invoice_keys:=array_append(invoice_keys,old.invoice_id);end if;
 if tg_op<>'DELETE'then invoice_keys:=array_append(invoice_keys,new.invoice_id);end if;
 select array_agg(distinct value)into invoice_keys from unnest(invoice_keys)value where value is not null;
 select r.payment_batch_id into locked_batch
 from public.solicitudes_pago r join public.solicitudes_pago_lineas l on l.id_solicitud=r.id
 where l.id_factura_proveedor=any(invoice_keys)and r.batch_processing_status='LOCKED_IN_BATCH'
  and context_batch is distinct from r.payment_batch_id::text
 order by r.id limit 1;
 if locked_batch is not null then
  raise exception using errcode='55000',message='La factura está incluida en el lote de pago '||locked_batch||' y no puede modificarse ni eliminarse.';
 end if;
 return case when tg_op='DELETE'then old else new end;
end$$;
drop trigger if exists supplier_invoice_batch_guard on public.supplier_invoice;
create trigger supplier_invoice_batch_guard before update or delete on public.supplier_invoice
 for each row execute function public.supplier_invoice_batch_guard();
drop trigger if exists supplier_invoice_line_batch_guard on public.supplier_invoice_line;
create trigger supplier_invoice_line_batch_guard before insert or update or delete on public.supplier_invoice_line
 for each row execute function public.supplier_invoice_batch_guard();
drop trigger if exists supplier_credit_note_batch_guard on public.supplier_credit_note;
create trigger supplier_credit_note_batch_guard before insert or update or delete on public.supplier_credit_note
 for each row execute function public.supplier_invoice_batch_guard();
drop trigger if exists supplier_debit_note_batch_guard on public.supplier_debit_note;
create trigger supplier_debit_note_batch_guard before insert or update or delete on public.supplier_debit_note
 for each row execute function public.supplier_invoice_batch_guard();
drop trigger if exists supplier_payment_application_batch_guard on public.supplier_payment_application;
create trigger supplier_payment_application_batch_guard before insert or update or delete on public.supplier_payment_application
 for each row execute function public.supplier_invoice_batch_guard();
drop trigger if exists supplier_invoice_withholding_batch_guard on public.supplier_invoice_withholding;
create trigger supplier_invoice_withholding_batch_guard before insert or update or delete on public.supplier_invoice_withholding
 for each row execute function public.supplier_invoice_batch_guard();

-- Rechaza la ejecución manual antes de que el motor presupuestario o contable
-- pueda generar efectos. El lote autorizado se identifica por una variable local
-- a la transacción y continúa por el flujo original sin duplicar lógica contable.
alter function public.pr_execute(jsonb)rename to pr_execute_without_payment_batch_guard;
revoke all on function public.pr_execute_without_payment_batch_guard(jsonb)from public,anon,authenticated;
create function public.pr_execute(p jsonb)returns jsonb
language plpgsql security definer set search_path=public,pg_temp as $$
declare h public.solicitudes_pago%rowtype;
 context_batch text:=nullif(current_setting('nexo.payment_batch_id',true),'');
begin
 select * into h from public.solicitudes_pago
 where id=nullif(p->>'id','')::bigint and id_subsidiaria=public.pr_access();
 if h.id is null then raise exception 'Solicitud de pago no encontrada.';end if;
 if h.batch_processing_status='LOCKED_IN_BATCH'
  and context_batch is distinct from h.payment_batch_id::text then
  raise exception using errcode='55000',message='La solicitud está bloqueada en el lote de pago '
   ||coalesce(h.payment_batch_id::text,'')||' y no puede pagarse manualmente.';
 end if;
 return public.pr_execute_without_payment_batch_guard(p);
end$$;
revoke all on function public.pr_execute(jsonb)from public,anon;
grant execute on function public.pr_execute(jsonb)to authenticated;

-- El permiso granular autoriza la ejecución únicamente cuando la llamada nace
-- de un lote vigente de la subsidiaria activa. No habilita pagos manuales.
create or replace function public.pr_can_execute()returns boolean
language plpgsql stable security definer set search_path=public,pg_temp as $$
declare context_batch text:=nullif(current_setting('nexo.payment_batch_id',true),'');
begin
 if public.app_is_admin()or exists(select 1 from public.roles r join public.user_roles u using(role_id)
  where r.role_id=public.app_active_role_id()and u.user_id=public.app_user_id()
   and lower(r.role_name)in('tesoreria','tesorería','tesorero','tesorera','treasury'))then return true;end if;
 if context_batch is null or context_batch!~'^[0-9]+$'
  or not public.payment_batch_has_permission('TREASURY_PAYMENT_BATCH_EXECUTE')then return false;end if;
 return exists(select 1 from public.payment_batches b where b.batch_id=context_batch::bigint
  and b.subsidiary_id=public.pr_access()and b.status in('FILE_GENERATED','SENT_TO_BANK','PARTIALLY_REJECTED'));
end$$;
revoke all on function public.pr_can_execute()from public,anon,authenticated;

-- Plantillas configurables. La definición queda versionada y puede sustituirse por la entregada por cada banco.
insert into public.bank_payment_formats(country_id,bank_id,format_code,format_name,file_extension,currency_id,encoding,structure_definition,response_definition,is_bank_verified,source_reference)
select cr.country_id,b.bank_id,x.code,x.name,x.ext,c.currency_id,x.encoding,x.structure,x.response,x.verified,x.source
from public.countries cr join public.banks b on b.country_id=cr.country_id
cross join public.currencies c
cross join lateral(values
 ('BAC_CR_PAYROLL_TXT','BAC · Pago a proveedores TXT','.txt','UTF-8',
  '{"strategy":"BAC","recordDelimiter":"CRLF","amountDecimals":2,"currencyCodes":{"CRC":"158","USD":"840"}}'::jsonb,
  '{"delimiter":",","referenceColumn":0,"statusColumn":1,"bankReferenceColumn":2,"reasonColumn":3,"successValues":["OK","APROBADO","PROCESADO"]}'::jsonb,
  false,'Especificaciones públicas BAC Credomatic Costa Rica; confirme la versión habilitada en su portal bancario'),
 ('BNCR_CONEXION_TXT','BNCR · BN Conexión ancho fijo','.txt','UTF-8',
  '{"strategy":"BNCR","recordDelimiter":"CRLF","amountDecimals":2,"fixedWidth":true}'::jsonb,
  '{"delimiter":"|","referenceColumn":0,"statusColumn":1,"bankReferenceColumn":2,"reasonColumn":3,"successValues":["OK","APROBADO","PROCESADO"]}'::jsonb,
  false,'Validar versión de layout con BN Conexión antes del primer envío'),
 ('BCR_EN_LINEA_CSV','BCR en Línea · Proveedores CSV','.csv','UTF-8',
  '{"strategy":"BCR","delimiter":",","recordDelimiter":"CRLF","amountDecimals":2}'::jsonb,
  '{"delimiter":",","referenceColumn":0,"statusColumn":1,"bankReferenceColumn":2,"reasonColumn":3,"successValues":["OK","APROBADO","PROCESADO"]}'::jsonb,
  false,'Validar versión de layout con BCR en Línea antes del primer envío')
)as x(code,name,ext,encoding,structure,response,verified,source)
where upper(coalesce(cr.country_code_iso2,''))='CR'and c.currency_code in('CRC','USD')and(
 (x.code like'BAC%'and(upper(b.bank_code)like'%BAC%'or upper(b.bank_name)like'%BAC%'))or
 (x.code like'BNCR%'and(upper(b.bank_code)in('BNCR','BN')or upper(b.bank_name)like'%NACIONAL%'))or
 (x.code like'BCR%'and upper(b.bank_code)like'%BCR%'and upper(b.bank_name)not like'%BAC%'))
on conflict(country_id,bank_id,format_code,currency_id)do update set
 format_name=excluded.format_name,file_extension=excluded.file_extension,encoding=excluded.encoding,
 structure_definition=excluded.structure_definition,response_definition=excluded.response_definition,
 source_reference=excluded.source_reference,updated_at=now();

insert into public.bank_payment_formats(country_id,bank_id,format_code,format_name,file_extension,currency_id,encoding,structure_definition,response_definition,is_bank_verified,source_reference)
select cr.country_id,null,'SINPE_GENERIC_XML','SINPE · XML configurable','.xml',c.currency_id,'UTF-8',
 '{"strategy":"SINPE","schemaVersion":"1.0","amountDecimals":2}'::jsonb,
 '{"type":"XML","itemTag":"Pago","referenceTag":"ReferenciaERP","statusTag":"Estado","bankReferenceTag":"ReferenciaBanco","reasonTag":"Motivo","successValues":["OK","APROBADO","PROCESADO"]}'::jsonb,
 false,'La entidad financiera define el layout de carga; confirme esta plantilla antes del primer envío.'
from public.countries cr cross join public.currencies c
where upper(coalesce(cr.country_code_iso2,''))='CR'and c.currency_code in('CRC','USD')
on conflict do nothing;

create or replace function public.payment_batch_options()returns jsonb
language plpgsql stable security definer set search_path=public,pg_temp as $$
declare sid bigint:=public.pr_access(); result jsonb;
begin
 if not public.payment_batch_has_permission('TREASURY_PAYMENT_BATCH_VIEW')then
  raise exception using errcode='42501',message='No tiene permiso para consultar lotes de pago.';
 end if;
 select jsonb_build_object(
  'company',jsonb_build_object('id',s.subsidiary_id,'name',s.name,'countryId',s.country_id,'country',coalesce(c.country_code_iso2,c.name)),
  'permissions',jsonb_build_object(
   'view',true,
   'manage',public.payment_batch_has_permission('TREASURY_PAYMENT_BATCH_MANAGE'),
   'execute',public.payment_batch_has_permission('TREASURY_PAYMENT_BATCH_EXECUTE')),
  'accounts',coalesce((select jsonb_agg(jsonb_build_object(
    'id',a.bank_account_id,'name',b.bank_name||' · '||a.account_number||' · '||cu.currency_code,
    'bankId',a.bank_id,'bank',b.bank_name,'number',a.account_number,
    'iban',coalesce(a.iban,a.account_number),'currencyId',a.currency_id,'currencyCode',cu.currency_code,'balance',a.balance)
   order by b.bank_name,a.account_number)
   from public.bank_account a join public.banks b using(bank_id)join public.currencies cu using(currency_id)
   where a.subsidiary_id=sid and not coalesce(a.is_credit_card,false)),'[]'::jsonb),
  'formats',coalesce((select jsonb_agg(jsonb_build_object(
    'id',f.format_id,'code',f.format_code,'name',f.format_name,'bankId',f.bank_id,
    'currencyId',f.currency_id,'currencyCode',cu.currency_code,'extension',f.file_extension,
    'verified',f.is_bank_verified,'sourceReference',f.source_reference)
   order by f.format_name,cu.currency_code)
   from public.bank_payment_formats f join public.currencies cu using(currency_id)
   where f.country_id=s.country_id and f.is_active),'[]'::jsonb),
  'currencies',coalesce((select jsonb_agg(jsonb_build_object('id',cu.currency_id,'code',cu.currency_code,'symbol',cu.symbol)order by cu.currency_code)
   from public.currencies cu where cu.currency_id in(select a.currency_id from public.bank_account a where a.subsidiary_id=sid)),'[]'::jsonb),
  'suppliers',coalesce((select jsonb_agg(jsonb_build_object('id',p.supplier_id,'name',p.company_name)order by p.company_name)
   from public.suppliers p where p.primary_subsidiary_id=sid or exists(select 1 from public.entity_subsidiaries e where e.supplier_id=p.supplier_id and e.subsidiary_id=sid)),'[]'::jsonb)
 )into result
 from public.subsidiaries s join public.countries c using(country_id)where s.subsidiary_id=sid;
 return result;
end$$;

-- Corrige la reserva de solicitudes para usar el saldo pagable después de retenciones de factura.
create or replace function public.pr_invoice_balance(p_id bigint)returns numeric
language sql stable security definer set search_path=public,pg_temp as $$
 select greatest((case when i.payable_amount=0 and coalesce(i.withholding_total,0)=0 and i.total_amount<>0
   then i.total_amount else i.payable_amount end)
  -coalesce((select sum(amount)from public.supplier_payment_application where invoice_id=i.invoice_id),0)
  -coalesce((select sum(amount)from public.supplier_credit_note where invoice_id=i.invoice_id),0)
  +coalesce((select sum(amount)from public.supplier_debit_note where invoice_id=i.invoice_id),0),0)
 from public.supplier_invoice i where i.invoice_id=p_id and i.subsidiary_id=public.pr_access()
$$;

-- Importe que efectivamente sale del banco después de retenciones calculadas al pagar.
create or replace function public.payment_request_transfer_amount(p_request_id bigint)returns numeric
language plpgsql stable security definer set search_path=public,pg_temp as $$
declare line record; wh record; prior_recognized numeric; prior_applied numeric; settlement numeric; due numeric; retained numeric:=0; applied numeric:=0;
begin
 for line in select l.id_factura_proveedor,l.monto,i.payable_amount,i.total_amount,i.withholding_total
  from public.solicitudes_pago_lineas l join public.supplier_invoice i on i.invoice_id=l.id_factura_proveedor
  where l.id_solicitud=p_request_id loop
  applied:=applied+line.monto;
  settlement:=case when line.payable_amount=0 and coalesce(line.withholding_total,0)=0 and line.total_amount<>0 then line.total_amount else line.payable_amount end;
  for wh in select * from public.supplier_invoice_withholding w where w.invoice_id=line.id_factura_proveedor and w.application_moment='Al aplicar el pago'loop
   select coalesce(sum(x.withholding_amount),0)into prior_recognized from public.supplier_payment_withholding x where x.invoice_withholding_id=wh.invoice_withholding_id;
   select coalesce(sum(a.amount),0)into prior_applied from public.supplier_payment_application a where a.invoice_id=line.id_factura_proveedor;
   due:=case when settlement<=0 then 0 when prior_applied+line.monto>=settlement-0.000001
    then wh.withholding_amount-prior_recognized
    else least(wh.withholding_amount-prior_recognized,round(wh.withholding_amount*line.monto/settlement,6))end;
   retained:=retained+greatest(due,0);
  end loop;
 end loop;
 return greatest(applied-retained,0);
end$$;
revoke all on function public.payment_request_transfer_amount(bigint)from public,anon,authenticated;

create or replace function public.payment_batch_candidates(p jsonb)returns jsonb
language plpgsql stable security definer set search_path=public,pg_temp as $$
declare sid bigint:=public.pr_access(); account_key bigint:=nullif(p->>'bankAccountId','')::bigint;
 currency_key bigint:=nullif(p->>'currencyId','')::bigint; supplier_key bigint:=nullif(p->>'supplierId','')::bigint;
 due_to date:=coalesce(nullif(p->>'dueTo','')::date,'2999-12-31'::date); result jsonb;
begin
 if not public.payment_batch_has_permission('TREASURY_PAYMENT_BATCH_VIEW')then raise exception using errcode='42501',message='No tiene permiso para consultar pagos masivos.';end if;
 if account_key is not null and not exists(select 1 from public.bank_account a where a.bank_account_id=account_key and a.subsidiary_id=sid and not coalesce(a.is_credit_card,false))then raise exception 'La cuenta pagadora no pertenece a la subsidiaria activa.';end if;
 if account_key is not null then select currency_id into currency_key from public.bank_account where bank_account_id=account_key;end if;
 select coalesce(jsonb_agg(jsonb_build_object(
  'id',q.id,'number',q.numero,'plannedDate',q.fecha_pago_programada,'dueDate',q.due_date,
  'supplierId',q.id_proveedor,'supplier',q.company_name,'taxId',q.tax_id,
  'idType',q.id_type,'currencyId',q.id_moneda,'currency',q.currency_code,
  'applicationAmount',q.total,'amount',q.transfer_amount,
  'iban',q.iban,'ibanValid',q.iban_valid,'taxIdValid',q.tax_valid,
  'valid',q.iban_valid and q.tax_valid and not q.invoice_conflict,
  'errors',to_jsonb(array_remove(array[
    case when not q.iban_valid then'IBAN de Costa Rica incompleto o inválido.'end,
    case when not q.tax_valid then'Identificación fiscal incompatible con el tipo F/J/NITE/DIMEX.'end,
    case when q.invoice_conflict then'Una factura está reservada por otra solicitud pendiente o aprobada; resuelva esa solicitud antes de generar el lote.'end],null)),
  'invoices',q.invoices)order by q.fecha_pago_programada,q.id),'[]'::jsonb)into result
 from(
  select h.id,h.numero,h.fecha_pago_programada,h.id_proveedor,h.id_moneda,h.total,
   s.company_name,s.tax_id,coalesce(s.payment_id_type,case when s.supplier_type='Personal'then'F'else'J'end)id_type,
   public.cr_iban_normalize(s.payment_iban)iban,public.cr_iban_valid(s.payment_iban)iban_valid,
   public.cr_tax_id_valid(s.tax_id,coalesce(s.payment_id_type,case when s.supplier_type='Personal'then'F'else'J'end))tax_valid,
   c.currency_code,min(i.due_date)due_date,public.payment_request_transfer_amount(h.id)transfer_amount,
   exists(select 1 from public.solicitudes_pago_lineas own_line
    join public.solicitudes_pago_lineas other_line on other_line.id_factura_proveedor=own_line.id_factura_proveedor and other_line.id_solicitud<>h.id
    join public.solicitudes_pago other_request on other_request.id=other_line.id_solicitud
    where own_line.id_solicitud=h.id and other_request.estado in('BORRADOR','PENDIENTE_APROBACION','APROBADO'))invoice_conflict,
   jsonb_agg(jsonb_build_object('number',i.invoice_number,'amount',l.monto)order by i.invoice_number)invoices
  from public.solicitudes_pago h join public.suppliers s on s.supplier_id=h.id_proveedor
  join public.currencies c on c.currency_id=h.id_moneda
  join public.solicitudes_pago_lineas l on l.id_solicitud=h.id
  join public.supplier_invoice i on i.invoice_id=l.id_factura_proveedor
  where h.id_subsidiaria=sid and h.tipo_solicitud='CXP'and h.estado='APROBADO'
   and h.batch_processing_status='UNASSIGNED'and h.payment_batch_id is null
   and(currency_key is null or h.id_moneda=currency_key)
   and(supplier_key is null or h.id_proveedor=supplier_key)
  group by h.id,s.supplier_id,c.currency_code
  having min(i.due_date)<=due_to
 )q;
 return result;
end$$;

create or replace function public.payment_batch_detail(p_batch_id bigint)returns jsonb
language plpgsql stable security definer set search_path=public,pg_temp as $$
declare b public.payment_batches%rowtype; result jsonb;
begin
 select * into b from public.payment_batches where batch_id=p_batch_id;
 if b.batch_id is null or not public.payment_batch_can(b.subsidiary_id,'TREASURY_PAYMENT_BATCH_VIEW')then raise exception using errcode='42501',message='Lote no encontrado o sin acceso.';end if;
 select jsonb_build_object(
  'header',to_jsonb(b)||jsonb_build_object(
   'id',b.batch_id,'number',b.batch_number,'executionDate',b.execution_date,'currency',cu.currency_code,
   'bank',bk.bank_name,'account',ba.account_number,'accountIban',coalesce(ba.iban,ba.account_number),
   'formatCode',b.format_code_snapshot,'formatName',b.format_name_snapshot,
   'extension',b.file_extension_snapshot,'encoding',b.encoding_snapshot,
   'structureDefinition',b.format_structure_snapshot,'responseDefinition',b.response_definition_snapshot,
   'verified',b.format_verified_snapshot,'sourceReference',b.format_source_reference_snapshot,
   'company',s.name,'createdBy',u.email,'bankReference',b.bank_response_reference,
   'fileName',b.generated_file_name,'hasFile',exists(select 1 from public.payment_batch_files bf where bf.batch_id=b.batch_id)),
  'items',coalesce((select jsonb_agg(jsonb_build_object(
    'id',i.batch_item_id,'lineNumber',i.line_number,'lineReference',i.line_reference,
    'requestId',i.payment_request_id,'requestNumber',i.request_number_snapshot,'supplierId',i.supplier_id,
    'supplier',i.vendor_name_snapshot,'taxId',i.vendor_tax_id_snapshot,'idType',i.vendor_id_type_snapshot,
    'iban',i.vendor_iban,'applicationAmount',i.application_amount,'amount',i.amount,'status',i.processing_status,
    'bankReference',i.bank_reference_number,'rejectionCode',i.rejection_code,'rejectionReason',i.rejection_reason,
    'paymentId',i.payment_id,'journalId',i.journal_id,
    'invoices',coalesce((select jsonb_agg(jsonb_build_object('number',inv.invoice_number,'amount',line.monto)order by inv.invoice_number)
      from public.solicitudes_pago_lineas line join public.supplier_invoice inv on inv.invoice_id=line.id_factura_proveedor
      where line.id_solicitud=i.payment_request_id),'[]'::jsonb))
   order by i.line_number)from public.payment_batch_items i where i.batch_id=b.batch_id),'[]'::jsonb),
  'responseFiles',coalesce((select jsonb_agg(jsonb_build_object(
    'id',rf.response_file_id,'fileName',rf.file_name,'checksum',rf.checksum,
    'uploadedBy',ru.email,'createdAt',rf.created_at)order by rf.created_at desc)
   from public.payment_batch_response_files rf join public.users ru on ru.user_id=rf.uploaded_by
   where rf.batch_id=b.batch_id),'[]'::jsonb)
 )into result
 from public.bank_account ba join public.banks bk using(bank_id)join public.currencies cu using(currency_id)
 join public.bank_payment_formats f on f.format_id=b.payment_format_id join public.subsidiaries s on s.subsidiary_id=b.subsidiary_id
 join public.users u on u.user_id=b.created_by where ba.bank_account_id=b.bank_account_id;
 return result;
end$$;

create or replace function public.payment_batch_prepare(p jsonb)returns jsonb
language plpgsql security definer set search_path=public,pg_temp as $$
declare sid bigint:=public.pr_access(); ba public.bank_account%rowtype; f public.bank_payment_formats%rowtype;
 b public.payment_batches%rowtype; h public.solicitudes_pago%rowtype; s public.suppliers%rowtype;
 request_id bigint; ids bigint[]; n integer:=0; total_value numeric:=0; application_value numeric:=0;
 transfer_value numeric; normalized_iban text; source_account text; id_type text; batch_no text;
begin
 if not public.payment_batch_has_permission('TREASURY_PAYMENT_BATCH_MANAGE')then raise exception using errcode='42501',message='No tiene permiso para generar lotes de pago.';end if;
 if jsonb_typeof(p->'requestIds')is distinct from'array'or jsonb_array_length(p->'requestIds')not between 1 and 500 then raise exception 'Seleccione entre 1 y 500 solicitudes aprobadas.';end if;
 select array_agg(distinct value::text::bigint)into ids from jsonb_array_elements(p->'requestIds');
 if cardinality(ids)<>jsonb_array_length(p->'requestIds')then raise exception 'La selección contiene solicitudes repetidas.';end if;
 select * into ba from public.bank_account where bank_account_id=(p->>'bankAccountId')::bigint and subsidiary_id=sid and not coalesce(is_credit_card,false)for update;
 if ba.bank_account_id is null then raise exception 'Seleccione una cuenta bancaria válida.';end if;
 source_account:=public.cr_iban_normalize(coalesce(ba.iban,ba.account_number));
 if source_account!~'^[0-9]{10}$'and not public.cr_iban_valid(source_account)then
  raise exception 'La cuenta pagadora requiere una cuenta local de 10 dígitos o un IBAN CR válido de 22 caracteres.';
 end if;
 select * into f from public.bank_payment_formats where format_id=(p->>'formatId')::bigint and country_id=ba.country_id and is_active;
 if f.format_id is null or(f.bank_id is not null and f.bank_id<>ba.bank_id)or(f.currency_id is not null and f.currency_id<>ba.currency_id)then raise exception 'El formato no corresponde al banco, país o moneda de la cuenta pagadora.';end if;
 if nullif(p->>'executionDate','')is null or coalesce(nullif(p->>'rate','')::numeric,0)<=0 then raise exception 'Indique fecha de ejecución y tipo de cambio válido.';end if;
 if ba.currency_id=(select currency_id from public.subsidiaries where subsidiary_id=sid)and(p->>'rate')::numeric<>1 then raise exception 'La moneda funcional requiere tipo de cambio 1.';end if;
 batch_no:='PAY-BATCH-'||to_char((p->>'executionDate')::date,'YYYY')||'-'||lpad(nextval('public.payment_batch_number_seq')::text,6,'0');
 insert into public.payment_batches(subsidiary_id,bank_account_id,payment_format_id,format_code_snapshot,format_name_snapshot,
  file_extension_snapshot,encoding_snapshot,format_verified_snapshot,format_source_reference_snapshot,
  format_structure_snapshot,response_definition_snapshot,
  batch_number,execution_date,currency_id,exchange_rate,created_by)
 values(sid,ba.bank_account_id,f.format_id,f.format_code,f.format_name,f.file_extension,f.encoding,f.is_bank_verified,f.source_reference,
  f.structure_definition,f.response_definition,
  batch_no,(p->>'executionDate')::date,ba.currency_id,(p->>'rate')::numeric,public.app_user_id())returning * into b;
 perform set_config('nexo.payment_batch_id',b.batch_id::text,true);
 foreach request_id in array ids loop
  select * into h from public.solicitudes_pago where id=request_id and id_subsidiaria=sid for update;
  if h.id is null or h.tipo_solicitud<>'CXP'or h.estado<>'APROBADO'or h.batch_processing_status<>'UNASSIGNED'or h.payment_batch_id is not null then raise exception 'La solicitud % ya no está disponible para un lote.',request_id;end if;
  if h.id_moneda<>ba.currency_id then raise exception 'Todas las solicitudes deben usar la moneda de la cuenta pagadora.';end if;
  perform public.pr_validate(h.id);
  if exists(select 1 from public.solicitudes_pago_lineas own_line
   join public.solicitudes_pago_lineas other_line on other_line.id_factura_proveedor=own_line.id_factura_proveedor and other_line.id_solicitud<>h.id
   join public.solicitudes_pago other_request on other_request.id=other_line.id_solicitud
   where own_line.id_solicitud=h.id and other_request.estado in('BORRADOR','PENDIENTE_APROBACION','APROBADO'))then
   raise exception 'La solicitud % comparte una factura con otra solicitud activa. Anule o resuelva la otra solicitud antes de generar el lote.',h.numero;
  end if;
  select * into s from public.suppliers where supplier_id=h.id_proveedor;
  normalized_iban:=public.cr_iban_normalize(s.payment_iban);
  id_type:=coalesce(s.payment_id_type,case when s.supplier_type='Personal'then'F'else'J'end);
  if not public.cr_iban_valid(normalized_iban)then raise exception 'El proveedor % no tiene un IBAN de Costa Rica válido.',s.company_name;end if;
  if not public.cr_tax_id_valid(s.tax_id,id_type)then raise exception 'La identificación fiscal del proveedor % no es válida para el tipo %.',s.company_name,id_type;end if;
  transfer_value:=public.payment_request_transfer_amount(h.id);
  if transfer_value<=0 then raise exception 'La solicitud % no produce un desembolso bancario positivo.',h.numero;end if;
  n:=n+1;application_value:=application_value+h.total;total_value:=total_value+transfer_value;
  insert into public.payment_batch_items(batch_id,payment_request_id,supplier_id,currency_id,application_amount,amount,line_number,line_reference,
   request_number_snapshot,vendor_name_snapshot,vendor_tax_id_snapshot,vendor_id_type_snapshot,vendor_iban)
  values(b.batch_id,h.id,h.id_proveedor,h.id_moneda,h.total,transfer_value,n,'PB'||b.batch_id::text||'-'||lpad(n::text,5,'0'),
   h.numero,coalesce(nullif(s.payment_beneficiary_name,''),s.company_name),regexp_replace(s.tax_id,'[^0-9]','','g'),id_type,normalized_iban);
  update public.solicitudes_pago set payment_batch_id=b.batch_id,batch_processing_status='LOCKED_IN_BATCH',vendor_iban=normalized_iban,
   version=version+1,updated_at=now()where id=h.id;
  insert into public.solicitudes_pago_eventos(id_solicitud,usuario,accion,nota)
   values(h.id,public.app_user_id(),'BLOQUEADO_EN_LOTE',batch_no);
 end loop;
 if application_value>ba.balance then raise exception 'Saldo bancario insuficiente para contabilizar el lote. Disponible %, aplicación bruta %, transferencia neta %.',round(ba.balance,2),round(application_value,2),round(total_value,2);end if;
 update public.payment_batches set application_total=application_value,total_amount=total_value,item_count=n where batch_id=b.batch_id;
 perform set_config('nexo.payment_batch_id','',true);
 return public.payment_batch_detail(b.batch_id);
end$$;

create or replace function public.payment_batch_finalize(p jsonb)returns jsonb
language plpgsql security definer set search_path=public,extensions,pg_temp as $$
declare b public.payment_batches%rowtype; content bytea; expected_extension text; calculated_checksum text;
begin
 select * into b from public.payment_batches where batch_id=(p->>'batchId')::bigint for update;
 if b.batch_id is null or not public.payment_batch_can(b.subsidiary_id,'TREASURY_PAYMENT_BATCH_MANAGE')then raise exception using errcode='42501',message='Lote no encontrado o sin acceso.';end if;
 if b.status<>'DRAFT'then raise exception 'Solo un lote en borrador puede recibir el archivo generado.';end if;
 content:=decode(coalesce(p->>'contentBase64',''),'base64');
 if octet_length(content)=0 or octet_length(content)>10485760 then raise exception 'El archivo generado debe pesar entre 1 byte y 10 MB.';end if;
 expected_extension:=b.file_extension_snapshot;
 if lower(coalesce(p->>'fileName',''))not like'%'||expected_extension then raise exception 'La extensión del archivo no corresponde al formato bancario.';end if;
 calculated_checksum:=encode(digest(content,'sha256'),'hex');
 if coalesce(lower(p->>'checksum'),'')<>calculated_checksum then raise exception 'La huella SHA-256 del archivo generado no coincide con su contenido.';end if;
 insert into public.payment_batch_files(batch_id,content)values(b.batch_id,content);
 update public.payment_batches set status='FILE_GENERATED',generated_file_name=p->>'fileName',
  generated_file_mime=coalesce(nullif(p->>'mimeType',''),'application/octet-stream'),
  generated_file_checksum=calculated_checksum,generated_at=now()where batch_id=b.batch_id;
 return jsonb_build_object('batch',jsonb_build_object('id',b.batch_id,'number',b.batch_number,'status','FILE_GENERATED',
  'total',b.total_amount,'itemCount',b.item_count,'fileName',p->>'fileName'),
  'downloadUrl','/api/treasury/payment-batches/'||b.batch_id||'/download');
end$$;

create or replace function public.payment_batch_file(p_batch_id bigint)returns jsonb
language plpgsql stable security definer set search_path=public,pg_temp as $$
declare b public.payment_batches%rowtype; content bytea;
begin
 select * into b from public.payment_batches where batch_id=p_batch_id;
 if b.batch_id is null or not public.payment_batch_can(b.subsidiary_id,'TREASURY_PAYMENT_BATCH_MANAGE')then raise exception using errcode='42501',message='Lote no encontrado o sin permiso para descargarlo.';end if;
 select f.content into content from public.payment_batch_files f where f.batch_id=b.batch_id;
 if content is null then raise exception 'El lote todavía no tiene un archivo generado.';end if;
 return jsonb_build_object('fileName',b.generated_file_name,'mimeType',b.generated_file_mime,
  'checksum',b.generated_file_checksum,'contentBase64',encode(content,'base64'));
end$$;

create or replace function public.payment_batch_report(p jsonb)returns jsonb
language plpgsql stable security definer set search_path=public,pg_temp as $$
declare sid bigint:=public.pr_access(); result jsonb;
begin
 if not public.payment_batch_has_permission('TREASURY_PAYMENT_BATCH_VIEW')then raise exception using errcode='42501',message='No tiene permiso para consultar lotes de pago.';end if;
 select jsonb_build_object('rows',coalesce(jsonb_agg(jsonb_build_object(
  'id',b.batch_id,'number',b.batch_number,'executionDate',b.execution_date,'bank',bk.bank_name,
  'account',ba.account_number,'currency',cu.currency_code,'total',b.total_amount,'itemCount',b.item_count,
  'status',b.status,'createdBy',u.email,'createdAt',b.created_at,'generatedAt',b.generated_at,
  'bankReference',b.bank_response_reference,'fileName',b.generated_file_name,
  'paidCount',(select count(*)from public.payment_batch_items i where i.batch_id=b.batch_id and i.processing_status='PAID_CONFIRMED'),
  'rejectedCount',(select count(*)from public.payment_batch_items i where i.batch_id=b.batch_id and i.processing_status='REJECTED_BANK'))
  order by b.created_at desc),'[]'::jsonb))into result
 from public.payment_batches b join public.bank_account ba using(bank_account_id)join public.banks bk using(bank_id)
 join public.currencies cu on cu.currency_id=b.currency_id join public.users u on u.user_id=b.created_by
 where b.subsidiary_id=sid
  and b.execution_date between coalesce(nullif(p->>'from','')::date,'1900-01-01')and coalesce(nullif(p->>'to','')::date,'2999-12-31')
  and(nullif(p->>'status','')is null or b.status=p->>'status')
  and(nullif(p->>'bankAccountId','')is null or b.bank_account_id=(p->>'bankAccountId')::bigint);
 return result;
end$$;

create or replace function public.payment_batch_mark_sent(p jsonb)returns jsonb
language plpgsql security definer set search_path=public,pg_temp as $$
declare b public.payment_batches%rowtype;
begin
 select * into b from public.payment_batches where batch_id=(p->>'batchId')::bigint for update;
 if b.batch_id is null or not public.payment_batch_can(b.subsidiary_id,'TREASURY_PAYMENT_BATCH_MANAGE')then raise exception using errcode='42501',message='Lote no encontrado o sin acceso.';end if;
 if b.status='FILE_GENERATED'then update public.payment_batches set status='SENT_TO_BANK'where batch_id=b.batch_id;
 elsif b.status<>'SENT_TO_BANK'then raise exception 'Solo un archivo generado puede marcarse como enviado al banco.';end if;
 return jsonb_build_object('id',b.batch_id,'status','SENT_TO_BANK');
end$$;

create or replace function public.payment_batch_cancel(p jsonb)returns jsonb
language plpgsql security definer set search_path=public,pg_temp as $$
declare b public.payment_batches%rowtype; item public.payment_batch_items%rowtype;
begin
 select * into b from public.payment_batches where batch_id=(p->>'batchId')::bigint for update;
 if b.batch_id is null or not public.payment_batch_can(b.subsidiary_id,'TREASURY_PAYMENT_BATCH_MANAGE')then raise exception using errcode='42501',message='Lote no encontrado o sin acceso.';end if;
 if b.status not in('DRAFT','FILE_GENERATED')then raise exception 'Solo puede cancelar un lote que todavía no fue enviado al banco.';end if;
 perform set_config('nexo.payment_batch_id',b.batch_id::text,true);
 for item in select * from public.payment_batch_items where batch_id=b.batch_id and processing_status='LOCKED_IN_BATCH'for update loop
  update public.solicitudes_pago set payment_batch_id=null,batch_processing_status='UNASSIGNED',vendor_iban=null,
   version=version+1,updated_at=now()where id=item.payment_request_id;
  update public.payment_batch_items set processing_status='CANCELLED',rejection_reason=coalesce(nullif(trim(p->>'reason'),''),'Lote cancelado antes de enviarse.'),processed_at=now()where batch_item_id=item.batch_item_id;
  insert into public.solicitudes_pago_eventos(id_solicitud,usuario,accion,nota)values(item.payment_request_id,public.app_user_id(),'LIBERADO_DE_LOTE',b.batch_number);
 end loop;
 update public.payment_batches set status='CANCELLED'where batch_id=b.batch_id;
 perform set_config('nexo.payment_batch_id','',true);
 return jsonb_build_object('id',b.batch_id,'status','CANCELLED');
end$$;

create or replace function public.payment_batch_apply_response(p jsonb)returns jsonb
language plpgsql security definer set search_path=public,extensions,pg_temp as $$
declare b public.payment_batches%rowtype; item public.payment_batch_items%rowtype; h public.solicitudes_pago%rowtype;
 row_data jsonb; result jsonb; row_status text; row_reference text; matched_count integer:=0;
 pending_count integer; paid_count integer; rejected_count integer; final_status text;
 processed_item_ids bigint[]:='{}'::bigint[]; success_values text[]; rejection_values text[];
 payment_key bigint; actual_cash numeric; response_content bytea; calculated_response_checksum text;
begin
 select * into b from public.payment_batches where batch_id=(p->>'batchId')::bigint for update;
 if b.batch_id is null or not public.payment_batch_can(b.subsidiary_id,'TREASURY_PAYMENT_BATCH_EXECUTE')then raise exception using errcode='42501',message='Lote no encontrado o sin permiso para aplicarlo.';end if;
 if b.status not in('FILE_GENERATED','SENT_TO_BANK','PARTIALLY_REJECTED')then raise exception 'El lote no está listo para recibir confirmación bancaria.';end if;
 if jsonb_typeof(p->'results')is distinct from'array'or jsonb_array_length(p->'results')not between 1 and 500 then raise exception 'La respuesta bancaria debe contener entre 1 y 500 movimientos.';end if;
 if jsonb_typeof(b.response_definition_snapshot->'successValues')='array'then
  select array_agg(upper(value))into success_values from jsonb_array_elements_text(b.response_definition_snapshot->'successValues');
 end if;
 if jsonb_typeof(b.response_definition_snapshot->'rejectionValues')='array'then
  select array_agg(upper(value))into rejection_values from jsonb_array_elements_text(b.response_definition_snapshot->'rejectionValues');
 end if;
 success_values:=coalesce(success_values,array['OK','SUCCESS','APROBADO','PROCESADO','PAID','ACEPTADO']);
 rejection_values:=coalesce(rejection_values,array['REJECTED','RECHAZADO','ERROR','FAILED','DEVUELTO']);
 if nullif(p->>'responseFileName','')is not null then
  response_content:=decode(coalesce(p->>'responseContentBase64',''),'base64');
  if octet_length(response_content)not between 1 and 5242880 then raise exception 'La respuesta bancaria debe pesar entre 1 byte y 5 MB.';end if;
  calculated_response_checksum:=encode(digest(response_content,'sha256'),'hex');
  if coalesce(lower(p->>'responseChecksum'),'')<>calculated_response_checksum then raise exception 'La huella SHA-256 de la respuesta bancaria no coincide con su contenido.';end if;
  insert into public.payment_batch_response_files(batch_id,file_name,checksum,content,uploaded_by)
   values(b.batch_id,p->>'responseFileName',calculated_response_checksum,response_content,public.app_user_id())on conflict(batch_id,checksum)do nothing;
 end if;
 -- Mantiene el mismo orden de bloqueo que la preparación del lote: banco y luego solicitudes.
 perform 1 from public.bank_account where bank_account_id=b.bank_account_id for update;
 perform set_config('nexo.payment_batch_id',b.batch_id::text,true);
 for row_data in select value from jsonb_array_elements(p->'results')loop
  if nullif(row_data->>'itemId','')is null and nullif(row_data->>'lineReference','')is null and nullif(row_data->>'requestNumber','')is null then
   raise exception 'Cada resultado bancario requiere itemId, lineReference o requestNumber.';
  end if;
  if nullif(row_data->>'itemId','')is not null and(row_data->>'itemId')!~'^[0-9]+$'then raise exception 'El itemId de la respuesta bancaria no es válido.';end if;
  select * into item from public.payment_batch_items i where i.batch_id=b.batch_id
   and case when nullif(row_data->>'itemId','')is not null then i.batch_item_id=(row_data->>'itemId')::bigint
    when nullif(row_data->>'lineReference','')is not null then i.line_reference=row_data->>'lineReference'
    else i.request_number_snapshot=row_data->>'requestNumber'end for update;
  if item.batch_item_id is null then raise exception 'Una línea de la respuesta no coincide con un pago pendiente del lote.';end if;
  if(nullif(row_data->>'lineReference','')is not null and item.line_reference<>row_data->>'lineReference')
   or(nullif(row_data->>'requestNumber','')is not null and item.request_number_snapshot<>row_data->>'requestNumber')then
   raise exception 'La respuesta contiene identificadores contradictorios para una misma línea.';
  end if;
  if item.batch_item_id=any(processed_item_ids)then raise exception 'La respuesta bancaria contiene una línea duplicada: %.',item.line_reference;end if;
  if item.processing_status<>'LOCKED_IN_BATCH'then raise exception 'La línea % ya fue procesada y no admite otra respuesta.',item.line_reference;end if;
  processed_item_ids:=array_append(processed_item_ids,item.batch_item_id);
  matched_count:=matched_count+1;row_status:=upper(coalesce(row_data->>'status',''));
  if row_status=any(success_values)then
   select * into h from public.solicitudes_pago where id=item.payment_request_id for update;
   row_reference:=coalesce(nullif(trim(row_data->>'bankReference'),''),nullif(trim(p->>'globalReference'),''),b.batch_number||'-'||lpad(item.line_number::text,5,'0'));
   result:=public.pr_execute(jsonb_build_object('id',h.id,'version',h.version,'date',b.execution_date,'rate',b.exchange_rate,
    'bankId',b.bank_account_id,'method','SINPE','reference',row_reference));
   select payment_id into payment_key from public.solicitudes_pago where id=h.id;
   select amount_paid into actual_cash from public.supplier_payment where payment_id=payment_key;
   if actual_cash is null or abs(actual_cash-item.amount)>.000001 then
    raise exception 'El egreso contabilizado de la solicitud % no coincide con la transferencia bancaria del lote.',h.numero;
   end if;
   update public.solicitudes_pago set batch_processing_status='PAID_CONFIRMED',bank_reference_number=row_reference,updated_at=now()where id=h.id;
   update public.payment_batch_items set processing_status='PAID_CONFIRMED',bank_reference_number=row_reference,
    payment_id=payment_key,journal_id=(result->>'journalId')::bigint,
    raw_response=row_data,processed_at=now()where batch_item_id=item.batch_item_id;
  elsif row_status=any(rejection_values)then
   update public.solicitudes_pago set payment_batch_id=null,batch_processing_status='UNASSIGNED',vendor_iban=null,
    version=version+1,updated_at=now()where id=item.payment_request_id;
   update public.payment_batch_items set processing_status='REJECTED_BANK',rejection_code=nullif(row_data->>'code',''),
    rejection_reason=coalesce(nullif(trim(row_data->>'reason'),''),'Rechazado por el banco.'),bank_reference_number=nullif(row_data->>'bankReference',''),
    raw_response=row_data,processed_at=now()where batch_item_id=item.batch_item_id;
   insert into public.solicitudes_pago_eventos(id_solicitud,usuario,accion,nota)values(item.payment_request_id,public.app_user_id(),'RECHAZADO_BANCO',coalesce(row_data->>'reason','Sin motivo informado'));
  else raise exception 'Estado bancario no reconocido para la referencia %: %.',coalesce(row_data->>'lineReference',row_data->>'requestNumber'),row_status;end if;
 end loop;
 if matched_count=0 then raise exception 'Ninguna línea de la respuesta coincide con el lote.';end if;
 select count(*)filter(where processing_status='LOCKED_IN_BATCH'),count(*)filter(where processing_status='PAID_CONFIRMED'),count(*)filter(where processing_status='REJECTED_BANK')
 into pending_count,paid_count,rejected_count from public.payment_batch_items where batch_id=b.batch_id;
 final_status:=case when pending_count=0 and rejected_count=0 then'FULLY_APPLIED'when rejected_count>0 then'PARTIALLY_REJECTED'else'SENT_TO_BANK'end;
 update public.payment_batches set status=final_status,
  bank_response_reference=coalesce(nullif(trim(p->>'globalReference'),''),bank_response_reference),
  bank_response_file_name=coalesce(nullif(p->>'responseFileName',''),bank_response_file_name),
  bank_response_checksum=coalesce(calculated_response_checksum,bank_response_checksum),
  bank_response_received_at=case when nullif(p->>'responseFileName','')is not null then now()else bank_response_received_at end,
  confirmed_by=public.app_user_id()where batch_id=b.batch_id;
 perform set_config('nexo.payment_batch_id','',true);
 return jsonb_build_object('id',b.batch_id,'status',final_status,'paid',paid_count,'rejected',rejected_count,'pending',pending_count);
end$$;

create or replace function public.payment_batch_apply_reference(p jsonb)returns jsonb
language plpgsql security definer set search_path=public,pg_temp as $$
declare b public.payment_batches%rowtype; results jsonb;
begin
 select * into b from public.payment_batches where batch_id=(p->>'batchId')::bigint;
 if b.batch_id is null or not public.payment_batch_can(b.subsidiary_id,'TREASURY_PAYMENT_BATCH_EXECUTE')then raise exception using errcode='42501',message='Lote no encontrado o sin permiso para aplicarlo.';end if;
 if nullif(trim(p->>'reference'),'')is null then raise exception 'Ingrese la referencia global entregada por el banco.';end if;
 select coalesce(jsonb_agg(jsonb_build_object('itemId',i.batch_item_id,'status','APROBADO',
  'bankReference',(p->>'reference')||'-'||lpad(i.line_number::text,5,'0'))order by i.line_number),'[]'::jsonb)into results
 from public.payment_batch_items i where i.batch_id=b.batch_id and i.processing_status='LOCKED_IN_BATCH';
 if jsonb_array_length(results)=0 then raise exception 'El lote no tiene solicitudes pendientes de confirmar.';end if;
 return public.payment_batch_apply_response(jsonb_build_object('batchId',b.batch_id,'globalReference',trim(p->>'reference'),'results',results));
end$$;

revoke all on table public.bank_payment_formats,public.payment_batches,public.payment_batch_items,
 public.payment_batch_files,public.payment_batch_response_files from public,anon,authenticated;
grant select on table public.bank_payment_formats,public.payment_batches,public.payment_batch_items to authenticated;
revoke all on sequence public.bank_payment_formats_format_id_seq,public.payment_batches_batch_id_seq,
 public.payment_batch_items_batch_item_id_seq,public.payment_batch_response_files_response_file_id_seq,
 public.payment_batch_number_seq from public,anon,authenticated;

revoke all on function public.payment_batch_options(),public.payment_batch_candidates(jsonb),public.payment_batch_detail(bigint),
 public.payment_batch_prepare(jsonb),public.payment_batch_finalize(jsonb),public.payment_batch_file(bigint),public.payment_batch_report(jsonb),
 public.payment_batch_mark_sent(jsonb),public.payment_batch_cancel(jsonb),public.payment_batch_apply_response(jsonb),public.payment_batch_apply_reference(jsonb)
 from public,anon;
grant execute on function public.payment_batch_options(),public.payment_batch_candidates(jsonb),public.payment_batch_detail(bigint),
 public.payment_batch_prepare(jsonb),public.payment_batch_finalize(jsonb),public.payment_batch_file(bigint),public.payment_batch_report(jsonb),
 public.payment_batch_mark_sent(jsonb),public.payment_batch_cancel(jsonb),public.payment_batch_apply_response(jsonb),public.payment_batch_apply_reference(jsonb)
 to authenticated;

notify pgrst,'reload schema';
