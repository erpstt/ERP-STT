import{runMigrationPreview}from'./lib/migration-preview.mjs';
await runMigrationPreview({entrypoint:'scripts/apply-purchase-transaction-supports.mjs',defaultFiles:['20261001130000_purchase_transaction_cost_centers_supports.sql'],allowFileArgument:false});
