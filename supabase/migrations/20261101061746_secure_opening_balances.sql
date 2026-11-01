-- C-04 opening balances: preserve original financial engines and historical data.
set local lock_timeout='5s';set local statement_timeout='60s';
create schema opening_balance_private;
revoke all on schema opening_balance_private from public,anon,authenticated,service_role;
grant usage on schema opening_balance_private to authenticated;
create function opening_balance_private.allowed(a text) returns boolean language sql stable security definer set search_path=pg_catalog,public,pg_temp as $$select asset_posting_private.allowed('accounting:opening-balances',a)$$;
create function opening_balance_private.access(a text) returns bigint language sql stable security definer set search_path=pg_catalog,public,pg_temp as $$select asset_posting_private.access('accounting:opening-balances',a)$$;
create function opening_balance_private.context_access() returns bigint language plpgsql stable security definer set search_path=pg_catalog,public,pg_temp as $$declare sid bigint:=asset_posting_private.identity();begin
 if not(opening_balance_private.allowed('view') or opening_balance_private.allowed('create') or opening_balance_private.allowed('delete')) then raise exception using errcode='42501',message='Sin acceso a la apertura.';end if;return sid;end$$;
create function opening_balance_private.visible(id bigint) returns boolean language sql stable security definer set search_path=pg_catalog,public,pg_temp as $$select opening_balance_private.allowed('view') and exists(select 1 from public.opening_balance_runs where opening_balance_runs.id=$1 and subsidiary_id=asset_posting_private.identity())$$;
create or replace function public.opening_balance_assert_access(p_action text) returns bigint language plpgsql stable security definer set search_path=pg_catalog,public,pg_temp as $$begin
 if p_action='view' and current_setting('nexo.opening_read_context',true)='true' then return opening_balance_private.context_access();end if;
 return opening_balance_private.access(p_action);end$$;
alter function public.opening_balance_options() set schema opening_balance_private;
alter function public.opening_balance_preview(bigint) set schema opening_balance_private;
alter function public.opening_balance_validate(jsonb) set schema opening_balance_private;
alter function public.opening_balance_post(bigint) set schema opening_balance_private;
alter function public.opening_balance_reverse(bigint) set schema opening_balance_private;

create function opening_balance_private.lock_scope(a text) returns bigint language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$declare sid bigint:=opening_balance_private.access(a);begin
 -- Same lock order as the existing FX/opening engines, before staging deletes a draft.
 perform pg_advisory_xact_lock(hashtextextended('fx-subsidiary:'||sid,0));
 perform 1 from public.subsidiaries where subsidiary_id=sid for update;
 return sid;end$$;
create function opening_balance_private.run(id bigint,a text,locking boolean default false) returns public.opening_balance_runs language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$declare sid bigint;r public.opening_balance_runs;begin
 sid:=case when a='context' then opening_balance_private.context_access() when locking then opening_balance_private.lock_scope(a) else opening_balance_private.access(a) end;
 if id is null or id<=0 then raise exception using errcode='22023',message='Lote inválido.';end if;
 if locking then select * into r from public.opening_balance_runs where opening_balance_runs.id=$1 and subsidiary_id=sid for update;
 else select * into r from public.opening_balance_runs where opening_balance_runs.id=$1 and subsidiary_id=sid;end if;
 if not found then raise exception using errcode='42501',message='Lote no disponible.';end if;return r;end$$;
create function opening_balance_private.finite_payload(p jsonb) returns void language plpgsql immutable set search_path=pg_catalog as $$declare v jsonb;k text;begin
 if jsonb_typeof(p)='object' then
  for k,v in select * from jsonb_each(p) loop
   if k=any(array['debit','credit','debitFx','creditFx','exchangeRate','localDebit','localCredit','foreignDebit','foreignCredit','cost','purchaseCost','accumulatedDepreciation','bookValue','originalAmount','localEquivalent']) and lower(trim(both '"' from v::text)) in('nan','infinity','-infinity','+infinity','inf','-inf') then raise exception using errcode='22023',message='Los importes y tasas deben ser finitos.';end if;
   perform opening_balance_private.finite_payload(v);
  end loop;
 elsif jsonb_typeof(p)='array' then for v in select value from jsonb_array_elements(p) loop perform opening_balance_private.finite_payload(v);end loop;end if;
