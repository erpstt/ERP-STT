-- Reviewed production definitions, without business data or credentials.
CREATE OR REPLACE FUNCTION core_dictionary_private.allowed(k text, a text)
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
begin
 perform core_dictionary_private.actor();
 if k is null or a is null or k not in('countries','currencies')or a not in('view','create','edit','delete')then return false;end if;
 return(a='view'and(public.app_is_admin()or exists(select 1 from public.role_access_matrix where role_id=public.app_active_role_id()and resource_key='legacy:all'and can_view)))
 or exists(select 1 from public.role_access_matrix m where m.role_id=public.app_active_role_id()and m.resource_key='core:'||k and m.can_view and case a when'view'then true when'create'then m.can_create when'edit'then m.can_edit else m.can_delete end);
 exception when insufficient_privilege then return false;
end$function$;
CREATE OR REPLACE FUNCTION pending_invoice_private.pending_invoice_control_options()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare base jsonb;can_reclassify boolean;can_view_reclassification boolean;
begin
  base:=public.pending_invoice_control_options_before_annual_reclassification();
  can_reclassify:=public.app_is_admin()or exists(
    select 1 from public.role_access_matrix access
    where access.role_id=public.app_active_role_id()
      and(access.resource_key='legacy:all'
        or(access.resource_key='accounting:pending-invoice-reclassification'
          and access.can_create))
  );
  can_view_reclassification:=public.app_is_admin()or exists(
    select 1 from public.role_access_matrix access
    where access.role_id=public.app_active_role_id()
      and(access.resource_key='legacy:all'
        or(access.resource_key='accounting:pending-invoice-reclassification'
          and access.can_view))
  );
  return base||jsonb_build_object(
    'canReclassify',can_reclassify,
    'canViewReclassification',can_view_reclassification,
    'periodTypes',jsonb_build_array(
      jsonb_build_object('id','ACTUAL','name','Período actual'),
      jsonb_build_object('id','ANTERIOR','name','Períodos anteriores')
    )
  );
end
$function$;
CREATE OR REPLACE FUNCTION pending_invoice_private.pending_invoice_reclassification_preview(p_reclassification_date date)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  sid bigint:=public.active_subsidiary_id();
  uid bigint:=public.app_user_id();
  fiscal_year_value integer;
  run_row public.pending_invoice_reclassification_runs%rowtype;
  rows_value jsonb:='[]'::jsonb;
  by_currency jsonb:='[]'::jsonb;
  accounts_value jsonb;
  issues jsonb:='[]'::jsonb;
  item_count integer:=0;
  total_local numeric(24,6):=0;
  total_foreign numeric(24,6):=0;
  invalid_fx integer:=0;
  malformed_sources integer:=0;
  post_cutoff_reversals integer:=0;
  reconciliation_value jsonb:='[]'::jsonb;
  reconciliation_balanced boolean:=true;
  can_create boolean:=false;
  period_open boolean:=false;
  book_exists boolean:=false;
  book_count integer:=0;
  configured_accounts integer:=0;
  company_name text;
