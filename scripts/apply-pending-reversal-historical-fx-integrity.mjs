// --dry-run now returns file metadata; transactional trial/rollback is disabled.
// Former --verify database checks and --apply execution are disabled.
import{runMigrationPreview}from'./lib/migration-preview.mjs';
await runMigrationPreview({entrypoint:'scripts/apply-pending-reversal-historical-fx-integrity.mjs',defaultFiles:['20261021130000_pending_reversal_historical_fx_integrity.sql'],allowFileArgument:false});
