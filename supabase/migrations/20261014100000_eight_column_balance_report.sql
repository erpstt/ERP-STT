-- Balance General de 8 Columnas (Balance Tributario).
--
-- El reporte usa exclusivamente la moneda local del libro seleccionado. La
-- clasificación se deriva del plan de cuentas para no mantener un segundo
-- catálogo que pueda divergir de Activo/Pasivo/Patrimonio/Ingreso/Costo/Gasto.

create index if not exists gl_impact_eight_column_balance_idx
  on public.gl_impact(subsidiary_id,accounting_book_id,posting_date,account_id);

create or replace function public.run_eight_column_balance_report(
  p_filters jsonb default '{}'::jsonb
) returns jsonb
language plpgsql
stable
security definer
set search_path=public,pg_temp
as $$
declare
  uid bigint:=public.app_user_id();
  sid bigint:=nullif(p_filters->>'subsidiaryId','')::bigint;
  requested_book_id bigint:=nullif(p_filters->>'bookId','')::bigint;
  selected_book_id bigint;
  date_from date;
  date_to date;
  detail_level integer:=coalesce(nullif(coalesce(p_filters->>'detailLevel',p_filters->>'hierarchy'),'')::integer,4);
  include_zero boolean:=lower(coalesce(nullif(p_filters->>'includeZero',''),'false')) in ('true','1','yes','si');
  result jsonb;