end$$;
create function opening_balance_private.check_run(r public.opening_balance_runs) returns void language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$declare period_row public.fiscal_periods;begin
 if r.status not in('VALIDATED','POSTED') then raise exception using errcode='55000',message='Valide el lote antes de continuar.';end if;
 if exists(select 1 from public.opening_balance_lines l where l.run_id=r.id and (
  not exists(select 1 from public.chart_accounts a join public.account_subsidiaries s using(account_id) where a.account_id=l.account_id and s.subsidiary_id=r.subsidiary_id and s.is_active and a.accepts_entries and not a.is_inactive)
  or not exists(select 1 from public.subsidiaries s where s.subsidiary_id=r.subsidiary_id and (l.currency_id=s.currency_id or exists(select 1 from public.subsidiary_currencies c where c.subsidiary_id=s.subsidiary_id and c.currency_id=l.currency_id)))
  or (l.location_id is not null and not exists(select 1 from public.locations x where x.location_id=l.location_id and (x.subsidiary_id=r.subsidiary_id or exists(select 1 from public.location_subsidiaries ls where ls.location_id=x.location_id and ls.subsidiary_id=r.subsidiary_id))))
 )) then raise exception using errcode='55000',message='Las cuentas, monedas o ubicaciones cambiaron desde la validación.';end if;
 if not exists(select 1 from public.chart_accounts a join public.account_subsidiaries s using(account_id) where a.account_id=r.transition_account_id and a.account_number='319999' and s.subsidiary_id=r.subsidiary_id and s.is_active and a.accepts_entries and not a.is_inactive) then raise exception using errcode='55000',message='La cuenta transitoria de apertura no está habilitada.';end if;
 if exists(select 1 from public.opening_balance_lines l where l.run_id=r.id and (l.historical_rate is null or l.historical_rate<=0 or l.historical_rate::text in('NaN','Infinity','-Infinity') or l.foreign_amount::text in('NaN','Infinity','-Infinity') or l.local_debit::text in('NaN','Infinity','-Infinity') or l.local_credit::text in('NaN','Infinity','-Infinity') or l.foreign_amount<0 or l.local_debit<0 or l.local_credit<0 or (l.local_debit>0)=(l.local_credit>0))) then raise exception using errcode='55000',message='El lote contiene importes inválidos.';end if;
 select * into period_row from public.fiscal_periods where subsidiary_id=r.subsidiary_id and r.opening_date between start_date and end_date order by fiscal_period_id limit 1;
 if not found or coalesce(period_row.is_closed,false) or coalesce(period_row.gl_closed,false) or coalesce(period_row.is_inactive,false) or (coalesce(period_row.ar_closed,false) and exists(select 1 from public.opening_balance_lines where run_id=r.id and source_type='AR')) or (coalesce(period_row.ap_closed,false) and exists(select 1 from public.opening_balance_lines where run_id=r.id and source_type='AP')) then raise exception using errcode='55000',message='El período de apertura está cerrado o no está disponible.';end if;
 if r.status='POSTED' and not exists(select 1 from public.journal j where j.journal_id=r.journal_id and j.subsidiary_id=r.subsidiary_id and j.journal_date=r.opening_date and j.is_opening_balance and j.status='CONTABILIZADO') then raise exception using errcode='55000',message='El origen contable de la apertura requiere revisión.';end if;
end$$;
create function public.opening_balance_options() returns jsonb language plpgsql stable security definer set search_path=pg_catalog,public,pg_temp as $$declare sid bigint:=opening_balance_private.context_access();result jsonb;prior text:=current_setting('nexo.opening_read_context',true);begin
 perform set_config('nexo.opening_read_context','true',true);result:=opening_balance_private.opening_balance_options();perform set_config('nexo.opening_read_context',coalesce(prior,''),true);
 result:=result||jsonb_build_object('canView',opening_balance_private.allowed('view'),'canCreate',opening_balance_private.allowed('create'),'canReverse',opening_balance_private.allowed('delete'));
 -- Consultation does not need bank identifiers or setup catalogs.
 if not opening_balance_private.allowed('create') then result:=result-'bankAccounts'-'assetCategories'-'pendingAccounts';end if;
 return result;
exception when others then perform set_config('nexo.opening_read_context',coalesce(prior,''),true);raise;end$$;
create function public.opening_balance_preview(p_run_id bigint) returns jsonb language plpgsql stable security definer set search_path=pg_catalog,public,pg_temp as $$declare r public.opening_balance_runs;result jsonb;prior text:=current_setting('nexo.opening_read_context',true);begin
 r:=opening_balance_private.run(p_run_id,'context');perform set_config('nexo.opening_read_context','true',true);result:=opening_balance_private.opening_balance_preview(p_run_id);perform set_config('nexo.opening_read_context',coalesce(prior,''),true);return result;
