-- Advisory UI metadata only. Actual writers retain their existing locked guards.
set local lock_timeout='5s';
set local statement_timeout='60s';
create schema banking_action_private;
revoke all on schema banking_action_private from public,anon,authenticated,service_role;

create function banking_action_private.annotate_report(p_report jsonb,p_kind text)
returns jsonb language plpgsql stable security invoker set search_path=pg_catalog,public,pg_temp as $$
declare sid bigint:=public.active_subsidiary_id();resource text;result_rows jsonb;can_edit boolean;can_delete boolean;
begin
 resource:=case p_kind when 'check' then 'banking:bank-checks' when 'deposit' then 'banking:bank-deposits'
  when 'fee' then 'banking:bank-fees' when 'transfer' then 'banking:bank-transfers' end;
 if resource is null then raise exception using errcode='22023',message='Tipo de operación bancaria inválido.';end if;
 can_edit:=p_kind<>'transfer' and public.security_resource_allowed(resource,'edit');
 can_delete:=p_kind<>'transfer' and public.security_resource_allowed(resource,'delete');
 -- Parse only the already-authorized report rows; no additional rows are exposed.
 with source_rows as materialized(
  select value row,ordinality ord,(value->>case when p_kind='deposit' then 'depositId' else 'id' end)::bigint id
  from jsonb_array_elements(coalesce(p_report->'rows','[]'::jsonb))with ordinality
 ),eligible as(
  select h.check_id id from source_rows s join public.bank_check h on h.check_id=s.id
   join public.journal j on j.journal_id=h.journal_id join public."transaction" t on t.transaction_id=j.transaction_id
   join public.bank_account b on b.bank_account_id=h.bank_account_id
   join public.fiscal_periods f on f.fiscal_period_id=h.fiscal_period_id
  where p_kind='check' and h.subsidiary_id=sid and j.subsidiary_id=sid and t.subsidiary_id=sid and b.subsidiary_id=sid
   and t.transaction_id=h.transaction_id and exists(select 1 from public.transaction_types tt where tt.transaction_type_id=t.transaction_type_id and tt.abbreviation='CHQ_TRF')
   and j.status='CONTABILIZADO' and j.journal_type=h.payment_type and h.status='APROBADA' and j.journal_number=h.check_number and t.tran_number=h.check_number
   and j.fiscal_period_id=h.fiscal_period_id and t.fiscal_period_id=h.fiscal_period_id
   and j.currency_id=h.currency_id and t.currency_id=h.currency_id and b.currency_id=h.currency_id
   and j.journal_date=h.payment_date and t.tran_date=h.payment_date and t.total_amount=h.amount and h.amount>0 and h.amount::text not in('NaN','Infinity','-Infinity')
   and not exists(select 1 from public.bank_check other where other.check_id<>h.check_id and(other.journal_id=h.journal_id or other.transaction_id=h.transaction_id))
   and f.subsidiary_id=sid and not coalesce(f.is_closed,false) and not coalesce(f.gl_closed,false) and not coalesce(f.is_inactive,false)
   and(select count(*)from public.bank_transaction bt where bt.transaction_id=h.transaction_id)=1
   and not exists(select 1 from public.bank_transaction bt where bt.transaction_id=h.transaction_id and(bt.bank_account_id is distinct from h.bank_account_id
    or bt.tran_type is distinct from h.payment_type or bt.amount is distinct from -h.amount or bt.tran_date is distinct from h.payment_date or bt.reconciliation_status is distinct from 'PENDIENTE_EN_TRANSITO'))
   and not exists(select 1 from public.bank_reconciliation r where r.bank_account_id=h.bank_account_id and r.status='CERRADA' and r.reconciliation_date>=h.payment_date)
  union all
  select h.deposit_id from source_rows s join public.bank_deposit h on h.deposit_id=s.id
   join public.journal j on j.journal_id=h.journal_id join public."transaction" t on t.transaction_id=j.transaction_id
   join public.bank_account b on b.bank_account_id=h.bank_account_id
   join public.fiscal_periods f on f.fiscal_period_id=h.fiscal_period_id
  where p_kind='deposit' and h.subsidiary_id=sid and j.subsidiary_id=sid and t.subsidiary_id=sid and b.subsidiary_id=sid
   and exists(select 1 from public.transaction_types tt where tt.transaction_type_id=t.transaction_type_id and tt.abbreviation='DEP_BAN') and j.status='CONTABILIZADO'
   and j.journal_number=h.deposit_number and t.tran_number=h.deposit_number and j.fiscal_period_id=h.fiscal_period_id and t.fiscal_period_id=h.fiscal_period_id
   and f.subsidiary_id=sid and not coalesce(f.is_closed,false) and not coalesce(f.gl_closed,false) and not coalesce(f.is_inactive,false)
   and(select count(*)from public.bank_transaction bt where bt.transaction_id=j.transaction_id and bt.tran_type='DEP_BAN')=1
   and not exists(select 1 from public.bank_transaction bt where bt.transaction_id=j.transaction_id and bt.tran_type='DEP_BAN' and(bt.bank_account_id is distinct from h.bank_account_id
    or bt.amount is distinct from h.total_amount or bt.tran_date is distinct from h.deposit_date or bt.reconciliation_status is distinct from 'PENDIENTE_EN_TRANSITO'))
   and not exists(select 1 from public.bank_reconciliation r where r.bank_account_id=h.bank_account_id and r.status='CERRADA' and r.reconciliation_date>=h.deposit_date)
  union all
  select h.fee_id from source_rows s join public.bank_fee h on h.fee_id=s.id
   join public.journal j on j.journal_id=h.journal_id join public."transaction" t on t.transaction_id=j.transaction_id
   join public.bank_account b on b.bank_account_id=h.bank_account_id
   join public.fiscal_periods f on f.fiscal_period_id=h.fiscal_period_id
  where p_kind='fee' and h.subsidiary_id=sid and j.subsidiary_id=sid and t.subsidiary_id=sid and b.subsidiary_id=sid and t.transaction_id=h.transaction_id
   and exists(select 1 from public.transaction_types tt where tt.transaction_type_id=t.transaction_type_id and tt.abbreviation='COM_BAN')
   and j.status='CONTABILIZADO' and j.journal_type='Comisiones bancarias' and j.journal_number=h.fee_number and t.tran_number=h.fee_number
   and j.fiscal_period_id=h.fiscal_period_id and t.fiscal_period_id=h.fiscal_period_id and j.currency_id=h.currency_id and t.currency_id=h.currency_id and b.currency_id=h.currency_id
   and j.journal_date=h.fee_date and t.tran_date=h.fee_date and t.total_amount=h.amount and h.amount>0 and h.amount::text not in('NaN','Infinity','-Infinity')
   and not exists(select 1 from public.bank_fee other where other.fee_id<>h.fee_id and(other.journal_id=h.journal_id or other.transaction_id=h.transaction_id))
   and f.subsidiary_id=sid and not coalesce(f.is_closed,false) and not coalesce(f.gl_closed,false) and not coalesce(f.is_inactive,false)
   and(select count(*)from public.bank_transaction bt where bt.transaction_id=h.transaction_id)=1
   and not exists(select 1 from public.bank_transaction bt where bt.transaction_id=h.transaction_id and(bt.bank_account_id is distinct from h.bank_account_id
    or bt.amount is distinct from -h.amount or bt.tran_type is distinct from 'COM_BAN' or bt.tran_date is distinct from h.fee_date or bt.reconciliation_status is distinct from 'PENDIENTE_EN_TRANSITO'
    or exists(select 1 from public.bank_reconciliation_match m where m.bank_tran_id=bt.bank_tran_id)))
   and not exists(select 1 from public.bank_reconciliation r where r.bank_account_id=h.bank_account_id and r.status='CERRADA' and r.reconciliation_date>=h.fee_date)
 )select coalesce(jsonb_agg(s.row||jsonb_build_object('_actions',jsonb_build_object('canEdit',can_edit and e.id is not null,'canDelete',can_delete and e.id is not null))order by s.ord),'[]'::jsonb)
 into result_rows from source_rows s left join eligible e on e.id=s.id;
 return jsonb_set(p_report,'{rows}',result_rows);
