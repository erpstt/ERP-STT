// Preview only: former installation, live verification and metric queries are disabled.
import{runMigrationPreview}from'./lib/migration-preview.mjs';
await runMigrationPreview({entrypoint:'scripts/apply-opening-pending-auxiliary.mjs',defaultFiles:['20261014110000_opening_pending_invoice_auxiliary.sql'],allowFileArgument:false});
