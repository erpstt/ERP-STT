-- Keep sales invoice numbering canonical and continuous per subsidiary.
--
-- Historical customer invoices can exist without a transaction because they
-- were loaded as opening balances.  For that reason the sequence is aligned
-- against invoice, transaction and journal instead of relying on only one of
-- those tables.

create or replace function public.ensure_sales_invoice_number_sequence(
  p_subsidiary_id bigint
)returns void
language plpgsql
security definer
set search_path=public,pg_temp
as $$
declare
  transaction_type_key bigint;
  canonical_max bigint:=0;
begin
  if p_subsidiary_id is null
    or not exists(
      select 1
      from public.subsidiaries subsidiary
      where subsidiary.subsidiary_id=p_subsidiary_id
    ) then
    raise exception 'La subsidiaria indicada no existe.';
  end if;

  select transaction_type.transaction_type_id
    into transaction_type_key
  from public.transaction_types transaction_type
  where transaction_type.abbreviation='FAC_VEN'
  order by transaction_type.transaction_type_id
  limit 1;

  if transaction_type_key is null then
    raise exception 'No existe el tipo de transacción FAC_VEN.';
  end if;

  -- Use the same lock as next_transaction_number.  This makes discovery of
  -- the historical maximum and the subsequent increment one atomic sequence
  -- with respect to every normal invoice creation.
  perform pg_advisory_xact_lock(
    hashtextextended('transaction-number:'||transaction_type_key::text,0)
  );

  select coalesce(max(canonical.number_value),0)
    into canonical_max
  from (
    select substring(invoice.invoice_number from '^FAC-([0-9]+)$')::bigint
      as number_value
    from public.invoice invoice
    where invoice.subsidiary_id=p_subsidiary_id
      and invoice.invoice_number~'^FAC-[0-9]+$'

    union all

    select substring(transaction_row.tran_number from '^FAC-([0-9]+)$')::bigint
    from public."transaction" transaction_row
    where transaction_row.subsidiary_id=p_subsidiary_id
      and transaction_row.tran_number~'^FAC-[0-9]+$'

    union all

    select substring(journal.journal_number from '^FAC-([0-9]+)$')::bigint
    from public.journal journal
    where journal.subsidiary_id=p_subsidiary_id
      and journal.journal_number~'^FAC-[0-9]+$'
  )canonical;

  insert into public.number_sequences(
    scope_type,transaction_type_id,subsidiary_id,prefix,suffix,
    current_number,padding_length
  )values(
    'Transacción',transaction_type_key,p_subsidiary_id,'FAC-',null,
    canonical_max,8
  )
  on conflict(transaction_type_id,subsidiary_id)
    where scope_type='Transacción'
  do update set
    current_number=greatest(
      public.number_sequences.current_number,
      case
        -- Existing configured series are preserved.  Only a FAC- series is
        -- synchronized against the imported canonical FAC- history.
        when public.number_sequences.prefix='FAC-'
          and public.number_sequences.suffix is null
          then excluded.current_number
        else public.number_sequences.current_number
      end
    );
end
$$;

revoke all on function public.ensure_sales_invoice_number_sequence(bigint)
  from public,anon,authenticated;

-- Backfill both active and inactive subsidiaries.  The helper remains the
-- future-subsidiary mechanism because the outer save wrapper invokes it for
-- every new invoice before consuming a number.
do $$
declare
  subsidiary_row record;
begin
  for subsidiary_row in
    select subsidiary_id
    from public.subsidiaries
    order by subsidiary_id
  loop
    perform public.ensure_sales_invoice_number_sequence(
      subsidiary_row.subsidiary_id
    );
  end loop;
end
$$;

-- Repair the one invoice created by the legacy timestamp fallback.  Every
-- predicate is intentional: a rerun is a no-op, while an occupied target or
-- an inconsistent linked document aborts the migration instead of producing
-- a partially corrected accounting document.
do $$
declare
  affected_invoice public.invoice%rowtype;
  old_number constant text:='FAC_VEN-20261026181826700';
  corrected_number constant text:='FAC-00000669';
  linked_transaction_number text;
  linked_journal_number text;
  transaction_type_key bigint;
  needs_number_change boolean:=false;
  has_optional_reference boolean:=false;