end$$;
revoke all on function banking_action_private.annotate_report(jsonb,text)from public,anon,authenticated,service_role;

do $bank_actions$
declare item record;target regprocedure;definition text;needle text;replacement text;
begin
 for item in select * from(values
  ('check','bank-checks','bank_check','ac1607415b41a45a835dfe00ac0d032b','ab33363e6b30f5a6a202145b02782832'),
  ('deposit','bank-deposits','bank_deposit','dc6c178789de1c8689d7ba000b25ec85','35da16c8bb429af62ebf79c20d76f77d'),
  ('fee','bank-fees','bank_fee','170c54779cd8d6e8471f94794f27a886','86fff44116b9d3745630af7e6dbecab8'),
  ('transfer','bank-transfers','bank_transfer','13d6e043d5449a6c0c7c9398782fb7c9','89e50347efd5aad52418c14d5c401c77')
 )v(kind,resource,stem,options_md5,report_md5)loop
  target:=('public.'||item.stem||'_options()')::regprocedure;
  if md5((select prosrc from pg_proc where oid=target))is distinct from item.options_md5 then raise exception 'Reviewed banking % options changed.',item.kind;end if;
  definition:=pg_get_functiondef(target);needle:='return '||item.stem||'_private.'||item.stem||'_options()';
  replacement:='return '||item.stem||'_private.'||item.stem||'_options()||jsonb_build_object(''access'',jsonb_build_object(''canView'',public.security_resource_allowed(''banking:'||item.resource||''',''view''),''canCreate'',public.security_resource_allowed(''banking:'||item.resource||''',''create''),''canEdit'','||case when item.kind='transfer' then 'false' else 'public.security_resource_allowed(''banking:'||item.resource||''',''edit'')' end||',''canDelete'','||case when item.kind='transfer' then 'false' else 'public.security_resource_allowed(''banking:'||item.resource||''',''delete'')'end||'))';
  if item.kind='check'then
   -- Keep the existing owned-location default; otherwise use an explicitly
   -- shared location that the same protected validator permits.
   replacement:=replacement||$shared$||jsonb_build_object('location',(
    select jsonb_build_object('id',l.location_id,'name',l.name)from public.locations l
    where l.subsidiary_id=public.active_subsidiary_id()or exists(select 1 from public.location_subsidiaries ls where ls.location_id=l.location_id and ls.subsidiary_id=public.active_subsidiary_id())
    order by case when l.subsidiary_id=public.active_subsidiary_id()then 0 else 1 end,l.location_id limit 1
   ))$shared$;
  end if;
  if(length(definition)-length(replace(definition,needle,'')))/length(needle)<>1 then raise exception 'Unexpected banking % options wrapper.',item.kind;end if;
  execute replace(definition,needle,replacement);
  target:=('public.'||case when item.kind='transfer' then 'run_bank_transfer' else item.stem end||'_report(jsonb)')::regprocedure;
  if md5((select prosrc from pg_proc where oid=target))is distinct from item.report_md5 then raise exception 'Reviewed banking % report changed.',item.kind;end if;
  definition:=pg_get_functiondef(target);needle:='return '||item.stem||'_private.'||case when item.kind='transfer' then 'run_bank_transfer' else item.stem end||'_report(p_filters);';
  replacement:='return banking_action_private.annotate_report('||item.stem||'_private.'||case when item.kind='transfer' then 'run_bank_transfer' else item.stem end||'_report(p_filters),'''||item.kind||''');';
  if(length(definition)-length(replace(definition,needle,'')))/length(needle)<>1 then raise exception 'Unexpected banking % report wrapper.',item.kind;end if;
  execute replace(definition,needle,replacement);
 end loop;
end$bank_actions$;
