-- The audit columns on journal already include created_by_name; avoid a duplicate CTE column.
do $$declare definition text;begin
 definition:=pg_get_functiondef('run_general_journal_report(jsonb)'::regprocedure);
 definition:=replace(definition,'''Sistema'') created_by_name','''Sistema'') journal_creator_name');
 definition:=replace(definition,'p.created_by_name','p.journal_creator_name');
 execute definition;
end$$;
create table scheduled_report_catalog(code text primary key,name text not null,category text not null,requires_bank boolean not null default false);
insert into scheduled_report_catalog(code,name,category,requires_bank)values
 ('AR','Cuentas por Cobrar','Operativos',false),('AP','Cuentas por Pagar','Operativos',false),
 ('balance-sheet','Estado de Situación Financiera','Financieros',false),('income-statement','Estado de Resultados Integral','Financieros',false),
 ('cash-flow','Estado de Flujos de Efectivo','Financieros',false),('equity-changes','Estado de Cambios en el Patrimonio','Financieros',false),
 ('trial-balance','Balance de Comprobación','Operativos',false),('general-ledger','Libro Mayor','Operativos',false),('journal','Libro Diario','Operativos',false),
 ('pending-invoice-control','Control de Pendientes de Facturar','Operativos',false),('sales-transactions','Ventas Transaccionales','Operativos',false),('purchase-transactions','Compras Transaccionales','Operativos',false),
 ('bank-reconciliation','Bancos y Conciliación · Auxiliar','Bancarios',true),('bank-balances','Saldos Bancarios por Período','Bancarios',false),
 ('fx-revaluation','Análisis de Revaluación','Financieros',false),('asset-reconciliation','Conciliación de Activos vs. Libro Mayor','Activos fijos',false),
 ('asset-projection','Proyección Fiscal y Financiera','Activos fijos',false),('asset-impairment','Deterioro de Valor y Bajas','Activos fijos',false);
alter table scheduled_report_catalog enable row level security;revoke all on scheduled_report_catalog from public,anon,authenticated;
alter table scheduled_reports drop constraint scheduled_reports_report_kind_check;
alter table scheduled_reports add constraint scheduled_reports_report_catalog_fk foreign key(report_kind)references scheduled_report_catalog;
alter table scheduled_reports add column period_mode text not null default 'YEAR_TO_DATE'check(period_mode in('YEAR_TO_DATE','MONTH_TO_DATE','LAST_7_DAYS','LAST_30_DAYS')),add column report_options jsonb not null default '{}';

-- A scoped, trusted worker context allows the existing report functions to run without a browser session.
-- Ordinary authenticated sessions still use the original subsidiary selection without any change.
alter function active_subsidiary_id()rename to active_subsidiary_id_without_report_context;
-- Existing RLS policies retain the renamed function OID and still execute it.
revoke all on function active_subsidiary_id_without_report_context()from public,anon;
grant execute on function active_subsidiary_id_without_report_context()to authenticated;
create function active_subsidiary_id()returns bigint language plpgsql stable security definer set search_path=public,pg_temp as $$
declare sid bigint;begin
 if coalesce(auth.role(),'')='service_role'and nullif(auth.jwt()->>'scheduled_report_sid','')is not null then
 sid:=(auth.jwt()->>'scheduled_report_sid')::bigint;
 if not scheduled_report_owner_allowed(app_user_id(),sid)then raise exception 'El propietario ya no tiene acceso a esta sociedad.';end if;return sid;
 end if;
 return active_subsidiary_id_without_report_context();
end$$;
revoke all on function active_subsidiary_id()from public,anon;grant execute on function active_subsidiary_id()to authenticated,service_role;

create function scheduled_report_catalog_options()returns jsonb language plpgsql stable security definer set search_path=public,pg_temp as $$
declare sid bigint:=scheduled_report_access();begin
 return jsonb_build_object('reports',(select jsonb_agg(to_jsonb(c)order by category,name)from scheduled_report_catalog c),
 'books',coalesce((select jsonb_agg(jsonb_build_object('id',accounting_book_id,'name',book_name,'primary',is_primary)order by book_name)from accounting_books where subsidiary_id=sid and is_active),'[]'),
 'banks',coalesce((select jsonb_agg(jsonb_build_object('id',bank_account_id,'name',account_number)order by account_number)from bank_account where subsidiary_id=sid),'[]'));
