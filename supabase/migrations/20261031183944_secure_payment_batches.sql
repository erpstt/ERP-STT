-- C-04: role/SID guarded batches and server-only bank-file processing.
set local lock_timeout='5s';set local statement_timeout='60s';
create schema payment_batch_private;
revoke all on schema payment_batch_private from public,anon,authenticated,service_role;
grant usage on schema payment_batch_private to authenticated;
-- The technical helpers are shared with the protected Treasury request executor.
create or replace function public.payment_batch_has_permission(p_code text) returns boolean language plpgsql stable security definer set search_path=pg_catalog,public,pg_temp as $$begin
 perform asset_posting_private.identity();
 return public.app_is_admin() or exists(select 1 from public.role_permissions rp join public.permissions p using(permission_id) where rp.role_id=public.app_active_role_id() and p.code=p_code);
 exception when insufficient_privilege then return false;end$$;
create or replace function public.payment_batch_can(p_subsidiary_id bigint,p_code text) returns boolean language plpgsql stable security definer set search_path=pg_catalog,public,pg_temp as $$begin
 return p_subsidiary_id=asset_posting_private.identity() and public.payment_batch_has_permission(p_code);
 exception when insufficient_privilege then return false;end$$;
-- Preserve the real engines; none of these private functions is a client RPC.
do $$declare r record;body text;n text;names text[]:=array['payment_batch_options','payment_batch_candidates','payment_batch_prepare','payment_batch_detail','payment_batch_finalize','payment_batch_file','payment_batch_report','payment_batch_mark_sent','payment_batch_cancel','payment_batch_apply_response','payment_batch_apply_reference','payment_request_transfer_amount'];begin
 for r in select p.oid,p.oid::regprocedure sig from pg_proc p join pg_namespace ns on ns.oid=p.pronamespace where ns.nspname='public' and p.proname=any(names) loop execute format('alter function %s set schema payment_batch_private',r.sig);end loop;
 for r in select p.oid from pg_proc p join pg_namespace ns on ns.oid=p.pronamespace where ns.nspname='payment_batch_private' loop
  body:=pg_get_functiondef(r.oid);foreach n in array names loop body:=replace(body,'public.'||n||'(','payment_batch_private.'||n||'(');end loop;
  body:=replace(body,'array_agg(distinct value::text::bigint)','array_agg(distinct value::text::bigint order by value::text::bigint)');execute body;
 end loop;end$$;
create function payment_batch_private.allowed(a text) returns boolean language plpgsql stable security definer set search_path=pg_catalog,public,pg_temp as $$declare v boolean;c boolean;begin
 perform asset_posting_private.identity();if not exists(select 1 from auth.sessions where id::text=auth.jwt()->>'session_id' and user_id=auth.uid() and (not_after is null or not_after>now())) then return false;end if;v:=asset_posting_private.allowed('treasury:payment-batches','view') and public.payment_batch_has_permission('TREASURY_PAYMENT_BATCH_VIEW');
 c:=asset_posting_private.allowed('treasury:payment-batches','create') and public.payment_batch_has_permission('TREASURY_PAYMENT_BATCH_VIEW') and public.payment_batch_has_permission('TREASURY_PAYMENT_BATCH_MANAGE');
 return case a when 'view' then v when 'manage' then c when 'execute' then v and public.payment_batch_has_permission('TREASURY_PAYMENT_BATCH_EXECUTE') when 'context' then v or c else false end;
 exception when insufficient_privilege then return false;end$$;
create function payment_batch_private.access(a text) returns bigint language plpgsql stable security definer set search_path=pg_catalog,public,pg_temp as $$declare sid bigint:=asset_posting_private.identity();begin
 if not payment_batch_private.allowed(a) then raise exception using errcode='42501',message='El rol activo no puede realizar esta accion en Lotes de Pago.';end if;return sid;end$$;
create function payment_batch_private.visible(id bigint) returns boolean language plpgsql stable security definer set search_path=pg_catalog,public,pg_temp as $$begin
 return payment_batch_private.allowed('view') and exists(select 1 from public.payment_batches where batch_id=id and subsidiary_id=asset_posting_private.identity());
 exception when insufficient_privilege then return false;end$$;
