-- El catálogo contable se consulta como una sola estructura agregada. Esto evita
-- paginar toda la matriz cuenta x subsidiaria y evaluar RLS miles de veces.

create index if not exists account_subsidiaries_active_account_subsidiary_idx
  on public.account_subsidiaries(account_id,subsidiary_id)
  where is_active;

create index if not exists account_subsidiaries_active_subsidiary_account_idx
  on public.account_subsidiaries(subsidiary_id,account_id)
  where is_active;

create index if not exists chart_accounts_group_account_idx
  on public.chart_accounts(account_group_id,account_id);

create index if not exists user_subsidiaries_subsidiary_user_idx
  on public.user_subsidiaries(subsidiary_id,user_id);

-- Estado inicial solicitado: todas las cuentas, incluso las históricas, quedan
-- disponibles en todas las subsidiarias. El RPC definido por esta migración
-- funciona también como marcador: si el archivo se ejecuta manualmente otra
-- vez, conserva las selecciones que el administrador ya haya realizado.
do $$
begin
  if to_regprocedure('public.save_chart_account_catalog(bigint,jsonb,bigint[])') is null then
    insert into public.account_subsidiaries(account_id,subsidiary_id,is_active)
    select account.account_id,subsidiary.subsidiary_id,true
      from public.chart_accounts account
     cross join public.subsidiaries subsidiary
    on conflict(account_id,subsidiary_id)
    do update set is_active=true;
  end if;
end
$$;

-- Varias migraciones históricas dejaron políticas permisivas duplicadas. Como
-- PostgreSQL las combina con OR, cada fila ejecutaba varias veces funciones de
-- sesión y administración. La tabla de relación queda de lectura directa; toda
-- escritura pasa por los RPC validados o por sus triggers SECURITY DEFINER.
do $$
declare
  policy record;
begin
  for policy in
    select policyname
      from pg_policies
     where schemaname='public'
       and tablename='account_subsidiaries'
  loop
    execute format('drop policy %I on public.account_subsidiaries',policy.policyname);
  end loop;
end
$$;

create policy account_subsidiaries_select
on public.account_subsidiaries
for select to authenticated
using (
  (select coalesce(public.app_is_admin(),false))
  or account_subsidiaries.subsidiary_id in (
    select access.subsidiary_id
      from public.user_subsidiaries access
     where access.user_id=(select public.app_user_id())
  )
);

-- El Plan de Cuentas es global y consultable por usuarios autenticados, pero
-- sus escrituras directas ya no quedan abiertas a cualquier usuario. El RPC
-- atómico aplica además las validaciones de grupo y alcance por subsidiaria.
do $$
declare
  policy record;
begin
  for policy in
    select policyname
      from pg_policies
     where schemaname='public'
       and tablename='chart_accounts'
  loop
    execute format('drop policy %I on public.chart_accounts',policy.policyname);
  end loop;
end
$$;

create policy chart_accounts_authenticated_select
on public.chart_accounts
for select to authenticated
using (true);

create policy chart_accounts_admin_insert
on public.chart_accounts
for insert to authenticated
with check ((select coalesce(public.app_is_admin(),false)));

create policy chart_accounts_admin_update
on public.chart_accounts
for update to authenticated
using ((select coalesce(public.app_is_admin(),false)))
with check ((select coalesce(public.app_is_admin(),false)));

create policy chart_accounts_admin_delete
on public.chart_accounts
for delete to authenticated
using ((select coalesce(public.app_is_admin(),false)));

create or replace function public.chart_accounts_catalog()
returns jsonb
language plpgsql
stable
security definer
set search_path=public,pg_temp
as $$
declare
  current_user_id bigint:=public.app_user_id();
  can_access_all boolean;
  result jsonb;