begin
  perform pending_invoice_private.reclass_context();
  if uid is null or sid is null or not exists(
    select 1 from public.user_subsidiaries access
    where access.user_id=uid and access.subsidiary_id=sid
  )then
    raise exception using errcode='42501',
      message='Seleccione una subsidiaria autorizada para consultar la reclasificación.';
  end if;
  if p_reclassification_date is null
    or extract(month from p_reclassification_date)<>1
    or extract(day from p_reclassification_date)<>1 then
    raise exception 'La reclasificación anual debe fecharse el 01 de enero.';
  end if;
  if p_reclassification_date>current_date then
    raise exception 'La reclasificación anual no puede ejecutarse con una fecha futura.';
  end if;
  fiscal_year_value:=extract(year from p_reclassification_date)::integer;
  select subsidiary.name into company_name
  from public.subsidiaries subsidiary where subsidiary.subsidiary_id=sid;

  can_create:=public.app_is_admin()or exists(
    select 1 from public.role_access_matrix access
    where access.role_id=public.app_active_role_id()
      and(access.resource_key='legacy:all'
        or(access.resource_key='accounting:pending-invoice-reclassification'
          and access.can_create))
  );
  select exists(
    select 1 from public.fiscal_periods period
    where period.subsidiary_id=sid
      and p_reclassification_date between period.start_date and period.end_date
      and not period.is_closed and not coalesce(period.gl_closed,false)
      and not coalesce(period.is_inactive,false)
  )into period_open;
  select count(*)::integer into book_count
  from public.accounting_books book
  where book.subsidiary_id=sid and book.is_primary and book.is_active;
  book_exists:=book_count=1;

  with configured as(
    select account.account_number,
      jsonb_build_object('id',account.account_id,'number',account.account_number,
        'name',account.account_name)account_object
    from public.chart_accounts account
    join public.account_subsidiaries assignment using(account_id)
    where account.account_number in('113003','113004','413001','413002')
      and assignment.subsidiary_id=sid and assignment.is_active
      and account.accepts_entries and not account.is_inactive
  )
  select(select count(*)from configured),jsonb_build_object(
    'currentControl',(select account_object from configured where account_number='113003'),
    'priorControl',(select account_object from configured where account_number='113004'),
    'currentCounterpart',(select account_object from configured where account_number='413001'),
    'bridge',(select account_object from configured where account_number='413002')
  )into configured_accounts,accounts_value;

  select * into run_row
  from public.pending_invoice_reclassification_runs run
  where run.subsidiary_id=sid and run.fiscal_year=fiscal_year_value;

  if run_row.id is not null then
    select coalesce(jsonb_agg(jsonb_build_object(
      'sourceType',item.source_type,'sourceId',coalesce(item.source_journal_id,item.source_opening_pending_id),
      'reference',item.source_reference,'originDate',item.origin_date,
      'originJournalId',item.origin_journal_id,'customerId',item.customer_id,
      'customer',customer.company_name,'currencyId',item.currency_id,
      'currency',currency.currency_code,'historicalExchangeRate',item.historical_exchange_rate,
      'balanceLocal',item.local_amount,'balanceForeign',item.foreign_amount,
      'serviceMonth',item.service_month,'serviceCountryId',item.service_country_id,
      'serviceCountry',country.name,'journalId',item.reclassification_journal_id
    )order by item.origin_date,item.source_type,item.id),'[]'::jsonb),
      count(*)::integer,coalesce(sum(item.local_amount),0),coalesce(sum(item.foreign_amount),0),
      count(*)filter(where abs(item.local_amount-round(item.foreign_amount*item.historical_exchange_rate,6))>.005)::integer
    into rows_value,item_count,total_local,total_foreign,invalid_fx
    from public.pending_invoice_reclassification_items item
    left join public.customers customer on customer.customer_id=item.customer_id
    join public.currencies currency on currency.currency_id=item.currency_id
    left join public.countries country on country.country_id=item.service_country_id
    where item.run_id=run_row.id;

    select coalesce(jsonb_agg(jsonb_build_object(
      'currencyId',summary.currency_id,'currency',summary.currency_code,
      'count',summary.item_count,'local',summary.local_amount,
      'foreign',summary.foreign_amount
    )order by summary.currency_code),'[]'::jsonb)into by_currency
    from(
      select item.currency_id,currency.currency_code,count(*)::integer item_count,
        sum(item.local_amount)local_amount,sum(item.foreign_amount)foreign_amount
      from public.pending_invoice_reclassification_items item
      join public.currencies currency on currency.currency_id=item.currency_id
      where item.run_id=run_row.id
      group by item.currency_id,currency.currency_code
    )summary;
  else
    select coalesce(jsonb_agg(jsonb_build_object(
      'sourceType',candidate.source_type,'sourceId',candidate.source_id,
      'reference',candidate.source_reference,'originDate',candidate.origin_date,
      'originJournalId',candidate.origin_journal_id,'customerId',candidate.customer_id,
      'customer',coalesce(candidate.customer_name,'Sin cliente'),
      'currencyId',candidate.currency_id,'currency',candidate.currency_code,
      'historicalExchangeRate',candidate.historical_exchange_rate,
      'balanceLocal',candidate.balance_local,'balanceForeign',candidate.balance_foreign,
      'serviceMonth',candidate.service_month,'serviceCountryId',candidate.service_country_id,
      'serviceCountry',candidate.service_country
    )order by candidate.origin_date,candidate.source_type,candidate.source_id),'[]'::jsonb),
      count(*)::integer,coalesce(sum(candidate.balance_local),0),
      coalesce(sum(candidate.balance_foreign),0),
      count(*)filter(where candidate.origin_journal_id is null
        or candidate.historical_exchange_rate is null
        or candidate.historical_exchange_rate<=0
        or candidate.balance_local<=.000001
        or candidate.balance_foreign<=.000001
        or abs(candidate.balance_local-round(candidate.balance_foreign*candidate.historical_exchange_rate,6))>.005)::integer
    into rows_value,item_count,total_local,total_foreign,invalid_fx
    from public.pending_invoice_reclassification_candidates(sid,p_reclassification_date)candidate;

    select count(*)::integer into malformed_sources
    from public.journal source
    where source.subsidiary_id=sid
      and(source.journal_number like'ASI_PEN-%'
        or source.journal_type='Asientos Pendientes de Facturar')
      and coalesce(source.pending_period_type,'ACTUAL')='ACTUAL'
      and source.journal_date<p_reclassification_date
      and source.status='CONTABILIZADO'
      and source.reversal_status not in('REVERSADO_TOTAL','ANULADO')
      and(
        (select count(*)from public.journal_line line
          join public.chart_accounts account using(account_id)
          where line.journal_id=source.journal_id
            and account.account_number='113003'and line.debit>0)<>1
        or(select count(*)from public.journal_line line
          join public.chart_accounts account using(account_id)
          where line.journal_id=source.journal_id
            and account.account_number='413001'and line.credit>0)<>1
        or(select count(*)from public.journal_line line
          where line.journal_id=source.journal_id)<>2
        or exists(select 1 from public.journal_line line
          where line.journal_id=source.journal_id
            and(line.tax_code_id is not null or coalesce(line.tax_rate,0)<>0))
        or(select count(distinct line.customer_id)from public.journal_line line
          where line.journal_id=source.journal_id and line.customer_id is not null)>1
        or source.transaction_id is null
        or(select count(*)from public.gl_impact impact
          join public.accounting_books book using(accounting_book_id)
          where impact.transaction_id=source.transaction_id
            and book.subsidiary_id=sid and book.is_primary and book.is_active)<>2
        or(select count(*)from public.gl_impact impact
          join public.accounting_books book using(accounting_book_id)
          join public.chart_accounts account using(account_id)
          where impact.transaction_id=source.transaction_id
            and book.subsidiary_id=sid and book.is_primary and book.is_active
            and account.account_number='113003'
            and impact.debit_amount>0 and impact.credit_amount=0)<>1
        or(select count(*)from public.gl_impact impact
          join public.accounting_books book using(accounting_book_id)
          join public.chart_accounts account using(account_id)
          where impact.transaction_id=source.transaction_id
            and book.subsidiary_id=sid and book.is_primary and book.is_active
            and account.account_number='413001'
            and impact.credit_amount>0 and impact.debit_amount=0)<>1
        or exists(
          select 1
          from(
            select
              coalesce(sum(line.debit)filter(where account.account_number='113003'),0)control_debit,
              coalesce(sum(line.credit)filter(where account.account_number='413001'),0)counterpart_credit,
              coalesce(sum(line.debit_fx)filter(where account.account_number='113003'),0)control_debit_fx,
              coalesce(sum(line.credit_fx)filter(where account.account_number='413001'),0)counterpart_credit_fx
            from public.journal_line line
            join public.chart_accounts account using(account_id)
            where line.journal_id=source.journal_id
          )line_totals
          where line_totals.control_debit<=0
            or line_totals.control_debit_fx<=0
            or abs(line_totals.control_debit-line_totals.counterpart_credit)>.000001
            or abs(line_totals.control_debit_fx-line_totals.counterpart_credit_fx)>.000001
            or abs(line_totals.control_debit-line_totals.control_debit_fx)>.000001
            or abs(line_totals.counterpart_credit-line_totals.counterpart_credit_fx)>.000001
        )
        or exists(
          select 1
          from(
            select
              coalesce(sum(impact.debit_amount)filter(where account.account_number='113003'),0)control_debit,
              coalesce(sum(impact.credit_amount)filter(where account.account_number='413001'),0)counterpart_credit,
              coalesce(sum(impact.debit_fx)filter(where account.account_number='113003'),0)control_debit_fx,
              coalesce(sum(impact.credit_fx)filter(where account.account_number='413001'),0)counterpart_credit_fx,
              coalesce((
                select sum(source_line.debit)
                from public.journal_line source_line
                join public.chart_accounts source_account using(account_id)
                where source_line.journal_id=source.journal_id
                  and source_account.account_number='113003'
              ),0)line_control_debit,
              coalesce((
                select sum(source_line.credit)
                from public.journal_line source_line
                join public.chart_accounts source_account using(account_id)
                where source_line.journal_id=source.journal_id
                  and source_account.account_number='413001'
              ),0)line_counterpart_credit,
              coalesce(bool_or(
                coalesce(impact.original_currency_id,transaction_row.currency_id)
                  is distinct from source.currency_id
              ),false)wrong_currency
            from public.gl_impact impact
            join public.accounting_books book using(accounting_book_id)
            join public.chart_accounts account using(account_id)
            join public."transaction" transaction_row using(transaction_id)
            where impact.transaction_id=source.transaction_id
              and book.subsidiary_id=sid and book.is_primary and book.is_active
          )impact_totals
          where impact_totals.control_debit<=0
            or impact_totals.control_debit_fx<=0
            or abs(impact_totals.control_debit-impact_totals.counterpart_credit)>.000001
            or abs(impact_totals.control_debit_fx-impact_totals.counterpart_credit_fx)>.000001
            or abs(impact_totals.control_debit_fx-impact_totals.line_control_debit)>.000001
            or abs(impact_totals.counterpart_credit_fx-impact_totals.line_counterpart_credit)>.000001
            or abs(impact_totals.control_debit-
              round(impact_totals.line_control_debit*source.exchange_rate,6))>.005
            or abs(impact_totals.counterpart_credit-
              round(impact_totals.line_counterpart_credit*source.exchange_rate,6))>.005
            or impact_totals.wrong_currency
        )
      );

    select count(*)::integer into post_cutoff_reversals
    from public.pending_invoice_reversal reversal
    where reversal.reversal_date>=p_reclassification_date
      and(
        exists(
          select 1 from public.journal source
          where source.journal_id=reversal.source_journal_id
            and source.subsidiary_id=sid
            and source.journal_date<p_reclassification_date
            and coalesce(source.pending_period_type,'ACTUAL')='ACTUAL'
            and coalesce(source.reversal_status,'PENDIENTE')<>'ANULADO'
        )
        or exists(
          select 1
          from public.opening_pending_invoice_items item
          join public.opening_balance_runs opening_run on opening_run.id=item.run_id
          where item.id=reversal.source_opening_pending_id
            and item.subsidiary_id=sid and item.period_type='ACTUAL'
            and opening_run.opening_date<p_reclassification_date
            and item.opening_reversed_at is null
        )
      );

    select coalesce(jsonb_agg(jsonb_build_object(
      'currencyId',row.currency_id,'currency',row.currency_code,
      'ledgerLocal',row.ledger_local,'auxiliaryLocal',row.auxiliary_local,
      'localDifference',row.local_difference,
      'ledgerForeign',row.ledger_foreign,'auxiliaryForeign',row.auxiliary_foreign,
      'foreignDifference',row.foreign_difference,'balanced',row.balanced
    )order by row.currency_code),'[]'::jsonb),coalesce(bool_and(row.balanced),true)
    into reconciliation_value,reconciliation_balanced
    from public.pending_invoice_reclassification_reconciliation(
      sid,p_reclassification_date
    )row;

    select coalesce(jsonb_agg(jsonb_build_object(
      'currencyId',summary.currency_id,'currency',summary.currency_code,
      'count',summary.item_count,'local',summary.local_amount,
      'foreign',summary.foreign_amount
    )order by summary.currency_code),'[]'::jsonb)into by_currency
    from(
      select candidate.currency_id,candidate.currency_code,count(*)::integer item_count,
        sum(candidate.balance_local)local_amount,sum(candidate.balance_foreign)foreign_amount
      from public.pending_invoice_reclassification_candidates(sid,p_reclassification_date)candidate
      group by candidate.currency_id,candidate.currency_code
    )summary;
  end if;

  if configured_accounts<>4 then issues:=issues||jsonb_build_array('Las cuentas 113003, 113004, 413001 y 413002 deben estar activas y asignadas a la subsidiaria.');end if;
  if not book_exists then issues:=issues||jsonb_build_array('Debe existir exactamente un libro contable principal activo para la subsidiaria.');end if;
  if not period_open then issues:=issues||jsonb_build_array('El período contable del 01 de enero debe estar abierto para Libro Mayor.');end if;
  if invalid_fx>0 then issues:=issues||jsonb_build_array('Hay pendientes cuya tasa histórica no reproduce el saldo local.');end if;
  if malformed_sources>0 then issues:=issues||jsonb_build_array('Hay pendientes que no conservan exactamente las líneas 113003 al debe y 413001 al haber.');end if;
  if post_cutoff_reversals>0 then issues:=issues||jsonb_build_array('Existen reversiones fechadas desde el 01 de enero sobre saldos a reclasificar. Deben corregirse antes de ejecutar una reclasificación retroactiva.');end if;
  if not reconciliation_balanced then issues:=issues||jsonb_build_array('El saldo del Mayor en 113003 no coincide con el auxiliar de pendientes al 01 de enero. Revise el detalle de conciliación.');end if;
  if item_count=0 and run_row.id is null then issues:=issues||jsonb_build_array('No hay pendientes del período anterior con saldo vivo para reclasificar.');end if;
  if not can_create then issues:=issues||jsonb_build_array('El rol activo puede consultar, pero no ejecutar la reclasificación.');end if;

  return jsonb_build_object(
    'subsidiary',jsonb_build_object('id',sid,'name',company_name),
    'reclassificationDate',p_reclassification_date,
    'fiscalYear',fiscal_year_value,
    'alreadyExecuted',run_row.id is not null and run_row.status='POSTED',
    'runId',run_row.id,'status',run_row.status,
    'canExecute',run_row.id is null and can_create and configured_accounts=4
      and book_exists and period_open and invalid_fx=0 and malformed_sources=0
      and post_cutoff_reversals=0 and reconciliation_balanced and item_count>0,
    'issues',issues,'accounts',accounts_value,'rows',rows_value,
    'reconciliation',reconciliation_value,
    'totals',jsonb_build_object('count',item_count,'local',total_local,
      'foreign',total_foreign,'bridgeDebit',total_local,'bridgeCredit',total_local,
      'difference',0,'byCurrency',by_currency)
  );