create function payment_batch_private.header(id bigint,a text) returns public.payment_batches language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$declare b public.payment_batches%rowtype;sid bigint:=asset_posting_private.identity();begin
 perform payment_batch_private.access(case when a in('detail','file') then 'context' else a end);
 select * into b from public.payment_batches where batch_id=id and subsidiary_id=sid for update;
 if b.batch_id is null or (a in('detail','file') and not payment_batch_private.allowed('view') and b.created_by<>public.app_user_id()) or (a='file' and not public.payment_batch_has_permission('TREASURY_PAYMENT_BATCH_MANAGE')) then raise exception using errcode='42501',message='Lote no disponible.';end if;return b;end$$;
-- Immutable snapshot: includes the payer account and all original transfer instructions.
create table payment_batch_private.seals(batch_id bigint primary key references public.payment_batches,source_account text not null,fingerprint text not null);
create table payment_batch_private.capabilities(
 batch_id bigint references public.payment_batches,purpose text check(purpose in('FILE','RESPONSE')),nonce uuid not null unique,
 auth_sub uuid not null,session_id text not null,user_id bigint not null,role_id bigint not null,subsidiary_id bigint not null,
 expires_at timestamptz not null,used_at timestamptz,primary key(batch_id,purpose));
alter table payment_batch_private.seals enable row level security;
alter table payment_batch_private.capabilities enable row level security;
revoke all on all tables in schema payment_batch_private from public,anon,authenticated,service_role;
create function payment_batch_private.fingerprint(id bigint) returns text language sql stable security definer set search_path=pg_catalog,public,pg_temp as $$
 select encode(sha256(convert_to(jsonb_build_object('header',to_jsonb(b)-array['status','generated_file_name','generated_file_mime','generated_file_checksum','generated_at','bank_response_reference','bank_response_file_name','bank_response_checksum','bank_response_received_at','confirmed_by','updated_at'],
 'currencyCode',(select currency_code from public.currencies where currency_id=b.currency_id),'payer',jsonb_build_array(a.bank_account_id,a.account_number,a.iban,a.currency_id,a.subsidiary_id,a.account_id,a.bank_id,a.country_id),
 'items',(select jsonb_agg(to_jsonb(i)-array['processing_status','bank_reference_number','rejection_code','rejection_reason','payment_id','journal_id','raw_response','processed_at'] order by i.line_number) from public.payment_batch_items i where i.batch_id=b.batch_id))::text,'UTF8')),'hex')
 from public.payment_batches b join public.bank_account a using(bank_account_id) where b.batch_id=id
$$;
create function payment_batch_private.integrity(id bigint,require_file boolean default false) returns void language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$declare b public.payment_batches%rowtype;r record;begin
 select * into b from public.payment_batches where batch_id=id for update;
 if b.batch_id is null or not exists(select 1 from payment_batch_private.seals s where s.batch_id=id and s.fingerprint=payment_batch_private.fingerprint(id))
 or not asset_posting_private.finite(b.exchange_rate) or b.exchange_rate<=0 or not isfinite(b.execution_date)
 or b.item_count not between 1 and 500 or not asset_posting_private.finite(b.total_amount) or not asset_posting_private.finite(b.application_total)
 or b.total_amount<=0 or b.total_amount>b.application_total
 or b.item_count<>(select count(*) from public.payment_batch_items where batch_id=id)
 or b.total_amount<>(select sum(amount) from public.payment_batch_items where batch_id=id)
 or b.application_total<>(select sum(application_amount) from public.payment_batch_items where batch_id=id)
 then raise exception using errcode='55000',message='Las instrucciones del lote cambiaron o no son coherentes.';end if;
 perform 1 from public.bank_account where bank_account_id=b.bank_account_id for update;
 -- Lock requests in deterministic order. Existing pr_validate checks invoice reservations and scope.
 for r in select i.*,h.id_subsidiaria,h.id_moneda,h.id_proveedor,h.tipo_solicitud,h.estado,h.payment_batch_id,h.batch_processing_status,h.total,h.payment_id
 from public.payment_batch_items i join public.solicitudes_pago h on h.id=i.payment_request_id where i.batch_id=integrity.id and i.processing_status='LOCKED_IN_BATCH' order by h.id for update of h loop
  if r.id_subsidiaria<>b.subsidiary_id or r.id_moneda<>b.currency_id or r.currency_id<>b.currency_id or r.id_proveedor<>r.supplier_id or r.tipo_solicitud<>'CXP' or r.estado<>'APROBADO'
  or r.payment_batch_id is distinct from id or r.batch_processing_status<>'LOCKED_IN_BATCH' or r.payment_id is not null
  or r.total<>r.application_amount or not asset_posting_private.finite(r.amount) or r.amount<=0 or r.amount<>payment_batch_private.payment_request_transfer_amount(r.payment_request_id)
  then raise exception using errcode='55000',message='La reserva o el importe de la solicitud cambiaron.';end if;
  perform public.pr_validate(r.payment_request_id);
 end loop;
 if require_file and not exists(select 1 from public.payment_batch_files f where f.batch_id=id and encode(sha256(f.content),'hex')=b.generated_file_checksum)
 then raise exception using errcode='55000',message='El archivo bancario no coincide con su huella.';end if;
