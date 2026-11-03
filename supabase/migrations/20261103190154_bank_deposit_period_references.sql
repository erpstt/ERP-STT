-- Deposits use period references authorized by their own banking permission.
-- Fiscal catalog maintenance permissions and all posting guards remain unchanged.
set local lock_timeout='5s';
set local statement_timeout='30s';

create or replace function public.bank_deposit_options()
returns jsonb language plpgsql stable security definer
set search_path=pg_catalog,public,pg_temp as $$
declare sid bigint;
begin
 sid:=bank_deposit_private.assert_access('view');
 return bank_deposit_private.bank_deposit_options()||jsonb_build_object(
  'periods',coalesce((
   select jsonb_agg(jsonb_build_object(
    'fiscal_period_id',p.fiscal_period_id,
    'period_name',p.period_name,
    'subsidiary_id',p.subsidiary_id,
    'start_date',p.start_date,
    'end_date',p.end_date,
    'is_closed',p.is_closed,
    'gl_closed',p.gl_closed,
    'is_inactive',p.is_inactive
   )order by p.start_date,p.fiscal_period_id)
   from public.fiscal_periods p where p.subsidiary_id=sid
  ),'[]'::jsonb)
 );
end$$;

revoke all on function public.bank_deposit_options() from public,anon,authenticated,service_role;
grant execute on function public.bank_deposit_options() to authenticated;
notify pgrst,'reload schema';
