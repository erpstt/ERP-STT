-- Activate after deploying the compatible maintenance client.
create function sequence_security_private.guard()returns trigger language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $guard$
begin
 if sequence_security_private.has_context('maintenance')then
  perform sequence_security_private.access(case tg_op when 'INSERT'then'create'when'UPDATE'then'edit'else'delete'end);
 elsif sequence_security_private.has_context('runtime')then
  perform sequence_security_private.actor();
  if tg_op='DELETE'or new.entity_key is not null or not sequence_security_private.member(new.subsidiary_id)then raise exception using errcode='42501',message='Generacion fuera de alcance.';end if;
  if tg_op='UPDATE'and (new.current_number<old.current_number or (to_jsonb(new)-array['current_number','created_by_id','created_by_email','created_by_name','actor_type','actor_source','execution_context_id','updated_by_id','updated_by_email','updated_by_name','updated_actor_type','updated_actor_source','updated_execution_context_id'])is distinct from(to_jsonb(old)-array['current_number','created_by_id','created_by_email','created_by_name','actor_type','actor_source','execution_context_id','updated_by_id','updated_by_email','updated_by_name','updated_actor_type','updated_actor_source','updated_execution_context_id']))then raise exception using errcode='55000',message='El generador solo avanza el contador.';end if;
 else raise exception using errcode='42501',message='Use el mantenimiento o generador protegido.';end if;
 if tg_op='DELETE'then return old;end if;return new;
end $guard$;
-- Copy the reviewed implementation, then replace its original OID with a wrapper.
-- Cleanup occurs even with early returns inside the original implementation.
do $wrap$
declare r record;f record;definition text;args text;call_args text;body text;inner_name text;
begin
 for r in select *from(values
('reverse_pending_invoice_journal_before_service_dimensions(bigint,jsonb)','pending_reverse','0b2b5085cfd887c98f029e8f722f1097'),
('fx_revaluation_private.fx_post_journal(bigint,date,integer,text)','fx_post','a9b4d8849df82b49aa6175ef81ad8e4b'),
('next_transaction_number(bigint,bigint)','transaction_next','a11bbe0d1a12107a60f7d213ef2e08e9'),
('reverse_opening_pending_invoice_before_period_type(bigint,jsonb)','opening_reverse','bf4f6a8d090c36918abfa05fbe04c404'),
('pending_invoice_private.pending_invoice_reclassification_execute(date)','pending_reclass','7bcf4a7a4eb2cff7893edbd7bcbbd807'),
('sales_invoice_private.ensure_sales_invoice_number_sequence(bigint)','sales_invoice_init','8fde9fd392937b3bccc09d0e0b0cd458'),
('next_manual_journal_number(text,bigint)','manual_journal_next','d947f7e74991f17cc0f5fe354f861bd9')
 )v(signature,inner_name,expected_hash)loop
  select p.*,n.nspname,pg_get_function_arguments(p.oid)full_args,pg_get_function_result(p.oid)result_type into f from pg_proc p join pg_namespace n on n.oid=p.pronamespace where p.oid=to_regprocedure(r.signature);
  if f.oid is null or md5(f.prosrc)<>r.expected_hash then raise exception 'Reviewed generator changed: %',r.signature;end if;
  inner_name:='runtime_'||r.inner_name;
  definition:=regexp_replace(pg_get_functiondef(f.oid),'^CREATE OR REPLACE FUNCTION [^(]+',format('CREATE OR REPLACE FUNCTION sequence_security_private.%I',inner_name));
  execute definition;
  select string_agg('$'||i,','order by i)into call_args from generate_series(1,f.pronargs)i;
  body:=format('declare cid bigint;%s begin perform sequence_security_private.actor();cid:=sequence_security_private.enter(''runtime'');%s sequence_security_private.%I(%s);delete from sequence_security_private.contexts where id=cid;%s exception when others then delete from sequence_security_private.contexts where id=cid;raise;end',
   case when f.result_type='void'then''else'v '||f.result_type||';'end,
   case when f.result_type='void'then'perform'else'v:='end,inner_name,coalesce(call_args,''),
   case when f.result_type='void'then'return;'else'return v;'end);
  execute format('create or replace function %I.%I(%s)returns %s language plpgsql security definer set search_path=pg_catalog,public,pg_temp as %L',f.nspname,f.proname,f.full_args,f.result_type,body);
  execute format('revoke all on function %s from public,anon,authenticated,service_role',f.oid::regprocedure);
 end loop;
end $wrap$;
create trigger sequence_boundary_guard before insert or update or delete on public.number_sequences for each row execute function sequence_security_private.guard();
create function sequence_security_private.transaction_type_identity()returns trigger language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $identity$
begin
 if tg_op='UPDATE'and new.abbreviation is not distinct from old.abbreviation then return new;end if;
 if exists(select 1 from number_sequences where transaction_type_id=old.transaction_type_id)then raise exception using errcode='55000',message='El tipo numerado conserva su abreviatura y dependencias.';end if;
 if tg_op='DELETE'then return old;end if;return new;
end $identity$;
create trigger sequence_transaction_type_identity before update of abbreviation or delete on public.transaction_types for each row execute function sequence_security_private.transaction_type_identity();
-- Transaction types still use a raw catalog insert. Keep its default usable
-- through an unexposed helper requiring exact creation permission/global scope.
create function sequence_security_private.transaction_type_code()returns text language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $code$
declare value bigint;begin
 perform sequence_security_private.actor();
 if not core_dictionary_private.global_scope()or not exists(select 1 from role_access_matrix where role_id=public.app_active_role_id()and resource_key='core:transaction-types'and can_view and can_create)then raise exception using errcode='42501',message='Requiere permiso explicito para crear tipos de transaccion.';end if;
 value:=nextval('public.transaction_type_code_seq');return'TT-'||case when length(value::text)<8 then lpad(value::text,8,'0')else value::text end;
end $code$;
alter table public.transaction_types alter column code set default sequence_security_private.transaction_type_code();
do $acl$ declare r record;s text;begin
 for r in select policyname from pg_policies where schemaname='public'and tablename='number_sequences'loop execute format('drop policy %I on public.number_sequences',r.policyname);end loop;
 alter table public.number_sequences enable row level security;
 create policy sequence_scoped_read on public.number_sequences for select to authenticated using(sequence_security_private.visible(number_sequences));
 revoke all on public.number_sequences from public,anon,authenticated,service_role;
 for r in select attname from pg_attribute where attrelid='public.number_sequences'::regclass and attnum>0 and not attisdropped loop execute format('revoke all(%I)on public.number_sequences from public,anon,authenticated,service_role',r.attname);end loop;
 grant select on public.number_sequences to authenticated,service_role;
 foreach s in array array['customer_number_seq','supplier_number_seq','employee_number_seq','product_code_seq','item_type_code_seq','uom_code_seq','transaction_type_code_seq','financial_creditor_code_seq','related_company_code_seq']loop execute format('revoke all on sequence public.%I from public,anon,authenticated,service_role',s);end loop;
 execute format('revoke all on sequence %s from public,anon,authenticated,service_role',pg_get_serial_sequence('public.number_sequences','sequence_id'));
end $acl$;
revoke all on all functions in schema sequence_security_private from public,anon,authenticated,service_role;
grant execute on function sequence_security_private.visible(public.number_sequences),sequence_security_private.transaction_type_code()to authenticated;
notify pgrst,'reload schema';
