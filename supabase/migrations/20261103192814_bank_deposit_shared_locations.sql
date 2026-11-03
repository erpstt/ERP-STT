-- Deposits use the same subsidiary memberships as the location catalog.
-- Preserve authorization/posting bodies; replace only their legacy location scope.
set local lock_timeout='5s';
set local statement_timeout='30s';

do $$declare original text;modified text;
begin
 original:=pg_get_functiondef('bank_deposit_private.validate_payload(jsonb,bigint,bigint)'::regprocedure);
 modified:=replace(original,
  '(l.subsidiary_id=p_sid or l.subsidiary_id is null)',
  '(l.subsidiary_id=p_sid or exists(select 1 from public.location_subsidiaries ls where ls.location_id=l.location_id and ls.subsidiary_id=p_sid))');
 if modified=original then raise exception 'Unexpected deposit validation location scope; review before applying.';end if;
 execute modified;

 original:=pg_get_functiondef('bank_deposit_private.save_bank_deposit(jsonb)'::regprocedure);
 modified:=replace(original,
  'select 1 from locations where location_id=location_key and (subsidiary_id=sid or subsidiary_id is null)',
  'select 1 from public.locations l where l.location_id=location_key and (l.subsidiary_id=sid or exists(select 1 from public.location_subsidiaries ls where ls.location_id=l.location_id and ls.subsidiary_id=sid))');
 if modified=original then raise exception 'Unexpected deposit posting location scope; review before applying.';end if;
 execute modified;

 original:=pg_get_functiondef('bank_deposit_private.bank_deposit_options()'::regprocedure);
 modified:=replace(original,
  'where l.subsidiary_id=s.subsidiary_id order by l.location_id',
  'where (l.subsidiary_id=s.subsidiary_id or exists(select 1 from public.location_subsidiaries ls where ls.location_id=l.location_id and ls.subsidiary_id=s.subsidiary_id)) order by l.location_id');
 if modified=original then raise exception 'Unexpected deposit options location scope; review before applying.';end if;
 execute modified;
end$$;

notify pgrst,'reload schema';
