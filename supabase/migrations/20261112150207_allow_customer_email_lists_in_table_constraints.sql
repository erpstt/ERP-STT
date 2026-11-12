set local lock_timeout='5s';
set local statement_timeout='60s';
-- Apply the same address-list validation at the storage layer as the customer editor and mail delivery.
alter table public.customers
 drop constraint if exists customers_email_format,
 drop constraint if exists customer_statement_email_required,
 add constraint customers_email_format check (
  email is null or coalesce(cardinality(entity_master_private.customer_email_recipients(email)),0)>0
 ),
 add constraint customer_statement_email_required check (
  not envio_estado_cuenta_auto or coalesce(cardinality(entity_master_private.customer_email_recipients(email)),0)>0
 );
notify pgrst,'reload schema';
