create or replace function payment_request_private.beneficiary_bank_dto(kind text, entity_id bigint, entity_name text, active boolean, data jsonb)
returns jsonb language sql stable security invoker
set search_path = pg_catalog, public, pg_temp
as $$
  select jsonb_build_object(
    'entityType',kind,'entityId',entity_id,'name',entity_name,
    'beneficiaryName',nullif(btrim(data->>'payment_beneficiary_name'),''),
    'identification',nullif(btrim(case when kind='Proveedor' then data->>'tax_id' else data->>'identification' end),''),
    'isActive',active,
    'accounts',coalesce((
      select jsonb_agg(jsonb_build_object(
        'slot',account.slot,'bankId',account.bank_id,'bankName',bank.bank_name,
        'iban',account.iban,'accountNumber',account.account_number,
        'currencyId',account.currency_id,'currencyCode',currency.currency_code
      ) order by account.position)
      from (values
        (1,'primary',nullif(data->>'payment_bank_id','')::bigint,
          nullif(data->>'payment_iban',''),nullif(data->>'payment_account_number',''),
          nullif(data->>'payment_currency_id','')::bigint),
        (2,'secondary',nullif(data->>'secondary_payment_bank_id','')::bigint,
          nullif(data->>'secondary_payment_iban',''),nullif(data->>'secondary_payment_account_number',''),
          nullif(data->>'secondary_payment_currency_id','')::bigint)
      ) account(position,slot,bank_id,iban,account_number,currency_id)
      left join public.banks bank on bank.bank_id=account.bank_id
      left join public.currencies currency on currency.currency_id=account.currency_id
      where account.bank_id is not null or account.iban is not null
        or account.account_number is not null or account.currency_id is not null
    ),'[]'::jsonb))
$$;


notify pgrst,'reload schema';
