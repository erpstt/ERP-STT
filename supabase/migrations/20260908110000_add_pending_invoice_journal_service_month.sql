alter table journal_line
  add column if not exists service_month text
  check (service_month is null or service_month ~ '^[0-9]{4}-(0[1-9]|1[0-2])$');

alter function create_journal_entry(jsonb) rename to create_journal_entry_without_service_month;

create function create_journal_entry(payload jsonb) returns bigint
language plpgsql security definer set search_path=public,pg_temp as $$
declare jid bigint;
begin
  jid:=create_journal_entry_without_service_month(payload);
  with supplied as (
    select ordinality,
      case when payload->>'journal_type'='Asientos Pendientes de Facturar'
        then nullif(value->>'service_month','') end service_month
    from jsonb_array_elements(payload->'lines') with ordinality
  ), stored as (
    select journal_line_id,row_number() over(order by journal_line_id) ordinality
    from journal_line where journal_id=jid
  )
  update journal_line line set service_month=supplied.service_month
  from supplied join stored using(ordinality)
  where line.journal_line_id=stored.journal_line_id;
  return jid;
end$$;
revoke all on function create_journal_entry(jsonb) from public;
grant execute on function create_journal_entry(jsonb) to authenticated;

alter function update_journal_entry(bigint,jsonb) rename to update_journal_entry_without_service_month;

create function update_journal_entry(target_journal_id bigint,payload jsonb) returns bigint
language plpgsql security definer set search_path=public,pg_temp as $$
declare jid bigint;
begin
  jid:=update_journal_entry_without_service_month(target_journal_id,payload);
  with supplied as (
    select ordinality,
      case when payload->>'journal_type'='Asientos Pendientes de Facturar'
        then nullif(value->>'service_month','') end service_month
    from jsonb_array_elements(payload->'lines') with ordinality
  ), stored as (
    select journal_line_id,row_number() over(order by journal_line_id) ordinality
    from journal_line where journal_id=jid
  )
  update journal_line line set service_month=supplied.service_month
  from supplied join stored using(ordinality)
  where line.journal_line_id=stored.journal_line_id;
  return jid;
end$$;
revoke all on function update_journal_entry(bigint,jsonb) from public;
grant execute on function update_journal_entry(bigint,jsonb) to authenticated;