begin
  if current_user_id is null then
    raise exception using errcode='42501',message='Debe iniciar sesión para consultar el Plan de Cuentas.';
  end if;

  can_access_all:=coalesce(public.app_is_admin(),false);

  with allowed_subsidiaries as (
    select subsidiary.subsidiary_id
      from public.subsidiaries subsidiary
     where can_access_all
        or exists(
          select 1
            from public.user_subsidiaries access
           where access.user_id=current_user_id
             and access.subsidiary_id=subsidiary.subsidiary_id
        )
  ), assignments as (
    select assignment.account_id,
           array_agg(assignment.subsidiary_id order by assignment.subsidiary_id) as subsidiary_ids
      from public.account_subsidiaries assignment
      join allowed_subsidiaries allowed using(subsidiary_id)
     where assignment.is_active
     group by assignment.account_id
  )
  select coalesce(
    jsonb_agg(
      to_jsonb(account)
      || jsonb_build_object(
        'account_group_code',account_group.group_code,
        'account_group_name',account_group.group_name,
        'subsidiary_ids',coalesce(to_jsonb(assignments.subsidiary_ids),'[]'::jsonb)
      )
      order by account.account_id
    ),
    '[]'::jsonb
  )
    into result
    from public.chart_accounts account
    left join public.account_group account_group
      on account_group.group_id=account.account_group_id
    left join assignments
      on assignments.account_id=account.account_id;

  return result;
end
$$;

revoke all on function public.chart_accounts_catalog() from public,anon;
grant execute on function public.chart_accounts_catalog() to authenticated;

create or replace function public.save_chart_account_subsidiaries(
  p_account_id bigint,
  p_subsidiary_ids bigint[]
)
returns bigint[]
language plpgsql
security definer
set search_path=public,pg_temp
as $$
declare
  current_user_id bigint:=public.app_user_id();
  allowed_ids bigint[];
  selected_ids bigint[];
  saved_ids bigint[];
begin
  if current_user_id is null then
    raise exception using errcode='42501',message='Debe iniciar sesión para modificar el Plan de Cuentas.';
  end if;

  if not coalesce(public.app_is_admin(),false) then
    raise exception using errcode='42501',message='Solo un administrador puede asignar subsidiarias a una cuenta contable.';
  end if;

  perform 1
    from public.chart_accounts
   where account_id=p_account_id
   for update;
  if not found then
    raise exception using errcode='P0002',message='La cuenta contable no existe.';
  end if;

  select coalesce(array_agg(distinct selected_id order by selected_id),'{}'::bigint[])
    into selected_ids
    from unnest(coalesce(p_subsidiary_ids,'{}'::bigint[])) selected_id
   where selected_id is not null;

  if cardinality(selected_ids)=0 then
    raise exception using errcode='23514',message='Seleccione al menos una subsidiaria para la cuenta contable.';
  end if;

  select coalesce(array_agg(subsidiary.subsidiary_id order by subsidiary.subsidiary_id),'{}'::bigint[])
    into allowed_ids
    from public.subsidiaries subsidiary;

  if exists(
    select 1
      from unnest(selected_ids) selected_id
     where not selected_id=any(allowed_ids)
  ) then
    raise exception using errcode='42501',message='Una o más subsidiarias no están autorizadas para el usuario.';
  end if;

  -- La ausencia física es la fuente de verdad para una cuenta no habilitada.
  -- Esto mantiene compatibles las consultas históricas que verifican la
  -- relación pero que no filtraban explícitamente por is_active.
  delete from public.account_subsidiaries assignment
   where assignment.account_id=p_account_id
     and not assignment.subsidiary_id=any(selected_ids);

  insert into public.account_subsidiaries(account_id,subsidiary_id,is_active)
  select p_account_id,selected_id,true
    from unnest(selected_ids) selected_id
  on conflict(account_id,subsidiary_id)
  do update set is_active=true;

  select coalesce(array_agg(assignment.subsidiary_id order by assignment.subsidiary_id),'{}'::bigint[])
    into saved_ids
    from public.account_subsidiaries assignment
   where assignment.account_id=p_account_id
     and assignment.is_active
     and assignment.subsidiary_id=any(allowed_ids);

  return saved_ids;
end
$$;

revoke all on function public.save_chart_account_subsidiaries(bigint,bigint[]) from public,anon;
grant execute on function public.save_chart_account_subsidiaries(bigint,bigint[]) to authenticated;

