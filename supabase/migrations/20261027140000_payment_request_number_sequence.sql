begin;

-- Las solicitudes de pago fueron creadas después de la carga inicial del
-- catálogo de secuencias. Al no existir SOL_PAG por subsidiaria, pr_save
-- entraba en su contingencia y utilizaba una marca de tiempo de 17 dígitos.
-- Se crea el consecutivo canónico sin renumerar documentos históricos.
do $$
declare
  transaction_type_key bigint;
  canonical_max bigint;
begin
  select transaction_type_id into transaction_type_key
  from public.transaction_types
  where abbreviation='SOL_PAG';

  if transaction_type_key is null then
    raise exception 'No existe el tipo de transacción SOL_PAG.';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended('transaction-number:'||transaction_type_key::text,0)
  );

  select coalesce(max(
    (regexp_match(numero,'^SOL_PAG-([0-9]+)$'))[1]::bigint
  ),0) into canonical_max
  from public.solicitudes_pago
  where numero~'^SOL_PAG-[0-9]+$'
    -- El formato de contingencia anterior era una marca de tiempo de
    -- exactamente 17 digitos; no debe convertirse en el nuevo consecutivo.
    and numero!~'^SOL_PAG-[0-9]{17}$';

  insert into public.number_sequences(
    scope_type,transaction_type_id,subsidiary_id,prefix,suffix,
    current_number,padding_length,allow_manual_update
  )
  select
    'Transacción',transaction_type_key,subsidiary_id,'SOL_PAG-',null,
    canonical_max,8,false
  from public.subsidiaries
  on conflict(transaction_type_id,subsidiary_id)
    where scope_type='Transacción'
  do update set
    prefix='SOL_PAG-',
    suffix=null,
    current_number=greatest(
      public.number_sequences.current_number,
      excluded.current_number
    ),
    padding_length=8,
    allow_manual_update=false;
end
$$;

-- Mantiene el contrato existente para todos los módulos. La única extensión
-- específica es que SOL_PAG se auto-configura para subsidiarias futuras y
-- también consulta solicitudes_pago al descartar números ya utilizados.
create or replace function public.next_transaction_number(
  target_type bigint,
  target_subsidiary bigint
)
returns text
language plpgsql
security definer
set search_path=public,pg_temp
as $$
declare
  result text;
  type_abbreviation text;
  canonical_max bigint;
begin
  if target_type is null or target_subsidiary is null then
    raise exception 'El tipo de transacción y la subsidiaria son obligatorios.';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended('transaction-number:'||target_type::text,0)
  );

  select abbreviation into type_abbreviation
  from public.transaction_types
  where transaction_type_id=target_type;

  if type_abbreviation is null then
    raise exception 'El tipo de transaccion indicado no existe.';
  end if;

  -- SOL_PAG usa un numero unico global aunque la configuracion se conserve
  -- por subsidiaria. Antes de incrementar, sincronice la fila seleccionada
  -- con el mayor consecutivo global para evitar recorrer miles de colisiones
  -- cuando una filial llevaba tiempo sin emitir solicitudes.
  if type_abbreviation='SOL_PAG' then
    select coalesce(max(
      (regexp_match(numero,'^SOL_PAG-([0-9]+)$'))[1]::bigint
    ),0) into canonical_max
    from public.solicitudes_pago
    where numero~'^SOL_PAG-[0-9]+$'
      and numero!~'^SOL_PAG-[0-9]{17}$';

    update public.number_sequences
    set current_number=greatest(current_number,canonical_max)
    where scope_type='Transacción'
      and transaction_type_id=target_type
      and subsidiary_id=target_subsidiary;
  end if;

  loop
    result:=null;
    update public.number_sequences
    set current_number=current_number+1
    where scope_type='Transacción'
      and transaction_type_id=target_type
      and subsidiary_id=target_subsidiary
    returning coalesce(prefix,'')||
      case
        when length(current_number::text)<padding_length
          then lpad(current_number::text,padding_length,'0')
        else current_number::text
      end||coalesce(suffix,'')
    into result;

    if result is null then
      if type_abbreviation is distinct from 'SOL_PAG' then
        raise exception
          'No existe una secuencia para el tipo de transacción y subsidiaria seleccionados.';
      end if;

      if not exists(
        select 1 from public.subsidiaries
        where subsidiary_id=target_subsidiary
      ) then
        raise exception 'La subsidiaria indicada no existe.';
      end if;

      select coalesce(max(
        (regexp_match(numero,'^SOL_PAG-([0-9]+)$'))[1]::bigint
      ),0) into canonical_max
      from public.solicitudes_pago
      where numero~'^SOL_PAG-[0-9]+$'
        and numero!~'^SOL_PAG-[0-9]{17}$';

      insert into public.number_sequences(
        scope_type,transaction_type_id,subsidiary_id,prefix,suffix,
        current_number,padding_length,allow_manual_update
      )values(
        'Transacción',target_type,target_subsidiary,'SOL_PAG-',null,
        canonical_max,8,false
      )
      on conflict(transaction_type_id,subsidiary_id)
        where scope_type='Transacción'
      do update set
        prefix='SOL_PAG-',
        suffix=null,
        current_number=greatest(
          public.number_sequences.current_number,
          excluded.current_number
        ),
        padding_length=8,
        allow_manual_update=false;

      continue;
    end if;

    exit when not exists(
      select 1 from public."transaction" where tran_number=result
    ) and not exists(
      select 1 from public.journal where journal_number=result
    ) and not exists(
      select 1 from public.supplier_payment where payment_number=result
    ) and not exists(
      select 1 from public.customer_payment where payment_number=result
    ) and not exists(
      select 1 from public.solicitudes_pago where numero=result
    );
  end loop;

  return result;
end
$$;

-- Los documentos ya aprobados o aplicados conservan su identificador para no
-- alterar referencias bancarias, contables o de auditoría. Solo se corrigen
-- borradores que todavía tienen el formato de contingencia por timestamp.
do $$
declare
  request_row record;
  transaction_type_key bigint;
  corrected_number text;
begin
  select transaction_type_id into transaction_type_key
  from public.transaction_types
  where abbreviation='SOL_PAG';

  for request_row in
    select id,numero,id_subsidiaria,id_solicitante
    from public.solicitudes_pago
    where estado='BORRADOR'
      and numero~'^SOL_PAG-[0-9]{17}$'
    order by id
    for update
  loop
    corrected_number:=public.next_transaction_number(
      transaction_type_key,request_row.id_subsidiaria
    );

    update public.solicitudes_pago
    set numero=corrected_number,
        version=version+1,
        updated_at=now()
    where id=request_row.id;

    insert into public.solicitudes_pago_eventos(
      id_solicitud,usuario,accion,nota
    )values(
      request_row.id,request_row.id_solicitante,'NUMERACION_CORREGIDA',
      'Corrección automática de consecutivo. Número anterior: '
        ||request_row.numero||'. Nuevo número: '||corrected_number||'.'
    );
  end loop;
end
$$;

revoke all on function public.next_transaction_number(bigint,bigint)
from public,anon,authenticated;
grant execute on function public.next_transaction_number(bigint,bigint)
to service_role;

comment on function public.next_transaction_number(bigint,bigint) is
  'Genera consecutivos transaccionales serializados. SOL_PAG se auto-configura y valida unicidad contra solicitudes de pago.';

commit;
notify pgrst,'reload schema';
