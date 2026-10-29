-- Reduce las seis llamadas HTTP de la pantalla de reportes a una sola RPC.
-- Las funciones existentes conservan sus reglas de acceso y su contrato; esta
-- función únicamente compone sus resultados dentro de la misma transacción.
create or replace function public.accounting_report_options_bundle()
returns jsonb
language sql
stable
security definer
set search_path=public,pg_temp
as $$
  select
    coalesce(public.accounting_report_options(),'{}'::jsonb)
    || coalesce(public.income_statement_dimension_links(),'{}'::jsonb)
    || jsonb_build_object(
      'journalOptions',coalesce(public.general_journal_options(),'{}'::jsonb),
      'pendingInvoiceOptions',coalesce(public.pending_invoice_control_options(),'{}'::jsonb),
      'agingOptions',coalesce(public.aging_report_options(),'{}'::jsonb),
      'bankOptions',coalesce(public.bank_reconciliation_options(),'{}'::jsonb)
    );
$$;

revoke all on function public.accounting_report_options_bundle() from public,anon;
grant execute on function public.accounting_report_options_bundle() to authenticated;

comment on function public.accounting_report_options_bundle() is
  'Opciones de reportes contables consolidadas en una única llamada HTTP.';

notify pgrst,'reload schema';