begin
  select invoice.*
    into affected_invoice
  from public.invoice invoice
  where invoice.invoice_id=674
  for update;

  if not found then
    return;
  end if;
  if affected_invoice.invoice_number not in(old_number,corrected_number) then
    return;
  end if;

  if affected_invoice.subsidiary_id<>24 then
    raise exception
      'La factura 674 conserva el número temporal, pero no pertenece a la subsidiaria esperada.';
  end if;
  if affected_invoice.transaction_id is null or affected_invoice.journal_id is null then
    raise exception
      'La factura 674 no tiene transacción y asiento vinculados; no se puede renumerar de forma íntegra.';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended('sales-invoice-number-correction:674',0)
  );

  if exists(
      select 1 from public.invoice invoice
      where invoice.invoice_number=corrected_number
        and invoice.invoice_id<>affected_invoice.invoice_id
    )
    or exists(
      select 1 from public."transaction" transaction_row
      where transaction_row.tran_number=corrected_number
        and transaction_row.transaction_id<>affected_invoice.transaction_id
    )
    or exists(
      select 1 from public.journal journal
      where journal.journal_number=corrected_number
        and journal.journal_id<>affected_invoice.journal_id
    ) then
    raise exception
      'No se puede corregir la factura 674 porque el número FAC-00000669 ya está ocupado.';
  end if;

  select transaction_row.tran_number
    into linked_transaction_number
  from public."transaction" transaction_row
  where transaction_row.transaction_id=affected_invoice.transaction_id
  for update;
  if not found then
    raise exception 'No existe la transacción vinculada a la factura 674.';
  end if;

  select journal.journal_number
    into linked_journal_number
  from public.journal journal
  where journal.journal_id=affected_invoice.journal_id
  for update;
  if not found then
    raise exception 'No existe el asiento vinculado a la factura 674.';
  end if;

  if linked_transaction_number not in(old_number,corrected_number)
    or linked_journal_number not in(old_number,corrected_number) then
    raise exception
      'La factura 674 tiene una numeración inconsistente en su transacción o asiento vinculado.';
  end if;

  needs_number_change:=affected_invoice.invoice_number<>corrected_number
    or linked_transaction_number<>corrected_number
    or linked_journal_number<>corrected_number;

  if needs_number_change then
    if exists(
        select 1
        from public.customer_payment_application application
        where application.invoice_id=affected_invoice.invoice_id
      )
      or exists(
        select 1
        from public.credit_note note
        where note.invoice_id=affected_invoice.invoice_id
      )
      or exists(
        select 1
        from public.debit_note note
        where note.invoice_id=affected_invoice.invoice_id
      )
      or exists(
        select 1
        from public.journal_support support
        where support.journal_id=affected_invoice.journal_id
      ) then
      raise exception
        'La factura 674 ya tiene cobros, notas o respaldos vinculados y no se puede renumerar automáticamente.';
    end if;

    -- These optional modules reference the invoice by id rather than by its
    -- display number. Even so, block the one-time repair when operational
    -- processes already depend on the document so the change remains fully
    -- auditable.
    if to_regclass('public.pending_invoice_reversal') is not null then
      execute
        'select exists(select 1 from public.pending_invoice_reversal where sales_invoice_id=$1)'
        into has_optional_reference
        using affected_invoice.invoice_id;
    end if;
    if not has_optional_reference
      and to_regclass('public.treasury_schedule') is not null then
      execute
        'select exists(select 1 from public.treasury_schedule where invoice_id=$1)'
        into has_optional_reference
        using affected_invoice.invoice_id;
    end if;
    if has_optional_reference then
      raise exception
        'La factura 674 ya participa en una reversión de pendientes o programación de tesorería y no se puede renumerar automáticamente.';
    end if;

    update public.invoice
    set invoice_number=corrected_number
    where invoice_id=affected_invoice.invoice_id;

    update public."transaction"
    set tran_number=corrected_number
    where transaction_id=affected_invoice.transaction_id;

    update public.journal
    set journal_number=corrected_number
    where journal_id=affected_invoice.journal_id;
  end if;

  update public.journal_line
  set note='Cuenta por cobrar · '||corrected_number
  where journal_id=affected_invoice.journal_id
    and note in(
      'Cuenta por cobrar · AUTO',
      'Cuenta por cobrar · '||old_number
    );

  perform public.ensure_sales_invoice_number_sequence(
    affected_invoice.subsidiary_id
  );

  select transaction_type.transaction_type_id
    into transaction_type_key
  from public.transaction_types transaction_type
  where transaction_type.abbreviation='FAC_VEN'
  order by transaction_type.transaction_type_id
  limit 1;

  update public.number_sequences
  set prefix='FAC-',suffix=null,padding_length=8,
      current_number=greatest(current_number,669)
  where scope_type='Transacción'
    and transaction_type_id=transaction_type_key
    and subsidiary_id=affected_invoice.subsidiary_id;
