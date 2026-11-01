CREATE OR REPLACE FUNCTION public.validate_tax_supervisor()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
begin
  if new.tax_supervisor_user_id is not null and not exists(
    select 1 from public.users u
    join public.user_subsidiaries us on us.user_id=u.user_id
    where u.user_id=new.tax_supervisor_user_id
      and u.is_active
      and us.subsidiary_id=new.subsidiary_id
  ) then
    raise exception 'El supervisor tributario debe ser un usuario activo con acceso a la subsidiaria.';
  end if;
  return new;
end$function$;
CREATE OR REPLACE FUNCTION public.validate_subsidiary_income_autorent()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
begin
  perform public.validate_income_autorent_configuration(
    new.subsidiary_id,new.country_id,new.applies_income_autorent,
    new.autorent_active_account_id,new.autorent_passive_account_id,new.autorent_percentage
  );
  return new;
end
$function$;
CREATE OR REPLACE FUNCTION public.ensure_subsidiary_income_autorent_accounts()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
begin
  if not coalesce(new.applies_income_autorent,false) then
    return new;
  end if;

  if new.autorent_active_account_id is null
     or not exists(
       select 1
       from public.chart_accounts a
       where a.account_id=new.autorent_active_account_id
         and a.category='Activo'
         and a.nature='Deudora'
         and a.financial_statement='Balance General'
         and a.level=4
         and a.accepts_entries
         and not a.is_inactive
     ) then
    raise exception 'Seleccione una cuenta de Activo, naturaleza deudora, de Balance General y habilitada para movimientos.';
  end if;

  if new.autorent_passive_account_id is null
     or not exists(
       select 1
       from public.chart_accounts a
       where a.account_id=new.autorent_passive_account_id
         and a.category='Pasivo'
         and a.nature='Acreedora'
         and a.financial_statement='Balance General'
         and a.level=4
         and a.accepts_entries
         and not a.is_inactive
     ) then
    raise exception 'Seleccione una cuenta de Pasivo, naturaleza acreedora, de Balance General y habilitada para movimientos.';
  end if;

  insert into public.account_subsidiaries(account_id,subsidiary_id,is_active)
  values
    (new.autorent_active_account_id,new.subsidiary_id,true),
    (new.autorent_passive_account_id,new.subsidiary_id,true)
  on conflict(account_id,subsidiary_id)
  do update set is_active=true;

  return new;
end
$function$;
CREATE OR REPLACE FUNCTION public.link_all_accounts_to_new_subsidiary()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
begin
  insert into public.account_subsidiaries(account_id,subsidiary_id,is_active)
  select account_id,new.subsidiary_id,true
  from public.chart_accounts
  on conflict(account_id,subsidiary_id)
  do update set is_active=true;
  return new;
end
$function$;
CREATE OR REPLACE FUNCTION public.validate_income_autorent_configuration(p_subsidiary_id bigint, p_country_id bigint, p_applies boolean, p_active_account_id bigint, p_passive_account_id bigint, p_percentage numeric)
 RETURNS void
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
begin
  if not coalesce(p_applies,false) then return;end if;

  if not exists(
    select 1 from public.countries c
    where c.country_id=p_country_id
      and(
        upper(coalesce(c.country_code_iso2,''))='CO'
        or upper(coalesce(c.country_code_iso3,''))='COL'
        or lower(btrim(c.name))='colombia'
      )
  )then
    raise exception 'La autorretencion de renta solo puede activarse para subsidiarias de Colombia.';
  end if;
  if p_percentage is null or p_percentage<=0 or p_percentage>1 then
    raise exception 'La tarifa de autorretencion debe ser un factor mayor que cero y menor o igual a uno (0.0110 equivale a 1.10%%).';
  end if;
  if p_active_account_id is null or p_passive_account_id is null then
    raise exception 'Configure las cuentas de activo y pasivo para la autorretencion de renta.';
  end if;
  if p_active_account_id=p_passive_account_id then
    raise exception 'Las cuentas de activo y pasivo de autorretencion deben ser diferentes.';
  end if;
  if not exists(
    select 1
    from public.chart_accounts a
    join public.account_subsidiaries sa using(account_id)
    where a.account_id=p_active_account_id and sa.subsidiary_id=p_subsidiary_id
      and sa.is_active and a.accepts_entries and not a.is_inactive
      and a.category='Activo' and a.financial_statement='Balance General'
  )then
    raise exception 'La cuenta de anticipo de autorretencion debe ser una cuenta activa de Activo, de Balance General, que acepte movimientos en la subsidiaria.';
  end if;
  if not exists(
    select 1
    from public.chart_accounts a
    join public.account_subsidiaries sa using(account_id)
    where a.account_id=p_passive_account_id and sa.subsidiary_id=p_subsidiary_id
      and sa.is_active and a.accepts_entries and not a.is_inactive
      and a.category='Pasivo' and a.financial_statement='Balance General'
  )then
    raise exception 'La cuenta por pagar de autorretencion debe ser una cuenta activa de Pasivo, de Balance General, que acepte movimientos en la subsidiaria.';
  end if;
end
$function$;
