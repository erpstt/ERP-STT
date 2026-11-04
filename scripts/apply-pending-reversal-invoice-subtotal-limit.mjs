import{runMigrationPreview}from'./lib/migration-preview.mjs';
await runMigrationPreview({entrypoint:'scripts/apply-pending-reversal-invoice-subtotal-limit.mjs',defaultFiles:['20261019090000_pending_reversal_invoice_subtotal_limit.sql'],allowFileArgument:false});