end
$$;

-- Preserve the complete existing wrapper chain.  This migration only adds an
-- outer integrity boundary around it.
do $$
begin
  if to_regprocedure(
      'public.save_sales_invoice_before_number_integrity(jsonb,bigint)'
    ) is null then
    if to_regprocedure('public.save_sales_invoice(jsonb,bigint)') is null then
      raise exception 'No existe la función save_sales_invoice que se debe proteger.';
    end if;
    alter function public.save_sales_invoice(jsonb,bigint)
      rename to save_sales_invoice_before_number_integrity;
  end if;
end
$$;

revoke all on function public.save_sales_invoice_before_number_integrity(jsonb,bigint)
  from public,anon,authenticated;

create or replace function public.save_sales_invoice(
  payload jsonb,
  target_invoice_id bigint default null
)returns jsonb
language plpgsql
security definer
set search_path=public,pg_temp
as $$
declare
  sid bigint:=public.active_subsidiary_id();
  effective_payload jsonb:=coalesce(payload,'{}'::jsonb);
  result jsonb;
  invoice_key bigint;
  invoice_number_value text;
  transaction_number_value text;
  journal_number_value text;
  transaction_key bigint;
  journal_key bigint;
  automatic_number boolean;
  generated_number text;
begin
  -- Editing preserves every historical/external document number and must not
  -- consume a new sequence value.
  if target_invoice_id is not null then
    return public.save_sales_invoice_before_number_integrity(
      effective_payload,target_invoice_id
    );
  end if;

  if sid is null then
    raise exception 'Debe seleccionar una subsidiaria antes de crear la factura.';
  end if;

  perform public.ensure_sales_invoice_number_sequence(sid);
  automatic_number:=coalesce(btrim(effective_payload->>'invoice_number'),'')=''
    or upper(btrim(effective_payload->>'invoice_number'))='AUTO';
  if automatic_number then
    effective_payload:=effective_payload
      ||jsonb_build_object('invoice_number','AUTO');
  end if;

  result:=public.save_sales_invoice_before_number_integrity(
    effective_payload,null
  );
  invoice_key:=nullif(result->>'invoiceId','')::bigint;
  generated_number:=coalesce(result->>'transactionNumber','');

  if invoice_key is null then
    raise exception 'La factura guardada no devolvió un identificador válido.';
  end if;

  select invoice.invoice_number,invoice.transaction_id,invoice.journal_id,
         transaction_row.tran_number,journal.journal_number
    into invoice_number_value,transaction_key,journal_key,
         transaction_number_value,journal_number_value
  from public.invoice invoice
  join public."transaction" transaction_row
    on transaction_row.transaction_id=invoice.transaction_id
  join public.journal journal
    on journal.journal_id=invoice.journal_id
  where invoice.invoice_id=invoice_key
    and invoice.subsidiary_id=sid;

  if not found then
    raise exception
      'La factura creada no conserva sus vínculos contables de numeración.';
  end if;

  if generated_number~'^FAC_VEN-[0-9]{17}$'
    or transaction_number_value~'^FAC_VEN-[0-9]{17}$'
    or journal_number_value~'^FAC_VEN-[0-9]{17}$'
    or (automatic_number and invoice_number_value~'^FAC_VEN-[0-9]{17}$') then
    raise exception
      'No fue posible obtener la secuencia configurada. La creación de la factura fue revertida.';
  end if;

  if generated_number=''
    or transaction_number_value<>generated_number
    or journal_number_value<>generated_number then
    raise exception
      'La numeración de la transacción y el asiento no coincide; la creación fue revertida.';
  end if;

  if automatic_number
    and invoice_number_value<>generated_number then
    raise exception
      'La numeración automática de la factura, la transacción y el asiento no coincide; la creación fue revertida.';
  end if;

  -- The original routine builds this note from the input token AUTO.  Replace
  -- it only after the three stored document numbers have passed validation.
  update public.journal_line
  set note='Cuenta por cobrar · '||invoice_number_value
  where journal_id=journal_key
    and note='Cuenta por cobrar · AUTO';

  return result;
end
$$;

revoke all on function public.save_sales_invoice(jsonb,bigint)
  from public,anon;
grant execute on function public.save_sales_invoice(jsonb,bigint)
  to authenticated;

notify pgrst,'reload schema';
