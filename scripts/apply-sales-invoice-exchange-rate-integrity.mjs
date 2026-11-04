import{runMigrationPreview}from'./lib/migration-preview.mjs';
await runMigrationPreview({entrypoint:'scripts/apply-sales-invoice-exchange-rate-integrity.mjs',defaultFiles:['20261026150000_sales_invoice_exchange_rate_integrity.sql'],allowFileArgument:false});