-- Alta y edición atómicas: la cuenta y su alcance se confirman juntas. En un
-- error de validación no queda una cuenta huérfana ni una asignación parcial.
create or replace function public.save_chart_account_catalog(
  p_account_id bigint,
  p_payload jsonb,
  p_subsidiary_ids bigint[]
)
returns jsonb
language plpgsql
security definer
set search_path=public,pg_temp
as $$
declare
  current_user_id bigint:=public.app_user_id();
  account_group public.account_group%rowtype;
  existing_account public.chart_accounts%rowtype;
  account_record public.chart_accounts%rowtype;
  selected_ids bigint[];
  saved_ids bigint[];
  account_name_value text:=nullif(trim(p_payload->>'account_name'),'');
  group_id_value bigint:=nullif(p_payload->>'account_group_id','')::bigint;
  nature_value text:=nullif(p_payload->>'nature','');
  financial_statement_value text:=nullif(p_payload->>'financial_statement','');
  category_value text:=nullif(p_payload->>'category','');
  accepts_entries_value boolean:=case when p_payload ? 'accepts_entries' then nullif(p_payload->>'accepts_entries','')::boolean end;
  full_ifrs_value boolean:=case when p_payload ? 'full_ifrs_only' then coalesce(nullif(p_payload->>'full_ifrs_only','')::boolean,false) end;
  pending_fx_value boolean:=case when p_payload ? 'pending_fx_revaluation' then coalesce(nullif(p_payload->>'pending_fx_revaluation','')::boolean,false) end;
  cash_flow_value text:=nullif(p_payload->>'cash_flow_activity','');
  inactive_value boolean:=case when p_payload ? 'is_inactive' then coalesce(nullif(p_payload->>'is_inactive','')::boolean,false) end;
  payment_request_value boolean:=case when p_payload ? 'payment_request_enabled' then coalesce(nullif(p_payload->>'payment_request_enabled','')::boolean,false) end;
begin
  if current_user_id is null then
    raise exception using errcode='42501',message='Debe iniciar sesión para modificar el Plan de Cuentas.';
  end if;
  if not coalesce(public.app_is_admin(),false) then
    raise exception using errcode='42501',message='Solo un administrador puede modificar el Plan de Cuentas.';
  end if;

  if account_name_value is null then
    raise exception using errcode='23514',message='El nombre de la cuenta es obligatorio.';
  end if;
  if group_id_value is null then
    raise exception using errcode='23514',message='Seleccione un grupo de cuentas.';
  end if;
  select *
    into account_group
    from public.account_group
   where group_id=group_id_value;
  if not found then
    raise exception using errcode='23503',message='El grupo de cuentas seleccionado no existe.';
  end if;

  if p_account_id is not null then
    select *
      into existing_account
      from public.chart_accounts
     where account_id=p_account_id
     for update;
    if not found then
      raise exception using errcode='P0002',message='La cuenta contable no existe.';
    end if;
  end if;

  nature_value:=coalesce(nature_value,existing_account.nature,account_group.nature);
  financial_statement_value:=coalesce(financial_statement_value,existing_account.financial_statement,account_group.financial_statement);
  category_value:=coalesce(category_value,existing_account.category,account_group.category);
  accepts_entries_value:=coalesce(accepts_entries_value,existing_account.accepts_entries,true);
  full_ifrs_value:=coalesce(full_ifrs_value,existing_account.full_ifrs_only,account_group.full_ifrs_only,false);
  cash_flow_value:=coalesce(cash_flow_value,existing_account.cash_flow_activity,'NO_APLICA');
  inactive_value:=coalesce(inactive_value,existing_account.is_inactive,false);
  payment_request_value:=category_value in('Costo','Gasto')
    and coalesce(payment_request_value,existing_account.payment_request_enabled,false);
  pending_fx_value:=case when category_value in('Activo','Pasivo')
    then coalesce(pending_fx_value,existing_account.pending_fx_revaluation,account_group.pending_fx_revaluation,false)
    else false end;

  if nature_value not in('Deudora','Acreedora') then
    raise exception using errcode='23514',message='La naturaleza contable no es válida.';
  end if;
  if financial_statement_value not in('Balance General','Estado de Resultados') then
    raise exception using errcode='23514',message='El estado financiero no es válido.';
  end if;
  if category_value not in('Activo','Pasivo','Patrimonio','Ingreso','Costo','Gasto') then
    raise exception using errcode='23514',message='La categoría contable no es válida.';
  end if;
  if not accepts_entries_value then
    raise exception using errcode='23514',message='Las cuentas del Plan de Cuentas deben recibir movimientos.';
  end if;
  if cash_flow_value not in('OPERACION','INVERSION','FINANCIACION','EFECTIVO_EQUIVALENTE','NO_APLICA') then
    raise exception using errcode='23514',message='El tipo de actividad de flujo no es válido.';
  end if;

  select coalesce(array_agg(distinct selected_id order by selected_id),'{}'::bigint[])
    into selected_ids
    from unnest(coalesce(p_subsidiary_ids,'{}'::bigint[])) selected_id
   where selected_id is not null;
  if cardinality(selected_ids)=0 then
    raise exception using errcode='23514',message='Seleccione al menos una subsidiaria para la cuenta contable.';
  end if;
  if exists(
    select 1
      from unnest(selected_ids) selected_id
     where not exists(
       select 1 from public.subsidiaries subsidiary
        where subsidiary.subsidiary_id=selected_id
     )
  ) then
    raise exception using errcode='23503',message='Una o más subsidiarias seleccionadas no existen.';
  end if;
  if p_account_id is null then
    insert into public.chart_accounts(
      account_group_id,account_name,level,nature,financial_statement,category,
      accepts_entries,payment_request_enabled,full_ifrs_only,
      pending_fx_revaluation,cash_flow_activity,is_inactive
    )
    values(
      account_group.group_id,account_name_value,4,nature_value,
      financial_statement_value,category_value,true,
      payment_request_value,full_ifrs_value,pending_fx_value,
      cash_flow_value,inactive_value
    )
    returning * into account_record;
  else
    update public.chart_accounts account
       set account_group_id=account_group.group_id,
           account_name=account_name_value,
           level=4,
           nature=nature_value,
           financial_statement=financial_statement_value,
           category=category_value,
           accepts_entries=true,
           payment_request_enabled=payment_request_value,
           full_ifrs_only=full_ifrs_value,
           pending_fx_revaluation=pending_fx_value,
           cash_flow_activity=cash_flow_value,
           is_inactive=inactive_value
     where account.account_id=p_account_id
     returning account.* into account_record;
    if not found then
      raise exception using errcode='P0002',message='La cuenta contable no existe.';
    end if;
  end if;

  saved_ids:=public.save_chart_account_subsidiaries(account_record.account_id,selected_ids);

  return to_jsonb(account_record)
    || jsonb_build_object(
      'account_group_code',account_group.group_code,
      'account_group_name',account_group.group_name,
      'subsidiary_ids',to_jsonb(saved_ids)
    );
