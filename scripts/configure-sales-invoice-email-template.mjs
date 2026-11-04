// Preview only: installation/readiness and configured-template counts are
// disabled. This manifest does not claim delivery configuration or send state.
import{runMigrationPreview}from'./lib/migration-preview.mjs';
await runMigrationPreview({entrypoint:'scripts/configure-sales-invoice-email-template.mjs',defaultFiles:['20260928130000_sales_invoice_email_template.sql'],allowFileArgument:false});