exception when others then perform set_config('nexo.opening_read_context',coalesce(prior,''),true);raise;end$$;
create function public.opening_balance_validate(p jsonb) returns jsonb language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$declare sid bigint:=opening_balance_private.lock_scope('create');k text;result jsonb;prior text:=current_setting('nexo.opening_read_context',true);begin
 if jsonb_typeof(p) is distinct from 'object' or nullif(p->>'expectedSubsidiaryId','')::bigint is distinct from sid then raise exception using errcode='42501',message='La subsidiaria cambió; vuelva a cargar la apertura.';end if;
 for k in select unnest(array['rows','assets','pending','banks']) loop if p?k and (jsonb_typeof(p->k) is distinct from 'array' or jsonb_array_length(p->k)>50000) then raise exception using errcode='22023',message='Archivo de apertura inválido o demasiado grande.';end if;end loop;
 perform opening_balance_private.finite_payload(p);perform set_config('nexo.opening_read_context','true',true);result:=opening_balance_private.opening_balance_validate(p);perform set_config('nexo.opening_read_context',coalesce(prior,''),true);return result;
exception when others then perform set_config('nexo.opening_read_context',coalesce(prior,''),true);raise;end$$;
create function public.opening_balance_post(p_run_id bigint) returns jsonb language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$declare r public.opening_balance_runs;begin
 r:=opening_balance_private.run(p_run_id,'create',true);perform opening_balance_private.check_run(r);return opening_balance_private.opening_balance_post(p_run_id);end$$;
create function public.opening_balance_reverse(p_run_id bigint) returns jsonb language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$declare r public.opening_balance_runs;begin
 r:=opening_balance_private.run(p_run_id,'delete',true);if r.status<>'POSTED' then raise exception using errcode='55000',message='La apertura no está contabilizada.';end if;perform opening_balance_private.check_run(r);return opening_balance_private.opening_balance_reverse(p_run_id);end$$;

-- RLS is scoped to the active role AND active subsidiary, including auxiliary rows.
do $$declare t text;pred text;p record;c record;begin
 foreach t in array array['opening_balance_runs','opening_balance_lines','opening_fixed_asset_lines','opening_ar_ap_gl_control_lines','opening_bank_accounts','opening_bank_items','opening_bank_gl_links','opening_pending_invoice_items','opening_pending_invoice_lines','opening_pending_invoice_supports'] loop
  execute format('alter table public.%I enable row level security',t);
  for p in select policyname from pg_policies where schemaname='public' and tablename=t loop execute format('drop policy %I on public.%I',p.policyname,t);end loop;
  pred:=case when t='opening_balance_runs' then 'opening_balance_private.visible(id)'
   when t in('opening_balance_lines','opening_fixed_asset_lines','opening_ar_ap_gl_control_lines','opening_bank_accounts','opening_pending_invoice_items') then 'opening_balance_private.visible(run_id)'
   when t in('opening_bank_items','opening_bank_gl_links') then 'exists(select 1 from public.opening_bank_accounts a where a.id=opening_bank_account_id and opening_balance_private.visible(a.run_id))'
   else 'exists(select 1 from public.opening_pending_invoice_items i where i.id=item_id and opening_balance_private.visible(i.run_id))' end;
  execute format('create policy opening_secure_read on public.%I for select to authenticated using(%s)',t,pred);
  execute format('revoke all on public.%I from public,anon,authenticated,service_role',t);
  for c in select column_name from information_schema.columns where table_schema='public' and table_name=t loop execute format('revoke insert(%I),update(%I),references(%I),select(%I) on public.%I from public,anon,authenticated,service_role',c.column_name,c.column_name,c.column_name,c.column_name,t);end loop;
  execute format('grant select on public.%I to authenticated',t);
 end loop;
 -- Historical engines stay bound to their existing callers; no client/service entry points.
 for p in select pf.oid::regprocedure signature from pg_proc pf join pg_namespace n on n.oid=pf.pronamespace where n.nspname='public' and pf.proname like 'opening_%' and pf.prorettype<>'trigger'::regtype and pf.proname not in('opening_balance_options','opening_balance_preview','opening_balance_validate','opening_balance_post','opening_balance_reverse','opening_pending_invoice_reversal_options') loop execute format('revoke all on function %s from public,anon,authenticated,service_role',p.signature);end loop;
end$$;
revoke all on all functions in schema opening_balance_private from public,anon,authenticated,service_role;
grant execute on function opening_balance_private.visible(bigint) to authenticated;
revoke all on function public.opening_balance_options(),public.opening_balance_preview(bigint),public.opening_balance_validate(jsonb),public.opening_balance_post(bigint),public.opening_balance_reverse(bigint) from public,anon,authenticated,service_role;
grant execute on function public.opening_balance_options(),public.opening_balance_preview(bigint),public.opening_balance_validate(jsonb),public.opening_balance_post(bigint),public.opening_balance_reverse(bigint) to authenticated;
notify pgrst,'reload schema';
