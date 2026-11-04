import{runMigrationPreview}from'./lib/migration-preview.mjs';
await runMigrationPreview({entrypoint:'scripts/apply-settled-invoice-report-breakdown.mjs',defaultFiles:['20260930163000_settled_sales_invoice_funding_breakdown.sql'],allowFileArgument:false});