end
$$;

revoke all on function public.save_chart_account_catalog(bigint,jsonb,bigint[]) from public,anon;
grant execute on function public.save_chart_account_catalog(bigint,jsonb,bigint[]) to authenticated;

-- Defensa central para cualquier flujo que genere líneas contables. Los
-- formularios filtran el catálogo, pero esta validación impide que un cliente
-- desactualizado o una llamada directa contabilice en una cuenta deshabilitada.
create or replace function public.account_enabled_for_subsidiary(
  p_account_id bigint,
  p_subsidiary_id bigint
)
returns boolean
language sql
stable
security definer
set search_path=public,pg_temp
as $$
  select exists(
    select 1
      from public.chart_accounts account
      join public.account_subsidiaries assignment using(account_id)
     where account.account_id=p_account_id
       and assignment.subsidiary_id=p_subsidiary_id
       and assignment.is_active
       and account.accepts_entries
       and not account.is_inactive
       and not coalesce(account.is_summary,false)
  )
$$;

revoke all on function public.account_enabled_for_subsidiary(bigint,bigint)
  from public,anon,authenticated;

-- Una desasignación posterior no debe impedir el extorno de un movimiento
-- histórico válido. La excepción queda limitada a asientos que enlazan de
-- forma explícita el asiento original y solamente a cuentas que realmente
-- estuvieron en sus líneas o en sus impactos de mayor.
create or replace function public.reversal_source_has_account(
  p_reversal_journal_id bigint,
  p_account_id bigint,
  p_subsidiary_id bigint
)
returns boolean
language sql
stable
security definer
set search_path=public,pg_temp
as $$
  select exists(
    select 1
      from public.journal reversal
      join public.journal source
        on source.journal_id=reversal.reversed_from_journal_id
     where reversal.journal_id=p_reversal_journal_id
       and reversal.reversed_from_journal_id is not null
       and reversal.journal_id<>source.journal_id
       and reversal.subsidiary_id=p_subsidiary_id
       and source.subsidiary_id=p_subsidiary_id
       and (
         exists(
           select 1
             from public.journal_line source_line
            where source_line.journal_id=source.journal_id
              and source_line.account_id=p_account_id
         )
         or (
           source.transaction_id is not null
           and exists(
             select 1
               from public.gl_impact source_impact
              where source_impact.transaction_id=source.transaction_id
                and source_impact.subsidiary_id=p_subsidiary_id
                and source_impact.account_id=p_account_id
           )
         )
       )
  )