end
$function$;
CREATE OR REPLACE FUNCTION public.audit_has_direct_read(p_resource_key text)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  select public.app_is_admin()or exists(
    select 1
    from public.role_access_matrix access
    where access.role_id=public.app_active_role_id()
      and access.can_view
      and access.resource_key in('legacy:all',p_resource_key)
  )
$function$;
CREATE OR REPLACE FUNCTION public.opening_balance_options_before_opening_pending()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare sid bigint:=opening_balance_assert_access('view');result jsonb;
begin
 select jsonb_build_object(
  'canCreate',app_is_admin()or exists(select 1 from role_access_matrix m where m.role_id=app_active_role_id()and(m.resource_key='legacy:all'or(m.resource_key='accounting:opening-balances'and m.can_create))),
  'canReverse',app_is_admin()or exists(select 1 from role_access_matrix m where m.role_id=app_active_role_id()and(m.resource_key='legacy:all'or(m.resource_key='accounting:opening-balances'and m.can_delete))),
  'subsidiary',jsonb_build_object('id',s.subsidiary_id,'name',s.name,'currencyId',s.currency_id,'currency',cu.currency_code),
  'accounts',coalesce((select jsonb_agg(jsonb_build_object('id',a.account_id,'number',a.account_number,'name',a.account_name,'category',a.category)order by a.account_number)from chart_accounts a join account_subsidiaries x using(account_id)where x.subsidiary_id=s.subsidiary_id and x.is_active and a.account_number='319999'and a.accepts_entries and not a.is_inactive),'[]'),
  'assetCategories',coalesce((select jsonb_agg(jsonb_build_object('code',category_code,'name',category_name,'life',useful_life_months,'method',depreciation_method)order by category_code)from asset_category where subsidiary_id=s.subsidiary_id and is_active),'[]'),
  'run',(select to_jsonb(r)from opening_balance_runs r where r.subsidiary_id=s.subsidiary_id and r.status<>'REVERSED'order by r.id desc limit 1)
 )into result from subsidiaries s join currencies cu using(currency_id)where s.subsidiary_id=sid;
 return result;
