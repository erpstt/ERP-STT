// --dry-run now returns file metadata; transactional trial/rollback is disabled.
// Former --verify database checks and --apply execution are disabled.
import{runMigrationPreview}from'./lib/migration-preview.mjs';
await runMigrationPreview({entrypoint:'scripts/apply-pending-invoice-reclassification.mjs',defaultFiles:['20261021120000_pending_invoice_annual_reclassification.sql'],allowFileArgument:false});
