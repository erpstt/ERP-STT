import{runMigrationPreview}from'./lib/migration-preview.mjs';
await runMigrationPreview({entrypoint:'scripts/apply-sales-invoice-service-country-integrity.mjs',defaultFiles:['20261001121000_enforce_sales_invoice_service_country.sql'],allowFileArgument:false});