begin
  if uid is null then
    raise exception using errcode='42501',message='La sesión no identifica un usuario.';
  end if;
  if sid is null then
    raise exception 'Seleccione la subsidiaria del reporte.';
  end if;
  if not exists(
    select 1 from public.user_subsidiaries access
    where access.user_id=uid and access.subsidiary_id=sid
  )then
    raise exception using errcode='42501',message='No tiene acceso a la subsidiaria seleccionada.';
  end if;

  perform public.security_assert_role_access('reports:accounting-reports','view');

  begin
    date_from:=nullif(p_filters->>'dateFrom','')::date;
    date_to:=nullif(p_filters->>'dateTo','')::date;
  exception when invalid_datetime_format then
    raise exception 'El rango de fechas no es válido.';
  end;
  if date_from is null or date_to is null then
    raise exception 'Indique las fechas inicial y final del reporte.';
  end if;
  if date_from>date_to then
    raise exception 'La fecha inicial no puede ser posterior a la fecha final.';
  end if;
  if detail_level not between 1 and 4 then
    raise exception 'El nivel de detalle debe estar entre 1 y 4.';
  end if;

  if requested_book_id is null then
    select book.accounting_book_id into selected_book_id
    from public.accounting_books book
    where book.subsidiary_id=sid and book.is_active
    order by book.is_primary desc,book.accounting_book_id
    limit 1;
  else
    select book.accounting_book_id into selected_book_id
    from public.accounting_books book
    where book.accounting_book_id=requested_book_id
      and book.subsidiary_id=sid and book.is_active;
  end if;
  if selected_book_id is null then
    raise exception 'La subsidiaria no tiene un libro contable activo disponible.';
  end if;

  with recursive group_ancestry as(
    select leaf.group_id leaf_group_id,leaf.group_id,leaf.group_code,leaf.group_name,
      leaf.level,leaf.parent_id,leaf.category,0 depth
    from public.account_group leaf
    union all
    select ancestry.leaf_group_id,parent.group_id,parent.group_code,parent.group_name,
      parent.level,parent.parent_id,parent.category,ancestry.depth+1
    from group_ancestry ancestry
    join public.account_group parent on parent.group_id=ancestry.parent_id
    where ancestry.depth<20
  ),group_paths as(
    select ancestry.leaf_group_id,
      jsonb_agg(
        jsonb_build_object(
          'id',ancestry.group_id,
          'code',ancestry.group_code,
          'name',ancestry.group_name,
          'level',ancestry.level,
          'parentId',ancestry.parent_id,
          'category',ancestry.category
        ) order by coalesce(ancestry.level,100),ancestry.depth desc,ancestry.group_code
      )group_path
    from group_ancestry ancestry
    group by ancestry.leaf_group_id
  ),account_universe as(
    -- Cuentas imputables actualmente habilitadas: permiten mostrar ceros.
    select account.account_id,account.account_number,account.account_name,
      account.account_group_id,account.category account_category,
      account.nature account_nature,account.is_inactive,account.accepts_entries
    from public.account_subsidiaries assignment
    join public.chart_accounts account using(account_id)
    where assignment.subsidiary_id=sid and assignment.is_active
      and not account.is_inactive and account.accepts_entries
    union
    -- Cuentas con historia en el periodo, aun si fueron desactivadas después.
    select account.account_id,account.account_number,account.account_name,
      account.account_group_id,account.category account_category,
      account.nature account_nature,account.is_inactive,account.accepts_entries
    from public.gl_impact impact
    join public.chart_accounts account using(account_id)
    where impact.subsidiary_id=sid
      and impact.accounting_book_id=selected_book_id
      and impact.posting_date between date_from and date_to
  ),movements as(
    select impact.account_id,
      coalesce(sum(impact.debit_amount),0)::numeric(24,6) debit,
      coalesce(sum(impact.credit_amount),0)::numeric(24,6) credit
    from public.gl_impact impact
    where impact.subsidiary_id=sid
      and impact.accounting_book_id=selected_book_id
      and impact.posting_date between date_from and date_to
    group by impact.account_id
  ),classified as(
    select account.account_id,account.account_number,account.account_name,
      account.account_group_id group_id,grp.group_code,grp.group_name,
      grp.level group_level,grp.parent_id group_parent_id,
      coalesce(paths.group_path,'[]'::jsonb)group_path,
      coalesce(account.account_category,grp.category,'Sin clasificar')category,
      coalesce(account.account_nature,grp.nature,'Deudora')nature,
      case coalesce(account.account_category,grp.category)
        when 'Activo'then'ACTIVO'
        when 'Pasivo'then'PASIVO'
        when 'Patrimonio'then'PASIVO'
        when 'Costo'then'PERDIDA'
        when 'Gasto'then'PERDIDA'
        when 'Ingreso'then'GANANCIA'
        else'SIN_CLASIFICAR'
      end classification,
      coalesce(movement.debit,0)::numeric(24,6)debit,
      coalesce(movement.credit,0)::numeric(24,6)credit,
      account.is_inactive,account.accepts_entries
    from account_universe account
    join public.account_group grp on grp.group_id=account.account_group_id
    left join group_paths paths on paths.leaf_group_id=grp.group_id
    left join movements movement using(account_id)
  ),eligible as(
    select * from classified
    where include_zero or debit<>0 or credit<>0
  ),row_values as(
    select account_id,account_number,account_name,group_id,group_code,group_name,
      group_level,group_parent_id,group_path,category,nature,classification,
      debit,credit,
      greatest(debit-credit,0)::numeric(24,6)debtor_balance,
      greatest(credit-debit,0)::numeric(24,6)creditor_balance,
      case when classification='ACTIVO'then debit-credit else 0 end::numeric(24,6)asset,
      case when classification='PASIVO'then credit-debit else 0 end::numeric(24,6)liability,
      case when classification='PERDIDA'then debit-credit else 0 end::numeric(24,6)loss,
      case when classification='GANANCIA'then credit-debit else 0 end::numeric(24,6)gain,
      is_inactive,accepts_entries
    from eligible
  ),totals as(
    select
      coalesce(sum(debit),0)::numeric(24,6)debit,
      coalesce(sum(credit),0)::numeric(24,6)credit,
      coalesce(sum(debtor_balance),0)::numeric(24,6)debtor_balance,
      coalesce(sum(creditor_balance),0)::numeric(24,6)creditor_balance,
      coalesce(sum(asset),0)::numeric(24,6)asset,
      coalesce(sum(liability),0)::numeric(24,6)liability,
      coalesce(sum(loss),0)::numeric(24,6)loss,
      coalesce(sum(gain),0)::numeric(24,6)gain,
      count(*)::integer account_count,
      count(*)filter(where classification='SIN_CLASIFICAR')::integer unclassified_count,
      coalesce(sum(debit-credit)filter(where classification='SIN_CLASIFICAR'),0)::numeric(24,6)unclassified_net
    from row_values
  ),calculation as(
    select totals.*,
      (gain-loss)::numeric(24,6)exercise_result,
      (asset-liability)::numeric(24,6)inventory_difference,
      (gain-loss)::numeric(24,6)result_difference,
      greatest(-(gain-loss),0)::numeric(24,6)result_asset,
      greatest(gain-loss,0)::numeric(24,6)result_liability,
      greatest(gain-loss,0)::numeric(24,6)result_loss,
      greatest(-(gain-loss),0)::numeric(24,6)result_gain
    from totals
  ),final_totals as(
    select calculation.*,
      (asset+result_asset)::numeric(24,6)equalized_asset,
      (liability+result_liability)::numeric(24,6)equalized_liability,
      (loss+result_loss)::numeric(24,6)equalized_loss,
      (gain+result_gain)::numeric(24,6)equalized_gain
    from calculation
  )
  select jsonb_build_object(
    'header',jsonb_build_object(
      'subsidiaryId',company.subsidiary_id,
      'subsidiary',company.name,
      'legalName',company.legal_name,
      'taxId',company.tax_id,
      'currency',currency.currency_code,
      'currencyName',currency.name,
      'symbol',currency.symbol,
      'dateFrom',date_from,
      'dateTo',date_to,
      'bookId',book.accounting_book_id,
      'bookName',book.book_name,
      'detailLevel',detail_level,
      'includeZero',include_zero
    ),
    'rows',coalesce((
      select jsonb_agg(jsonb_build_object(
        'accountId',row_value.account_id,
        'accountNumber',row_value.account_number,
        'accountName',row_value.account_name,
        'groupId',row_value.group_id,
        'groupCode',row_value.group_code,
        'groupName',row_value.group_name,
        'groupLevel',row_value.group_level,
        'groupParentId',row_value.group_parent_id,
        'groupPath',row_value.group_path,
        'category',row_value.category,
        'nature',row_value.nature,
        'classification',row_value.classification,
        'debit',row_value.debit,
        'credit',row_value.credit,
        'debtorBalance',row_value.debtor_balance,
        'creditorBalance',row_value.creditor_balance,
        'asset',row_value.asset,
        'liability',row_value.liability,
        'loss',row_value.loss,
        'gain',row_value.gain,
        'isInactive',row_value.is_inactive,
        'acceptsEntries',row_value.accepts_entries
      )order by
        case row_value.classification when 'ACTIVO' then 1 when 'PASIVO' then 2 when 'PERDIDA' then 3 when 'GANANCIA' then 4 else 9 end,
        row_value.account_number,row_value.account_id)
      from row_values row_value
    ),'[]'::jsonb),
    'total',(select account_count from final_totals),
    'summary',(select jsonb_build_object(
      'debit',summary.debit,
      'credit',summary.credit,
      'debtorBalance',summary.debtor_balance,
      'creditorBalance',summary.creditor_balance,
      'asset',summary.asset,
      'liability',summary.liability,
      'loss',summary.loss,
      'gain',summary.gain,
      'exerciseResult',summary.exercise_result,
      'inventoryDifference',summary.inventory_difference,
      'resultDifference',summary.result_difference,
      'accountCount',summary.account_count,
      'unclassifiedCount',summary.unclassified_count,
      'unclassifiedNet',summary.unclassified_net,
      'resultRow',jsonb_build_object(
        'label','Resultado del ejercicio',
        'asset',summary.result_asset,
        'liability',summary.result_liability,
        'loss',summary.result_loss,
        'gain',summary.result_gain
      ),
      'equalized',jsonb_build_object(
        'asset',summary.equalized_asset,
        'liability',summary.equalized_liability,
        'loss',summary.equalized_loss,
        'gain',summary.equalized_gain
      ),
      'validations',jsonb_build_object(
        'debitsCreditsBalanced',summary.debit=summary.credit,
        'balancesBalanced',summary.debtor_balance=summary.creditor_balance,
        'resultBridgeBalanced',summary.inventory_difference=summary.result_difference,
        'equalizedBalanceSheet',summary.equalized_asset=summary.equalized_liability,
        'equalizedResults',summary.equalized_loss=summary.equalized_gain,
        'allBalanced',summary.debit=summary.credit
          and summary.debtor_balance=summary.creditor_balance
          and summary.inventory_difference=summary.result_difference
          and summary.equalized_asset=summary.equalized_liability
          and summary.equalized_loss=summary.equalized_gain
          and summary.unclassified_count=0
      ),
      'warnings',case when summary.unclassified_count>0 then
        jsonb_build_array(format(
          '%s cuenta(s) con movimiento no tienen una categoría financiera válida; revise el plan de cuentas.',
          summary.unclassified_count
        ))else'[]'::jsonb end
    )from final_totals summary)
  )into result
  from public.subsidiaries company
  join public.currencies currency using(currency_id)
  join public.accounting_books book on book.accounting_book_id=selected_book_id
  where company.subsidiary_id=sid;

  return result;
