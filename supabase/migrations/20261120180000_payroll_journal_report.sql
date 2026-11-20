-- Read-only journal report: payroll/liquidation, group 223, no GL joins or duplication.
create function public.run_payroll_journal_report(p_filters jsonb default '{}') returns jsonb
language plpgsql stable security definer set search_path=pg_catalog,public,pg_temp as $$
declare sid bigint;uid bigint;df date;dt date;kind text;aid bigint;rows jsonb;accounts jsonb;company jsonb;begin
 perform public.security_assert_role_access('reports:accounting-reports','view');
 uid:=public.app_user_id();sid:=public.active_subsidiary_id();
 if uid is null or sid is null or not exists(select 1 from public.users u join public.user_subsidiaries s using(user_id) where u.user_id=uid and u.is_active and s.subsidiary_id=sid) then raise exception using errcode='42501',message='La subsidiaria activa no está autorizada.';end if;
 if jsonb_typeof(p_filters) is distinct from 'object' or exists(select 1 from jsonb_object_keys(p_filters) k where k not in('dateFrom','dateTo','transactionType','accountId','noteMode')) then raise exception using errcode='22023',message='Filtros inválidos.';end if;
 if coalesce(p_filters->>'dateFrom','')!~'^[0-9]{4}-[0-9]{2}-[0-9]{2}$' or coalesce(p_filters->>'dateTo','')!~'^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then raise exception using errcode='22023',message='Seleccione un rango de fechas válido.';end if;
 if coalesce(p_filters->>'noteMode','HEADER') not in('LINE','HEADER') then raise exception using errcode='22023',message='Agrupacion invalida.';end if;
 df:=(p_filters->>'dateFrom')::date;dt:=(p_filters->>'dateTo')::date;
 if df>dt or date_trunc('month',df)<>date_trunc('month',dt) then raise exception using errcode='22023',message='Seleccione fechas ordenadas dentro del mismo mes.';end if;
 kind:=coalesce(p_filters->>'transactionType','ALL');
 if kind not in('ALL','ASI_NOM','ASI_LIQ') then raise exception using errcode='22023',message='Seleccione nómina, liquidación o ambos tipos.';end if;
 if nullif(p_filters->>'accountId','') is not null then
  if p_filters->>'accountId'!~'^[1-9][0-9]{0,18}$' then raise exception using errcode='22023',message='Cuenta inválida.';end if;aid:=(p_filters->>'accountId')::bigint;
 end if;
 with recursive g as(select group_id from public.account_group where group_code='223' union select x.group_id from public.account_group x join g on x.parent_id=g.group_id)
 select coalesce(jsonb_agg(jsonb_build_object('id',a.account_id,'number',a.account_number,'name',a.account_name) order by a.account_number),'[]') into accounts from public.chart_accounts a
 where a.account_group_id in(select group_id from g) and (exists(select 1 from public.account_subsidiaries s where s.account_id=a.account_id and s.subsidiary_id=sid) or exists(select 1 from public.journal_line l join public.journal j using(journal_id) where l.account_id=a.account_id and j.subsidiary_id=sid));
 if aid is not null and not exists(select 1 from jsonb_array_elements(accounts) x where (x->>'id')::bigint=aid) then raise exception using errcode='42501',message='Cuenta fuera del grupo o subsidiaria.';end if;
 if exists(select 1 from public.journal j join public.journal_line l using(journal_id) join public."transaction" t on t.transaction_id=j.transaction_id and t.subsidiary_id=sid join public.transaction_types tt using(transaction_type_id)
  where j.subsidiary_id=sid and j.status='CONTABILIZADO' and j.journal_date between df and dt and tt.abbreviation in('ASI_NOM','ASI_LIQ') and(kind='ALL' or tt.abbreviation=kind)
  and l.account_id in(select (x->>'id')::bigint from jsonb_array_elements(accounts)x) and(aid is null or l.account_id=aid)
  and(j.exchange_rate is null or j.exchange_rate<=0 or j.exchange_rate::text in('NaN','Infinity','-Infinity') or l.debit is null or l.credit is null or l.debit::text in('NaN','Infinity','-Infinity') or l.credit::text in('NaN','Infinity','-Infinity'))) then raise exception using errcode='55000',message='Existen asientos con importes o tipo de cambio inválidos.';end if;
 with detail as(
  select a.account_id,a.account_number,a.account_name,j.journal_id,j.journal_number,j.journal_date,tt.abbreviation,
   case when coalesce(p_filters->>'noteMode','HEADER')='HEADER' then coalesce(nullif(btrim(j.memo),''),'Sin nota del asiento') else coalesce(nullif(btrim(l.note),''),nullif(btrim(j.memo),''),'Sin nota') end note,l.department_id,coalesce(d.name,'Sin departamento') department,
   j.currency_id,cu.currency_code,sum(l.debit) debit_original,sum(l.credit) credit_original,
   sum(round(l.debit*j.exchange_rate,6)) debit,sum(round(l.credit*j.exchange_rate,6)) credit
  from public.journal j join public.journal_line l using(journal_id) join public.chart_accounts a using(account_id)
  join public."transaction" t on t.transaction_id=j.transaction_id and t.subsidiary_id=sid
  join public.transaction_types tt using(transaction_type_id) left join public.departments d on d.department_id=l.department_id left join public.currencies cu on cu.currency_id=j.currency_id
  where j.subsidiary_id=sid and j.status='CONTABILIZADO' and j.journal_date between df and dt
  and tt.abbreviation in('ASI_NOM','ASI_LIQ') and(kind='ALL' or tt.abbreviation=kind)
  and a.account_id in(select (x->>'id')::bigint from jsonb_array_elements(accounts)x) and(aid is null or a.account_id=aid)
  group by a.account_id,a.account_number,a.account_name,j.journal_id,j.journal_number,j.journal_date,tt.abbreviation,j.memo,case when coalesce(p_filters->>'noteMode','HEADER')='HEADER' then coalesce(nullif(btrim(j.memo),''),'Sin nota del asiento') else coalesce(nullif(btrim(l.note),''),nullif(btrim(j.memo),''),'Sin nota') end,l.department_id,d.name,j.currency_id,cu.currency_code
 ) select coalesce(jsonb_agg(jsonb_build_object('accountId',account_id,'accountNumber',account_number,'accountName',account_name,'journalId',journal_id,'journalNumber',journal_number,'date',journal_date,'type',abbreviation,'note',note,'departmentId',department_id,'department',department,'currencyId',currency_id,'currency',currency_code,'debit',debit,'credit',credit,'net',credit-debit,'debitOriginal',debit_original,'creditOriginal',credit_original,'netOriginal',credit_original-debit_original) order by account_number,note,journal_date,journal_number,journal_id,department,department_id),'[]') into rows from detail;
 if jsonb_array_length(rows)>10000 then raise exception using errcode='22023',message='El resultado supera 10000 filas. Reduzca las fechas o seleccione una cuenta.';end if;
 select jsonb_build_object('id',s.subsidiary_id,'name',s.name,'currency',c.currency_code) into company from public.subsidiaries s join public.currencies c using(currency_id) where s.subsidiary_id=sid;
 return jsonb_build_object('subsidiary',company,'group','223','filters',p_filters||jsonb_build_object('noteMode',coalesce(p_filters->>'noteMode','HEADER'),'transactionType',kind),'accounts',accounts,'rows',rows,'netDefinition','Haber menos Debe',
 'total',(select coalesce(sum((x->>'net')::numeric),0) from jsonb_array_elements(rows)x));
end$$;
revoke all on function public.run_payroll_journal_report(jsonb) from public,anon,authenticated,service_role;
grant execute on function public.run_payroll_journal_report(jsonb) to authenticated;
notify pgrst,'reload schema';
