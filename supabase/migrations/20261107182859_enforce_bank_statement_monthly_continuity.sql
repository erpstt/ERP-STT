-- Validate new statement writes only. Historical statements and matches are untouched.
set local lock_timeout='5s';
set local statement_timeout='60s';

do $guard$
declare item record;begin
 for item in select *from(values
 ('reconciliation_private.before_import(bigint,date,numeric,numeric,jsonb)','49a8a7fb7d133842ce532cb0b0c38f61'),
 ('public.save_bank_statement_metadata(bigint,jsonb)','f85ba1fdcd3e70362cf82afa7404065c'),
 ('public.delete_bank_statement(bigint)','052071b9412d8b287bd0718c453d0f42'),
 ('reconciliation_private.bank_scope(bigint,date,boolean)','dea2f3c05681394fad5cf646ed4bde79'),
 ('reconciliation_private.statement_mutable(bigint)','dc9fe0847fccedbab410a47dbab9a9f1'),
 ('reconciliation_private.access(text,text)','db49a13764d60473eb083ed784e76786')
 )v(signature,expected)loop
  if(select md5(prosrc)from pg_proc where oid=item.signature::regprocedure)is distinct from item.expected then
   raise exception 'Unexpected bank statement validation source: %',item.signature;
  end if;
 end loop;
end$guard$;

create function reconciliation_private.statement_balance_context(p_bank bigint,p_date date)
returns jsonb language plpgsql stable security definer set search_path=pg_catalog,public,pg_temp as $$
declare previous_date date;previous public.bank_statement;begin
 if p_date is null or not isfinite(p_date)then raise exception using errcode='22023',message='Indique una fecha de extracto válida.';end if;
 perform reconciliation_private.bank_scope(p_bank,p_date,false);
 previous_date:=date_trunc('month',p_date)::date-1;
 select *into previous from public.bank_statement where bank_account_id=p_bank and statement_date=previous_date;
 return jsonb_build_object('bankAccountId',p_bank,'statementDate',p_date,'previousDate',previous_date,
  'previousStatement',case when previous.statement_id is null then null else
   jsonb_build_object('id',previous.statement_id,'date',previous.statement_date,'closingBalance',previous.closing_balance)end);
end$$;

