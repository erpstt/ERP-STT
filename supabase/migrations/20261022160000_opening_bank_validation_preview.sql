-- Show bank reconciliation differences during validation while keeping posting
-- and activation strict.  The flag is transaction-local and is set only by the
-- public validation wrapper.

create or replace function public.opening_bank_assert_reconciled(p_run_id bigint)
returns void
language plpgsql
stable
security definer
set search_path=public,pg_temp
as $$
declare
 reconciliation jsonb;
 discrepancy_text text;
begin
 reconciliation:=public.opening_bank_reconciliation(p_run_id);

 if exists(
  select 1
  from jsonb_array_elements(reconciliation)item
  where abs(coalesce((item->>'difference')::numeric,0))>=.005
     or abs(coalesce((item->>'localDifference')::numeric,0))>=.005
 )then
  -- Validation must return the reconciliation rows so the user can identify
  -- and correct the account.  Posting and activation never set this flag.
  if coalesce(current_setting('app.opening_bank_validation_preview',true),'')='1'then
   return;
  end if;

  select string_agg(
   format(
    'Cuenta contable %s · %s · Banco %s · Cuenta bancaria %s: Mayor %s (local %s); Auxiliar %s (local %s); Diferencia %s (local %s).',
    coalesce(nullif(item->>'ledgerAccountNumber',''),'Sin cuenta'),
    coalesce(nullif(item->>'currency',''),'Sin moneda'),
    coalesce(nullif(concat_ws(' · ',nullif(item->>'bankCode',''),nullif(item->>'bankName','')),''),'Sin banco'),
    coalesce(nullif(item->>'accountNumber',''),'Sin cuenta bancaria'),
    coalesce(item->>'ledger','0'),coalesce(item->>'ledgerLocal','0'),
    coalesce(item->>'auxiliary','0'),coalesce(item->>'auxiliaryLocal','0'),
    coalesce(item->>'difference','0'),coalesce(item->>'localDifference','0')
   ),
   ' 'order by item->>'ledgerAccountNumber',item->>'currency'
  )into discrepancy_text
  from jsonb_array_elements(reconciliation)item
  where abs(coalesce((item->>'difference')::numeric,0))>=.005
     or abs(coalesce((item->>'localDifference')::numeric,0))>=.005;

  raise exception using
   message='El Auxiliar de Bancos no coincide con el Libro Mayor. '
    ||coalesce(discrepancy_text,'No fue posible identificar la cuenta con diferencia.'),
   detail=reconciliation::text,
   hint='Revise en el Libro Mayor y en el Auxiliar de Bancos los importes de la cuenta y moneda indicadas.';
 end if;
end
$$;

revoke all on function public.opening_bank_assert_reconciled(bigint)
 from public,anon,authenticated;

do $$
begin
 if to_regprocedure('public.opening_balance_validate_before_bank_preview_details(jsonb)')is null then
  alter function public.opening_balance_validate(jsonb)
   rename to opening_balance_validate_before_bank_preview_details;
 end if;
end
$$;

revoke all on function public.opening_balance_validate_before_bank_preview_details(jsonb)
 from public,anon,authenticated;

create or replace function public.opening_balance_validate(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path=public,pg_temp
as $$
declare result jsonb;
begin
 perform set_config('app.opening_bank_validation_preview','1',true);
 result:=public.opening_balance_validate_before_bank_preview_details(p);
 perform set_config('app.opening_bank_validation_preview','',true);
 return result;
exception when others then
 perform set_config('app.opening_bank_validation_preview','',true);
 raise;
end
$$;

revoke all on function public.opening_balance_validate(jsonb)from public,anon;
grant execute on function public.opening_balance_validate(jsonb)to authenticated;

notify pgrst,'reload schema';