end$$;
create function payment_batch_private.issue(id bigint,kind text) returns uuid language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$declare token uuid:=gen_random_uuid();begin
 insert into payment_batch_private.capabilities(batch_id,purpose,nonce,auth_sub,session_id,user_id,role_id,subsidiary_id,expires_at)
 values(id,kind,token,auth.uid(),auth.jwt()->>'session_id',public.app_user_id(),public.app_active_role_id(),asset_posting_private.identity(),clock_timestamp()+interval '2 minutes')
 on conflict(batch_id,purpose) do update set nonce=excluded.nonce,auth_sub=excluded.auth_sub,session_id=excluded.session_id,user_id=excluded.user_id,role_id=excluded.role_id,subsidiary_id=excluded.subsidiary_id,expires_at=excluded.expires_at,used_at=null;
 return token;end$$;
create function payment_batch_private.restore_actor(p jsonb,kind text) returns text language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$declare c payment_batch_private.capabilities%rowtype;old_claims text:=current_setting('request.jwt.claims',true);begin
 select * into c from payment_batch_private.capabilities where batch_id=(p->>'batchId')::bigint and purpose=kind and nonce=nullif(p->>'capability','')::uuid for update;
 if c.batch_id is null or c.used_at is not null or c.expires_at<=clock_timestamp() then raise exception using errcode='42501',message='Autorizacion de procesamiento no disponible.';end if;
 perform set_config('request.jwt.claims',jsonb_build_object('sub',c.auth_sub,'session_id',c.session_id)::text,true);
 if asset_posting_private.identity()<>c.subsidiary_id or public.app_user_id()<>c.user_id or public.app_active_role_id()<>c.role_id then raise exception using errcode='42501',message='El contexto de la autorizacion cambio.';end if;
 perform payment_batch_private.access(case kind when 'FILE' then 'manage' else 'execute' end);
 update payment_batch_private.capabilities set used_at=clock_timestamp() where batch_id=c.batch_id and purpose=kind;
 return coalesce(old_claims,'{}');end$$;
create function public.payment_batch_access() returns jsonb language plpgsql stable security definer set search_path=pg_catalog,public,pg_temp as $$begin
 perform payment_batch_private.access('context');return jsonb_build_object('view',payment_batch_private.allowed('view'),'manage',payment_batch_private.allowed('manage'),'execute',payment_batch_private.allowed('execute'),'download',(payment_batch_private.allowed('view') or payment_batch_private.allowed('manage')) and public.payment_batch_has_permission('TREASURY_PAYMENT_BATCH_MANAGE'));end$$;
create function public.payment_batch_options() returns jsonb language plpgsql stable security definer set search_path=pg_catalog,public,pg_temp as $$begin
 perform payment_batch_private.access('context');return payment_batch_private.payment_batch_options()||jsonb_build_object('permissions',public.payment_batch_access());end$$;
