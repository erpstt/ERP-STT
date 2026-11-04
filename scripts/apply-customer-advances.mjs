import{runMigrationPreview}from'./lib/migration-preview.mjs';
await runMigrationPreview({entrypoint:'scripts/apply-customer-advances.mjs',defaultFiles:['20260909190000_customer_advances.sql'],allowFileArgument:false});
