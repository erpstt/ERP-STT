// Preview only: installation, notification environment guards and live queue/
// template checks are disabled. This manifest does not claim SMTP/send state.
import{runMigrationPreview}from'./lib/migration-preview.mjs';
await runMigrationPreview({entrypoint:'scripts/activate-customer-statements.mjs',defaultFiles:['20260920140000_customer_statement_notifications.sql'],allowFileArgument:false});