create function reconciliation_private.assert_statement_balances(p_bank bigint,p_date date,p_open numeric,p_close numeric,p_lines jsonb,p_allow_summary boolean default false)
returns void language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$
declare ctx jsonb;prior numeric;line jsonb;line_date date;amount numeric;net numeric:=0;expected numeric;row_number integer:=0;begin
 ctx:=reconciliation_private.statement_balance_context(p_bank,p_date);
 if not reconciliation_private.finite(p_open)or not reconciliation_private.finite(p_close)
  or abs(round(p_open,6))>=1e18 or abs(round(p_close,6))>=1e18
  or p_lines is null or jsonb_typeof(p_lines)<>'array'then
  raise exception using errcode='22023',message='El extracto requiere saldos finitos dentro de su precisión y movimientos válidos.';
 end if;
 if ctx->'previousStatement'<>'null'::jsonb then
  prior:=(ctx#>>'{previousStatement,closingBalance}')::numeric;
  if not reconciliation_private.finite(prior)then raise exception using errcode='PBC01',message='Revise el saldo final del extracto anterior antes de importar.';end if;
  if abs(round(p_open,6)-round(prior,6))>=.005 then
   raise exception using errcode='PBC01',message=format('El saldo inicial no coincide con el cierre del extracto anterior del %s: esperado %s, recibido %s. Revise el archivo bancario.',ctx->>'previousDate',prior,p_open);
  end if;
 end if;
 for line in select value from jsonb_array_elements(p_lines)loop
  row_number:=row_number+1;
  if jsonb_typeof(line)<>'object'then raise exception using errcode='22023',message=format('Movimiento %s inválido.',row_number);end if;
  line_date:=nullif(line->>'date','')::date;amount:=(line->>'amount')::numeric;
  if line_date is null or not isfinite(line_date)or line_date<date_trunc('month',p_date)::date or line_date>p_date then
   raise exception using errcode='PBC03',message=format('El movimiento %s debe estar dentro del mes seleccionado y no ser posterior al corte.',row_number);
  end if;
  if not reconciliation_private.finite(amount)or round(amount,6)=0 or abs(round(amount,6))>=1e18 then
   raise exception using errcode='22023',message=format('El movimiento %s requiere un importe finito no cero con precisión de seis decimales.',row_number);
  end if;
  net:=net+round(amount,6);
 end loop;
 if not(p_allow_summary and jsonb_array_length(p_lines)=0)then
  expected:=round(round(p_open,6)+net,2);
  if abs(round(p_close,6)-expected)>=.005 then
   raise exception using errcode='PBC02',message=format('El saldo final no coincide con el inicial más los movimientos: esperado %s, recibido %s. Revise el archivo bancario.',expected,p_close);
  end if;
 end if;
end$$;

create function reconciliation_private.assert_statement_following(p_old_id bigint,p_bank bigint,p_date date,p_close numeric,p_delete boolean default false)
returns void language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$
declare original public.bank_statement;following public.bank_statement;next_start date;begin
 if p_old_id is not null then
  select *into original from public.bank_statement where statement_id=p_old_id;
  if original.statement_id is null then raise exception using errcode='42501',message='Extracto no disponible.';end if;
  if p_delete or original.bank_account_id is distinct from p_bank or original.statement_date is distinct from p_date then
   next_start:=(date_trunc('month',original.statement_date)+interval'1 month')::date;
   if original.statement_date=next_start-1 and exists(
    select 1 from public.bank_statement s where s.bank_account_id=original.bank_account_id
     and s.statement_id<>p_old_id and s.statement_date>=next_start and s.statement_date<(next_start+interval'1 month')::date
   )then raise exception using errcode='PBC04',message='No puede eliminar o mover este extracto: el mes siguiente depende de su saldo final.';end if;
  end if;
 end if;
 if not p_delete and(original.statement_id is null or original.bank_account_id is distinct from p_bank or original.statement_date is distinct from p_date or original.closing_balance is distinct from p_close)then
  next_start:=(date_trunc('month',p_date)+interval'1 month')::date;
  if p_date=next_start-1 then
   select *into following from public.bank_statement s where s.bank_account_id=p_bank
    and s.statement_id is distinct from p_old_id and s.statement_date>=next_start and s.statement_date<(next_start+interval'1 month')::date
    and(not reconciliation_private.finite(s.opening_balance)or abs(round(s.opening_balance,6)-round(p_close,6))>=.005)
    order by s.statement_date,s.statement_id limit 1;
   if following.statement_id is not null then raise exception using errcode='PBC04',
    message=format('El saldo final no coincide con el inicial del extracto siguiente del %s. No se modificaron los extractos.',following.statement_date);end if;
  end if;
 end if;
end$$;

create function public.bank_statement_balance_context(p_bank_account_id bigint,p_statement_date date)
returns jsonb language plpgsql stable security definer set search_path=pg_catalog,public,pg_temp as $$
begin
 perform reconciliation_private.access('banking:bank-statements','create');
 perform reconciliation_private.access('reports:accounting-reports','view');
 return reconciliation_private.statement_balance_context(p_bank_account_id,p_statement_date);
end$$;

do $patch$
declare definition text;needle text;replacement text;begin
 definition:=pg_get_functiondef('reconciliation_private.before_import(bigint,date,numeric,numeric,jsonb)'::regprocedure);
 needle:=' for line in select value from jsonb_array_elements(p_lines) loop';
 replacement:=' perform reconciliation_private.assert_statement_balances(p_bank,p_date,p_open,p_close,p_lines);'||chr(10)||needle;
 if position(needle in definition)=0 then raise exception 'Missing statement import line validation boundary';end if;
 definition:=replace(definition,needle,replacement);
 needle:=' end loop;'||chr(10)||'end';
 replacement:=' end loop;'||chr(10)||
  ' perform reconciliation_private.assert_statement_following(key,p_bank,p_date,p_close);'||chr(10)||'end';
 if position(needle in definition)=0 then raise exception 'Missing statement import validation boundary';end if;
 execute replace(definition,needle,replacement);

 definition:=pg_get_functiondef('public.save_bank_statement_metadata(bigint,jsonb)'::regprocedure);
 needle:=' if p_statement_id is null then'||chr(10)||'  insert into public.bank_statement';
 replacement:=' perform reconciliation_private.assert_statement_balances(selected_bank_key,d,(p_payload->>''opening_balance'')::numeric,(p_payload->>''closing_balance'')::numeric,'||
  '(select coalesce(jsonb_agg(jsonb_build_object(''date'',l.bank_date,''amount'',l.amount)order by l.statement_line_id),''[]''::jsonb)from public.bank_statement_line l where l.statement_id=p_statement_id),true);'||chr(10)||
  ' perform reconciliation_private.assert_statement_following(p_statement_id,selected_bank_key,d,(p_payload->>''closing_balance'')::numeric);'||chr(10)||
  ' if p_statement_id is null then'||chr(10)||'  insert into public.bank_statement';
 if position(needle in definition)=0 then raise exception 'Missing statement metadata write boundary';end if;
 execute replace(definition,needle,replacement);

 definition:=pg_get_functiondef('public.delete_bank_statement(bigint)'::regprocedure);
 needle:='perform reconciliation_private.statement_mutable(p_statement_id);delete from public.bank_statement_line';
 replacement:='perform reconciliation_private.statement_mutable(p_statement_id);perform reconciliation_private.assert_statement_following(p_statement_id,null,null,null,true);delete from public.bank_statement_line';
 if position(needle in definition)=0 then raise exception 'Missing statement deletion boundary';end if;
 execute replace(definition,needle,replacement);
end$patch$;

revoke all on function reconciliation_private.statement_balance_context(bigint,date),
 reconciliation_private.assert_statement_balances(bigint,date,numeric,numeric,jsonb,boolean),
 reconciliation_private.assert_statement_following(bigint,bigint,date,numeric,boolean)from public,anon,authenticated,service_role;
revoke all on function public.bank_statement_balance_context(bigint,date)from public,anon,authenticated,service_role;
grant execute on function public.bank_statement_balance_context(bigint,date)to authenticated;
notify pgrst,'reload schema';
