CREATE OR REPLACE FUNCTION public.accounting_report_options_bundle()
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  select
    coalesce(public.accounting_report_options(),'{}'::jsonb)
    || coalesce(public.income_statement_dimension_links(),'{}'::jsonb)
    || jsonb_build_object(
      'journalOptions',coalesce(public.general_journal_options(),'{}'::jsonb),
      'pendingInvoiceOptions',coalesce(public.pending_invoice_control_options(),'{}'::jsonb),
      'agingOptions',coalesce(public.aging_report_options(),'{}'::jsonb),
      'bankOptions',coalesce(case when reconciliation_private.allowed('reports:accounting-reports','view') then reconciliation_private.bank_reconciliation_options() else '{}'::jsonb end,'{}'::jsonb)
    );
$function$ ;