end$function$;
CREATE OR REPLACE FUNCTION public.security_assert_role_access(p_resource_key text, p_action text DEFAULT 'view'::text)
 RETURNS void
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare allowed boolean:=false;
begin
 if p_resource_key in('security:users','security:roles','security:user-roles','security:user-subsidiaries','security:permissions','security:role-permissions','security:role-access-matrix')then perform access_admin_private.access(substr(p_resource_key,10),p_action);return;end if;
 if public.app_is_admin()then return;end if;
 if p_action not in('view','create','edit','delete')then raise exception'La acción solicitada no es válida.';end if;
 select exists(select 1 from public.role_access_matrix m where m.role_id=public.app_active_role_id()and(
   m.resource_key='legacy:all' or(m.resource_key=p_resource_key and case p_action when'view'then m.can_view when'create'then m.can_create when'edit'then m.can_edit else m.can_delete end)
 ))into allowed;
 if not allowed then raise exception using errcode='42501',message='El rol activo no tiene permiso para realizar esta acción.';end if;
end$function$;
CREATE OR REPLACE FUNCTION public.security_resource_allowed(p_resource_key text, p_action text DEFAULT 'view'::text)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  select public.app_user_id() is not null
    and p_action in('view','create','edit','delete')
    and(
      public.app_is_admin()
      or exists(
        select 1
        from public.role_access_matrix access
        where access.role_id=public.app_active_role_id()
          and(
            access.resource_key='legacy:all'
            or(
              access.resource_key=p_resource_key
              and case p_action
                when 'view' then access.can_view
                when 'create' then access.can_create
                when 'edit' then access.can_edit
                when 'delete' then access.can_delete
                else false
              end
            )
          )
      )
    )
