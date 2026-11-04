import{runMigrationPreview}from'./lib/migration-preview.mjs';
await runMigrationPreview({entrypoint:'scripts/apply-settled-invoice-reconciliation.mjs',defaultFiles:['20260930163000_settled_sales_invoice_funding_breakdown.sql','20260930163500_customer_receivable_application_guard.sql'],allowFileArgument:false});