$$;

revoke all on function public.reversal_source_has_account(bigint,bigint,bigint)
  from public,anon,authenticated;

create or replace function public.validate_journal_line_account_scope()
returns trigger
language plpgsql
security definer
set search_path=public,pg_temp
as $$
declare
  subsidiary_key bigint;
  effective_tax_rate numeric;
  tax_account_key bigint;
begin
  select entry.subsidiary_id
    into subsidiary_key
    from public.journal entry
   where entry.journal_id=new.journal_id;

  if subsidiary_key is null then
    raise exception using
      errcode='23503',
      message='El asiento contable no existe o no tiene una subsidiaria válida.';
  end if;

  if not public.account_enabled_for_subsidiary(new.account_id,subsidiary_key)
     and not public.reversal_source_has_account(
       new.journal_id,new.account_id,subsidiary_key
     ) then
    raise exception using
      errcode='23514',
      message=format(
        'La cuenta contable %s no está activa y habilitada para la subsidiaria %s.',
        new.account_id,subsidiary_key
      );
  end if;

  -- sync_journal_gl_impacts genera la contrapartida fiscal a partir de estos
  -- campos. Validarla aquí evita que el impacto fiscal eluda el alcance de la
  -- cuenta aunque no exista como una segunda journal_line.
  if new.tax_code_id is not null
     and coalesce(new.note,'') not like 'Retención %' then
    select coalesce(new.tax_rate,tax_code.rate_percentage,0),
           case when new.debit>0
             then tax_type.asset_account_id
             else tax_type.liability_account_id
           end
      into effective_tax_rate,tax_account_key
      from public.tax_codes tax_code
      join public.tax_types tax_type using(tax_type_id)
     where tax_code.tax_code_id=new.tax_code_id;

    if found and effective_tax_rate>0 then
      if tax_account_key is null then
        raise exception using
          errcode='23514',
          message='El tipo de impuesto seleccionado no tiene configurada la cuenta contable correspondiente.';
      end if;
      if not public.account_enabled_for_subsidiary(tax_account_key,subsidiary_key)
         and not public.reversal_source_has_account(
           new.journal_id,tax_account_key,subsidiary_key
         ) then
        raise exception using
          errcode='23514',
          message=format(
            'La cuenta contable del impuesto %s no está activa y habilitada para la subsidiaria %s.',
            tax_account_key,subsidiary_key
          );
      end if;
    end if;
  end if;

  return new;
end
$$;

revoke all on function public.validate_journal_line_account_scope()
  from public,anon,authenticated;

drop trigger if exists validate_journal_line_account_scope_trigger
  on public.journal_line;
create trigger validate_journal_line_account_scope_trigger
before insert or update of journal_id,account_id,debit,credit,tax_code_id,tax_rate,note
on public.journal_line
for each row execute function public.validate_journal_line_account_scope();

-- gl_impact también puede recibir escrituras directas desde flujos antiguos.
-- La misma regla se aplica aquí para que ningún camino pueda contabilizar
-- una cuenta inactiva o no asignada. No se consulta ni modifica el impacto que
-- dispara el trigger, por lo que no existe recursión.
create or replace function public.validate_gl_impact_account_scope()
returns trigger
language plpgsql
security definer
set search_path=public,pg_temp
as $$
declare
  reversal_journal_key bigint;
begin
  if public.account_enabled_for_subsidiary(new.account_id,new.subsidiary_id) then
    return new;
  end if;

  select reversal.journal_id
    into reversal_journal_key
    from public.journal reversal
   where reversal.transaction_id=new.transaction_id
     and reversal.subsidiary_id=new.subsidiary_id
     and reversal.reversed_from_journal_id is not null
     and public.reversal_source_has_account(
       reversal.journal_id,new.account_id,new.subsidiary_id
     )
   order by reversal.journal_id
   limit 1;

  if reversal_journal_key is null then
    raise exception using
      errcode='23514',
      message=format(
        'La cuenta contable %s no está activa y habilitada para la subsidiaria %s.',
        new.account_id,new.subsidiary_id
      );
  end if;

  return new;
end
$$;

revoke all on function public.validate_gl_impact_account_scope()
  from public,anon,authenticated;

drop trigger if exists validate_gl_impact_account_scope_trigger
  on public.gl_impact;
