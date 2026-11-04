// Preview only: former installation, live verification and metric queries are disabled.
import{runMigrationPreview}from'./lib/migration-preview.mjs';
await runMigrationPreview({entrypoint:'scripts/apply-sales-invoice-intercompany-receivable-account.mjs',defaultFiles:['20261020100000_sales_invoice_intercompany_receivable_account.sql'],allowFileArgument:false});
