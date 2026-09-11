do $$
declare parent_key bigint;group_key bigint;account_key bigint;
begin
 select group_id into parent_key from account_group where group_code='310';
 if parent_key is null then raise exception'No existe el grupo padre 310 - Capital.';end if;
 insert into account_group(group_code,group_name,level,parent_id,nature,financial_statement,category,full_ifrs_only,pending_fx_revaluation,is_inactive)
 values('319','Saldos Iniciales y Cuentas Transitorias',3,parent_key,'Acreedora','Balance General','Patrimonio',false,false,false)
 on conflict(group_code)do update set group_name=excluded.group_name,level=excluded.level,parent_id=excluded.parent_id,nature=excluded.nature,financial_statement=excluded.financial_statement,category=excluded.category,full_ifrs_only=false,pending_fx_revaluation=false,is_inactive=false
 returning group_id into group_key;
 select account_id into account_key from chart_accounts where account_number='319999';
 if account_key is null then
  insert into chart_accounts(account_number,account_name,account_type,account_group_id,level,nature,financial_statement,category,accepts_entries,full_ifrs_only,pending_fx_revaluation,is_summary,is_inactive,cash_flow_activity)
  values('temporal','Saldos Iniciales Transitorios','Patrimonio',group_key,4,'Acreedora','Balance General','Patrimonio',true,false,false,false,false,'NO_APLICA')returning account_id into account_key;
  update chart_accounts set account_number='319999'where account_id=account_key;
 else
  update chart_accounts set account_name='Saldos Iniciales Transitorios',account_type='Patrimonio',account_group_id=group_key,level=4,nature='Acreedora',financial_statement='Balance General',category='Patrimonio',accepts_entries=true,full_ifrs_only=false,pending_fx_revaluation=false,is_summary=false,is_inactive=false,cash_flow_activity='NO_APLICA'where account_id=account_key;
 end if;
 insert into account_subsidiaries(account_id,subsidiary_id,is_active)select account_key,subsidiary_id,true from subsidiaries where is_active on conflict(account_id,subsidiary_id)do update set is_active=true;
end$$;
notify pgrst,'reload schema';