create trigger validate_gl_impact_account_scope_trigger
before insert or update
on public.gl_impact
for each row execute function public.validate_gl_impact_account_scope();

-- Keep the PPE reconciliation aligned with active account assignments.
create or replace function public.fixed_asset_proposal_report(p_filters jsonb default '{}')returns jsonb language plpgsql stable security definer set search_path=public,pg_temp as $$
declare sid bigint:=fixed_asset_proposal_access();result jsonb;reconciliation jsonb;begin
 with accounts as(select a.account_id,a.account_number,a.account_name from chart_accounts a join account_subsidiaries s using(account_id)where s.subsidiary_id=sid and s.is_active and fixed_asset_ppe_account(a.account_id)),
 amounts as(select a.*,coalesce((select sum(g.debit_amount-g.credit_amount)from gl_impact g join accounting_books b using(accounting_book_id)where g.subsidiary_id=sid and g.account_id=a.account_id and b.is_primary and b.is_active),0)gl,
 coalesce((select sum(x.purchase_cost)from asset x join asset_category c using(category_id)where x.subsidiary_id=sid and c.asset_account_id=a.account_id and x.status<>'BAJA'),0)auxiliary,
 coalesce((select sum(p.amount_local)from activos_fijos_propuestas p where p.subsidiary_id=sid and p.account_id=a.account_id and p.status='PENDIENTE'),0)pending from accounts a)
 select jsonb_build_object('accounts',coalesce(jsonb_agg(jsonb_build_object('id',account_id,'number',account_number,'name',account_name,'gl',gl,'auxiliary',auxiliary,'pending',pending,'difference',gl-auxiliary-pending)order by account_number),'[]'),'gl',coalesce(sum(gl),0),'auxiliary',coalesce(sum(auxiliary),0),'pending',coalesce(sum(pending),0),'difference',coalesce(sum(gl-auxiliary-pending),0),'balanced',coalesce(bool_and(gl-auxiliary-pending=0),true),'hasPrimaryBook',exists(select 1 from accounting_books where subsidiary_id=sid and is_primary and is_active),'outsidePpe',coalesce((select sum(amount_local)from activos_fijos_propuestas where subsidiary_id=sid and status='PENDIENTE'and not fixed_asset_ppe_account(account_id)),0))into reconciliation from amounts;
 select jsonb_build_object('rows',coalesce(jsonb_agg(to_jsonb(q)order by q.source_date,q.proposal_id),'[]'))into result from(
 select p.*,a.account_number,a.account_name,c.currency_code,fixed_asset_ppe_account(p.account_id)is_ppe,
 coalesce((select jsonb_agg(jsonb_build_object('id',x.asset_id,'number',z.asset_number,'amount',x.amount_local))from fixed_asset_proposal_allocation x join asset z using(asset_id)where x.proposal_id=p.proposal_id),'[]')assets
 from activos_fijos_propuestas p join chart_accounts a using(account_id)join currencies c on c.currency_id=p.currency_id where p.subsidiary_id=sid
 and(p.status=coalesce(nullif(p_filters->>'status',''),'PENDIENTE'))
 and(nullif(p_filters->>'from','')is null or p.source_date>=(p_filters->>'from')::date)and(nullif(p_filters->>'to','')is null or p.source_date<=(p_filters->>'to')::date)
 and(nullif(p_filters->>'search','')is null or concat_ws(' ',p.source_number,p.invoice_number,p.description,p.third_party,a.account_number)ilike'%'||(p_filters->>'search')||'%'))q;
 return result||jsonb_build_object('reconciliation',reconciliation,'options',fixed_asset_options()||jsonb_build_object('canManage',exists(select 1 from user_roles ur join role_permissions rp using(role_id)join permissions p using(permission_id)where ur.user_id=app_user_id()and p.code='fixed-assets:proposals:manage'),'categories',coalesce((select jsonb_agg(jsonb_build_object('id',category_id,'name',category_name,'accountId',asset_account_id))from asset_category where subsidiary_id=sid and is_active),'[]'),'expenseAccounts',coalesce((select jsonb_agg(jsonb_build_object('id',a.account_id,'name',a.account_number||' · '||a.account_name))from chart_accounts a join account_subsidiaries s using(account_id)where s.subsidiary_id=sid and s.is_active and a.accepts_entries and not a.is_inactive and a.category in('Costo','Gasto')),'[]')));
end$$;