$function$;
CREATE OR REPLACE FUNCTION public.user_invitation_email_settings(p_action text, p_payload jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  uid bigint:=public.app_user_id();
  sid bigint:=public.active_subsidiary_id();
  action_name text:=lower(trim(coalesce(p_action,'')));
  cfg public.configuraciones_correos%rowtype;
  subject_value text;
  body_value text;
  invalid_variable text;
  can_edit boolean:=false;
begin
  if uid is null or sid is null or not exists(
    select 1
    from public.users account
    join public.user_subsidiaries access on access.user_id=account.user_id
    where account.user_id=uid
      and account.is_active
      and access.subsidiary_id=sid
  ) then
    raise exception using errcode='42501',message='Debe iniciar sesión y seleccionar una subsidiaria autorizada.';
  end if;

  if action_name not in('get','save','delivery') then
    raise exception using errcode='22023',message='Acción inválida.';
  end if;

  perform public.security_assert_role_access(
    case
      when action_name='delivery' then 'security:users'
      else 'configuration:notification-templates'
    end,
    case
      when action_name='save' then 'edit'
      when action_name='delivery' then 'create'
      else 'view'
    end
  );

  can_edit:=public.app_is_admin()or exists(
    select 1
    from public.role_access_matrix access
    where access.role_id=public.app_active_role_id()
      and(
        access.resource_key='legacy:all'
        or(
          access.resource_key='configuration:notification-templates'
          and access.can_edit
        )
      )
  );

  perform public.user_invitation_email_ensure_template(sid);

  if action_name='save' then
    subject_value:=trim(coalesce(p_payload->>'subject',''));
    body_value:=coalesce(p_payload->>'body','');
    if length(subject_value) not between 1 and 200
      or subject_value~E'[\r\n]'
      or length(body_value) not between 1 and 20000
    then
      raise exception using errcode='22023',message='La plantilla de invitación no es válida.';
    end if;

    if subject_value~*'\{\{[[:space:]]*enlace_activacion[[:space:]]*\}\}' then
      raise exception using errcode='22023',message='La variable {{enlace_activacion}} solo puede utilizarse en el cuerpo del correo.';
    end if;

    select matched.captures[1]
      into invalid_variable
    from regexp_matches(
      subject_value||E'\n'||body_value,
      '\{\{[[:space:]]*([^{}]+?)[[:space:]]*\}\}',
      'g'
    ) as matched(captures)
    where trim(matched.captures[1])<>all(array[
      'empresa_nombre','usuario_nombre','usuario_correo',
      'enlace_activacion','fecha_expiracion'
    ]::text[])
    limit 1;

    if invalid_variable is not null then
      raise exception using errcode='22023',message='Variable no permitida en la plantilla: {{'||trim(invalid_variable)||'}}.';
    end if;

    update public.configuraciones_correos
    set asunto_template=subject_value,
        cuerpo_template=body_value,
        activo=coalesce((p_payload->>'active')::boolean,false),
        updated_by_email=(select email from public.users where user_id=uid),
        updated_at=clock_timestamp()
    where id_subsidiaria=sid
      and tipo_notificacion='USUARIO_INVITACION';
  end if;

  select *
    into cfg
  from public.configuraciones_correos
  where id_subsidiaria=sid
    and tipo_notificacion='USUARIO_INVITACION';

  return jsonb_build_object(
    'template',to_jsonb(cfg),
    'subsidiary',(
      select jsonb_build_object(
        'id',subsidiary_id,
        'name',name,
        'logo',logo_url
      )
      from public.subsidiaries
      where subsidiary_id=sid
    ),
    'canEdit',can_edit,
    'variables',jsonb_build_array(
      'empresa_nombre','usuario_nombre','usuario_correo',
      'enlace_activacion','fecha_expiracion'
    )
  );
end;
$function$;
CREATE OR REPLACE FUNCTION public.user_password_recovery_email_settings(p_action text, p_payload jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  uid bigint:=public.app_user_id();
  sid bigint:=public.active_subsidiary_id();
  action_name text:=lower(trim(coalesce(p_action,'')));
  cfg public.configuraciones_correos%rowtype;
  subject_value text;
  body_value text;
  invalid_variable text;
  can_edit boolean:=false;
begin
  if uid is null or sid is null or not exists(
    select 1
    from public.users account
    join public.user_subsidiaries access on access.user_id=account.user_id
    where account.user_id=uid
      and account.is_active
      and access.subsidiary_id=sid
  ) then
    raise exception using errcode='42501',message='Debe iniciar sesión y seleccionar una subsidiaria autorizada.';
  end if;

  if action_name not in('get','save','delivery') then
    raise exception using errcode='22023',message='Acción inválida.';
  end if;

  perform public.security_assert_role_access(
    case when action_name='delivery' then 'security:users'
         else 'configuration:notification-templates' end,
    case when action_name='save' then 'edit'
         when action_name='delivery' then 'edit'
         else 'view' end
  );

  can_edit:=public.app_is_admin()or exists(
    select 1 from public.role_access_matrix access
    where access.role_id=public.app_active_role_id()
      and(
        access.resource_key='legacy:all'
        or(access.resource_key='configuration:notification-templates'and access.can_edit)
      )
  );

  perform public.user_password_recovery_email_ensure_template(sid);

  if action_name='save' then
    subject_value:=trim(coalesce(p_payload->>'subject',''));
    body_value:=coalesce(p_payload->>'body','');
    if length(subject_value)not between 1 and 200
      or subject_value~E'[\r\n]'
      or length(body_value)not between 1 and 20000 then
      raise exception using errcode='22023',message='La plantilla de recuperación no es válida.';
    end if;
    if subject_value~*'\{\{[[:space:]]*enlace_recuperacion[[:space:]]*\}\}' then
      raise exception using errcode='22023',message='La variable {{enlace_recuperacion}} solo puede utilizarse en el cuerpo del correo.';
    end if;
    select matched.captures[1]
      into invalid_variable
    from regexp_matches(
      subject_value||E'\n'||body_value,
      '\{\{[[:space:]]*([^{}]+?)[[:space:]]*\}\}',
      'g'
    )as matched(captures)
    where trim(matched.captures[1])<>all(array[
      'empresa_nombre','usuario_nombre','usuario_correo',
      'enlace_recuperacion','fecha_expiracion'
    ]::text[])
    limit 1;
    if invalid_variable is not null then
      raise exception using errcode='22023',message='Variable no permitida en la plantilla: {{'||trim(invalid_variable)||'}}.';
    end if;
    update public.configuraciones_correos
    set asunto_template=subject_value,
        cuerpo_template=body_value,
        activo=coalesce((p_payload->>'active')::boolean,false),
        updated_by_email=(select email from public.users where user_id=uid),
        updated_at=clock_timestamp()
    where id_subsidiaria=sid and tipo_notificacion='USUARIO_RECUPERACION';
  end if;

  select *
    into cfg
  from public.configuraciones_correos
  where id_subsidiaria=sid
    and tipo_notificacion='USUARIO_RECUPERACION';

  return jsonb_build_object(
    'template',to_jsonb(cfg),
    'subsidiary',(
      select jsonb_build_object('id',subsidiary_id,'name',name,'logo',logo_url)
      from public.subsidiaries
      where subsidiary_id=sid
    ),
    'canEdit',can_edit,
    'variables',jsonb_build_array(
      'empresa_nombre','usuario_nombre','usuario_correo',
      'enlace_recuperacion','fecha_expiracion'
    )
  );
end;
$function$;
CREATE OR REPLACE FUNCTION rate_security_private.allowed(k text, a text)
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$begin
 perform rate_security_private.actor();if k is null or a is null or k not in('exchange-rates','consolidated-exchange-rates')or a not in('view','create','edit','delete')then return false;end if;
 return(a='view'and(public.app_is_admin()or exists(select 1 from public.role_access_matrix where role_id=public.app_active_role_id()and resource_key='legacy:all')))
 or exists(select 1 from public.role_access_matrix m where m.role_id=public.app_active_role_id()and m.resource_key='configuration:'||k and m.can_view and case a when'view'then true when'create'then m.can_create when'edit'then m.can_edit else m.can_delete end);
 exception when insufficient_privilege then return false;end$function$;
CREATE OR REPLACE FUNCTION sequence_security_private.allowed(a text)
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$begin
 perform sequence_security_private.actor();if a is null or a not in('view','create','edit','delete')then return false;end if;
 return(a='view'and(public.app_is_admin()or exists(select 1 from role_access_matrix where role_id=public.app_active_role_id()and resource_key='legacy:all'and can_view)))or exists(select 1 from role_access_matrix m where m.role_id=public.app_active_role_id()and m.resource_key='core:number-sequences'and m.can_view and case a when'view'then true when'create'then m.can_create when'edit'then m.can_edit else m.can_delete end);
 exception when insufficient_privilege then return false;end$function$;
CREATE OR REPLACE FUNCTION status_master_private.allowed(a text)
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$begin
 perform core_dictionary_private.actor();if a is null or a not in('view','create','edit','delete')then return false;end if;
 return(a='view'and(public.app_is_admin()or exists(select 1 from role_access_matrix where role_id=public.app_active_role_id()and resource_key='legacy:all'and can_view)))or exists(select 1 from role_access_matrix m where m.role_id=public.app_active_role_id()and m.resource_key='core:status'and m.can_view and case a when'view'then true when'create'then m.can_create when'edit'then m.can_edit else m.can_delete end);
 exception when insufficient_privilege then return false;end$function$;
CREATE OR REPLACE FUNCTION transaction_type_private.allowed(a text)
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$begin
 perform core_dictionary_private.actor();if a is null or a not in('view','create','edit','delete')then return false;end if;
 return(a='view'and(public.app_is_admin()or exists(select 1 from role_access_matrix where role_id=public.app_active_role_id()and resource_key='legacy:all'and can_view)))or exists(select 1 from role_access_matrix m where m.role_id=public.app_active_role_id()and m.resource_key='core:transaction-types'and m.can_view and case a when'view'then true when'create'then m.can_create when'edit'then m.can_edit else m.can_delete end);
 exception when insufficient_privilege then return false;end$function$;