end
$$;

comment on function public.run_eight_column_balance_report(jsonb) is
 'Balance General de 8 Columnas por subsidiaria y libro: sumas, saldos, inventario, resultado y validaciones de cuadratura.';

revoke all on function public.run_eight_column_balance_report(jsonb) from public;
grant execute on function public.run_eight_column_balance_report(jsonb) to authenticated;
grant execute on function public.run_eight_column_balance_report(jsonb) to service_role;

create or replace function public.eight_column_balance_report_options()
returns jsonb
language plpgsql
stable
security definer
set search_path=public,pg_temp
as $$
declare
  uid bigint:=public.app_user_id();
begin
  if uid is null then
    raise exception using errcode='42501',message='La sesión no identifica un usuario.';
  end if;
  perform public.security_assert_role_access('reports:accounting-reports','view');

  return jsonb_build_object(
    'subsidiaries',coalesce((
      select jsonb_agg(jsonb_build_object(
        'id',company.subsidiary_id,
        'name',company.name,
        'legalName',company.legal_name,
        'taxId',company.tax_id,
        'currencyId',company.currency_id,
        'currency',currency.currency_code,
        'symbol',currency.symbol
      )order by company.name)
      from public.subsidiaries company
      join public.user_subsidiaries access using(subsidiary_id)
      join public.currencies currency using(currency_id)
      where access.user_id=uid and company.is_active
    ),'[]'::jsonb),
    'books',coalesce((
      select jsonb_agg(jsonb_build_object(
        'id',book.accounting_book_id,
        'name',book.book_name,
        'subsidiaryId',book.subsidiary_id,
        'currencyId',book.base_currency_id,
        'isPrimary',book.is_primary
      )order by book.subsidiary_id,book.is_primary desc,book.book_name)
      from public.accounting_books book
      join public.user_subsidiaries access using(subsidiary_id)
      where access.user_id=uid and book.is_active
    ),'[]'::jsonb),
    'periods',coalesce((
      select jsonb_agg(jsonb_build_object(
        'id',period.fiscal_period_id,
        'name',period.period_name,
        'start',period.start_date,
        'end',period.end_date,
        'subsidiaryId',period.subsidiary_id
      )order by period.start_date desc)
      from public.fiscal_periods period
      join public.user_subsidiaries access using(subsidiary_id)
      where access.user_id=uid and not coalesce(period.is_inactive,false)
    ),'[]'::jsonb),
    'activeSubsidiaryId',case when exists(
      select 1 from public.user_subsidiaries access
      where access.user_id=uid and access.subsidiary_id=public.active_subsidiary_id()
    )then public.active_subsidiary_id()end,
    'defaultDateFrom',date_trunc('year',current_date)::date,
    'defaultDateTo',current_date
  );
end
$$;

comment on function public.eight_column_balance_report_options() is
 'Subsidiarias y libros autorizados para el Balance General de 8 Columnas; identifica explicitamente el libro principal.';

revoke all on function public.eight_column_balance_report_options() from public;
grant execute on function public.eight_column_balance_report_options() to authenticated;
grant execute on function public.eight_column_balance_report_options() to service_role;
