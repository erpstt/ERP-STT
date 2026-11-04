import{runMigrationPreview}from'./lib/migration-preview.mjs';
await runMigrationPreview({entrypoint:'scripts/apply-sales-service-month-fix.mjs',defaultFiles:['20261001110000_fix_sales_service_month.sql'],allowFileArgument:false});
