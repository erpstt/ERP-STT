import{runMigrationPreview}from'./lib/migration-preview.mjs';
await runMigrationPreview({entrypoint:'scripts/apply-sales-note-service-country.mjs',defaultFiles:['20261001120000_add_sales_note_service_country.sql'],allowFileArgument:false});
