-- Imported opening invoices intentionally point at a shared opening journal
-- without storing its transaction on each invoice. Resolve it in memory only;
-- the exact opening line, entity, currency, rate and amounts remain mandatory.
set local lock_timeout='5s';
set local statement_timeout='60s';

do $opening_transaction$
declare target regprocedure:='supplier_payment_private.invoice_basis(bigint,bigint)'::regprocedure;definition text;needle text;replacement text;
begin
 if md5((select prosrc from pg_proc where oid=target))is distinct from'e863be451b40c8a542319b264bcce936'then raise exception 'Reviewed supplier invoice historical basis changed.';end if;
 definition:=pg_get_functiondef(target);
 needle:=$old$select * into j from public.journal where journal_id=i.journal_id;select * into t from public."transaction" where transaction_id=i.transaction_id;$old$;
 replacement:=$new$select * into j from public.journal where journal_id=i.journal_id;
 if coalesce(i.is_opening_balance,false)and i.transaction_id is null then
  i.transaction_id:=j.transaction_id;
 end if;
 select * into t from public."transaction" where transaction_id=i.transaction_id;$new$;
 if(length(definition)-length(replace(definition,needle,'')))/length(needle)<>1 then raise exception 'Unexpected opening invoice transaction lookup.';end if;
 execute replace(definition,needle,replacement);
end$opening_transaction$;