create function public.payment_batch_candidates(p jsonb) returns jsonb language plpgsql stable security definer set search_path=pg_catalog,public,pg_temp as $$begin perform payment_batch_private.access('manage');return payment_batch_private.payment_batch_candidates(p);end$$;
create function public.payment_batch_report(p jsonb) returns jsonb language plpgsql stable security definer set search_path=pg_catalog,public,pg_temp as $$begin perform payment_batch_private.access('view');return payment_batch_private.payment_batch_report(p);end$$;
create function public.payment_batch_detail(p_batch_id bigint) returns jsonb language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$declare b public.payment_batches%rowtype;begin
 b:=payment_batch_private.header(p_batch_id,'detail');return payment_batch_private.payment_batch_detail(b.batch_id);end$$;
create function public.payment_batch_prepare(p jsonb) returns jsonb language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$declare d jsonb;id bigint;n numeric:=nullif(p->>'rate','')::numeric;begin
 perform payment_batch_private.access('manage');
 if not asset_posting_private.finite(n) or n<=0 or not isfinite(nullif(p->>'executionDate','')::date) then raise exception using errcode='22023',message='Fecha y tipo de cambio invalidos.';end if;
 d:=payment_batch_private.payment_batch_prepare(p);id:=(d#>>'{header,id}')::bigint;
 insert into payment_batch_private.seals select id,coalesce(a.iban,a.account_number),payment_batch_private.fingerprint(id) from public.payment_batches b join public.bank_account a using(bank_account_id) where b.batch_id=id;
 perform payment_batch_private.integrity(id);
 return d||jsonb_build_object('fileCapability',payment_batch_private.issue(id,'FILE'));end$$;
-- Only the application server may persist generated bytes or parsed bank results.
create function public.payment_batch_finalize(p jsonb) returns jsonb language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$declare claims text;id bigint:=(p->>'batchId')::bigint;b public.payment_batches%rowtype;result jsonb;begin
 claims:=payment_batch_private.restore_actor(p,'FILE');b:=payment_batch_private.header(id,'manage');
 if b.created_by<>public.app_user_id() or b.status<>'DRAFT' or p->>'fileName' is distinct from b.batch_number||b.file_extension_snapshot then raise exception using errcode='55000',message='Generacion protegida por propietario o estado.';end if;
 perform payment_batch_private.integrity(id);result:=payment_batch_private.payment_batch_finalize(p);perform payment_batch_private.integrity(id,true);
 perform set_config('request.jwt.claims',claims,true);return result;end$$;
create function public.payment_batch_file(p_batch_id bigint) returns jsonb language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$declare b public.payment_batches%rowtype;begin
 b:=payment_batch_private.header(p_batch_id,'file');if b.status in('DRAFT','CANCELLED') then raise exception using errcode='55000',message='El archivo no esta disponible en este estado.';end if;
 -- Historical processed requests can legitimately change later; immutable file instructions must match.
 if not exists(select 1 from payment_batch_private.seals s where s.batch_id=p_batch_id and s.fingerprint=payment_batch_private.fingerprint(p_batch_id)) or not exists(select 1 from public.payment_batch_files f where f.batch_id=p_batch_id and encode(sha256(f.content),'hex')=b.generated_file_checksum) then raise exception using errcode='55000',message='El archivo o sus instrucciones cambiaron.';end if;
 return payment_batch_private.payment_batch_file(p_batch_id);end$$;
create function public.payment_batch_mark_sent(p jsonb) returns jsonb language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$declare b public.payment_batches%rowtype;begin
 b:=payment_batch_private.header((p->>'batchId')::bigint,'manage');perform payment_batch_private.integrity(b.batch_id,true);return payment_batch_private.payment_batch_mark_sent(p);end$$;
create function public.payment_batch_cancel(p jsonb) returns jsonb language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$declare b public.payment_batches%rowtype;result jsonb;begin
 b:=payment_batch_private.header((p->>'batchId')::bigint,'manage');if nullif(trim(p->>'reason'),'') is null then raise exception using errcode='22023',message='Indique el motivo de cancelacion.';end if;
 result:=payment_batch_private.payment_batch_cancel(p);delete from payment_batch_private.capabilities where batch_id=b.batch_id;return result;end$$;
create function public.payment_batch_prepare_response(p_batch_id bigint) returns jsonb language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$declare b public.payment_batches%rowtype;begin
 b:=payment_batch_private.header(p_batch_id,'execute');if b.status not in('FILE_GENERATED','SENT_TO_BANK','PARTIALLY_REJECTED') then raise exception using errcode='55000',message='El lote no admite respuestas.';end if;
 perform payment_batch_private.integrity(b.batch_id,true);return payment_batch_private.payment_batch_detail(b.batch_id)||jsonb_build_object('responseCapability',payment_batch_private.issue(b.batch_id,'RESPONSE'));end$$;
create function public.payment_batch_apply_response(p jsonb) returns jsonb language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$declare claims text;b public.payment_batches%rowtype;result jsonb;begin
 claims:=payment_batch_private.restore_actor(p,'RESPONSE');b:=payment_batch_private.header((p->>'batchId')::bigint,'execute');perform payment_batch_private.integrity(b.batch_id,true);
 if nullif(p->>'responseFileName','') is null or lower(p->>'responseFileName')!~'\.(ack|res|csv|txt|xml)$' then raise exception using errcode='22023',message='Respuesta bancaria invalida.';end if;
 result:=payment_batch_private.payment_batch_apply_response(p);perform set_config('request.jwt.claims',claims,true);return result;end$$;
create function public.payment_batch_apply_reference(p jsonb) returns jsonb language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$declare b public.payment_batches%rowtype;begin
 b:=payment_batch_private.header((p->>'batchId')::bigint,'execute');perform payment_batch_private.integrity(b.batch_id,true);return payment_batch_private.payment_batch_apply_reference(p);end$$;
do $$declare t text;p record;c record;begin foreach t in array array['bank_payment_formats','payment_batches','payment_batch_items','payment_batch_files','payment_batch_response_files'] loop
 execute format('alter table public.%I enable row level security',t);for p in select policyname from pg_policies where schemaname='public' and tablename=t loop execute format('drop policy %I on public.%I',p.policyname,t);end loop;
 execute format('revoke all on public.%I from public,anon,authenticated,service_role',t);for c in select column_name from information_schema.columns where table_schema='public' and table_name=t loop execute format('revoke all (%I) on public.%I from public,anon,authenticated,service_role',c.column_name,t);end loop;
 if t in('bank_payment_formats','payment_batches','payment_batch_items') then execute format('grant select on public.%I to authenticated',t);
 execute format('create policy batch_read on public.%I for select to authenticated using(%s)',t,case t when 'bank_payment_formats' then 'payment_batch_private.allowed(''context'')' else 'payment_batch_private.visible(batch_id)' end);end if;
end loop;end$$;
revoke all on all functions in schema payment_batch_private from public,anon,authenticated,service_role;
grant execute on function payment_batch_private.allowed(text),payment_batch_private.visible(bigint) to authenticated;
revoke all on function public.payment_batch_touch(),public.payment_request_batch_guard(),public.supplier_invoice_batch_guard(),public.payment_batch_has_permission(text),public.payment_batch_can(bigint,text) from public,anon,authenticated,service_role;
revoke all on sequence public.payment_batch_number_seq from public,anon,authenticated,service_role;
revoke all on function public.payment_batch_access(),public.payment_batch_options(),public.payment_batch_candidates(jsonb),public.payment_batch_report(jsonb),public.payment_batch_detail(bigint),public.payment_batch_prepare(jsonb),public.payment_batch_finalize(jsonb),public.payment_batch_file(bigint),public.payment_batch_mark_sent(jsonb),public.payment_batch_cancel(jsonb),public.payment_batch_prepare_response(bigint),public.payment_batch_apply_response(jsonb),public.payment_batch_apply_reference(jsonb) from public,anon,authenticated,service_role;
grant execute on function public.payment_batch_access(),public.payment_batch_options(),public.payment_batch_candidates(jsonb),public.payment_batch_report(jsonb),public.payment_batch_detail(bigint),public.payment_batch_prepare(jsonb),public.payment_batch_file(bigint),public.payment_batch_mark_sent(jsonb),public.payment_batch_cancel(jsonb),public.payment_batch_prepare_response(bigint),public.payment_batch_apply_reference(jsonb) to authenticated;
grant execute on function public.payment_batch_finalize(jsonb),public.payment_batch_apply_response(jsonb) to service_role;
notify pgrst,'reload schema';