end$$;
create function scheduled_report_validate_options(p_sid bigint,p_kind text,p_options jsonb)returns void language plpgsql stable security definer set search_path=public,pg_temp as $$
declare bank_key bigint:=nullif(p_options->>'bankAccountId','')::bigint;book_key bigint:=nullif(p_options->>'bookId','')::bigint;begin
 if not exists(select 1 from scheduled_report_catalog where code=p_kind)then raise exception 'Seleccione un reporte del catálogo.';end if;
 if book_key is not null and not exists(select 1 from accounting_books where accounting_book_id=book_key and subsidiary_id=p_sid and is_active)then raise exception 'El libro no pertenece a la sociedad activa.';end if;
 if p_kind='bank-reconciliation'and(bank_key is null or not exists(select 1 from bank_account where bank_account_id=bank_key and subsidiary_id=p_sid))then raise exception 'Seleccione una cuenta bancaria de esta sociedad.';end if;
end$$;
alter function scheduled_report_manage(text,jsonb)rename to scheduled_report_manage_before_catalog;
revoke all on function scheduled_report_manage_before_catalog(text,jsonb)from public,anon,authenticated;
create function scheduled_report_manage(p_action text,p jsonb default '{}')returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare result jsonb;opts jsonb:=coalesce(p->'reportOptions','{}');mode text:=coalesce(p->>'periodMode','YEAR_TO_DATE');sid bigint:=scheduled_report_access();begin
 if p_action='save'then
 if mode not in('YEAR_TO_DATE','MONTH_TO_DATE','LAST_7_DAYS','LAST_30_DAYS')then raise exception 'Período relativo inválido.';end if;
 perform scheduled_report_validate_options(sid,p->>'report',opts);
 end if;
 result:=scheduled_report_manage_before_catalog(p_action,p);
 if p_action='list'then return result||scheduled_report_catalog_options();end if;
 if p_action='save'then
 update scheduled_reports set period_mode=mode,report_options=jsonb_build_object('bookId',nullif(opts->>'bookId','')::bigint,'bankAccountId',nullif(opts->>'bankAccountId','')::bigint)where id=(result->>'id')::bigint returning to_jsonb(scheduled_reports)into result;
 end if;return result;
end$$;

