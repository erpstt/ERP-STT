-- Existing editable notes may retain their own tax snapshot on their original
-- date. New notes, different codes/rates, and changed dates still use current
-- authorized tax configuration. No historical note is rewritten here.
set local lock_timeout='5s';
set local statement_timeout='60s';
do $note_tax$
declare target regprocedure:='supplier_note_private.prepare(text,jsonb,bigint)'::regprocedure;definition text;needle text;replacement text;
begin
 if md5((select prosrc from pg_proc where oid=target))is distinct from'ce31f4c60422df3fc999e4754efa158f'then raise exception 'Reviewed supplier note preparation changed.';end if;
 definition:=pg_get_functiondef(target);
 needle:=$old$if l?'tax_rate' and (l->>'tax_rate')::numeric is distinct from tax_rate then raise exception using errcode='22023',message='La tasa debe coincidir con el impuesto configurado.';end if;$old$;
 replacement:=$new$if l?'tax_rate' and (l->>'tax_rate')::numeric is distinct from tax_rate then
   if nid is null or tax_id is null then raise exception using errcode='22023',message='La tasa debe coincidir con el impuesto configurado.';end if;
   if n.note_date is distinct from(p->>'note_date')::date or not exists(
    select 1 from public.supplier_note_line history where history.note_kind=k and history.note_id=nid
     and history.tax_code_id=tax_id and history.tax_rate=(l->>'tax_rate')::numeric
   )then raise exception using errcode='22023',message='La tasa debe coincidir con el impuesto configurado o con el histórico de esta nota en su fecha original.';end if;
   tax_rate:=(l->>'tax_rate')::numeric;
   if not asset_posting_private.finite(tax_rate)or tax_rate not between 0 and 100 then raise exception using errcode='22023',message='Tasa inválida.';end if;
   if tax_rate>0 then perform asset_posting_private.account(tax_account);end if;
  end if;$new$;
 if(length(definition)-length(replace(definition,needle,'')))/length(needle)<>1 then raise exception 'Unexpected supplier note tax-rate guard.';end if;
 execute replace(definition,needle,replacement);
end$note_tax$;
