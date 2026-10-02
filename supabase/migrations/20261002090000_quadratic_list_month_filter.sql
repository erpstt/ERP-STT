-- Completa el filtro mensual del listado de conciliaciones cuadráticas.
create or replace function public.quadratic_reconciliation_list(p_filters jsonb default '{}'::jsonb)returns jsonb
language plpgsql stable security definer set search_path=public,pg_temp as $$
declare sid bigint:=nullif(p_filters->>'subsidiaryId','')::bigint;account_key bigint:=nullif(p_filters->>'bankAccountId','')::bigint;
 yr integer:=nullif(p_filters->>'periodYear','')::integer;mo integer:=nullif(p_filters->>'periodMonth','')::integer;
 state text:=nullif(p_filters->>'status','');result jsonb;
begin
 if not public.quadratic_has_permission('BANK_QUADRATIC_VIEW')then raise exception using errcode='42501',message='No tiene permiso para consultar conciliaciones cuadraticas.';end if;
 if sid is null then sid:=public.active_subsidiary_id();end if;
 if sid is not null and not public.quadratic_can(sid,'BANK_QUADRATIC_VIEW')then raise exception using errcode='42501',message='No tiene acceso a la subsidiaria seleccionada.';end if;
 with rows as(select r.*,b.account_number,bk.bank_name,c.currency_code,c.symbol,s.name subsidiary_name
  from public.quadratic_bank_reconciliations r join public.bank_account b using(bank_account_id)join public.banks bk using(bank_id)
  join public.currencies c using(currency_id)join public.subsidiaries s on s.subsidiary_id=r.subsidiary_id
  where public.quadratic_can(r.subsidiary_id,'BANK_QUADRATIC_VIEW')and(sid is null or r.subsidiary_id=sid)
   and(account_key is null or r.bank_account_id=account_key)and(yr is null or r.period_year=yr)
   and(mo is null or r.period_month=mo)and(state is null or r.status=state))
 select jsonb_build_object('rows',coalesce(jsonb_agg(jsonb_build_object('id',reconciliation_id,'subsidiaryId',subsidiary_id,
  'subsidiaryName',subsidiary_name,'bankAccountId',bank_account_id,'accountNumber',account_number,'bankName',bank_name,
  'currencyCode',currency_code,'currencySymbol',symbol,'periodYear',period_year,'periodMonth',period_month,'status',status,
  'bankEndBalance',bank_end_balance,'bookEndBalance',book_end_balance,'updatedAt',updated_at)
  order by period_year desc,period_month desc,reconciliation_id desc),'[]'::jsonb),'total',count(*))into result from rows;
 return result;
end$$;

revoke all on function public.quadratic_reconciliation_list(jsonb) from public,anon,authenticated;
grant execute on function public.quadratic_reconciliation_list(jsonb) to authenticated;