create function scheduled_report_snapshot_v2(p_sid bigint,p_kind text,p_cutoff date,p_options jsonb default '{}',p_owner bigint default null)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare old_claims text:=current_setting('request.jwt.claims',true);owner_email text;filters jsonb;report jsonb;rows jsonb:='[]';result jsonb;page int:=1;count_rows int;date_from date;period_key bigint;mode text:=coalesce(p_options->>'periodMode','YEAR_TO_DATE');book_key bigint;
begin
 if coalesce(auth.role(),'')='service_role'then
 if p_owner is null or not scheduled_report_owner_allowed(p_owner,p_sid)then raise exception 'El propietario no tiene acceso a reportes de esta sociedad.';end if;
 select email into owner_email from users where user_id=p_owner;
 perform set_config('request.jwt.claims',(coalesce(nullif(old_claims,'')::jsonb,'{}')||jsonb_build_object('email',owner_email,'scheduled_report_sid',p_sid))::text,true);
 elsif p_sid is distinct from scheduled_report_access()then raise exception 'Sociedad no autorizada.';end if;
 perform scheduled_report_validate_options(p_sid,p_kind,p_options);
 if p_cutoff is null then raise exception 'Seleccione la fecha de corte.';end if;
 if p_kind in('AR','AP')then result:=scheduled_report_snapshot(p_sid,p_kind,p_cutoff);
 else
 date_from:=case mode when 'YEAR_TO_DATE'then date_trunc('year',p_cutoff)::date when 'MONTH_TO_DATE'then date_trunc('month',p_cutoff)::date when 'LAST_7_DAYS'then p_cutoff-6 when 'LAST_30_DAYS'then p_cutoff-29 end;
 if date_from is null then raise exception 'Período relativo inválido.';end if;
 book_key:=nullif(p_options->>'bookId','')::bigint;
 if book_key is null then select accounting_book_id into book_key from accounting_books where subsidiary_id=p_sid and is_active and is_primary order by accounting_book_id limit 1;end if;
 filters:=jsonb_build_object('subsidiaryIds',jsonb_build_array(p_sid),'dateFrom',date_from,'dateTo',p_cutoff,'from',date_from,'to',p_cutoff,'bookId',book_key,'bankAccountId',nullif(p_options->>'bankAccountId','')::bigint,'bankView','AUXILIARY','hierarchy',4,'excludeZero',true,'pageSize',250);
 if p_kind='bank-balances'then
 select fiscal_period_id into period_key from fiscal_periods where subsidiary_id=p_sid and start_date<=p_cutoff and end_date>=p_cutoff order by end_date-start_date,fiscal_period_id limit 1;
 if period_key is null then raise exception 'No existe período contable para la fecha de corte.';end if;
 select start_date,end_date into date_from,p_cutoff from fiscal_periods where fiscal_period_id=period_key;
 filters:=filters||jsonb_build_object('periodId',period_key);
 end if;
 loop
 filters:=filters||jsonb_build_object('page',page);
 case p_kind
 when 'pending-invoice-control'then report:=run_pending_invoice_control_report(filters);
 when 'journal'then report:=run_general_journal_report(filters);
 when 'sales-transactions'then report:=run_sales_transaction_report(filters);
 when 'purchase-transactions'then report:=run_purchase_transaction_report(filters);
 when 'bank-reconciliation'then report:=run_bank_reconciliation_report(filters);
 when 'bank-balances'then report:=run_bank_balance_period_report(filters);
 when 'fx-revaluation'then report:=fx_report(filters);
 when 'asset-reconciliation','asset-projection','asset-impairment'then
 report:=fixed_asset_analytics(filters);
 report:=case p_kind when 'asset-reconciliation'then jsonb_build_object('rows',report->'reconciliation')when 'asset-projection'then jsonb_build_object('rows',report->'projection')else jsonb_build_object('impairments',report->'impairments','disposals',report->'disposals')end;
 else report:=run_accounting_report(p_kind,filters);
 end case;
 count_rows:=jsonb_array_length(coalesce(report->'rows','[]'));
 rows:=rows||coalesce(report->'rows','[]');
 if jsonb_array_length(rows)>20000 or coalesce((report->>'total')::int,0)>20000 then raise exception 'El reporte supera 20.000 filas. No se enviará un archivo incompleto.';end if;
 exit when not(report ? 'rows') or jsonb_array_length(rows)>=coalesce((report->>'total')::int,count_rows);
 if count_rows=0 or page>=2000 then raise exception 'No fue posible recuperar todas las páginas del reporte.';end if;
 page:=page+1;
 end loop;
 if report ? 'rows'then report:=report||jsonb_build_object('rows',rows);end if;
 if p_kind='bank-reconciliation'then
 report:=jsonb_build_object('rows',rows,'summary',report->'summary','bankAccount',(select jsonb_build_object('account',b.account_number,'bank',bk.bank_name,'currency',c.currency_code)from bank_account b join banks bk using(bank_id)join currencies c using(currency_id)where b.bank_account_id=(p_options->>'bankAccountId')::bigint));
 end if;
 if p_kind in('asset-reconciliation','asset-projection')then report:=report||jsonb_build_object('scopeNote','El auxiliar utiliza las fichas actuales de activos. La proyección incluye las depreciaciones registradas a la fecha de generación.');end if;
 result:=jsonb_build_object('kind',p_kind,'cutoff',p_cutoff,'dateFrom',date_from,'company',(select name from subsidiaries where subsidiary_id=p_sid),'currency',(select c.currency_code from subsidiaries s join currencies c using(currency_id)where s.subsidiary_id=p_sid),'rows','[]'::jsonb,'summary','{}'::jsonb,'data',report);
 end if;
 result:=result||jsonb_build_object('title',(select name from scheduled_report_catalog where code=p_kind));
 perform set_config('request.jwt.claims',coalesce(old_claims,''),true);return result;
exception when others then perform set_config('request.jwt.claims',coalesce(old_claims,''),true);raise;
end$$;
revoke all on function scheduled_report_catalog_options(),scheduled_report_validate_options(bigint,text,jsonb),scheduled_report_manage(text,jsonb),scheduled_report_snapshot_v2(bigint,text,date,jsonb,bigint)from public,anon,authenticated;
grant execute on function scheduled_report_manage(text,jsonb),scheduled_report_snapshot_v2(bigint,text,date,jsonb,bigint)to authenticated;
grant execute on function scheduled_report_snapshot_v2(bigint,text,date,jsonb,bigint)to service_role;
notify pgrst,'reload schema';
